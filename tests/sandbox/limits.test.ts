import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLaunch, sandboxHost, sandboxProject } from '../../src/sandbox/bwrap.ts';
import {
  defaultLimits,
  type LimitedStart,
  type Limits,
  limitedLaunch,
  prepareLimits,
  scopeStart,
  userTasks,
} from '../../src/sandbox/limits.ts';
import { WorkerBackend } from '../../src/sandbox/worker-backend.ts';
import { BUILTIN_TOOLS } from '../../src/tools/index.ts';
import { cgroupTestsRun, sandboxTestsRun } from '../helpers/sandbox.ts';

describe('the resource limits', () => {
  test('take three quarters of the memory, in a size every page size divides', () => {
    expect(defaultLimits(16 * 1024 ** 3)).toEqual({
      tasks: 4096,
      memoryBytes: 12 * 1024 ** 3,
      cpuWeight: 20,
    });
    const odd = defaultLimits(1_000_003_000).memoryBytes;
    expect(odd % (64 * 1024)).toBe(0);
    expect(odd).toBeLessThanOrEqual(750_002_250);
    expect(odd).toBeGreaterThan(750_002_250 - 64 * 1024);
  });

  test('put the command after their own, and their environment beside the sandbox one', () => {
    const limited: LimitedStart = {
      how: 'cgroup',
      prefix: () => ['/usr/bin/systemd-run', '--user', '--scope', '--'],
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      warnings: [],
    };
    expect(
      limitedLaunch(
        { command: ['/usr/bin/bwrap', '--', 'worker'], env: { HOME: '/home/u' } },
        limited,
      ),
    ).toEqual({
      command: [
        '/usr/bin/systemd-run',
        '--user',
        '--scope',
        '--',
        '/usr/bin/bwrap',
        '--',
        'worker',
      ],
      env: { HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' },
    });
  });
});

describe.if(process.platform === 'linux')('the tasks of the user', () => {
  test('count the threads of every process of the user, this one included', () => {
    const own = Number(/^Threads:\s+(\d+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]);
    expect(own).toBeGreaterThan(0);
    expect(userTasks(process.getuid?.() ?? -1)).toBeGreaterThanOrEqual(own);
  });
});

// Small enough to reach in a test.
const TEST_LIMITS: Limits = { tasks: 64, memoryBytes: 256 * 1024 * 1024, cpuWeight: 20 };

// Forks until the kernel refuses, then prints how many children it had, and ends them.
const FORKS = `python3 - <<'EOF'
import os, time
children = []
for _ in range(200):
    try:
        pid = os.fork()
    except OSError:
        break
    if pid == 0:
        time.sleep(30)
        os._exit(0)
    children.append(pid)
print(len(children))
for pid in children:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
EOF`;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-limits-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const project = join(scratch, 'project');
mkdirSync(project);
const hostEnv = { PATH: process.env.PATH, HOME: join(scratch, 'home'), LANG: 'C.UTF-8' };
const TOOLS = BUILTIN_TOOLS.map((tool) => tool.name);
const bash = BUILTIN_TOOLS.find((tool) => tool.name === 'bash');

const backends: WorkerBackend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
});

const start = async (limited: LimitedStart): Promise<(command: string) => Promise<string>> => {
  const host = sandboxHost();
  if (typeof host === 'string') throw new Error(host);
  const resolved = await sandboxProject(project, hostEnv);
  if ('error' in resolved) throw new Error(resolved.error);
  const launch = inspectLaunch({
    host,
    root: resolved.root,
    cwd: resolved.cwd,
    home: resolved.home,
    hostEnv,
    tools: TOOLS,
    readOnlyDirs: [],
  });
  const backend = await WorkerBackend.start({
    launch: limitedLaunch(launch, limited),
    tools: TOOLS,
  });
  backends.push(backend);
  return async (command) => {
    if (bash === undefined) throw new Error('no bash tool');
    const result = await backend.execute(
      bash,
      { command },
      { cwd: project, signal: new AbortController().signal },
    );
    return result.content;
  };
};

// How many children python had, the first line of the tool's output.
const forked = async (sh: (command: string) => Promise<string>): Promise<number> => {
  const output = await sh(FORKS);
  const children = Number(output.split('\n')[0]);
  if (Number.isNaN(children)) throw new Error(`no count of children in: ${output}`);
  return children;
};

const scoped = cgroupTestsRun ? await prepareLimits(process.env, TEST_LIMITS) : null;

