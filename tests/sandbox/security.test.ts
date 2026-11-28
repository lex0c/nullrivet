import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { networkInterfaces, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeToolCall, type ToolExecutionContext } from '../../src/agent/tool-broker.ts';
import { type LaunchOptions, sandboxHost, sandboxProject } from '../../src/sandbox/bwrap.ts';
import { sha256 } from '../../src/sandbox/evidence.ts';
import { verifyEvidence } from '../../src/sandbox/evidence-verify.ts';
import {
  enterArgs,
  type NetworkTools,
  networkTools,
  pinNamespaces,
  releaseNamespaces,
  runInNamespaces,
} from '../../src/sandbox/network/namespace.ts';
import { ScopeProxy } from '../../src/sandbox/network/proxy.ts';
import type { ProxyFactory } from '../../src/sandbox/network/proxy-process.ts';
import {
  type SecurityOptions,
  SecuritySession,
  verifyLauncher,
} from '../../src/sandbox/security.ts';
import { BUILTIN_TOOLS } from '../../src/tools/index.ts';
import { createJobTools } from '../../src/tools/jobs.ts';
import type { Tool } from '../../src/tools/types.ts';
import { captureClientHello } from '../helpers/client-hello.ts';
import {
  cgroupTestsRun,
  networkTestsRun,
  overlayTestsRun,
  sandboxTestsRun,
  vmTestsRun,
} from '../helpers/sandbox.ts';

const linux = process.platform === 'linux';
const runs = overlayTestsRun && networkTestsRun && cgroupTestsRun;

describe.if(linux && sandboxTestsRun)('the launcher of a security sandbox', () => {
  test('must be the parent of the process it reports, in its network namespace', async () => {
    const tools = networkTools();
    if (typeof tools === 'string') throw new Error(tools);
    const holders = [0, 1].map(() =>
      spawn(tools.unshare, ['--user', '--map-root-user', '--net', '--', 'sleep', '30'], {
        stdio: 'ignore',
      }),
    );
    try {
      await Bun.sleep(200);
      const [a, b] = holders.map((holder) => holder.pid as number) as [number, number];
      expect(() => verifyLauncher(a, `{"child-pid": ${b}}`)).toThrow(
        `the sandbox's namespaces are not those its launcher made: process ${b} is not a child of ${a}`,
      );
      expect(() => verifyLauncher(a, 'not json')).toThrow('the launcher reported no process');
      expect(() => verifyLauncher(a, '{"child-pid": -1}')).toThrow(
        'the launcher reported no process',
      );
    } finally {
      for (const holder of holders) holder.kill('SIGKILL');
    }
  });
});

const hostAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)?.address;
// The sandbox's address and gateway, so that the host's own address is another machine's to it.
const ADDRESS = { address: '10.0.2.15', prefix: 24, gateway: '10.0.2.2' };

const ALL_TOOLS: Tool[] = [...BUILTIN_TOOLS, ...createJobTools(null, 'one-shot')];
const TOOLS = ALL_TOOLS.map((tool) => tool.name);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-security-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const project = join(scratch, 'project');
mkdirSync(project);
writeFileSync(join(project, 'notes.txt'), 'project notes\n');

const sessions: SecuritySession[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const server of servers.splice(0)) server.close();
}, 30_000);

