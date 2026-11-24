import { accessSync, constants, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { isWithinDirectory } from '../tools/paths.ts';
import { HOST_TO_WORKER_FD, WORKER_TO_HOST_FD } from './protocol.ts';
import { type SyscallArch, sandboxArch, seccompProgram } from './seccomp.ts';
import type { WorkerLaunch } from './worker-backend.ts';
import { workerCommand, workerFiles } from './worker-command.ts';

type Env = Record<string, string | undefined>;

// A fixed list: the host's PATH may hold relative entries, which inside the sandbox would resolve
// against the project and run a program planted there.
const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin';
const TMP_BYTES = 1024 * 1024 * 1024;
const HOME_BYTES = 256 * 1024 * 1024;
const ROOT_LINKS = ['/bin', '/sbin', '/lib', '/lib64', '/lib32'];
const ETC_FILES = ['/etc/ld.so.cache', '/etc/alternatives'];
// Kernel keyring listings; the keys themselves are out of reach through the seccomp program.
const MASKED_PROC_FILES = ['/proc/keys', '/proc/key-users'];
// The launcher inputs follow the protocol descriptors.
const FIRST_INPUT_FD = Math.max(HOST_TO_WORKER_FD, WORKER_TO_HOST_FD) + 1;

// Only absolute entries are searched: a relative one would find a bwrap planted in the project.
export const findBwrap = (env: Env): string | null => {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, 'bwrap');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
};

export interface SandboxHost {
  bwrap: string;
  arch: SyscallArch;
}

// What the host needs for a sandbox profile, or why it cannot have one.
export const sandboxHost = (env: Env): SandboxHost | string => {
  if (process.platform !== 'linux') return 'sandbox profiles need Linux, where they use Bubblewrap';
  const arch = sandboxArch();
  if (arch === null) return `sandbox profiles support x86_64 and arm64, not ${process.arch}`;
  const bwrap = findBwrap(env);
  if (bwrap === null) return 'sandbox profiles need Bubblewrap (bwrap), which is not on PATH';
  return { bwrap, arch };
};

const realpathOrNull = async (path: string | undefined): Promise<string | null> => {
  if (path === undefined || path.length === 0 || !isAbsolute(path)) return null;
  try {
    return await realpath(path);
  } catch {
    return null;
  }
};

const accountHome = (): string | undefined => {
  try {
    return userInfo().homedir;
  } catch {
    // No account entry for this user, as in some containers: HOME is the only home there is.
    return undefined;
  }
};

// The directory the sandbox exposes: the nearest ancestor of the working directory with a .git
// entry, or the working directory itself, with symbolic links resolved. A .git that is a file
// (a worktree or a submodule) is not followed: a repository could point it anywhere. The root
// is refused when it is the home directory or above it, or when it contains a directory of
// sockets and session files: binding it would expose them.
export const sandboxProject = async (
  cwd: string,
  env: Env,
): Promise<{ root: string; cwd: string; home: string } | { error: string }> => {
  const real = await realpathOrNull(cwd);
  if (real === null) return { error: `cannot resolve the working directory ${cwd}` };
  let root = real;
  for (let dir = real; ; dir = dirname(dir)) {
    try {
      await lstat(join(dir, '.git'));
      root = dir;
      break;
    } catch {
      // No repository here.
    }
    if (dirname(dir) === dir) break;
  }
  const home = (await realpathOrNull(env.HOME)) ?? (await realpathOrNull(homedir()));
  if (home === null) return { error: 'cannot resolve the home directory' };
  const refuse = (what: string) => ({
    error: `the sandbox cannot expose ${root}: it contains ${what}. Start nullrivet in a directory that does not, such as the project's own.`,
  });
  if (root === '/') return refuse('the whole filesystem');
  // HOME can name another directory than the account's, whose files are the user's all the same.
  for (const dir of [home, await realpathOrNull(accountHome())]) {
    if (dir !== null && isWithinDirectory(root, dir)) return refuse(`the home directory ${dir}`);
  }
  const agent = env.SSH_AUTH_SOCK === undefined ? undefined : dirname(env.SSH_AUTH_SOCK);
  const sensitive = [
    '/tmp',
    '/run',
    '/var/run',
    '/var/run/docker.sock',
    env.XDG_RUNTIME_DIR,
    agent,
  ];
  for (const path of sensitive) {
    const resolved = await realpathOrNull(path);
    if (resolved !== null && isWithinDirectory(root, resolved)) return refuse(resolved);
  }
  return { root, cwd: real, home };
};

const groupName = (gid: number, fallback: string): string => {
  try {
    for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
      const [name, , id] = line.split(':');
      if (name !== undefined && id === String(gid)) return name;
    }
  } catch {
    // Without the host's group file, the user's name serves.
  }
  return fallback;
};

