import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NetworkTools,
  networkTools,
  pinNamespaces,
  releaseNamespaces,
  runInNamespaces,
} from '../../src/sandbox/network/namespace.ts';
import { cgroupTestsRun, networkTestsRun, overlayTestsRun } from '../helpers/sandbox.ts';
import {
  type ChatRequest,
  cliCommand,
  cliEnv,
  type FakeOllama,
  inTerminal,
  startCli,
  startFakeOllama,
  toolMessages,
} from './harness.ts';

let server: FakeOllama;
const dirs: string[] = [];
const tempDir = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-e2e-security-')));
  dirs.push(dir);
  return dir;
};

beforeAll(() => {
  server = startFakeOllama();
});
afterAll(() => server.stop());
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const toolsThenText = (calls: { name: string; args: Record<string, unknown> }[]) => {
  return (request: ChatRequest) =>
    toolMessages(request).length === 0 ? { toolCalls: calls } : { text: 'done' };
};

// A project, a home, and an engagement file beside them.
const setUp = (engagement: unknown) => {
  const base = tempDir();
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(home);
  mkdirSync(project);
  writeFileSync(join(project, 'notes.txt'), 'project notes\n');
  const file = join(base, 'engagement.json');
  writeFileSync(file, JSON.stringify(engagement));
  return { home, project, file };
};

// The security profile needs the user's service manager, which systemd-run reaches by these.
const bus = (): Record<string, string> =>
  Object.fromEntries(
    ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

const uniqueSleep = (): string => `sleep ${50 + Math.floor(Math.random() * 1_000) / 100}`;

// The ruleset of the namespaces of the CLI's sandbox: those of its Bubblewrap, the child of the
// CLI that runs it in place of systemd-run and unshare.
const rulesetOf = async (cli: number): Promise<string> => {
  const deadline = Date.now() + 10_000;
  let bwrap = '';
  while (bwrap === '' && Date.now() < deadline) {
    bwrap = Bun.spawnSync(['pgrep', '-P', String(cli), '-x', 'bwrap'])
      .stdout.toString()
      .trim();
    if (bwrap === '') await Bun.sleep(50);
  }
  const tools = networkTools() as NetworkTools;
  const namespaces = pinNamespaces(Number(bwrap.split('\n')[0]));
  try {
    return await runInNamespaces(tools, namespaces, [tools.nft, 'list', 'ruleset']);
  } finally {
    releaseNamespaces(namespaces);
  }
};

describe.if(overlayTestsRun && networkTestsRun && cgroupTestsRun)('--sandbox security', () => {
  test('tells the operator and the model the scope it puts in force', async () => {
    const { home, project, file } = setUp({
      scope: {
        allow: [{ cidr: '198.51.100.0/24', ports: [443] }],
        deny: [{ cidr: '198.51.100.9/32' }],
      },
    });
    const sleep = uniqueSleep();
    server.handle(toolsThenText([{ name: 'bash', args: { command: sleep } }]));
    const cli = startCli(['--sandbox', 'security', '--engagement', file, 'look'], {
      env: cliEnv(server, { HOME: home, ...bus() }),
      cwd: project,
    });
    await cli.waitFor((event) => event.type === 'tool:start');
    const rules = await rulesetOf(cli.child.pid);
    Bun.spawnSync(['pkill', '-x', '-f', sleep]);
    const { code } = await cli.finished;
    expect(code).toBe(0);
    expect(rules).toContain('198.51.100.0/24 . 443');
    expect(rules).toContain('198.51.100.9');
    const info = cli.events.filter((e) => e.type === 'info').map((e) => String(e.message));
    expect(info).toEqual([
      'Authorized, over TCP and UDP, and ICMP echo:\n- 198.51.100.0/24, ports 443\nDenied, even where authorized: 198.51.100.9/32',
    ]);
    const prompt = String(server.requests[0]?.messages[0]?.content);
    expect(prompt).toContain('# Sandbox: security');
    expect(prompt).toContain('The network is limited to the engagement scope below.');
    expect(prompt).toContain('- 198.51.100.0/24, ports 443');
  }, 60_000);

  test('does not start once the window has ended', async () => {
    const { home, project, file } = setUp({
      scope: {},
      window: { from: '2020-01-01T00:00:00Z', until: '2020-01-02T00:00:00Z' },
    });
    server.handle(() => ({ text: 'never asked' }));
    const before = server.requests.length;
    const cli = startCli(['--sandbox', 'security', '--engagement', file, 'look'], {
      env: cliEnv(server, { HOME: home, ...bus() }),
      cwd: project,
    });
    const { code } = await cli.finished;
    expect(code).toBe(1);
    expect(cli.events.filter((e) => e.type === 'error').map((e) => e.message)).toEqual([
      'the engagement window ended at 2020-01-02T00:00:00.000Z',
    ]);
    expect(server.requests.length).toBe(before);
  }, 30_000);

  test.skipIf(Bun.which('python3') === null)(
    'shows and refreshes its scope in the interactive session',
    async () => {
      // localhost resolves to loopback addresses, which the file names, here to deny them.
      const { home, project, file } = setUp({
        scope: {
          allow: [{ host: 'localhost', ports: [80] }],
          deny: [{ cidr: '127.0.0.0/8' }, { cidr: '::1/128' }],
        },
      });
      server.handle(() => ({ text: 'ok' }));
      const child = Bun.spawn(
        inTerminal(cliCommand(['--sandbox', 'security', '--engagement', file])),
        {
          env: { ...cliEnv(server, { HOME: home, ...bus() }), TERM: 'xterm-256color' },
          cwd: project,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      await Bun.sleep(2_000);
      child.stdin.write('/scope refresh\r');
      child.stdin.flush();
      await Bun.sleep(1_500);
      child.stdin.write('/exit\r');
      child.stdin.flush();
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      expect(output).toContain('security sandbox');
      expect(output).toMatch(/localhost, ports 80, at (::1, 127\.0\.0\.1|127\.0\.0\.1, ::1)/);
      expect(output).toContain('The names of the scope resolve to the same addresses as before.');
    },
    40_000,
  );
});

describe('--engagement', () => {
  test('is a usage error without the security profile, and the profile one without it', async () => {
    const { home, project, file } = setUp({ scope: {} });
    for (const argv of [
      ['--engagement', file, 'look'],
      ['--sandbox', 'security', 'look'],
    ]) {
      const cli = startCli(argv, { env: cliEnv(server, { HOME: home }), cwd: project });
      const { code, stderr } = await cli.finished;
      expect(code).toBe(2);
      expect(stderr).toMatch(
        /--engagement needs --sandbox security|--sandbox security needs --engagement/,
      );
    }
  }, 30_000);
});
