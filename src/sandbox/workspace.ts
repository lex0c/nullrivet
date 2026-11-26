import { randomBytes } from 'node:crypto';
import {
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { errorMessage } from '../errors.ts';
import {
  chmodFd,
  close,
  lstatAt,
  openBeneath,
  openDirectory,
  openDirectoryBeneath,
  openPathBeneath,
  RENAME_NOREPLACE,
  readdirAt,
  renameBeneath,
  rmdirAt,
  SysError,
  setXattr,
  tryLock,
  unlinkAt,
} from './changeset/dirfd.ts';

// The directory a sandbox of a workspace session keeps its writes in: `nullrivet-<pid>-<start>-<n>`
// in the user's runtime directory, a tmpfs only the user can write to, `n` counting the sandboxes
// the process started, with the overlay's upper and work directories inside. It is removed when
// the sandbox ends; one left by a process that was killed is removed by the next session that
// starts. A session holds the lock of the `lock` file in its directory while it lives: a process
// of another PID namespace that shares the runtime directory, as a container can, has an id that
// means nothing here, and its lock still shows. The directory is made under a name of its own,
// `<name>.new`, and renamed once its lock is held, so a session's directory is never seen without
// it.

type Env = Record<string, string | undefined>;

export interface WorkspaceDirectory {
  path: string;
  upper: string;
  work: string;
}

const PREFIX = 'nullrivet-';
// The count is optional: a directory left by a version that named it without one is removed too.
const SESSION_NAME = /^nullrivet-(\d+)-(\d+)(-\d+)?(\.new)?$/;
const LOCK = Buffer.from('lock');

// Filesystems whose change times or behaviour under an overlay are not local to this machine:
// another client can change a file without this kernel setting its change time, so conflicts
// would go unseen. The values are the magic numbers statfs reports.
const NETWORK_FILESYSTEMS = new Map<number, string>([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xff534d42, 'CIFS'],
  [0xfe534d42, 'SMB2'],
  [0x65735546, 'FUSE'],
  [0x01021997, '9P'],
  [0x00c36400, 'Ceph'],
]);

// Why the project cannot be mounted as a workspace, or null.
export const projectFilesystemError = (root: string): string | null => {
  const type = NETWORK_FILESYSTEMS.get(statfsSync(root).type);
  return type === undefined
    ? null
    : `the workspace sandbox does not support a project on ${type}: ${root} is on a filesystem that other machines or processes outside this kernel can change`;
};

// The start time of a process, in clock ticks since boot, or null when it does not exist. With
// the process id, it names one process: an id alone can be reused.
export const processStart = (pid: number): string | null => {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // The second field is the command name in parentheses, which can hold spaces and parentheses.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
};

const TMPFS = 0x01021994;

// The user's runtime directory, checked: a directory the user owns that no one else can write to,
// where nothing of another user can replace the session's directory, on a tmpfs, so that what the
// sandbox writes, which a process killed with SIGKILL leaves behind, is not kept in files on disk.
// A tmpfs is memory, which the system can still move to swap. The variable is set by the login
// session, but nothing stops it from naming another directory.
const runtimeDirectory = (env: Env): string | { error: string } => {
  const value = env.XDG_RUNTIME_DIR;
  if (value === undefined || value === '' || !isAbsolute(value)) {
    return {
      error:
        'the workspace sandbox keeps its changes in XDG_RUNTIME_DIR, which is not set to an absolute path; the login session sets it, as systemd does under /run/user',
    };
  }
  let path: string;
  let info: ReturnType<typeof lstatSync>;
  try {
    path = realpathSync(value);
    info = lstatSync(path);
  } catch (error) {
    return { error: `XDG_RUNTIME_DIR cannot be resolved: ${errorMessage(error)}` };
  }
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
    return {
      error: `XDG_RUNTIME_DIR ${path} must be a directory owned by the user and writable by no one else`,
    };
  }
  if (statfsSync(path).type !== TMPFS) {
    return {
      error: `XDG_RUNTIME_DIR ${path} must be on a tmpfs: the workspace sandbox keeps its changes in memory, not in files on disk`,
    };
  }
  return path;
};

// Gives the owner access to the directory `name` in `dir`: the overlay's work directory, and what
// the sandbox leaves, can have none. Reading a directory needs it, and so does moving one to
// another directory, which rewrites its `..` entry.
const grantOwner = (dir: number, name: Buffer, mode: number): void => {
  if ((mode & 0o700) === 0o700) return;
  const handle = openPathBeneath(dir, name);
  try {
    chmodFd(handle, 0o700);
  } finally {
    close(handle);
  }
};

