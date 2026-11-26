import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
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

// The arguments that enter the user and network namespaces of `pid` with their capabilities: the
// user's credentials are kept, since setting groups is refused in a user namespace, and so are the
// capabilities the namespace grants, which an exec would otherwise drop.
export const enterArgs = (tools: NetworkTools, pid: number, net = true): string[] => [
  tools.nsenter,
  `--user=/proc/${pid}/ns/user`,
  ...(net ? [`--net=/proc/${pid}/ns/net`] : []),
  '--preserve-credentials',
  '--keep-caps',
  '--',
];

// The whole environment of a helper: the host's holds provider keys, which none of them needs.
export const HELPER_ENV: Record<string, string> = { PATH: '/usr/bin:/usr/sbin:/bin:/sbin' };

const HELPER_TIMEOUT_MS = 10_000;
const SHOWN_ERROR_CHARS = 500;
const MAX_OUTPUT_CHARS = 1024 * 1024;

// Runs a program in the namespaces of `pid`, with `input` on its stdin, and resolves with its
// output; rejects with its error output when it fails or does not end within the timeout.
export const runInNamespaces = (
  tools: NetworkTools,
  pid: number,
  argv: readonly string[],
  input = '',
): Promise<string> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = [...enterArgs(tools, pid), ...argv];
    const child = spawn(file as string, args, { stdio: ['pipe', 'pipe', 'pipe'], env: HELPER_ENV });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < SHOWN_ERROR_CHARS) stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), HELPER_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const how = signal === null ? `code ${code}` : signal;
        reject(
          new Error(`${argv[0]} failed (${how}): ${stderr.trim().slice(0, SHOWN_ERROR_CHARS)}`),
        );
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
