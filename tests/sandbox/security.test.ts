import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeToolCall, type ToolExecutionContext } from '../../src/agent/tool-broker.ts';
import { type LaunchOptions, sandboxHost, sandboxProject } from '../../src/sandbox/bwrap.ts';
import {
  type NetworkTools,
  networkTools,
  pinNamespaces,
  releaseNamespaces,
  runInNamespaces,
} from '../../src/sandbox/network/namespace.ts';
import {
  type SecurityOptions,
  SecuritySession,
  verifyLauncher,
} from '../../src/sandbox/security.ts';
import { BUILTIN_TOOLS } from '../../src/tools/index.ts';
import { createJobTools } from '../../src/tools/jobs.ts';
import type { Tool } from '../../src/tools/types.ts';
import {
  cgroupTestsRun,
  networkTestsRun,
  overlayTestsRun,
  sandboxTestsRun,
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
    // Its directory holds the hosts file and the lock, no overlay.
    const own = sandboxDirectories().filter((name) => name.startsWith(`nullrivet-${process.pid}-`));
    expect(own).toHaveLength(1);
    expect(
      readdirSync(join(process.env.XDG_RUNTIME_DIR as string, own[0] as string)).sort(),
    ).toEqual(['etc', 'lock']);
  }, 60_000);

  test('takes new addresses of its names on a refresh, in its hosts file and its scope', async () => {
    const [ok, other] = [await listening(), await listening()];
    let answer = [host()];
    const { session, run } = await start(
      {
        scope: {
          // The host's address is a private one, authorized by naming it, on another port.
          allow: [
            { cidr: `${host()}/32`, ports: [other] },
            { host: 'svc.test', ports: [ok] },
          ],
        },
      },
      { resolve: async () => answer },
    );
    answer = ['192.0.2.10'];
    expect(await session.refresh()).toEqual({
      changes: [{ host: 'svc.test', added: ['192.0.2.10'], removed: [host()] }],
    });
    expect(await run('bash', { command: 'grep svc.test /etc/hosts' })).toContain(
      '192.0.2.10 svc.test',
    );
    const rules = await ruleset(session);
    expect(rules).toContain(`192.0.2.10 . ${ok}`);
    expect(rules).not.toContain(`${host()} . ${ok}`);
    expect(
      await run('bash', {
        command: `(exec 3<>/dev/tcp/${host()}/${ok}) 2>&1 | grep -o 'Connection refused'`,
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
    expect(await run('bash_jobs', {})).not.toContain('running');
    const deadline = Date.now() + 5_000;
    while (!notices.some((notice) => notice.includes('ended')) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(notices.join('\n')).toContain(`info: The engagement window ended at ${window.until}`);
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
      const window = endingIn(4);
      const until = new Date(window.until).getTime();
      const { session, run } = await start(
        {
          scope: {
            allow: [
              { cidr: `${host()}/32`, ports: [other] },
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
      // Each connection is stamped with the time it was tried, before it.
      // The command waits for it to leave its group, which is killed when the command ends.
      await run('bash', {
        command: `setsid sh -c 'while :; do t=$(date +%s.%N); (exec 3<>/dev/tcp/${host()}/${ok}) 2>/dev/null && echo $t >> /tmp/reached; sleep 0.05; done' >/dev/null 2>&1 </dev/null & sleep 0.5`,
      });
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