const openOwned = (dir: number, name: Buffer): number => {
  grantOwner(dir, name, Number(lstatAt(dir, name).mode));
  return openDirectoryBeneath(dir, name);
};

// Deletes a directory and everything in it, by descriptor and without recursion: each directory
// found inside one is moved up beside it, into the directory removed, before that one is emptied.
// The walk never holds more than two directories open, whatever the depth of the tree the sandbox
// left, and reaches paths longer than the system accepts.
const removeDirectory = (path: string): void => {
  const parent = openDirectory(dirname(path));
  const name = Buffer.from(basename(path));
  try {
    const top = openOwned(parent, name);
    try {
      for (let entries = readdirAt(top); entries.length > 0; entries = readdirAt(top)) {
        for (const entry of entries) {
          if (!lstatAt(top, entry).isDirectory()) {
            unlinkAt(top, entry);
            continue;
          }
          const dir = openOwned(top, entry);
          try {
            for (const child of readdirAt(dir)) {
              const info = lstatAt(dir, child);
              if (info.isDirectory()) {
                grantOwner(dir, child, Number(info.mode));
                const moved = Buffer.from(`.removing-${randomBytes(8).toString('hex')}`);
                renameBeneath(dir, child, top, moved, RENAME_NOREPLACE);
              } else {
                unlinkAt(dir, child);
              }
            }
          } finally {
            close(dir);
          }
          rmdirAt(top, entry);
        }
      }
    } finally {
      close(top);
    }
    rmdirAt(parent, name);
  } finally {
    close(parent);
  }
};

// The lock of a session's directory, taken; null when another session holds it.
const lockDirectory = (path: string, create: boolean): number | null => {
  const dir = openDirectory(path);
  try {
    const flags = create
      ? constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
      : constants.O_RDONLY;
    // openat2 takes a mode only with O_CREAT.
    const lock = openBeneath(dir, LOCK, flags, create ? 0o600 : 0);
    if (tryLock(lock)) return lock;
    close(lock);
    return null;
  } finally {
    close(dir);
  }
};

// The directories of sessions that are gone, removed. Only the user's own, and never one in use:
// its lock is held, or its process runs, with the same id and start time. A directory without a
// lock is one being made, under its `.new` name, or one a session left before taking it; there
// the process decides, which within a PID namespace covers the moment before the lock. Returns
// what could not be removed.
const sweep = (runtime: string): string[] => {
  const failures: string[] = [];
  for (const name of readdirSync(runtime)) {
    const match = SESSION_NAME.exec(name);
    if (match === null) continue;
    const path = join(runtime, name);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info === undefined || !info.isDirectory() || info.uid !== process.getuid?.()) continue;
    if (processStart(Number(match[1])) === match[2]) continue;
    let lock: number | null = null;
    try {
      try {
        lock = lockDirectory(path, false);
        if (lock === null) continue;
      } catch (error) {
        // A directory without a lock is one whose session ended before taking it.
        if (!(error instanceof SysError && error.code === 'ENOENT')) throw error;
      }
      removeDirectory(path);
    } catch (error) {
      failures.push(
        `the directory of an earlier session, ${path}, could not be removed: ${errorMessage(error)}`,
      );
    } finally {
      if (lock !== null) close(lock);
    }
  }
  return failures;
};

// Directories of this process's sessions, with the descriptor of their lock: removed on exit when
// the session could not remove its own, as when the process ends on a signal.
const live = new Map<string, number>();
// Sandboxes started by this process: an interactive session starts one each time it applies or
// discards the changes.
let started = 0;

// Whether the directory is this process's, and not yet removed.
export const isLiveWorkspaceDirectory = (directory: WorkspaceDirectory): boolean =>
  live.has(directory.path);

export const removeWorkspaceDirectory = (directory: WorkspaceDirectory): void => {
  removeDirectory(directory.path);
  const lock = live.get(directory.path);
  live.delete(directory.path);
  if (lock !== undefined) close(lock);
};

// Called on exit, when the locks end with the process. A directory that cannot be removed then is
// removed by the next session.
export const removeLiveWorkspaceDirectories = (): void => {
  for (const path of live.keys()) {
    try {
      removeDirectory(path);
    } catch {
      // Left for the sweep of the next session.
    }
  }
  live.clear();
};

