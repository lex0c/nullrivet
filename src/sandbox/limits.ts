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
  // An absolute bound, in percent of one CPU, whatever else runs; absent, none.
  cpuQuotaPercent?: number;
}

const MEMORY_SHARE = 0.75;
// A multiple of every page size, so the kernel holds the value as given.
const MEMORY_ALIGN = 64 * 1024;

const aligned = (bytes: number): number => Math.floor(bytes / MEMORY_ALIGN) * MEMORY_ALIGN;

// The limits of a sandbox on a host with `memory` bytes: three quarters of its memory, which
// leaves the rest to the host.
export const defaultLimits = (memory: number = totalmem()): Limits => ({
  tasks: 4096,
  memoryBytes: aligned(memory * MEMORY_SHARE),
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
  // With the cgroup way only: what starts a helper in a scope of its own, named `unit`, with
  // `limits`, made with what the manager accepted.
  scope?: (unit: string, limits: Limits) => string[];
  // With the cgroup way only: the memory the sandbox's scope holds, as read back from its cgroup.
  memoryBytes?: number;
  // With the cgroup way only: the env program that starts the sandbox with its own environment
  // alone. systemd-run runs it with the variables that reach the manager, and its own, which the
  // sandbox's first process would otherwise keep, readable in /proc/1/environ.
  clean?: string;
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
const ENV_LOCATIONS = ['/usr/bin/env', '/bin/env', '/run/current-system/sw/bin/env'];
const PROBE_TIMEOUT_MS = 5_000;
// What systemd-run needs to reach the user's service manager.
const BUS_VARIABLES = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];

// The limits the cgroup at `path` holds: absent for a file it does not have.
export const cgroupLimits = (path: string): Map<string, string> => {
  const held = new Map<string, string>();
  for (const name of ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.weight', 'cpu.max']) {
    try {
      held.set(name, readFileSync(`/sys/fs/cgroup${path}/${name}`, 'utf8').trim());
    } catch {
      held.set(name, 'absent');
    }
  }
  return held;
};

// What `held` lacks of `limits`; empty when it holds them. A kernel that does not account swap to
// cgroups has no memory.swap.max: no limit is possible there, and none is needed on a host
// without swap.
export const missingLimits = (held: ReadonlyMap<string, string>, limits: Limits): string[] => {
  const expected: [string, string][] = [
    ['memory.max', String(limits.memoryBytes)],
    ['pids.max', String(limits.tasks)],
    ['cpu.weight', String(limits.cpuWeight)],
  ];
  if (held.get('memory.swap.max') !== 'absent') expected.push(['memory.swap.max', '0']);
  // The manager's period is 100 ms: a quota of n percent is n thousand microseconds of it.
  if (limits.cpuQuotaPercent !== undefined) {
    expected.push(['cpu.max', `${limits.cpuQuotaPercent * 1000} 100000`]);
  }
  return expected
    .filter(([name, value]) => held.get(name) !== value)
    .map(([name, value]) => `${name} is ${held.get(name) ?? 'not read'} instead of ${value}`);
};

// Prints the limits of the cgroup it runs in, as name=value, with the shell's builtins only:
// absent for a controller the manager does not delegate, or swap the kernel does not account. Then
// the memory limit of each cgroup above it, which bounds its own.
const CGROUP_VALUES = [
  'while IFS= read -r line; do case $line in 0::*) path=${line#0::};; esac; done < /proc/self/cgroup',
  'cd "/sys/fs/cgroup$path" || exit 1',
  'for file in memory.max memory.swap.max pids.max cpu.weight; do',
  '  if IFS= read -r value 2>/dev/null < "$file"; then echo "$file=$value"; else echo "$file=absent"; fi',
  'done',
  'parent=$path',
  'while [ -n "$parent" ]; do',
  '  parent=${parent%/*}',
  '  if IFS= read -r value 2>/dev/null < "/sys/fs/cgroup$parent/memory.max"; then echo "parent=$value"; fi',
  'done',
].join('\n');

const found = (locations: readonly string[]): string | null => {
  for (const location of locations) {
    const real = trustedExecutable(location);
    if (real !== null) return real;
  }
  return null;
};

// What a newer manager has, each left out for an older one that refuses it: scopes took
// OOMPolicy= in systemd 253, and systemd-run --expand-environment came in 254. Without the first,
// a manager ends the whole scope after the kernel kills one of its processes; without the second,
// systemd-run replaces ${...} in the sandbox's command line with its own environment, paths and
// values of the sandbox's environment included. An older manager does neither.
const OPTIONAL = [
  { name: 'OOMPolicy', args: ['-p', 'OOMPolicy=continue'] },
  { name: 'expand-environment', args: ['--expand-environment=no'] },
] as const;

type Optional = (typeof OPTIONAL)[number];

const scopeArgs = (
  systemdRun: string,
  limits: Limits,
  optional: readonly Optional[],
  unit?: string,
): string[] => [
  systemdRun,
  '--user',
  '--scope',
  '--quiet',
  '--collect',
  ...(unit === undefined ? [] : [`--unit=${unit}`]),
  '-p',
  `TasksMax=${limits.tasks}`,
  '-p',
  `MemoryMax=${limits.memoryBytes}`,
  '-p',
  'MemorySwapMax=0',
  '-p',
  `CPUWeight=${limits.cpuWeight}`,
  ...(limits.cpuQuotaPercent === undefined ? [] : ['-p', `CPUQuota=${limits.cpuQuotaPercent}%`]),
  ...optional.flatMap((option) => option.args),
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

const hostHasSwap = (): boolean =>
  Number(/^SwapTotal:\s+(\d+)/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) > 0;

type ScopeStart =
  | { prefix: string[]; warnings: string[]; optional: readonly Optional[]; memoryBytes: number }
  | { problem: string };

// Starts a scope of `systemdRun` with `limits` and reads them back from its cgroup: the command
// that starts a sandbox in such a scope when they hold, why not otherwise. The memory is lowered to
// three quarters of the smallest limit above the scope, when that is less, and read back again.
export const scopeStart = async (
  systemdRun: string,
  limits: Limits,
  env: Record<string, string>,
  // Taken from the memory, whatever limits it: what a helper of the session gets in a scope of
  // its own.
  reserveBytes = 0,
): Promise<ScopeStart> => {
  const attempt = async (wanted: Limits) => {
    let optional: readonly Optional[] = OPTIONAL;
    for (;;) {
      const prefix = scopeArgs(systemdRun, wanted, optional);
      const result = await run([...prefix, SHELL, '-c', CGROUP_VALUES], env);
      const refused = optional.find(
        (option) => result.code !== 0 && result.stderr.includes(option.name),
      );
      if (refused === undefined) return checked(wanted, prefix, optional, result);
      optional = optional.filter((option) => option !== refused);
    }
  };
  const wanted = { ...limits, memoryBytes: limits.memoryBytes - reserveBytes };
  const first = await attempt(wanted);
  if ('problem' in first) return first;
  const parents = Math.min(...first.parents);
  const fitted = aligned(parents * MEMORY_SHARE - reserveBytes);
  if (fitted >= wanted.memoryBytes) return first;
  return attempt({ ...limits, memoryBytes: fitted });
};

const checked = (
  limits: Limits,
  prefix: string[],
  optional: readonly Optional[],
  result: { code: number | null; stdout: string; stderr: string },
): (ScopeStart & { prefix: string[]; parents: number[] }) | { problem: string } => {
  if (result.code !== 0) {
    return {
      problem: `the user's service manager did not start a scope: ${firstLine(result.stderr) || `exit code ${result.code}`}`,
    };
  }
  const held = new Map<string, string>();
  const parents: number[] = [];
  for (const line of result.stdout.trim().split('\n')) {
    const at = line.indexOf('=');
    const [name, value] = [line.slice(0, at), line.slice(at + 1)];
    if (name !== 'parent') held.set(name, value);
    else if (/^\d+$/.test(value)) parents.push(Number(value));
  }
  const swap = held.get('memory.swap.max');
  const wrong = missingLimits(held, limits);
  if (wrong.length > 0) {
    return {
      problem: `a scope of the user's service manager does not hold the limits: ${wrong.join('; ')}`,
    };
  }
  const warnings =
    swap === 'absent' && hostHasSwap()
      ? ["the sandbox's swap is not limited: the kernel does not account swap to cgroups"]
      : [];
  return { prefix, warnings, optional, parents, memoryBytes: limits.memoryBytes };
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
  // Memory kept for a helper in a scope of its own, out of the sandbox's.
  reserveBytes = 0,
): Promise<LimitedStart> => {
  const env: Record<string, string> = {};
  for (const name of BUS_VARIABLES) {
    const value = hostEnv[name];
    if (value !== undefined) env[name] = value;
  }
  const systemdRun = found(SYSTEMD_RUN_LOCATIONS);
  const clean = found(ENV_LOCATIONS);
  const scope =
    systemdRun === null
      ? { problem: 'systemd-run is not installed in a system directory' }
      : clean === null
        ? { problem: 'env is not installed in a system directory' }
        : await scopeStart(systemdRun, limits, env, reserveBytes);
  if ('prefix' in scope) {
    const { prefix, optional } = scope;
    const run = systemdRun as string;
    return {
      how: 'cgroup',
      prefix: () => prefix,
      memoryBytes: scope.memoryBytes,
      env,
      warnings: scope.warnings,
      scope: (unit, helperLimits) => scopeArgs(run, helperLimits, optional, unit),
      clean: clean as string,
    };
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
  command: [
    ...limited.prefix(),
    ...(limited.clean === undefined
      ? []
      : [
          limited.clean,
          '-i',
          ...Object.entries(launch.env).map(([name, value]) => `${name}=${value}`),
        ]),
    ...launch.command,
  ],
  env: { ...launch.env, ...limited.env },
});