const listening = async (): Promise<number> => {
  const server = createServer((socket) => {
    socket.on('data', () => socket.end('ok'));
    socket.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  return (server.address() as { port: number }).port;
};

let files = 0;
const engagementFile = (value: unknown): string => {
  files += 1;
  const path = join(scratch, `engagement-${files}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

const launchOptions = async (): Promise<SecurityOptions['launch'] & LaunchOptions> => {
  const host = sandboxHost();
  if (typeof host === 'string') throw new Error(host);
  const resolved = await sandboxProject(project, { HOME: join(scratch, 'home') });
  if ('error' in resolved) throw new Error(resolved.error);
  return {
    host,
    root: resolved.root,
    cwd: resolved.cwd,
    home: resolved.home,
    hostEnv: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    tools: TOOLS,
    readOnlyDirs: [],
    jobs: 'one-shot',
  };
};

interface Started {
  session: SecuritySession;
  notices: string[];
  run: (name: string, input: Record<string, unknown>) => Promise<string>;
}

const start = async (
  engagement: unknown,
  overrides: Partial<SecurityOptions> = {},
): Promise<Started> => {
  const launch = await launchOptions();
  const notices: string[] = [];
  const started = await SecuritySession.start({
    host: launch.host,
    launch,
    env: process.env,
    engagementPath: engagementFile(engagement),
    notice: (level, text) => notices.push(`${level}: ${text}`),
    address: ADDRESS,
    ...overrides,
  });
  if ('error' in started) throw new Error(started.error);
  sessions.push(started);
  const tools = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));
  const context = (): ToolExecutionContext => ({
    tools,
    mode: 'auto',
    cwd: project,
    signal: new AbortController().signal,
    backend: started.backend,
    engagement: started,
  });
  const run = async (name: string, input: Record<string, unknown>) =>
    (await executeToolCall({ id: name, name, input }, context())).content;
  return { session: started, notices, run };
};

const ruleset = async (session: SecuritySession): Promise<string> => {
  const tools = networkTools() as NetworkTools;
  const namespaces = pinNamespaces(session.pid);
  try {
    return await runInNamespaces(tools, namespaces, [tools.nft, 'list', 'ruleset']);
  } finally {
    releaseNamespaces(namespaces);
  }
};

// A window that ends on a whole second, `seconds` from now.
const endingIn = (seconds: number) => ({
  from: new Date(Date.now() - 60_000).toISOString(),
  until: new Date((Math.ceil(Date.now() / 1000) + seconds) * 1000).toISOString(),
});

const sandboxDirectories = (): string[] =>
  readdirSync(process.env.XDG_RUNTIME_DIR as string).filter((name) =>
    name.startsWith('nullrivet-'),
  );

const activeUnits = (prefix: string): string[] =>
  Bun.spawnSync(['systemctl', '--user', 'list-units', '--plain', '--no-legend', `${prefix}*`])
    .stdout.toString()
    .split('\n')
    .filter((line) => line.trim() !== '');

describe.if(linux && runs)('a sandbox of the security profile', () => {
  const host = (): string => {
    if (hostAddress === undefined) throw new Error('the host has no IPv4 address to test with');
    return hostAddress;
  };

  test('reaches its scope by address and by name, and nothing else', async () => {
    const [ok, other] = [await listening(), await listening()];
    const { session, run } = await start(
      {
        scope: {
          allow: [
            { cidr: `${host()}/32`, ports: [ok] },
            { host: 'svc.test', ports: [ok] },
          ],
        },
      },
      { resolve: async () => [host()] },
    );
    const output = await run('bash', {
      command: [
        'readlink /etc/hosts',
        'grep svc.test /etc/hosts',
        `(exec 3<>/dev/tcp/svc.test/${ok}; echo hi >&3; head -c 2 <&3; echo)`,
        `(exec 3<>/dev/tcp/${host()}/${other}) 2>&1 | grep -o 'Connection refused'`,
      ].join('; '),
    });
    expect(output).toContain('/etc/nullrivet/hosts');
    expect(output).toContain(`${host()} svc.test`);
    expect(output).toContain('ok');
    expect(output).toContain('Connection refused');
    expect(await ruleset(session)).toContain(`${host()} . ${ok}`);
    expect(activeUnits(`nullrivet-pasta-${process.pid}-`)).toHaveLength(1);
    // The test authorizes this host's own address, as a laboratory on this machine does: told.
    expect(session.warnings).toContain(
      `the scope authorizes addresses of this host, ${host()}: the sandbox reaches the services of this host listening there`,
    );
    // Its directory holds the hosts file and the lock, no overlay.
    const own = sandboxDirectories().filter((name) => name.startsWith(`nullrivet-${process.pid}-`));
    expect(own).toHaveLength(1);
    expect(
      readdirSync(join(process.env.XDG_RUNTIME_DIR as string, own[0] as string)).sort(),
    ).toEqual(['etc', 'lock']);
  }, 60_000);

  test('cannot widen, turn off or go around its network from inside', async () => {
    const ok = await listening();
    const { session, run } = await start({
      scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] },
    });
    const tries = [
      ['nft', 'nft flush ruleset'],
      ['sysctl', 'echo "0 0" > /proc/sys/net/ipv4/ping_group_range'],
      ['route', 'echo 1 > /proc/sys/net/ipv4/ip_forward'],
      ['user namespace', 'unshare --user --map-root-user true'],
      ['hosts', 'echo "198.51.100.1 svc.test" >> /etc/hosts'],
      ['hosts directory', 'touch /etc/nullrivet/added'],
      ['name', 'getent hosts example.com'],
      [
        'raw socket',
        `python3 -c "import socket; socket.socket(socket.AF_INET, socket.SOCK_RAW, 1)"`,
      ],
      [
        'packet socket',
        `python3 -c "import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW)"`,
      ],
      [
        'unix socket',
        `python3 -c "import socket; socket.socket(socket.AF_UNIX).connect('\\0/tmp/.X11-unix/X0')"`,
      ],
    ];
    const output = await run('bash', {
      command: tries
        .map(([name, command]) => `(${command}) >/dev/null 2>&1; echo "${name}: $?"`)
        .join('\n'),
    });
    // Each ran and failed: a program missing from the sandbox would prove nothing.
    for (const [name] of tries) {
      const code = new RegExp(`^${name}: (\\d+)$`, 'm').exec(output)?.[1];
      expect(
        `${name}: ${code === '0' ? 'succeeded' : code === undefined ? 'not run' : code === '127' ? 'not found' : 'refused'}`,
      ).toBe(`${name}: refused`);
    }
    // And the ruleset is the one installed.
    expect(await ruleset(session)).toContain(`${host()} . ${ok}`);
  }, 60_000);

  test('takes new addresses of its names on a refresh, in its hosts file and its scope', async () => {
    const ok = await listening();
    let answer = ['198.51.100.20'];
    const { session, run } = await start(
      { scope: { allow: [{ host: 'svc.test', ports: [ok] }] } },
      { resolve: async () => answer },
    );
    answer = ['192.0.2.10'];
    expect(await session.refresh()).toEqual({
      changes: [{ host: 'svc.test', added: ['192.0.2.10'], removed: ['198.51.100.20'] }],
    });
    expect(await run('bash', { command: 'grep svc.test /etc/hosts' })).toContain(
      '192.0.2.10 svc.test',
    );
    const rules = await ruleset(session);
    expect(rules).toContain(`192.0.2.10 . ${ok}`);
    expect(rules).not.toContain(`198.51.100.20 . ${ok}`);
    // The address the name no longer resolves to is refused at once.
    expect(
      await run('bash', {
        command: `(exec 3<>/dev/tcp/198.51.100.20/${ok}) 2>&1 | grep -o 'Connection refused'`,
      }),
    ).toContain('Connection refused');
  }, 60_000);

  test('ends its window: commands running cancelled, jobs stopped, network closed, reading on', async () => {
    const ok = await listening();
    const window = endingIn(3);
    const { session, notices, run } = await start({
      scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] },
      window,
    });
    expect(await run('bash_background', { command: 'sleep 60' })).toContain(
      'Started background job',
    );
    const running = await run('bash', { command: 'sleep 30; echo finished' });
    expect(running).not.toContain('finished');
    expect(Date.now()).toBeLessThan(new Date(window.until).getTime() + 3_000);
    expect(await run('bash', { command: 'echo again' })).toStartWith(
      `error [engagement.window]: bash was not executed: the engagement window ended at ${window.until}`,
    );
    // git runs fixed subcommands with the repository's programs disabled: it reads.
    expect(await run('git', { subcommand: 'status' })).not.toContain('engagement.window');
    expect(await run('read_file', { path: join(project, 'notes.txt') })).toContain('project notes');
    // The end is told once the jobs are stopped, which a slow host can take a while for.
    const deadline = Date.now() + 15_000;
    while (!notices.some((notice) => notice.includes('ended')) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(await run('bash_jobs', {})).not.toContain('running');
    expect(notices.join('\n')).toContain(`info: The engagement window ended at ${window.until}`);
    // What the operator and the model read of the scope says none of it is in force.
    expect(session.scope().at(-1)).toBe(
      `None of it is in force: the engagement window ended at ${window.until}.`,
    );
    expect(await ruleset(session)).toContain('table inet nullrivet_closed');
    expect(
      Bun.spawnSync(['pgrep', '-u', String(process.getuid?.()), '-x', 'pasta'])
        .stdout.toString()
        .trim(),
    ).toBe('');
  }, 60_000);

  test('leaves no way out after the end: to a process left behind, a refresh racing it, a helper hanging', async () => {
    const tools = networkTools() as NetworkTools;
    // An nft that hangs on the table that closes the network.
    const hanging = join(scratch, 'hanging-nft');
    writeFileSync(
      hanging,
      `#!/bin/sh\nif [ "$1" = -f ] && grep -q nullrivet_closed "$2"; then sleep 30; fi\nexec ${tools.nft} "$@"\n`,
      { mode: 0o755 },
    );
    for (const nft of [tools.nft, hanging]) {
      const [ok, other] = [await listening(), await listening()];
      let delay = 0;
      const window = endingIn(6);
      const until = new Date(window.until).getTime();
      const { session, run } = await start(
        {
          scope: {
            allow: [
              { cidr: `${host()}/32`, ports: [ok, other] },
              { host: 'svc.test', ports: [ok] },
            ],
          },
          window,
        },
        {
          tools: { ...tools, nft },
          resolve: async () => {
            await Bun.sleep(delay);
            return [host()];
          },
        },
      );
      // Out of every job and command: neither their cancellation nor the stop of the jobs ends it.
      // Each connection is stamped with the time it was tried, before it. bash, whose /dev/tcp
      // connects: sh can be dash, which has none. The command returns once five connections
      // succeeded, with their count: what reaches its target before the end must be shown, or no
      // refusal after it would mean anything.
      const ready = await run('bash', {
        command: [
          `setsid bash -c 'while :; do t=$(date +%s.%N); (exec 3<>/dev/tcp/${host()}/${ok}) 2>/dev/null && echo $t >> /tmp/reached; sleep 0.05; done' >/dev/null 2>&1 </dev/null &`,
          'for i in $(seq 60); do [ "$(cat /tmp/reached 2>/dev/null | wc -l)" -ge 5 ] && break; sleep 0.05; done',
          'echo "reached $(cat /tmp/reached 2>/dev/null | wc -l)"',
        ].join('\n'),
      });
      expect(Number(/reached (\d+)/.exec(ready)?.[1])).toBeGreaterThanOrEqual(5);
      await Bun.sleep(until - Date.now() - 1_000);
      delay = 2_500;
      const refreshing = session.refresh();
      await Bun.sleep(until - Date.now() + 2_500);
      expect(await refreshing).toEqual({
        error: `the engagement window ended at ${window.until}`,
      });
      const reached = (
        (await run('read_file', { path: '/tmp/reached' })).match(/\b\d{10}\.\d+\b/g) ?? []
      ).map(Number);
      expect(reached.length).toBeGreaterThan(5);
      expect(reached.filter((at) => at >= until / 1000)).toEqual([]);
      await session.close();
    }
  }, 120_000);

  test('refuses commands before its window opens', async () => {
    const ok = await listening();
    const from = new Date(Date.now() + 3_600_000).toISOString();
    const { session, run } = await start({
      scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] },
      window: { from, until: new Date(Date.now() + 7_200_000).toISOString() },
    });
    expect(await run('bash', { command: 'echo early' })).toStartWith(
      `error [engagement.window]: bash was not executed: the engagement window opens at ${from}`,
    );
    expect(await run('read_file', { path: join(project, 'notes.txt') })).toContain('project notes');
    expect(await ruleset(session)).toContain('meta time <');
  }, 60_000);

  test('closes its network at once, whatever a refresh is waiting for', async () => {
    const ok = await listening();
    let hang = false;
    const { session } = await start(
      {
        scope: {
          allow: [
            { cidr: `${host()}/32`, ports: [ok] },
            { host: 'svc.test', ports: [ok] },
          ],
        },
      },
      { resolve: () => (hang ? new Promise(() => undefined) : Promise.resolve([host()])) },
    );
    hang = true;
    const refreshing = session.refresh();
    await Bun.sleep(200);
    const started = Date.now();
    await session.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(activeUnits(`nullrivet-pasta-${process.pid}-`)).toEqual([]);
    const answered = await refreshing;
    expect(answered).toEqual({ error: 'the sandbox was closed' });
  }, 60_000);

  test('gives up a preparation that hangs within its time, its helpers killed, nothing left', async () => {
    const ok = await listening();
    const tools = networkTools() as NetworkTools;
    const hang = `sleep 61.${process.pid % 1000}`;
    // An nft that hangs, deaf to SIGTERM.
    const nft = join(scratch, 'deaf-nft');
    writeFileSync(nft, `#!/bin/sh\ntrap '' TERM\nexec ${hang}\n`, { mode: 0o755 });
    const launch = await launchOptions();
    const before = sandboxDirectories();
    const started = Date.now();
    const result = await SecuritySession.start({
      host: launch.host,
      launch,
      env: process.env,
      notice: () => undefined,
      address: ADDRESS,
      engagementPath: engagementFile({ scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] } }),
      tools: { ...tools, nft },
      prepareTimeoutMs: 1_000,
    });
    expect('error' in result ? result.error : 'started').toContain('not prepared within 1 s');
    // The start's time, and not the ten seconds a helper has.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(Bun.spawnSync(['pgrep', '-f', hang]).exitCode).toBe(1);
    expect(sandboxDirectories()).toEqual(before);
    expect(activeUnits(`nullrivet-pasta-${process.pid}-`)).toEqual([]);
  }, 60_000);

  test('gives up a preparation at a later step, with every process its helpers started', async () => {
    const tools = networkTools() as NetworkTools;
    const launch = await launchOptions();
    const cases = [
      // The listing, which the installation and the reference both make, the reference's from a
      // shell that starts nft.
      { step: 'the listing', when: '*" -j "*' },
      // The scope's installation, once pasta configured the network, in its scope.
      { step: "the scope's installation", when: '*nullrivet_b*' },
    ];
    for (const { step, when } of cases) {
      const ok = await listening();
      const hang = `sleep 62.${process.pid % 1000}${cases.findIndex((c) => c.step === step)}`;
      // An nft that hangs in a process of its own, deaf to SIGTERM, not run in its place.
      const nft = join(scratch, `deaf-nft-${cases.findIndex((c) => c.step === step)}`);
      writeFileSync(
        nft,
        `#!/bin/sh\ncase " $* $(cat "$2" 2>/dev/null) " in ${when}) trap '' TERM; ${hang}; exit 1;; esac\nexec ${tools.nft} "$@"\n`,
        { mode: 0o755 },
      );
      const before = sandboxDirectories();
      const started = Date.now();
      const result = await SecuritySession.start({
        host: launch.host,
        launch,
        env: process.env,
        notice: () => undefined,
        address: ADDRESS,
        engagementPath: engagementFile({
          scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] },
        }),
        tools: { ...tools, nft },
        prepareTimeoutMs: 3_000,
      });
      expect(`${step}: ${'error' in result ? result.error : 'started'}`).toContain(
        `${step}: the security sandbox did not start: the sandbox was not prepared: not prepared within 3 s`,
      );
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(Bun.spawnSync(['pgrep', '-f', hang]).exitCode).toBe(1);
      expect(sandboxDirectories()).toEqual(before);
      expect(activeUnits(`nullrivet-pasta-${process.pid}-`)).toEqual([]);
    }
  }, 120_000);

  test('does not start when its window has ended, nor leaves anything of a start that failed', async () => {
    const ok = await listening();
    const launch = await launchOptions();
    const common = {
      host: launch.host,
      launch,
      env: process.env,
      notice: () => undefined,
      address: ADDRESS,
    };
    const ended = await SecuritySession.start({
      ...common,
      engagementPath: engagementFile({
        scope: {},
        window: { from: '2020-01-01T00:00:00Z', until: '2020-01-02T00:00:00Z' },
      }),
    });
    expect('error' in ended ? ended.error : 'started').toBe(
      'the engagement window ended at 2020-01-02T00:00:00.000Z',
    );
    const interrupted = new AbortController();
    interrupted.abort();
    const givenUp = await SecuritySession.start({
      ...common,
      engagementPath: engagementFile({ scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] } }),
      signal: interrupted.signal,
    });
    expect('error' in givenUp ? givenUp.error : 'started').toBe(
      'the start of the sandbox was given up',
    );
    // An nft that fails: the network cannot be prepared.
    const tools = networkTools() as NetworkTools;
    const nft = join(scratch, 'failing-nft');
    writeFileSync(nft, '#!/bin/sh\necho "nft refused" >&2\nexit 1\n', { mode: 0o755 });
    const before = sandboxDirectories();
    const failed = await SecuritySession.start({
      ...common,
      engagementPath: engagementFile({ scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] } }),
      tools: { ...tools, nft },
    });
    expect('error' in failed ? failed.error : 'started').toContain('nft refused');
    expect(sandboxDirectories()).toEqual(before);
    expect(activeUnits(`nullrivet-pasta-${process.pid}-`)).toEqual([]);
  }, 60_000);
});

