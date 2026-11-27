import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { trustedExecutable } from './bwrap.ts';
import type { WorkerLaunch } from './worker-backend.ts';

// The resources a sandbox may take, so that a command that exhausts them, by design or by mistake,
// leaves the host usable. They protect the host's stability, not the boundary: one that cannot be
// put in force is a warning, not a reason to stop the session.
//
// With the user's service manager, the sandbox runs in a scope of its own: a cgroup that holds it
// whole, whatever namespaces it makes, with its tasks, its memory without swap, and a CPU weight
// below the default, which slows it only when the host needs the processors. When the sandbox
// passes its memory, the kernel kills its largest process, alone, and the manager leaves the others
// running. The values are checked as the kernel holds them, in a scope made the same way, before
// the first sandbox starts.
//
// Without the manager, only the processes are limited, by RLIMIT_NPROC. It counts every task of
// the user, the host's included, whatever namespace they run in: each sandbox gets the user's
// count at its start plus its own, under the user's current limit, which it never raises.

export interface Limits {
  // Processes and threads.
  tasks: number;
  memoryBytes: number;
  // Relative to the default of 100, under contention only.
  cpuWeight: number;
}

const MEMORY_SHARE = 0.75;
// A multiple of every page size, so the kernel holds the value as given.
const MEMORY_ALIGN = 64 * 1024;

// The limits of a sandbox on a host with `memory` bytes: three quarters of its memory, which
// leaves the rest to the host.
export const defaultLimits = (memory: number = totalmem()): Limits => ({
  tasks: 4096,
  memoryBytes: Math.floor((memory * MEMORY_SHARE) / MEMORY_ALIGN) * MEMORY_ALIGN,
  cpuWeight: 20,
});

// How a sandbox's command is started under its limits.
export interface LimitedStart {
  how: 'cgroup' | 'rlimit' | 'none';
  // What to put before a sandbox's command, made at each start: it runs the command in place of
  // itself, with its descriptors.
  prefix: () => string[];
  // For the started process alone: Bubblewrap clears its environment for the sandbox.
  env: Record<string, string>;
  // What is not limited, and why.
  warnings: string[];
}

const SYSTEMD_RUN_LOCATIONS = [
  '/usr/bin/systemd-run',
  '/bin/systemd-run',
  '/run/current-system/sw/bin/systemd-run',
];
const PRLIMIT_LOCATIONS = [
  '/usr/bin/prlimit',
  '/bin/prlimit',
  '/run/current-system/sw/bin/prlimit',
];
const SHELL = '/bin/sh';
const PROBE_TIMEOUT_MS = 5_000;
// What systemd-run needs to reach the user's service manager.
const BUS_VARIABLES = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];

// Prints the limits of the cgroup it runs in, one per line, with the shell's builtins only: absent
// for a controller the manager does not delegate.
const CGROUP_VALUES = [
  'while IFS= read -r line; do case $line in 0::*) path=${line#0::};; esac; done < /proc/self/cgroup',
  'cd "/sys/fs/cgroup$path" || exit 1',
  'for file in memory.max pids.max cpu.weight; do',
  '  if IFS= read -r value 2>/dev/null < "$file"; then echo "$value"; else echo absent; fi',
  'done',
].join('\n');

const found = (locations: readonly string[]): string | null => {
  for (const location of locations) {
    const real = trustedExecutable(location);
    if (real !== null) return real;
  }
  return null;
};

const scopeArgs = (systemdRun: string, limits: Limits, oomPolicy: boolean): string[] => [
  systemdRun,
  '--user',
  '--scope',
  '--quiet',
  '--collect',
  '-p',
  `TasksMax=${limits.tasks}`,
  '-p',
  `MemoryMax=${limits.memoryBytes}`,
  '-p',
  'MemorySwapMax=0',
  '-p',
  `CPUWeight=${limits.cpuWeight}`,
  ...(oomPolicy ? ['-p', 'OOMPolicy=continue'] : []),
  '--',
];