// Creates the directory of a new session, after removing those of sessions whose process is gone.
// The overlay keeps its markers in extended attributes of the user namespace, which tmpfs holds
// from Linux 6.6 on: without them, some operations in the sandbox would fail.
export const createWorkspaceDirectory = (
  env: Env,
): { directory: WorkspaceDirectory; warnings: string[] } | { error: string } => {
  const runtime = runtimeDirectory(env);
  if (typeof runtime !== 'string') return runtime;
  const warnings = sweep(runtime);
  const start = processStart(process.pid);
  if (start === null) return { error: 'the start time of this process cannot be read from /proc' };
  started += 1;
  const name = `${PREFIX}${process.pid}-${start}-${started}`;
  const path = join(runtime, name);
  const staging = `${path}.new`;
  try {
    mkdirSync(staging, { mode: 0o700 });
  } catch (error) {
    return { error: `cannot create the workspace directory ${staging}: ${errorMessage(error)}` };
  }
  let lock: number | null = null;
  try {
    lock = lockDirectory(staging, true);
    if (lock === null) throw new Error('its lock is held by another process');
    const dir = openDirectory(runtime);
    try {
      renameBeneath(dir, Buffer.from(`${name}.new`), dir, Buffer.from(name), RENAME_NOREPLACE);
    } finally {
      close(dir);
    }
  } catch (error) {
    if (lock !== null) close(lock);
    try {
      removeDirectory(staging);
    } catch {
      // Without its lock held, the next session's sweep removes it.
    }
    return { error: `cannot create the workspace directory ${path}: ${errorMessage(error)}` };
  }
  live.set(path, lock);
  const directory = { path, upper: join(path, 'upper'), work: join(path, 'work') };
  try {
    mkdirSync(directory.upper, { mode: 0o700 });
    mkdirSync(directory.work, { mode: 0o700 });
    setXattr(directory.upper, 'user.nullrivet', Buffer.alloc(0));
  } catch (error) {
    try {
      removeWorkspaceDirectory(directory);
    } catch {
      // Still listed as live, or left for the next session's sweep.
    }
    if (error instanceof SysError && (error.code === 'ENOTSUP' || error.code === 'EOPNOTSUPP')) {
      return {
        error: `the workspace sandbox needs extended attributes (user.*) in ${runtime}, which tmpfs supports from Linux 6.6`,
      };
    }
    return { error: `cannot prepare the workspace directory ${path}: ${errorMessage(error)}` };
  }
  return { directory, warnings };
};

const SECOND = 1_000_000_000n;

// How long the reference waits for the clock to move past the moment it is asked for: one step of
// the coarsest filesystem, FAT, with room to spare.
const CLOCK_WAIT_MS = 5_000;

// The time after which a change to the project is the host's: the change time of a file made
// right before the overlay is mounted, from the same clock as the project's own. A filesystem
// that keeps coarser times, as exFAT does in steps of 10 ms and FAT in steps of 2 s, stamps a
// change made later within one step with an earlier time. The step is taken from the project
// root's change time, the largest power of ten that divides it, and the reference moves back to
// the start of a step, of two seconds for whole seconds. On a filesystem with finer times the
// step found is small, and moving back by it only counts as changed what changed just before.
//
// The kernel stamps a change with the time of its last clock tick, so a change made just before
// the call, such as the application of an earlier sandbox's changes, can carry the probe's time
// and count as the host's. The reference is the first start of a step past the time of the call:
// every change made before the call comes before it. On a filesystem with coarse steps, this waits
// up to one step.
export const referenceTime = (directory: WorkspaceDirectory, projectRoot: string): bigint => {
  const probe = join(directory.path, 'reference');
  let writes = 0;
  const now = (): bigint => {
    writes += 1;
    writeFileSync(probe, String(writes));
    return statSync(probe, { bigint: true }).ctimeNs;
  };
  const root = statSync(projectRoot, { bigint: true }).ctimeNs;
  let step = SECOND;
  while (step > 1n && root % step !== 0n) step /= 10n;
  if (step === SECOND) step = 2n * SECOND;
  const called = now();
  const deadline = performance.now() + CLOCK_WAIT_MS;
  for (;;) {
    const time = now();
    const since = time - (time % step);
    if (since > called) return since;
    if (performance.now() > deadline) {
      throw new Error(`the clock did not move past ${called} within ${CLOCK_WAIT_MS} ms`);
    }
    Bun.sleepSync(1);
  }
};