describe.if(cgroupTestsRun)('a scope of the service manager', () => {
  const bus = Object.fromEntries(
    ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const fakes = mkdtempSync(join(tmpdir(), 'nullrivet-systemd-run-'));
  afterAll(() => rmSync(fakes, { recursive: true, force: true }));
  let made = 0;
  // A systemd-run that runs `body` on its arguments, then passes them to the real one.
  const fake = (body: string): string => {
    made += 1;
    const path = join(fakes, `systemd-run-${made}`);
    writeFileSync(path, `#!/bin/sh\n${body}\nexec /usr/bin/systemd-run "$@"\n`, { mode: 0o755 });
    return path;
  };
  // One that refuses the arguments `pattern` matches, as an older one refuses what came after it.
  const refusing = (pattern: string): string =>
    fake(
      `for arg; do case $arg in ${pattern}) echo "unrecognized option: $arg" >&2; exit 1;; esac; done`,
    );
  // One that replaces an argument, as a manager that accepts a limit and holds another.
  const replacing = (from: string, to: string): string =>
    fake(
      `n=$#\nfor arg; do case $arg in ${from}) arg=${to};; esac; set -- "$@" "$arg"; done\nshift $n`,
    );
  const started = async (systemdRun: string, limits: Limits = TEST_LIMITS) => {
    const result = await scopeStart(systemdRun, limits, bus);
    if (!('prefix' in result)) throw new Error(result.problem);
    return result.prefix;
  };
  const problem = async (systemdRun: string): Promise<string> => {
    const result = await scopeStart(systemdRun, TEST_LIMITS, bus);
    return 'problem' in result ? result.problem : `started: ${result.prefix.join(' ')}`;
  };

  test("runs the sandbox's command as given: systemd-run expands nothing in it", async () => {
    const prefix = await started('/usr/bin/systemd-run');
    expect(prefix).toContain('--expand-environment=no');
    const echoed = Bun.spawnSync([...prefix, '/bin/echo', '${HOME} ${p%/*} $HOME'], { env: bus });
    expect(echoed.stdout.toString()).toBe('${HOME} ${p%/*} $HOME\n');
  });

  test('is started without what an older manager refuses, and with the rest', async () => {
    const before254 = await started(refusing('--expand-environment=*'));
    expect(before254).not.toContain('--expand-environment=no');
    expect(before254).toContain('OOMPolicy=continue');
    const before253 = await started(refusing('--expand-environment=* | OOMPolicy=*'));
    expect(before253.filter((arg) => /OOMPolicy|expand-environment/.test(arg))).toEqual([]);
    expect(before253.slice(-3)).toEqual(['-p', 'CPUWeight=20', '--']);
  });

  test('is not used when the manager refuses one of its limits', async () => {
    expect(await problem(refusing('MemoryMax=*'))).toBe(
      "the user's service manager did not start a scope: unrecognized option: MemoryMax=268435456",
    );
  });

  test('is not used when the manager takes a limit and does not hold it', async () => {
    // As a manager that does not delegate the memory controller: the property is accepted, and
    // the cgroup has no limit.
    expect(await problem(replacing('MemoryMax=*', 'MemoryMax=infinity'))).toBe(
      "a scope of the user's service manager does not hold the limits: memory.max is max instead of 268435456",
    );
  });

  test.if(existsSync('/sys/fs/cgroup/user.slice/memory.swap.max'))(
    'is not used when the manager leaves the swap unlimited',
    async () => {
      expect(await problem(replacing('MemorySwapMax=*', 'MemorySwapMax=infinity'))).toBe(
        "a scope of the user's service manager does not hold the limits: memory.swap.max is max instead of 0",
      );
    },
  );

  test('takes three quarters of the smallest memory limit above it, when that is less', async () => {
    // A slice of its own with a gigabyte, above the scope.
    const slice = `nullrivettest${process.pid}.slice`;
    const systemctl = (...args: string[]) =>
      Bun.spawnSync(['/usr/bin/systemctl', '--user', ...args], { env: bus });
    expect(systemctl('set-property', '--runtime', slice, 'MemoryMax=1G').exitCode).toBe(0);
    try {
      const prefix = await started(fake(`set -- --slice=${slice} "$@"`), {
        ...TEST_LIMITS,
        memoryBytes: 4 * 1024 ** 3,
      });
      expect(prefix).toContain(`MemoryMax=${0.75 * 1024 ** 3}`);
    } finally {
      systemctl('revert', slice);
      systemctl('stop', slice);
    }
  });
});

describe.if(cgroupTestsRun)('a sandbox in a scope of its own', () => {
  test('holds its tasks, all its processes and threads together', async () => {
    expect(scoped?.how).toBe('cgroup');
    const sh = await start(scoped as LimitedStart);
    const children = await forked(sh);
    // The worker's threads, the shell and python take their part of the 64.
    expect(children).toBeGreaterThan(10);
    expect(children).toBeLessThan(64);
  }, 30_000);

  test('kills a process that passes the memory, alone: the sandbox goes on', async () => {
    const sh = await start(scoped as LimitedStart);
    // The service manager learns of the kill after it: a policy that stops the scope would end the
    // sandbox within the second.
    const output = await sh(
      `python3 -c "b = b'x' * (512 * 1024 * 1024)"; echo "exit $?"; sleep 1; echo "a second after"`,
    );
    expect(output).toStartWith('exit 137\na second after\n');
    expect(await sh('echo still here')).toContain('still here');
  }, 30_000);
});

describe.if(sandboxTestsRun)('a sandbox without the service manager', () => {
  test('counts the tasks of the user at each start, not once for the session', async () => {
    const limited = await prepareLimits({}, TEST_LIMITS);
    const limit = () => Number(/^--nproc=(\d+):/.exec(limited.prefix()[1] ?? '')?.[1]);
    const before = limit();
    const sleeps = Array.from({ length: 50 }, () => Bun.spawn(['sleep', '30']));
    try {
      expect(limit() - before).toBeGreaterThanOrEqual(30);
    } finally {
      for (const sleep of sleeps) sleep.kill();
    }
  });

  test('holds its processes by RLIMIT_NPROC, and says that memory and CPU are not limited', async () => {
    // No way to the manager: the fallback, wherever the tests run.
    const limited = await prepareLimits({}, TEST_LIMITS);
    expect(limited.how).toBe('rlimit');
    expect(limited.warnings).toHaveLength(1);
    expect(limited.warnings[0]).toStartWith(
      "the sandbox's memory and CPU are not limited, only its processes: the user's service manager did not start a scope: ",
    );
    const sh = await start(limited);
    const children = await forked(sh);
    // The user's other tasks can start meanwhile and take from the 64 too.
    expect(children).toBeGreaterThan(0);
    expect(children).toBeLessThan(64);
  }, 30_000);
});