// A target that records what each connection sent it, and answers a plain HTTP request.
const recorder = async (): Promise<{ port: number; received: Buffer[] }> => {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    const index = received.push(Buffer.alloc(0)) - 1;
    socket.on('data', (chunk: Buffer) => {
      received[index] = Buffer.concat([received[index] as Buffer, chunk]);
      if (
        /^[A-Z]+ \//.test(received[index].toString('latin1')) &&
        received[index].includes('\r\n\r\n')
      ) {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok\n');
      }
    });
    socket.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, received };
};

// The proxy in this process, its names answered by `answers` and every target the recorder:
// `dialed` keeps which address and port it was asked for. `die` ends it as a crash would.
const inProcessProxy = (target: number, answers: Record<string, string[]>) => {
  const dialed: string[] = [];
  const handles: { die: (reason: string) => Promise<void>; port: string }[] = [];
  // Each direct scope the session gave the proxy, as the addresses it authorizes.
  const scopes: string[][] = [];
  const factory: ProxyFactory = async ({ policy, report }) => {
    const proxy = await ScopeProxy.listen(policy, {
      resolve: async (name) => answers[name] ?? [],
      connect: (address, port) => {
        dialed.push(`${address} ${port}`);
        return connect({ host: '127.0.0.1', port: target, allowHalfOpen: true });
      },
      now: Date.now,
      ownAddresses: () => [],
      report,
    });
    let end: (reason: string) => void = () => undefined;
    const ended = new Promise<string>((resolve) => {
      end = resolve;
    });
    const die = async (reason: string): Promise<void> => {
      await proxy.close();
      end(reason);
    };
    handles.push({ die, port: `127.0.0.1:${proxy.port}` });
    return {
      port: proxy.port,
      ended,
      setDirect: async (direct) => {
        scopes.push(direct.allow.map(({ network }) => network.address));
        proxy.setDirect(direct);
      },
      stop: () => die('the proxy was stopped'),
    };
  };
  return { factory, dialed, handles, scopes };
};

