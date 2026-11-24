import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxHost } from '../../src/sandbox/bwrap.ts';
import { type ApplyOutcome, applyChanges } from '../../src/sandbox/changeset/apply.ts';
import { type Change, classify } from '../../src/sandbox/changeset/classify.ts';
import { close, openDirectory, openPath } from '../../src/sandbox/changeset/dirfd.ts';
import { readUpper, type UpperNode } from '../../src/sandbox/changeset/snapshot.ts';
import { symlinkTargetsInside } from '../../src/sandbox/changeset/validate.ts';
import { overlayTestsRun } from '../helpers/sandbox.ts';
import { isRoot } from '../tools/fixtures.ts';

const host = sandboxHost();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    Bun.spawnSync(['chmod', '-R', 'u+rwx', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A project and an overlay over it, as the workspace profile mounts it; `since` is taken after
// the project is set up, as the session takes it before mounting.
const workspace = (files: Record<string, string> = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-changeset-')));
  dirs.push(base);
  const project = join(base, 'project');
  const upper = join(base, 'upper');
  const work = join(base, 'work');
  mkdirSync(project);
  mkdirSync(upper);
  mkdirSync(work);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(project, path, '..'), { recursive: true });
    writeFileSync(join(project, path), content);
  }
  let since = 0n;
  const start = () => {
    // File times come from a coarse clock: a file written in the same tick as the probe would
    // count as changed, as it should.
    Bun.sleepSync(20);
    const probe = join(base, 'probe');
    writeFileSync(probe, '');
    since = statSync(probe, { bigint: true }).ctimeNs;
  };
  // Runs a shell script in the overlay, as the agent would.
  const agent = (script: string) => {
    if (typeof host === 'string') throw new Error(host);
    const run = Bun.spawnSync(
      [
        host.bwrap,
        '--dev-bind',
        '/',
        '/',
        '--overlay-src',
        project,
        '--overlay',
        upper,
        work,
        project,
        '--chdir',
        project,
        '--',
        'sh',
        '-c',
        script,
      ],
      { stderr: 'pipe' },
    );
    if (run.exitCode !== 0) throw new Error(`the agent script failed: ${run.stderr.toString()}`);
  };
  let snapshot: UpperNode | null = null;
  const changes = (): Change[] => {
    snapshot = readUpper(upper);
    const root = openDirectory(project);
    try {
      return symlinkTargetsInside(classify(snapshot, root), snapshot, root, project);
    } finally {
      close(root);
    }
  };
  const apply = (
    list: Change[] = changes(),
    afterCheck?: (change: Change) => void,
  ): ApplyOutcome => {
    const root = openDirectory(project);
    try {
      return applyChanges(list, {
        projectRoot: root,
        projectPath: project,
        upperPath: upper,
        since,
        ...(afterCheck === undefined ? {} : { afterCheck }),
      });
    } finally {
      close(root);
    }
  };
  return {
    base,
    project,
    upper,
    start,
    agent,
    changes,
    apply,
    file: (path: string) => join(project, path),
  };
};

const summary = (outcome: ApplyOutcome) => ({
  applied: outcome.applied.map((c) => `${c.op} ${c.path.join('/')}`),
  conflicts: outcome.conflicts.map((c) => `${c.change.path.join('/')}: ${c.reason}`),
  refused: outcome.refused.map((c) => `${c.change.path.join('/')}: ${c.reason}`),
  stopped: outcome.stopped?.reason ?? null,
});

