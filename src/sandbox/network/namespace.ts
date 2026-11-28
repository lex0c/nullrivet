import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { trustedExecutable } from '../bwrap.ts';

// The user and network namespaces of a sandbox with a network scope. The host makes them, with
// the user's id mapped to their root, and runs Bubblewrap in them, which puts the sandbox in a
// user namespace of its own, nested, without capabilities. The host, as the namespaces' owner,
// holds every capability over them; nothing in the sandbox does: it cannot change the ruleset or
// the namespace's settings, nor make a namespace of its own. A mapped root is what allows the
// host to set the namespace's sysctls, which belong to it: the ping group range, without which
// ICMP echo needs raw sockets.
//
// The host process never joins them: helpers do, each started for one operation, so the agent
// loop and the providers keep the host's network.

export interface NetworkTools {
  unshare: string;
  nsenter: string;
  nft: string;
  pasta: string;
  sh: string;
}

const locations = (name: string): string[] => [
  `/usr/bin/${name}`,
  `/usr/sbin/${name}`,
  `/bin/${name}`,
  `/sbin/${name}`,
  `/usr/local/bin/${name}`,
];

// Whether `path` is a directory that root owns, as are those above it, that no one else can write
// to unless it is sticky.
const rootDirectory = (path: string): boolean => {
  try {
    for (let level = realpathSync(path); ; level = dirname(level)) {
      const info = lstatSync(level);
      const writable = (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0;
      if (!info.isDirectory() || info.uid !== 0 || writable) return false;
      if (dirname(level) === level) return true;
    }
  } catch {
    return false;
  }
};

// A program at `location` that can be run by that name: the file it leads to is trusted, and the
// name itself, a link or the file, belongs to root in a directory that only root changes.
const runnable = (location: string): boolean => {
  if (trustedExecutable(location) === null) return false;
  try {
    return lstatSync(location).uid === 0 && rootDirectory(dirname(location));
  } catch {
    return false;
  }
};

// The programs the scope needs, each a root-owned file under root-owned directories that no one
// else can write to, or why one is missing.
export const networkTools = (): NetworkTools | string => {
  const found: Partial<NetworkTools> = {};
  for (const name of ['unshare', 'nsenter', 'nft', 'pasta', 'sh'] as const) {
    // pasta is passt run under the name pasta, often a link to it: the name chooses its mode, so
    // it is run by the name checked, not by the file the link leads to.
    const path = locations(name).find(runnable);
    if (path === undefined) {
      return name === 'pasta'
        ? 'the network scope needs passt (pasta), installed in a system directory'
        : `the network scope needs ${name}, installed in a system directory`;
    }
    found[name] = path;
  }
  return found as NetworkTools;
};

// The command that runs `command` in new user and network namespaces, with the user mapped to
// their root. The network namespace has only its loopback interface until pasta connects it.
export const inNewNamespaces = (tools: NetworkTools, command: readonly string[]): string[] => [
  tools.unshare,
  '--user',
  '--map-root-user',
  '--net',
  '--',
  ...command,
];

// The user and network namespaces a sandbox's network is configured in, held open by this process
// for as long as the network lives. A helper enters them by these descriptors, which name the same
// namespaces whatever happens to the process they were taken from and to its id. pasta refuses
// such a path, so it is given the process's own, checked against them right before it starts.
export interface Namespaces {
  pid: number;
  user: number;
  net: number;
}

// Opens the user and network namespaces of `pid`, which must not be this process's: until the
// process has made them, they are the host's.
export const pinNamespaces = (pid: number): Namespaces => {
  const opened: number[] = [];
  try {
    for (const kind of ['user', 'net']) {
      const named = readlinkSync(`/proc/${pid}/ns/${kind}`);
      if (named === readlinkSync(`/proc/self/ns/${kind}`)) {
        throw new Error(`process ${pid} runs in the host's ${kind} namespace`);
      }
      const fd = openSync(`/proc/${pid}/ns/${kind}`, 'r');
      opened.push(fd);
      // The process can end between the two, and its id go to another.
      if (`${kind}:[${fstatSync(fd).ino}]` !== named) {
        throw new Error(`the ${kind} namespace of process ${pid} changed while it was opened`);
      }
    }
  } catch (error) {
    for (const fd of opened) closeSync(fd);
    throw error;
  }
  const [user, net] = opened as [number, number];
  return { pid, user, net };
};

export const releaseNamespaces = (namespaces: Namespaces): void => {
  closeSync(namespaces.user);
  closeSync(namespaces.net);
};

// Whether the process the namespaces were taken from still runs in the network namespace pinned.
export const holdsNetwork = (namespaces: Namespaces): boolean => {
  try {
    return (
      readlinkSync(`/proc/${namespaces.pid}/ns/net`) === `net:[${fstatSync(namespaces.net).ino}]`
    );
  } catch {
    return false;
  }
};

const pinned = (fd: number): string => `/proc/${process.pid}/fd/${fd}`;

// The arguments that enter the namespaces with their capabilities. The user's credentials are
// kept, since setting groups is refused in a user namespace; they are its root, which keeps every
// capability of the namespace across the helper's exec.
export const enterArgs = (tools: NetworkTools, namespaces: Namespaces, net = true): string[] => [
  tools.nsenter,
  `--user=${pinned(namespaces.user)}`,
  ...(net ? [`--net=${pinned(namespaces.net)}`] : []),
  '--preserve-credentials',
  '--',
];

// The whole environment of a helper: the host's holds provider keys, which none of them needs. nft
// reads and lists the times of a window in the zone TZ names, which the ruleset writes in UTC.
export const HELPER_ENV: Record<string, string> = {
  PATH: '/usr/bin:/usr/sbin:/bin:/sbin',
  TZ: 'UTC',
};

const HELPER_TIMEOUT_MS = 10_000;
export const GIVEN_UP = 'the preparation of the network was given up';

// Kills a helper with every process it started: they run in a group of their own, and one left
// alive would hold the helper's output open, so that it would not be seen to end.
export const killHelper = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // ESRCH: the group has ended.
  }
};
const SHOWN_ERROR_CHARS = 500;
// A listing of a scope of many networks runs to megabytes.
const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;

// Runs a program in the namespaces, with `input` on its stdin, and resolves with its output; rejects
// with its error output when it fails, does not end within the timeout, or `signal` gives it up, which
// kills it at once.
export const runInNamespaces = (
  tools: NetworkTools,
  namespaces: Namespaces,
  argv: readonly string[],
  input = '',
  signal?: AbortSignal,
): Promise<string> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error(GIVEN_UP));
      return;
    }
    const [file, ...args] = [...enterArgs(tools, namespaces), ...argv];
    const child = spawn(file as string, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: HELPER_ENV,
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < SHOWN_ERROR_CHARS) stderr += chunk.toString();
    });
    const timer = setTimeout(() => killHelper(child), HELPER_TIMEOUT_MS);
    const giveUp = (): void => killHelper(child);
    signal?.addEventListener('abort', giveUp, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
      reject(error);
    });
    // After its output streams closed: the exit can come before their last data.
    child.once('close', (code, ended) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
      if (code === 0) resolve(stdout);
      else if (signal?.aborted === true) reject(new Error(GIVEN_UP));
      else {
        const how = ended === null ? `code ${code}` : ended;
        reject(
          new Error(`${argv[0]} failed (${how}): ${stderr.trim().slice(0, SHOWN_ERROR_CHARS)}`),
        );
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