describe.if(linux && runs)('names reached through the proxy', () => {
  test('are reached through the proxy alone, by their name in Host or in TLS', async () => {
    const target = await recorder();
    const answers = { 'svc.test': ['198.51.100.20'] };
    const { factory, dialed } = inProcessProxy(target.port, answers);
    const { session, run } = await start(
      { scope: { allow: [{ host: 'svc.test', ports: [80, 443], via: 'proxy' }] } },
      { resolve: async (name) => answers[name as keyof typeof answers] ?? [], proxy: factory },
    );
    expect(session.scope()).toContain('- svc.test, ports 80, 443, last checked at 198.51.100.20');
    expect(await run('bash', { command: 'curl -s -m 5 http://svc.test/x' })).toContain('ok');
    expect(target.received[0]?.toString('latin1')).toStartWith(
      'GET /x HTTP/1.1\r\nUser-Agent: curl/',
    );
    expect(target.received[0]?.toString('latin1')).toContain('Host: svc.test\r\n');
    expect(target.received[0]?.toString('latin1')).not.toContain('Proxy-Authorization');
    await run('bash', { command: 'curl -sk -m 5 https://svc.test/; true' });
    const hello = target.received[1] as Buffer;
    expect(hello[0]).toBe(22);
    expect(hello.toString('latin1')).toContain('svc.test');
    expect(new Set(dialed)).toEqual(new Set(['198.51.100.20 80', '198.51.100.20 443']));
    // Neither a route to the address nor the name exist without the proxy.
    expect(
      await run('bash', {
        command: `(exec 3<>/dev/tcp/198.51.100.20/443) 2>&1 | grep -o 'Connection refused'; getent hosts svc.test || echo unresolved`,
      }),
    ).toContain('Connection refused\nunresolved');
    // A ClientHello for another name, through the tunnel opened for this one: nothing is sent on.
    await run('bash', {
      command: 'curl -sk -m 5 --connect-to other.test:443:svc.test:443 https://other.test/; true',
    });
    expect(target.received.length).toBe(3);
    expect(target.received[2]?.length).toBe(0);
  }, 60_000);

  test("hold their credential out of every command line, and every environment but the sandbox's commands'", async () => {
    const target = await recorder();
    const answers = { 'svc.test': ['198.51.100.20'] };
    const { run } = await start(
      { scope: { allow: [{ host: 'svc.test', ports: [443], via: 'proxy' }] } },
      {
        resolve: async (name) => answers[name as keyof typeof answers] ?? [],
        proxy: inProcessProxy(target.port, answers).factory,
      },
    );
    const token = /nullrivet:([0-9a-f]{64})@127\.0\.0\.1:3128/.exec(
      await run('bash', { command: 'echo "$HTTPS_PROXY $NO_PROXY"' }),
    )?.[1];
    expect(token).toBeDefined();
    const pidNamespace = readlinkSync('/proc/self/ns/pid');
    let read = 0;
    for (const entry of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      try {
        expect(readFileSync(`/proc/${entry}/cmdline`, 'latin1')).not.toContain(token);
        read += 1;
        if (readFileSync(`/proc/${entry}/environ`, 'latin1').includes(token as string)) {
          expect(readlinkSync(`/proc/${entry}/ns/pid`)).not.toBe(pidNamespace);
        }
      } catch (error) {
        if ((error as { code?: string }).code === undefined) throw error;
        // Gone meanwhile, or not ours.
      }
    }
    expect(read).toBeGreaterThan(10);
  }, 60_000);

  test('relay nothing of a tunnel once the window has ended', async () => {
    const target = await recorder();
    const answers = { 'svc.test': ['198.51.100.20'] };
    const window = endingIn(8);
    const until = new Date(window.until).getTime();
    const { run } = await start(
      { scope: { allow: [{ host: 'svc.test', ports: [443], via: 'proxy' }] }, window },
      {
        resolve: async (name) => answers[name as keyof typeof answers] ?? [],
        proxy: inProcessProxy(target.port, answers).factory,
      },
    );
    const hello = Buffer.from(await captureClientHello('svc.test')).toString('hex');
    // Through a tunnel past its ClientHello, the time each chunk is written, every 10 ms.
    const script = [
      'import base64, binascii, os, socket, time',
      "credential = os.environ['HTTPS_PROXY'].split('//')[1].split('@')[0]",
      "s = socket.create_connection(('127.0.0.1', 3128))",
      "s.sendall(b'CONNECT svc.test:443 HTTP/1.1\\r\\nProxy-Authorization: Basic ' + base64.b64encode(credential.encode()) + b'\\r\\n\\r\\n')",
      's.recv(100)',
      `s.sendall(binascii.unhexlify('${hello}'))`,
      'while True:',
      '    try:',
      "        s.sendall(('%.6f\\n' % time.time()).encode())",
      '    except OSError:',
      '        break',
      '    time.sleep(0.01)',
    ].join('\n');
    await run('bash', {
      command: `cat > /tmp/tunnel.py <<'EOF'\n${script}\nEOF\nsetsid python3 -I /tmp/tunnel.py >/dev/null 2>&1 </dev/null &\nsleep 1`,
    });
    await Bun.sleep(until - Date.now() + 2_000);
    const sent = (target.received[0] as Buffer).toString('latin1');
    const written = (sent.match(/\b\d{10}\.\d{6}\b/g) ?? []).map(Number);
    expect(written.length).toBeGreaterThan(20);
    expect(written.filter((at) => at >= until / 1000)).toEqual([]);
  }, 60_000);

  test('hold NO_PROXY to what an environment takes, and say what it leaves out', async () => {
    const target = await recorder();
    const answers = { 'svc.test': ['198.51.100.20'] };
    const networks = Array.from({ length: 2_000 }, (_, index) => ({
      cidr: `10.${Math.floor(index / 250)}.${index % 250}.0/24`,
      ports: [22],
    }));
    const { session, run } = await start(
      { scope: { allow: [{ host: 'svc.test', ports: [443], via: 'proxy' }, ...networks] } },
      {
        resolve: async (name) => answers[name as keyof typeof answers] ?? [],
        proxy: inProcessProxy(target.port, answers).factory,
      },
    );
    expect(session.warnings.join('\n')).toMatch(
      /NO_PROXY leaves out \d+ of the 2000 names, addresses and networks reached directly, past 16384 characters/,
    );
    const lengths = await run('bash', { command: 'echo "${#NO_PROXY} ${#no_proxy}"' });
    const [, upper, lower] = (/(\d+) (\d+)/.exec(lengths) ?? []).map(Number) as number[];
    expect(upper).toBeLessThanOrEqual(16_384);
    expect(upper).toBe(lower);
  }, 60_000);

  test('are left out of NO_PROXY with a name reached directly that they end with', async () => {
    const target = await recorder();
    const answers = { 'api.acme.test': ['198.51.100.20'], 'acme.test': ['198.51.100.40'] };
    const { session, run } = await start(
      {
        scope: {
          allow: [
            { host: 'api.acme.test', ports: [80], via: 'proxy' },
            { host: 'acme.test', ports: [22] },
          ],
        },
      },
      {
        resolve: async (name) => answers[name as keyof typeof answers] ?? [],
        proxy: inProcessProxy(target.port, answers).factory,
      },
    );
    expect(session.warnings).toContain(
      'NO_PROXY leaves out acme.test, which names reached through the proxy end with: an HTTP client sends it to the proxy, which refuses it, unless told not to use the proxy, as curl is with --noproxy',
    );
    expect(await run('bash', { command: 'echo "$NO_PROXY"' })).toContain(
      'localhost,127.0.0.1,::1,198.51.100.40',
    );
    expect(await run('bash', { command: 'curl -s -m 5 http://api.acme.test/' })).toContain('ok');
  }, 60_000);

  test('hold both scopes while a refresh puts the new one in force, and report their moves', async () => {
    const target = await recorder();
    const answers: Record<string, string[]> = {
      'svc.test': ['198.51.100.20'],
      'direct.test': ['198.51.100.30'],
    };
    const proxy = inProcessProxy(target.port, answers);
    const { session, run } = await start(
      {
        scope: {
          allow: [
            { host: 'svc.test', ports: [443], via: 'proxy' },
            { host: 'direct.test', ports: [22] },
          ],
        },
      },
      { resolve: async (name) => answers[name] ?? [], proxy: proxy.factory },
    );
    expect(await run('bash', { command: 'echo "$NO_PROXY"' })).toContain('198.51.100.30');
    answers['direct.test'] = ['198.51.100.31'];
    answers['svc.test'] = ['198.51.100.21'];
    expect(await session.refresh()).toEqual({
      changes: [
        { host: 'direct.test', added: ['198.51.100.31'], removed: ['198.51.100.30'] },
        { host: 'svc.test', added: ['198.51.100.21'], removed: ['198.51.100.20'] },
      ],
    });
    expect(proxy.scopes).toEqual([['198.51.100.30', '198.51.100.31'], ['198.51.100.31']]);
    // The commands started after the refresh find what is reached directly now.
    const noProxy = await run('bash', { command: 'echo "$NO_PROXY"' });
    expect(noProxy).toContain('198.51.100.31');
    expect(noProxy).not.toContain('198.51.100.30');
  }, 60_000);

  test('stop a refresh that would authorize the address of one directly', async () => {
    const target = await recorder();
    const answers: Record<string, string[]> = {
      'svc.test': ['198.51.100.20'],
      'direct.test': ['198.51.100.30'],
    };
    const { session } = await start(
      {
        scope: {
          allow: [
            { host: 'svc.test', ports: [443], via: 'proxy' },
            { host: 'direct.test', ports: [443] },
          ],
        },
      },
      {
        resolve: async (name) => answers[name] ?? [],
        proxy: inProcessProxy(target.port, answers).factory,
      },
    );
    answers['direct.test'] = ['198.51.100.20'];
    expect(await session.refresh()).toEqual({
      error:
        'nothing changed: names reached through the proxy resolve to addresses the scope authorizes directly, where the sandbox would reach them without it: svc.test resolves to 198.51.100.20, which 198.51.100.20/32, ports 443, authorizes directly',
    });
    const rules = await ruleset(session);
    expect(rules).toContain('198.51.100.30 . 443');
    expect(rules).not.toContain('198.51.100.20');
  }, 60_000);

  test('close the network when the proxy ends by itself, whose port another could take', async () => {
    const target = await recorder();
    const answers = { 'svc.test': ['198.51.100.20'] };
    const proxy = inProcessProxy(target.port, answers);
    const { session, notices, run } = await start(
      { scope: { allow: [{ host: 'svc.test', ports: [80], via: 'proxy' }] } },
      {
        resolve: async (name) => answers[name as keyof typeof answers] ?? [],
        proxy: proxy.factory,
      },
    );
    const port = /127\.0\.0\.1:(\d+)/.exec(proxy.handles[0]?.port ?? '')?.[1];
    await proxy.handles[0]?.die('the proxy exited on SIGKILL');
    // Something else takes the port the proxy left.
    let taken = 0;
    const squatter = createServer((socket) => {
      taken += 1;
      socket.destroy();
    });
    servers.push(squatter);
    await new Promise<void>((resolve) => squatter.listen(Number(port), '127.0.0.1', resolve));
    await Bun.sleep(1_500);
    expect(notices).toContain(
      "warning: the sandbox's network stopped: the proxy stopped: the proxy exited on SIGKILL",
    );
    expect(session.scope().at(-1)).toBe(
      "None of it is in force: the sandbox's network stopped: the proxy stopped: the proxy exited on SIGKILL.",
    );
    await run('bash', { command: 'curl -s -m 3 http://svc.test/; true' });
    expect(taken).toBe(0);
    await session.close();

    const directories = sandboxDirectories().length;
    // A proxy that ends while the network is prepared: the worker is not released.
    const dying = inProcessProxy(target.port, answers);
    const launch = await launchOptions();
    const died = await SecuritySession.start({
      host: launch.host,
      launch,
      env: process.env,
      engagementPath: engagementFile({
        scope: { allow: [{ host: 'svc.test', ports: [443], via: 'proxy' }] },
      }),
      notice: () => undefined,
      address: ADDRESS,
      resolve: async (name) => answers[name as keyof typeof answers] ?? [],
      proxy: async (started) => {
        const running = await dying.factory(started);
        setTimeout(() => void dying.handles[0]?.die('the proxy exited on SIGKILL'), 10);
        return running;
      },
    });
    expect('error' in died ? died.error : 'started').toContain(
      'the proxy stopped: the proxy exited on SIGKILL',
    );
    expect(sandboxDirectories().length).toBe(directories);
    expect(activeUnits(`nullrivet-pasta-${process.pid}-`)).toEqual([]);
    const failed = await SecuritySession.start({
      host: launch.host,
      launch,
      env: process.env,
      engagementPath: engagementFile({
        scope: { allow: [{ host: 'svc.test', ports: [443], via: 'proxy' }] },
      }),
      notice: () => undefined,
      address: ADDRESS,
      resolve: async (name) => answers[name as keyof typeof answers] ?? [],
      proxy: () => Promise.reject(new Error('the proxy cannot listen')),
    });
    expect('error' in failed ? failed.error : 'started').toContain('the proxy cannot listen');
    expect(sandboxDirectories().length).toBe(directories);
    expect(activeUnits(`nullrivet-pasta-${process.pid}-`)).toEqual([]);
  }, 60_000);
});