describe.if(overlayTestsRun)('the workspace ChangeSet', () => {
  test('applies additions, edits, removals, renames and directories, and leaves the rest', async () => {
    const w = workspace({
      'edit.txt': 'old\n',
      'del.txt': 'gone\n',
      'mv.txt': 'moved\n',
      'mode.sh': 'echo\n',
      'touch.txt': 'same\n',
      'dir/a.txt': 'a\n',
      'dir/sub/b.txt': 'b\n',
      'opaque/old.txt': 'old\n',
      '.git/config': '[core]\n',
    });
    w.start();
    w.agent(
      [
        'echo new >> edit.txt',
        'echo added > added.txt',
        'rm del.txt',
        'mv mv.txt moved.txt',
        'chmod 4755 mode.sh',
        'touch -d 2001-01-01 touch.txt',
        'rm -r dir',
        'mkdir -p newdir/deep && echo deep > newdir/deep/file.txt',
        'rm -r opaque && mkdir opaque && echo fresh > opaque/new.txt',
        'ln -s edit.txt inside-link',
        'ln -s /etc/passwd outside-link',
        'ln -s /usr/bin/env usr-link',
        'mkfifo fifo',
        'echo "[core] fsmonitor = evil" > .git/config',
        'echo one > hard1 && ln hard1 hard2',
      ].join('; '),
    );
    const outcome = w.apply();
    const result = summary(outcome);
    expect(result.conflicts).toEqual([]);
    expect(result.stopped).toBeNull();
    expect(readFileSync(w.file('edit.txt'), 'utf8')).toBe('old\nnew\n');
    expect(readFileSync(w.file('added.txt'), 'utf8')).toBe('added\n');
    expect(existsSync(w.file('del.txt'))).toBe(false);
    expect(existsSync(w.file('mv.txt'))).toBe(false);
    expect(readFileSync(w.file('moved.txt'), 'utf8')).toBe('moved\n');
    // The set-user-ID bit never reaches the project.
    expect(statSync(w.file('mode.sh')).mode & 0o7777).toBe(0o755);
    expect(existsSync(w.file('dir'))).toBe(false);
    expect(readFileSync(w.file('newdir/deep/file.txt'), 'utf8')).toBe('deep\n');
    expect(readdirSync(w.file('opaque'))).toEqual(['new.txt']);
    expect(readlinkSync(w.file('inside-link'))).toBe('edit.txt');
    expect(readlinkSync(w.file('usr-link'))).toBe('/usr/bin/env');
    expect(existsSync(w.file('outside-link'))).toBe(false);
    expect(existsSync(w.file('fifo'))).toBe(false);
    expect(readFileSync(w.file('.git/config'), 'utf8')).toBe('[core]\n');
    // Hard links reach the project as separate files.
    expect(readFileSync(w.file('hard2'), 'utf8')).toBe('one\n');
    expect(lstatSync(w.file('hard1')).ino).not.toBe(lstatSync(w.file('hard2')).ino);
    expect(result.refused.sort()).toEqual([
      '.git: .git is never changed',
      'fifo: a FIFO is not applied',
      'outside-link: the link leads out of the project',
    ]);
    // A copy that changed only times is no change.
    expect(result.applied.some((line) => line.includes('touch.txt'))).toBe(false);
  });

  test('a removal of .git is refused, at any depth', () => {
    const w = workspace({ '.git/HEAD': 'ref\n', 'sub/.git/HEAD': 'ref\n', 'sub/file.txt': 'x\n' });
    w.start();
    w.agent('rm -rf .git; rm -rf sub');
    const result = summary(w.apply());
    expect(existsSync(w.file('.git/HEAD'))).toBe(true);
    expect(existsSync(w.file('sub/.git/HEAD'))).toBe(true);
    expect(result.refused).toEqual([
      '.git: .git is never changed',
      'sub: the directory is not removed: it holds a .git directory',
    ]);
  });

  test('a change to a file the host changed since the start is a conflict, and the rest applies', async () => {
    const w = workspace({ 'shared.txt': 'base\n', 'gone.txt': 'base\n', 'own.txt': 'base\n' });
    w.start();
    w.agent('echo agent >> shared.txt; echo agent >> gone.txt; echo agent >> own.txt');
    await Bun.sleep(10);
    writeFileSync(w.file('shared.txt'), 'operator\n');
    rmSync(w.file('gone.txt'));
    const result = summary(w.apply());
    expect(readFileSync(w.file('shared.txt'), 'utf8')).toBe('operator\n');
    expect(existsSync(w.file('gone.txt'))).toBe(false);
    expect(readFileSync(w.file('own.txt'), 'utf8')).toBe('base\nagent\n');
    // The file the agent edited and the operator deleted would be added again: its directory
    // changed, so it is not.
    expect(result.conflicts).toEqual([
      'gone.txt: its directory changed on the host',
      'shared.txt: the file changed on the host',
    ]);
  });

  test('an addition to a directory the host changed is a conflict, even with its time restored', async () => {
    const w = workspace({ 'dir/keep.txt': 'k\n' });
    const before = statSync(w.file('dir'));
    w.start();
    w.agent('echo new > dir/new.txt');
    await Bun.sleep(10);
    writeFileSync(w.file('dir/new.txt'), 'operator\n');
    rmSync(w.file('dir/new.txt'));
    // Restoring the modification time does not restore the change time.
    Bun.spawnSync(['touch', '-d', `@${Math.floor(before.mtimeMs / 1000)}`, w.file('dir')]);
    const result = summary(w.apply());
    expect(existsSync(w.file('dir/new.txt'))).toBe(false);
    expect(result.conflicts).toEqual(['dir/new.txt: its directory changed on the host']);
  });

  test('several additions to one directory are not conflicts with each other', () => {
    const w = workspace({ 'dir/keep.txt': 'k\n' });
    w.start();
    w.agent('for i in 1 2 3 4 5; do echo $i > dir/f$i.txt; done');
    const result = summary(w.apply());
    expect(result.conflicts).toEqual([]);
    expect(readdirSync(w.file('dir')).sort()).toEqual([
      'f1.txt',
      'f2.txt',
      'f3.txt',
      'f4.txt',
      'f5.txt',
      'keep.txt',
    ]);
  });

  test('a type change replaces the entry, and never follows a link of the project', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-outside-')));
    dirs.push(outside);
    writeFileSync(join(outside, 'key'), 'secret\n');
    const w = workspace({ 'tree/a.txt': 'a\n', 'file.txt': 'f\n' });
    symlinkSync(outside, w.file('ext'));
    w.start();
    w.agent(
      [
        'rm -r tree && ln -s file.txt tree',
        'rm file.txt && mkdir file.txt && echo in > file.txt/inner',
        'rm ext && mkdir ext && echo mine > ext/key',
        'ln -s ext/key via-ext',
      ].join('; '),
    );
    const result = summary(w.apply());
    expect(result.conflicts).toEqual([]);
    expect(readlinkSync(w.file('tree'))).toBe('file.txt');
    expect(readFileSync(w.file('file.txt/inner'), 'utf8')).toBe('in\n');
    // The link of the project was replaced by a directory, not followed into the outside.
    expect(lstatSync(w.file('ext')).isDirectory()).toBe(true);
    expect(readFileSync(join(outside, 'key'), 'utf8')).toBe('secret\n');
  });

  test('a link through a link of the project that leads out is refused', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-outside-')));
    dirs.push(outside);
    const w = workspace({ 'a.txt': 'a\n' });
    symlinkSync(outside, w.file('ext'));
    w.start();
    w.agent('ln -s ext/key leak; ln -s ../../../etc/passwd up');
    const result = summary(w.apply());
    expect(result.refused.sort()).toEqual([
      'leak: the link leads out of the project',
      'up: the link leads out of the project',
    ]);
  });

  test('a link to /usr that leads back out of it is refused', () => {
    const w = workspace();
    w.start();
    w.agent(
      [
        'ln -s /usr/../etc/passwd up',
        'ln -s /usr/lib/../../etc/passwd deeper',
        'ln -s /usr/bin/../../etc via',
        'ln -s via up2',
      ].join('; '),
    );
    const result = summary(w.apply());
    expect(result.refused.sort()).toEqual([
      'deeper: the link leads out of the project',
      'up2: the link leads out of the project',
      'up: the link leads out of the project',
      'via: the link leads out of the project',
    ]);
  });

  test('a link is checked again over what was applied, and refused when an entry it passes is not', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-outside-')));
    dirs.push(outside);
    const w = workspace({ 'sub/keep': 'k\n', 'links/keep': 'k\n' });
    symlinkSync(outside, w.file('sub/ext'));
    symlinkSync('../sub/keep', w.file('links/a'));
    w.start();
    w.agent(
      'rm sub/ext && mkdir sub/ext && echo mine > sub/ext/key; ln -sfn ../sub/ext/key links/a',
    );
    // Over the upper layer the link stays inside: sub/ext is the agent's directory there.
    expect(w.changes().filter((change) => change.op === 'refuse')).toEqual([]);
    // The operator replaces the link of the project, so its removal is a conflict; the directory
    // of the new link is untouched, so the link itself is not.
    rmSync(w.file('sub/ext'));
    symlinkSync(outside, w.file('sub/ext'));
    const result = summary(w.apply());
    expect(result.conflicts.map((line) => line.split(':')[0])).toEqual([
      'sub/ext',
      'sub/ext',
      'sub/ext/key',
    ]);
    // The link it replaces stays: its removal goes with the refused link.
    expect(result.refused).toEqual([
      'links/a: the link leads out of the project',
      'links/a: the entry that replaces it is not applied',
    ]);
    expect(readlinkSync(w.file('links/a'))).toBe('../sub/keep');
  });

  test('a link of the project replaced by one that leads out stays as it was', () => {
    const w = workspace({ 'config.txt': 'c\n' });
    symlinkSync('config.txt', w.file('config-link'));
    w.start();
    w.agent('ln -sfn /etc/passwd config-link');
    const result = summary(w.apply());
    expect(result.refused).toEqual([
      'config-link: the entry that replaces it is not applied',
      'config-link: the link leads out of the project',
    ]);
    expect(result.applied).toEqual([]);
    expect(readlinkSync(w.file('config-link'))).toBe('config.txt');
  });

  test('a mode change to a file with another name outside the project leaves that name alone', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-outside-')));
    dirs.push(outside);
    const w = workspace();
    writeFileSync(join(outside, 'secret'), 'shared\n', { mode: 0o600 });
    chmodSync(join(outside, 'secret'), 0o600);
    linkSync(join(outside, 'secret'), w.file('alias.txt'));
    w.start();
    w.agent('chmod 644 alias.txt');
    const result = summary(w.apply());
    expect(result.stopped).toBeNull();
    expect(result.applied).toEqual(['write alias.txt']);
    expect(statSync(w.file('alias.txt')).mode & 0o777).toBe(0o644);
    expect(readFileSync(w.file('alias.txt'), 'utf8')).toBe('shared\n');
    expect(statSync(join(outside, 'secret')).mode & 0o777).toBe(0o600);
    expect(statSync(join(outside, 'secret')).nlink).toBe(1);
  });

  test('FIFOs and sockets the project has are removed, alone or in a directory', () => {
    const w = workspace({ 'cache/data.txt': 'd\n' });
    Bun.spawnSync(['mkfifo', w.file('pipe'), w.file('cache/pipe')]);
    // A socket file stays after the process that bound it ends; Bun removes its own on stop.
    Bun.spawnSync([
      'python3',
      '-I',
      '-c',
      'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])',
      w.file('cache/server.sock'),
    ]);
    expect(lstatSync(w.file('cache/server.sock')).isSocket()).toBe(true);
    w.start();
    w.agent('rm pipe; rm -r cache');
    const result = summary(w.apply());
    expect(result.refused).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.applied.sort()).toEqual(['remove cache', 'remove pipe']);
    expect(readdirSync(w.project)).toEqual([]);
  });

  test('a link through an entry that is not applied is refused in the summary', () => {
    const w = workspace({ 'keep/.git/HEAD': 'ref\n', 'inside/file.txt': 'f\n' });
    symlinkSync('/etc', w.file('keep/out'));
    w.start();
    // The removal of keep is refused, so keep stays the project's directory, where out leads out.
    w.agent('rm -rf keep && ln -s inside keep; ln -s keep/out/passwd p');
    const refused = w
      .changes()
      .filter((change) => change.op === 'refuse')
      .map((change) => `${change.path.join('/')}: ${change.reason}`);
    expect(refused).toEqual([
      'keep: the directory is not removed: it holds a .git directory',
      'p: the link leads out of the project',
    ]);
    w.apply();
    expect(existsSync(w.file('p'))).toBe(false);
    expect(lstatSync(w.file('keep')).isDirectory()).toBe(true);
  });

  test.skipIf(isRoot)(
    'a file of the project without read permission is changed by mode and content',
    () => {
      const w = workspace({ secret: 'one\n', secret2: 'two\n' });
      chmodSync(w.file('secret'), 0o000);
      chmodSync(w.file('secret2'), 0o000);
      w.start();
      w.agent('chmod 600 secret; chmod 600 secret2 && echo more >> secret2');
      const result = summary(w.apply());
      expect(result.stopped).toBeNull();
      expect(result.conflicts).toEqual([]);
      expect(statSync(w.file('secret')).mode & 0o777).toBe(0o600);
      expect(readFileSync(w.file('secret'), 'utf8')).toBe('one\n');
      expect(readFileSync(w.file('secret2'), 'utf8')).toBe('two\nmore\n');
    },
  );

  test.skipIf(isRoot)(
    'a link through a directory of the project that cannot be read is refused',
    () => {
      const w = workspace({ 'locked/inner': 'x\n' });
      chmodSync(w.file('locked'), 0o000);
      w.start();
      w.agent('ln -s locked/inner link');
      const result = summary(w.apply());
      expect(result.refused).toEqual(['link: the link leads out of the project']);
    },
  );

  test('a set-group-ID bit the project already has is kept, and never added', () => {
    const w = workspace({ 'shared/keep.txt': 'k\n', 'plain/keep.txt': 'k\n' });
    chmodSync(w.file('shared'), 0o2775);
    w.start();
    w.agent('echo new > shared/new.txt; chmod 2775 plain');
    const result = summary(w.apply());
    expect(result.stopped).toBeNull();
    expect(readFileSync(w.file('shared/new.txt'), 'utf8')).toBe('new\n');
    expect(statSync(w.file('shared')).mode & 0o7777).toBe(0o2775);
    expect(statSync(w.file('plain')).mode & 0o7777).toBe(0o775);
  });

  test('a file whose modification time is in the future is not a conflict', () => {
    const w = workspace({ 'future.txt': 'base\n' });
    const later = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    utimesSync(w.file('future.txt'), later, later);
    w.start();
    w.agent('echo agent >> future.txt');
    const result = summary(w.apply());
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(w.file('future.txt'), 'utf8')).toBe('base\nagent\n');
  });

  test('a removed directory is removed whole, read-only directories inside it included', () => {
    const w = workspace({ 'cache/mod/file.txt': 'x\n', 'keep.txt': 'k\n' });
    chmodSync(w.file('cache/mod'), 0o555);
    w.start();
    w.agent('chmod -R u+w cache && rm -rf cache');
    const result = summary(w.apply());
    expect(result.stopped).toBeNull();
    expect(result.applied).toEqual(['remove cache']);
    expect(readdirSync(w.project)).toEqual(['keep.txt']);
  });

  test('names are applied byte for byte, control characters included', () => {
    const w = workspace();
    w.start();
    w.agent(`printf x > "$(printf 'esc\\033[31mred')"; printf y > "$(printf 'new\\nline')"`);
    const result = summary(w.apply());
    expect(result.applied.length).toBe(2);
    expect(readdirSync(w.project).sort()).toEqual(['esc\u001b[31mred', 'new\nline']);
  });

  test('a file of the sandbox that changes after it was read stops the application there', () => {
    const w = workspace();
    w.start();
    w.agent('echo 1 > a.txt; echo 2 > b.txt; echo 3 > c.txt');
    const list = w.changes();
    writeFileSync(join(w.upper, 'b.txt'), 'tampered\n');
    const outcome = w.apply(list);
    expect(outcome.applied.map((c) => c.path.join('/'))).toEqual(['a.txt']);
    expect(outcome.stopped?.reason).toBe('a file of the sandbox changed after it was read');
    expect(outcome.notReached.map((c) => c.path.join('/'))).toEqual(['c.txt']);
    expect(existsSync(w.file('b.txt'))).toBe(false);
    expect(readdirSync(w.project).filter((name) => name.startsWith('.nullrivet-'))).toEqual([]);
  });

  test('an unreadable entry of the upper layer is read, a directory with mode 000 included', () => {
    const w = workspace();
    w.start();
    w.agent('mkdir locked && echo x > locked/f && chmod 000 locked/f && chmod 000 locked');
    const result = summary(w.apply());
    expect(result.stopped).toBeNull();
    expect(statSync(w.file('locked')).mode & 0o777).toBe(0);
    chmodSync(w.file('locked'), 0o700);
    expect(statSync(w.file('locked/f')).mode & 0o777).toBe(0);
  });

  test('a file changed on the host between its check and its replacement keeps the host version', () => {
    const w = workspace({ 'race.txt': 'base\n', 'after.txt': 'base\n' });
    w.start();
    w.agent('echo agent >> race.txt; echo agent >> after.txt');
    const outcome = w.apply(undefined, (change) => {
      if (change.path.join('/') === 'race.txt') writeFileSync(w.file('race.txt'), 'operator\n');
    });
    expect(readFileSync(w.file('race.txt'), 'utf8')).toBe('operator\n');
    expect(outcome.stopped?.reason).toBe('the file changed on the host');
    expect(outcome.applied.map((c) => c.path.join('/'))).toEqual(['after.txt']);
    expect(outcome.notReached).toEqual([]);
    expect(readdirSync(w.project).filter((name) => name.startsWith('.nullrivet-'))).toEqual([]);
  });

  test('a file the host deletes between its check and its replacement stays deleted, with no leftover', () => {
    const w = workspace({ 'race.txt': 'base\n' });
    w.start();
    w.agent('echo agent >> race.txt');
    const outcome = w.apply(undefined, () => rmSync(w.file('race.txt')));
    expect(outcome.stopped?.reason).toBe('the file changed on the host');
    expect(readdirSync(w.project)).toEqual([]);
  });

  test('a file over the size limit is not hashed nor applied, a sparse one included', () => {
    const w = workspace();
    w.start();
    w.agent('truncate -s 2G big.bin; echo small > small.txt');
    const result = summary(w.apply());
    expect(result.refused).toEqual(['big.bin: a file larger than 1073741824 bytes is not applied']);
    expect(existsSync(w.file('big.bin'))).toBe(false);
    expect(readFileSync(w.file('small.txt'), 'utf8')).toBe('small\n');
  });

  test('entries deeper than the longest path the system accepts are applied', () => {
    const w = workspace();
    w.start();
    const name = 'd'.repeat(200);
    // One level at a time, by relative calls: a path that long is refused in one piece, and some
    // shells, dash among them, change directory by the whole path.
    w.agent(
      `python3 -I -c "import os\nfor _ in range(25):\n    os.mkdir('${name}'); os.chdir('${name}')\nopen('leaf.txt', 'w').write('deep\\n')"`,
    );
    const result = summary(w.apply());
    expect(result.stopped).toBeNull();
    expect(result.conflicts).toEqual([]);
    const fd = openDirectory(w.project);
    try {
      const parts = [
        ...Array.from({ length: 25 }, () => Buffer.from(name)),
        Buffer.from('leaf.txt'),
      ];
      const leaf = openPath(fd, parts, constants.O_RDONLY);
      expect(readFileSync(leaf, 'utf8')).toBe('deep\n');
      close(leaf);
    } finally {
      close(fd);
    }
  });
});