const run = (
  argv: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    const child = spawn(file as string, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      stderr = `no answer within ${PROBE_TIMEOUT_MS / 1000} s`;
      child.kill('SIGKILL');
    }, PROBE_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

const firstLine = (text: string): string => (text.trim().split('\n')[0] ?? '').slice(0, 300);

// Starts a scope of `systemdRun` with `limits` and reads them back from its cgroup: the command
// that starts a sandbox in such a scope when they hold, why not otherwise.
export const scopeStart = async (
  systemdRun: string,
  limits: Limits,
  env: Record<string, string>,
): Promise<{ prefix: string[] } | { problem: string }> => {
  const probe = async (oomPolicy: boolean) => {
    const prefix = scopeArgs(systemdRun, limits, oomPolicy);
    return { prefix, result: await run([...prefix, SHELL, '-c', CGROUP_VALUES], env) };
  };
  let { prefix, result } = await probe(true);
  // Scopes took OOMPolicy= in systemd 253. An older manager refuses it, and does not stop a scope
  // whose process the kernel killed either.
  if (result.code !== 0 && result.stderr.includes('OOMPolicy'))
    ({ prefix, result } = await probe(false));
  if (result.code !== 0) {
    return {
      problem: `the user's service manager did not start a scope: ${firstLine(result.stderr) || `exit code ${result.code}`}`,
    };
  }
  const expected = [limits.memoryBytes, limits.tasks, limits.cpuWeight].map(String);
  const held = result.stdout.trim().split('\n');
  if (held.join(' ') !== expected.join(' ')) {
    return {
      problem: `a scope of the user's service manager does not hold the limits: memory.max, pids.max and cpu.weight are ${held.join(', ')} instead of ${expected.join(', ')}`,
    };
  }
  return { prefix };
};

// The tasks, processes and threads, whose real user is `uid`, as RLIMIT_NPROC counts them.
export const userTasks = (uid: number): number => {
  let count = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let status: string;
    try {
      status = readFileSync(`/proc/${entry}/status`, 'utf8');
    } catch {
      // Ended meanwhile.
      continue;
    }
    const real = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    const threads = /^Threads:\s+(\d+)/m.exec(status)?.[1];
    if (real === String(uid) && threads !== undefined) count += Number(threads);
  }
  return count;
};

// This process's RLIMIT_NPROC, the soft one, which the user may have set below the hard one.
const taskLimit = (): number => {
  const line = readFileSync('/proc/self/limits', 'utf8')
    .split('\n')
    .find((row) => row.startsWith('Max processes'));
  const soft = line?.trim().split(/\s+/)[2];
  return soft === undefined || soft === 'unlimited' ? Number.POSITIVE_INFINITY : Number(soft);
};

// Decides how the sandboxes of a session are started under `limits`, once for the session.
export const prepareLimits = async (
  hostEnv: Record<string, string | undefined>,
  limits: Limits = defaultLimits(),
): Promise<LimitedStart> => {
  const env: Record<string, string> = {};
  for (const name of BUS_VARIABLES) {
    const value = hostEnv[name];
    if (value !== undefined) env[name] = value;
  }
  const systemdRun = found(SYSTEMD_RUN_LOCATIONS);
  const scope =
    systemdRun === null
      ? { problem: 'systemd-run is not installed in a system directory' }
      : await scopeStart(systemdRun, limits, env);
  if ('prefix' in scope) {
    const { prefix } = scope;
    return { how: 'cgroup', prefix: () => prefix, env, warnings: [] };
  }
  const prlimit = found(PRLIMIT_LOCATIONS);
  const uid = process.getuid?.();
  if (prlimit === null || uid === undefined) {
    return {
      how: 'none',
      prefix: () => [],
      env: {},
      warnings: [
        `the sandbox's resources are not limited: ${scope.problem}, and prlimit is not installed in a system directory`,
      ],
    };
  }
  return {
    how: 'rlimit',
    // Counted at each start: the user's tasks change during a session.
    prefix: () => {
      const tasks = Math.min(userTasks(uid) + limits.tasks, taskLimit());
      return [prlimit, `--nproc=${tasks}:${tasks}`, '--'];
    },
    env: {},
    warnings: [
      `the sandbox's memory and CPU are not limited, only its processes: ${scope.problem}`,
    ],
  };
};

// `launch` started under `limited`.
export const limitedLaunch = (launch: WorkerLaunch, limited: LimitedStart): WorkerLaunch => ({
  ...launch,
  command: [...limited.prefix(), ...launch.command],
  env: { ...launch.env, ...limited.env },
});