describe.if(linux && runs)('the proxy of a security sandbox, as a process of its own', () => {
  test('is reached from the sandbox, in a scope that ends with the session', async () => {
    // The session checks the name with this resolver; the proxy's process asks the host's, which
    // does not know it: its answer, from its own sandbox, shows the whole way works.
    const { session, run } = await start(
      { scope: { allow: [{ host: 'svc.test', ports: [80], via: 'proxy' }] } },
      { resolve: async () => ['198.51.100.20'] },
    );
    expect(activeUnits(`nullrivet-proxy-${process.pid}-`)).toHaveLength(1);
    expect(await run('bash', { command: 'curl -s -m 10 http://svc.test/' })).toContain(
      'nullrivet proxy: svc.test could not be resolved',
    );
    expect(await run('bash', { command: 'curl -s -m 10 http://other.test/' })).toContain(
      'nullrivet proxy: other.test is not reached through the proxy',
    );
    await session.close();
    expect(activeUnits(`nullrivet-proxy-${process.pid}-`)).toEqual([]);
  }, 60_000);
});

describe.if(linux && runs)('the evidence log of a security sandbox', () => {
  const host = (): string => {
    if (hostAddress === undefined) throw new Error('the host has no IPv4 address to test with');
    return hostAddress;
  };
  let logs = 0;
  const evidenceDir = (): string => {
    logs += 1;
    return join(scratch, `evidence-${logs}`);
  };
  const entriesOf = (dir: string) => {
    const name = readdirSync(dir).find((entry) => entry.endsWith('.jsonl')) as string;
    const path = join(dir, name);
    const entries = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
    return { path, entries };
  };
  const finalHashOf = (notices: string[]): string =>
    /the SHA-256 of the last is ([0-9a-f]{64})/.exec(notices.join('\n'))?.[1] as string;
  const finishedOf = (entries: Record<string, unknown>[], callId: string) =>
    entries.find((entry) => entry.type === 'tool.finished' && entry.callId === callId) as {
      outputs?: Record<string, unknown>[];
    };

  test('records the session whole: each call, its outputs as the worker hashed them, and its jobs', async () => {
    const ok = await listening();
    const dir = evidenceDir();
    const { session, run, notices } = await start({
      scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] },
      evidence: { dir },
    });
    await run('bash', { command: 'echo hi' });
    // A refresh, which names the scope it replaced by the hash the start gave it.
    expect(await session.refresh()).toEqual({ changes: [] });
    expect(await run('bash', { command: 'seq 1 200000' })).toContain('/tmp/nullrivet-');
    await run('read_file', { path: join(project, 'notes.txt') });
    // The sandbox does not see the evidence.
    expect(await run('bash', { command: `ls ${dir} 2>&1 || true` })).toContain('No such file');
    await run('bash_background', { command: 'echo job-output; sleep 0.2' });
    await Bun.sleep(1_500);
    // A job still running when the session ends is stopped, and its end and log recorded.
    await run('bash_background', { command: 'echo still-running; sleep 60' });
    await session.close();
    const { path, entries } = entriesOf(dir);
    const finalHash = finalHashOf([session.evidenceOutcome()?.text ?? '']);
    void notices;
    expect(verifyEvidence(path, finalHash)).toMatchObject({ status: 'complete', reasons: [] });
    expect(entries[0]?.type).toBe('session.started');
    expect(entries.at(-1)?.type).toBe('session.ended');
    expect(entries.find((entry) => entry.type === 'scope.refreshed')).toMatchObject({
      beforeSha256: entries[0]?.scopeSha256,
      afterSha256: entries[0]?.scopeSha256,
    });
    const started = entries.filter((entry) => entry.type === 'tool.started');
    expect(started.map((entry) => [entry.callId, entry.tool])).toEqual([
      ['c1', 'bash'],
      ['c2', 'bash'],
      ['c3', 'read_file'],
      ['c4', 'bash'],
      ['c5', 'bash_background'],
      ['c6', 'bash_background'],
    ]);
    expect(finishedOf(entries, 'c1').outputs?.[0]).toMatchObject({
      stream: 'stdout',
      preservation: 'inline',
      receivedSha256: sha256('hi\n'),
      complete: true,
    });
    const sequence = `${Array.from({ length: 200_000 }, (_, index) => index + 1).join('\n')}\n`;
    expect(finishedOf(entries, 'c2').outputs?.[0]).toMatchObject({
      stream: 'stdout',
      preservation: 'parts',
      receivedBytes: Buffer.byteLength(sequence),
      receivedSha256: sha256(sequence),
      savedSha256: sha256(sequence),
      copiedSha256: sha256(sequence),
      complete: true,
      matchesSaved: true,
    });
    const jobs = entries.filter((entry) => entry.type === 'job.started');
    expect(jobs.map((job) => job.callId)).toEqual(['c5', 'c6']);
    const finished = entries.filter((entry) => entry.type === 'job.finished') as unknown as {
      log: Record<string, unknown>;
    }[];
    expect(finished).toHaveLength(2);
    for (const job of finished) {
      expect(job.log).toMatchObject({ preservation: 'parts', matchesSaved: true });
    }
    expect(entries.at(-1)).toMatchObject({ jobsWithoutEnd: [], callsWithoutOutcome: [] });
  }, 60_000);

  test('records a part the sandbox replaced before it was copied as not preserved, and tells', async () => {
    const ok = await listening();
    const dir = evidenceDir();
    const { session, run, notices } = await start({
      scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] },
      evidence: { dir },
    });
    // A job that puts a link in place of every part of a call's output, as soon as it appears.
    await run('bash_background', {
      command:
        'while :; do for f in /tmp/nullrivet-*/*-bash-stdout.*; do [ -f "$f" ] && ln -sf /etc/passwd "$f"; done; sleep 0.005; done',
    });
    await run('bash', { command: 'seq 1 300000; sleep 0.3' });
    await session.close();
    const { path, entries } = entriesOf(dir);
    const output = finishedOf(entries, 'c2').outputs?.[0] as Record<string, unknown>;
    // The link leads to a file the sandbox has: it is refused, not followed.
    expect(output.preservation).toBe('omitted');
    expect(String(output.omitted)).toContain('cannot be opened');
    expect(notices.join('\n')).toContain('warning: evidence:');
    expect(verifyEvidence(path).status).toBe('incomplete');
  }, 60_000);

  test('does not start with the evidence inside what the sandbox sees', async () => {
    const launch = await launchOptions();
    const started = await SecuritySession.start({
      host: launch.host,
      launch,
      env: process.env,
      engagementPath: engagementFile({ scope: {}, evidence: { dir: join(project, 'evidence') } }),
      notice: () => undefined,
      address: ADDRESS,
    });
    expect('error' in started ? started.error : 'started').toContain(
      `it is inside ${project}, which the sandbox sees`,
    );
  }, 30_000);

  test('cancels the command running when the log fails during it, and runs nothing more', async () => {
    const ok = await listening();
    let answer = ['198.51.100.1'];
    const { session, run, notices } = await start(
      {
        scope: { allow: [{ host: 'svc.test', ports: [ok] }] },
        evidence: { dir: evidenceDir() },
      },
      { resolve: async () => answer, evidenceMaxBytes: 16_000 },
    );
    const running = run('bash', { command: 'sleep 30; echo finished' });
    await Bun.sleep(1_000);
    // A refresh to many addresses: its entry, with the scope in force, passes the log's limit.
    answer = [0, 1, 2].flatMap((net) =>
      Array.from(
        { length: 250 },
        (_, host) => `${['198.51.100', '203.0.113', '192.0.2'][net]}.${host + 1}`,
      ),
    );
    await session.refresh();
    const began = Date.now();
    expect(await running).not.toContain('finished');
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(session.closed()).toBe('the evidence log cannot be written');
    expect(await run('bash', { command: 'echo after' })).toStartWith('error [evidence.failed]');
    expect(notices.join('\n')).toContain('The evidence log cannot be written');
  }, 60_000);

  test('closes the network and refuses commands once the log cannot be written', async () => {
    const ok = await listening();
    const { session, run, notices } = await start(
      {
        scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] },
        evidence: { dir: evidenceDir() },
      },
      { evidenceMaxBytes: 12_000 },
    );
    let refused = '';
    for (let attempt = 0; attempt < 20 && refused === ''; attempt += 1) {
      const result = await run('bash', { command: 'seq 1 300' });
      if (result.startsWith('error [')) refused = result;
    }
    expect(refused).toMatch(
      /^error \[(evidence\.failed|engagement\.window)\]: bash was not executed/,
    );
    expect(notices.join('\n')).toContain(
      'warning: The evidence log cannot be written, so the network is closed and commands are refused: the evidence log reached its limit of 12000 bytes',
    );
    await Bun.sleep(1_500);
    expect(session.scope().at(-1)).toBe(
      "None of it is in force: the sandbox's network stopped: the evidence log cannot be written.",
    );
    expect(await run('read_file', { path: join(project, 'notes.txt') })).toStartWith(
      'error [evidence.failed]',
    );
  }, 60_000);
});