// Only root and the user: the host's files list every account on the system.
const identityFiles = (home: string): { passwd: string; group: string } => {
  const user = userInfo();
  const name = user.username.replace(/[:\n]/g, '');
  const shell = user.shell !== null && user.shell.length > 0 ? user.shell : '/bin/sh';
  const group = groupName(user.gid, name).replace(/[:\n]/g, '');
  return {
    passwd: `root:x:0:0:root:/root:/usr/sbin/nologin\n${name}:x:${user.uid}:${user.gid}:${name}:${home}:${shell}\n`,
    group: `root:x:0:\n${group}:x:${user.gid}:\n`,
  };
};

const HOSTS = '127.0.0.1 localhost\n::1 localhost\n';
const NSSWITCH = 'passwd: files\ngroup: files\nhosts: files\n';

// Built from nothing: the host's environment holds provider keys and other credentials.
// bubblewrap is started with it too, because its init process keeps the environment it was
// started with, readable from the sandbox through /proc/1/environ.
export const sandboxEnv = (host: Env, home: string): Record<string, string> => {
  const env: Record<string, string> = { PATH: SANDBOX_PATH, HOME: home, TMPDIR: '/tmp' };
  for (const [key, value] of Object.entries(host)) {
    if (value === undefined) continue;
    if (
      key === 'USER' ||
      key === 'LOGNAME' ||
      key === 'LANG' ||
      key === 'TZ' ||
      key.startsWith('LC_')
    ) {
      env[key] = value;
    }
  }
  return env;
};

// A host path as the host has it: a link with the same target, or the file or directory bound
// read-only. Nothing when it is absent, as /lib32 is on most distributions and /etc/localtime
// without a configured time zone, where the sandbox uses UTC.
const hostEntryArgs = (path: string): string[] => {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return ['--symlink', readlinkSync(path), path];
    if (info.isDirectory() || info.isFile()) return ['--ro-bind', path, path];
  } catch {
    // Absent on this host.
  }
  return [];
};

export interface InspectOptions {
  host: SandboxHost;
  root: string;
  cwd: string;
  home: string;
  hostEnv: Env;
  tools: readonly string[];
  // Directories the host writes and the worker reads, such as subagent reports.
  readOnlyDirs: readonly string[];
}

// The `inspect` profile: the project and the system read-only, a temporary home and /tmp, no
// network, no host processes, and only the worker's own files besides.
export const inspectLaunch = (options: InspectOptions): WorkerLaunch => {
  const env = sandboxEnv(options.hostEnv, options.home);
  const identity = identityFiles(options.home);
  const inputs = [identity.passwd, identity.group, HOSTS, NSSWITCH].map((text) =>
    Buffer.from(text),
  );
  const seccompFd = FIRST_INPUT_FD + inputs.length;
  const fd = (index: number): string => String(FIRST_INPUT_FD + index);
  const args = [
    '--unshare-all',
    // Explicit: --unshare-all only tries a user namespace, and --disable-userns needs one.
    '--unshare-user',
    '--disable-userns',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    ...Object.entries(env).flatMap(([key, value]) => ['--setenv', key, value]),
    '--ro-bind',
    '/usr',
    '/usr',
    ...ROOT_LINKS.flatMap(hostEntryArgs),
    ...ETC_FILES.flatMap((path) => ['--ro-bind-try', path, path]),
    '--ro-bind-data',
    fd(0),
    '/etc/passwd',
    '--ro-bind-data',
    fd(1),
    '/etc/group',
    '--ro-bind-data',
    fd(2),
    '/etc/hosts',
    '--ro-bind-data',
    fd(3),
    '/etc/nsswitch.conf',
    ...hostEntryArgs('/etc/localtime'),
    '--proc',
    '/proc',
    ...MASKED_PROC_FILES.flatMap((path) => ['--ro-bind', '/dev/null', path]),
    '--dev',
    '/dev',
    '--size',
    String(TMP_BYTES),
    '--tmpfs',
    '/tmp',
    '--size',
    String(HOME_BYTES),
    '--tmpfs',
    options.home,
    '--ro-bind',
    options.root,
    options.root,
    ...workerFiles().flatMap((path) => ['--ro-bind', path, path]),
    ...options.readOnlyDirs.flatMap((path) => ['--ro-bind', path, path]),
    '--seccomp',
    String(seccompFd),
    '--chdir',
    options.cwd,
    '--remount-ro',
    '/',
  ];
  return {
    command: [options.host.bwrap, ...args, '--', ...workerCommand(options.tools)],
    env,
    inputs: [...inputs, seccompProgram(options.host.arch)],
  };
};
