import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  appliedExitCode,
  type ChangesEvent,
  finishWorkspace,
} from '../../src/cli/workspace-changes.ts';
import type { ApplyOutcome } from '../../src/sandbox/changeset/apply.ts';
import { type Change, classify, GIT_NEVER_CHANGED } from '../../src/sandbox/changeset/classify.ts';
import { close, openBeneath, openDirectory, tryLock } from '../../src/sandbox/changeset/dirfd.ts';
import { readUpper } from '../../src/sandbox/changeset/snapshot.ts';
import {
  describeChanges,
  displayPath,
  formatApplyReport,
  formatChanges,
} from '../../src/sandbox/changeset/summary.ts';
import {
  createWorkspaceDirectory,
  processStart,
  referenceTime,
  removeLiveWorkspaceDirectories,
  removeWorkspaceDirectory,
} from '../../src/sandbox/workspace.ts';
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
    expect(directory.path).toBe(
      join(runtime, `nullrivet-${process.pid}-${processStart(process.pid)}`),
    );
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
    const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: runtime });
    if ('error' in created) throw new Error(created.error);
    expect(created.warnings).toEqual([]);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(other)).toBe(true);
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
      // Past the clock tick the project was made in, which would count as a change on the host.
      Bun.sleepSync(20);
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

  test('refuses a runtime directory that is missing, relative or writable by others', () => {
    const open = runtimeDir();
    chmodSync(open, 0o777);
    for (const env of [{}, { XDG_RUNTIME_DIR: 'run/user' }, { XDG_RUNTIME_DIR: open }]) {
      const created = createWorkspaceDirectory(env);
      expect('error' in created ? created.error : 'created').toContain('XDG_RUNTIME_DIR');
    }
    expect(readdirSync(open)).toEqual([]);
  });

  test('refuses a runtime directory on disk, where the changes would outlive a killed process', () => {
    // /var/tmp is kept between reboots, on disk.
    const disk = realpathSync(mkdtempSync(join('/var/tmp', 'nullrivet-runtime-')));
    dirs.push(disk);
    const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: disk });
    expect('error' in created ? created.error : 'created').toBe(
      `XDG_RUNTIME_DIR ${disk} must be on a tmpfs: the workspace sandbox keeps its changes in memory, never on disk`,
    );
    expect(readdirSync(disk)).toEqual([]);
  });

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
    const runtime = runtimeDir();
    const project = join(runtime, 'project');
    const upper = join(runtime, 'upper');
    mkdirSync(project);
    mkdirSync(upper);
    for (const name of ['a.txt', 'b.txt']) {
      writeFileSync(join(project, name), 'one\ntwo\nthree\n');
      writeFileSync(join(upper, name), 'one\n2\nthree\n');
    }
    const root = openDirectory(project);
    try {
      const changes = classify(readUpper(upper), root);
      const counted = (limits: { bytes: number; steps: number }) =>
        describeChanges(changes, root, upper, limits).map((entry) => [
          entry.path,
          entry.lines ?? entry.uncompared,
        ]);
      const unlimited = { added: 1, removed: 1 };
      expect(counted({ bytes: 1_000_000, steps: 1_000_000 })).toEqual([
        ['a.txt', unlimited],
        ['b.txt', unlimited],
      ]);
      // The first file read spends the bytes, and its comparison spends the steps.
      for (const limits of [
        { bytes: 1, steps: 1_000_000 },
        { bytes: 1_000_000, steps: 1 },
      ]) {
        expect(counted(limits)).toEqual([
          ['a.txt', unlimited],
          ['b.txt', true],
        ]);
      }
      const plain = {
        added: (text: string) => text,
        removed: (text: string) => text,
        attention: (text: string) => text,
        dim: (text: string) => text,
      };
      const text = formatChanges(
        describeChanges(changes, root, upper, { bytes: 1, steps: 1 }),
        plain,
      );
      expect(text).toContain('  modified b.txt  12B\n');
      expect(text).toContain('The lines of 1 file were not counted');
    } finally {
      close(root);
    }
  });
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