describe.if(linux && runs && vmTestsRun)(
  'a security sandbox whose commands run in a virtual machine',
  () => {
    const host = (): string => {
      if (hostAddress === undefined) throw new Error('the host has no IPv4 address to test with');
      return hostAddress;
    };
    const inVm = (engagement: unknown) => start(engagement, { vm: {} });

    test("runs the commands in a guest of the host's kernel, as the user, without what it does not need", async () => {
      const { run } = await inVm({ scope: { allow: [{ cidr: '198.51.100.0/24' }] } });
      const seen = await run('bash', {
        command:
          'id -u; uname -r; grep -cE "vmx|svm" /proc/cpuinfo; ls /proc/self/fd | tr "\\n" " "; echo; stat -c %a /; grep -E "^Cap(Prm|Eff|Bnd)" /proc/self/status | tr -s "\\t " " "',
      });
      expect(seen).toContain(
        [
          String(process.getuid?.()),
          release(),
          '0',
          // The command's own descriptors, the directory ls reads included: none of the protocol's.
          '0 1 2 3 ',
          '755',
          'CapPrm: 0000000000000000',
          'CapEff: 0000000000000000',
          'CapBnd: 0000000000000000',
        ].join('\n'),
      );
      expect(await run('read_file', { path: join(project, 'notes.txt') })).toContain(
        'project notes',
      );
      expect(
        await run('bash', { command: 'touch /etc/planted 2>&1; touch /usr/planted 2>&1' }),
      ).toContain('Permission denied');
    }, 60_000);

    test("reaches the scope through the guest's network, and nothing of the namespace's loopback", async () => {
      const ok = await listening();
      const other = await listening();
      const { run } = await inVm({ scope: { allow: [{ cidr: `${host()}/32`, ports: [ok] }] } });
      const probe = (address: string, port: number) =>
        run('bash', {
          command: `timeout 5 bash -c 'exec 3<>/dev/tcp/${address}/${port} && echo x >&3 && cat <&3' 2>&1 || echo refused`,
        });
      expect(await probe(host(), ok)).toContain('ok');
      expect(await probe(host(), other)).toContain('refused');
      expect(await probe('192.0.2.1', 80)).toContain('refused');
    }, 60_000);

    test("reaches nothing of the namespace's loopback but the proxy's port", async () => {
      const { session, run } = await inVm({ scope: { allow: [{ cidr: '198.51.100.0/24' }] } });
      // A service on the namespace's loopback, which the guest's address of its host leads to.
      const tools = networkTools() as NetworkTools;
      const namespaces = pinNamespaces(session.pid);
      const [file, ...args] = [
        ...enterArgs(tools, namespaces),
        'python3',
        '-I',
        '-u',
        '-c',
        'import socket\ns = socket.socket(); s.bind(("127.0.0.1", 47301)); s.listen(); print("listening")\nwhile True:\n c, _ = s.accept(); c.sendall(b"own"); c.close()',
      ];
      const service = spawn(file as string, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      try {
        await new Promise((resolve) => service.stdout?.once('data', resolve));
        expect(
          await run('bash', {
            command: `timeout 5 bash -c 'exec 3<>/dev/tcp/10.0.3.2/47301 && cat <&3' 2>&1 || echo refused`,
          }),
        ).toContain('refused');
      } finally {
        service.kill('SIGKILL');
        releaseNamespaces(namespaces);
      }
    }, 60_000);

    test("reaches a name of the proxy at the guest's address of its host", async () => {
      const target = await recorder();
      const answers = { 'svc.test': ['198.51.100.20'] };
      const { factory, dialed } = inProcessProxy(target.port, answers);
      const { run } = await start(
        { scope: { allow: [{ host: 'svc.test', ports: [80], via: 'proxy' }] } },
        {
          vm: {},
          resolve: async (name) => answers[name as keyof typeof answers] ?? [],
          proxy: factory,
        },
      );
      expect(await run('bash', { command: 'echo "$HTTP_PROXY"' })).toMatch(/@10\.0\.3\.2:3128/);
      expect(await run('bash', { command: 'curl -s -m 5 http://svc.test/x' })).toContain('ok');
      expect(dialed).toContain('198.51.100.20 80');
    }, 60_000);

    test("records the guest it ran in, and copies its outputs from the guest's /tmp", async () => {
      const dir = join(scratch, `evidence-vm-${Date.now()}`);
      const { session, run } = await inVm({
        scope: { allow: [{ cidr: '198.51.100.0/24' }] },
        evidence: { dir },
      });
      expect(await run('bash', { command: 'seq 1 200000' })).toContain('/tmp/nullrivet-');
      await session.close();
      const name = readdirSync(dir).find((entry) => entry.endsWith('.jsonl')) as string;
      const entries = readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries[0]?.vm).toMatchObject({
        kernelSource: 'distribution',
        kernel: { release: release() },
        machine: 'q35',
        network: { ipv4: '10.0.3.0/24' },
      });
      const finished = entries.find((entry) => entry.type === 'tool.finished') as {
        outputs: Record<string, unknown>[];
      };
      expect(finished.outputs[0]).toMatchObject({ preservation: 'parts', matchesSaved: true });
      expect(verifyEvidence(join(dir, name)).status).toBe('complete');
    }, 60_000);

    test('runs background jobs in the guest, with a terminal of its own for those that want one', async () => {
      const { run } = await inVm({ scope: { allow: [{ cidr: '198.51.100.0/24' }] } });
      expect(await run('bash_background', { command: 'echo from-job; sleep 30' })).toContain(
        'Started background job',
      );
      await Bun.sleep(1_000);
      expect(await run('bash_jobs', {})).toMatch(/running for \d+s: echo from-job; sleep 30/);
      expect(
        await run('bash', {
          command:
            'python3 -I -c "import pty, os; pid, fd = pty.fork(); print(os.ttyname(0)) if pid == 0 else print(\'pty\', os.read(fd, 100).decode().strip())"',
        }),
      ).toContain('pty /dev/pts/');
    }, 60_000);

    test('ends the guest with the session, and leaves no process of it', async () => {
      const { session, run } = await inVm({ scope: { allow: [{ cidr: '198.51.100.0/24' }] } });
      expect(await run('bash', { command: 'echo alive' })).toContain('alive');
      // QEMU's processes, by their name and the kernel the sandbox binds them.
      const qemu = () =>
        readdirSync('/proc')
          .filter((entry) => /^\d+$/.test(entry))
          .filter((pid) => {
            try {
              return (
                readFileSync(`/proc/${pid}/comm`, 'utf8').startsWith('qemu-system') &&
                readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('/.nullrivet-vm/kernel')
              );
            } catch {
              return false;
            }
          })
          .join(' ');
      expect(qemu()).not.toBe('');
      await session.close();
      expect(qemu()).toBe('');
    }, 60_000);

    test('refuses a kernel that is not one, before anything starts', async () => {
      const path = join(scratch, 'not-a-kernel');
      writeFileSync(path, 'text');
      await expect(
        start({ scope: { allow: [{ cidr: '198.51.100.0/24' }] } }, { vm: { kernel: path } }),
      ).rejects.toThrow(
        `the virtual machine cannot start: ${path} is not an x86 kernel image (bzImage)`,
      );
    }, 60_000);
  },
);
