import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NetworkTools,
  networkTools,
  pinNamespaces,
  releaseNamespaces,
  runInNamespaces,
} from '../../src/sandbox/network/namespace.ts';
import {
  cgroupTestsRun,
  networkTestsRun,
  overlayTestsRun,
  vmTestsRun,
} from '../helpers/sandbox.ts';
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

  test('does not start when a name reached through the proxy resolves off the public internet', async () => {
    const { home, project, file } = setUp({
      scope: { allow: [{ host: 'localhost', ports: [80], via: 'proxy' }] },
    });
    server.handle(() => ({ text: 'never asked' }));
    const before = server.requests.length;
    const cli = startCli(['--sandbox', 'security', '--engagement', file, 'look'], {
      env: cliEnv(server, { HOME: home, ...bus() }),
      cwd: project,
    });
    const { code } = await cli.finished;
    expect(code).toBe(1);
    const errors = cli.events.filter((e) => e.type === 'error').map((e) => String(e.message));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^names reached through the proxy must resolve to public addresses the scope does not deny: localhost resolves to (127\.0\.0\.1|::1), not on the public internet \(loopback\)/,
    );
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

describe.if(overlayTestsRun && networkTestsRun && cgroupTestsRun && vmTestsRun)(
  '--sandbox security --vm',
  () => {
    test("runs the model's commands in a guest of the host's kernel, whose first process is its init", async () => {
      const { home, project, file } = setUp({
        scope: { allow: [{ cidr: '198.51.100.0/24', ports: [443] }] },
      });
      server.handle(
        toolsThenText([{ name: 'bash', args: { command: 'uname -r; cat /proc/1/comm' } }]),
      );
      const cli = startCli(['--sandbox', 'security', '--engagement', file, '--vm', 'look'], {
        env: cliEnv(server, { HOME: home, ...bus() }),
        cwd: project,
      });
      const { code } = await cli.finished;
      expect(code).toBe(0);
      const results = toolMessages(server.requests.at(-1) as ChatRequest)
        .map((message) => String(message.content))
        .join('\n');
      expect(results).toContain(`${release()}\ninit`);
    }, 90_000);
  },
);

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

describe.if(overlayTestsRun && networkTestsRun && cgroupTestsRun)(
  '--sandbox security with an evidence log',
  () => {
    const logOf = (dir: string): string =>
      join(dir, readdirSync(dir).find((name) => name.endsWith('.jsonl')) as string);
    const verify = (args: string[]) => {
      const run = Bun.spawnSync(cliCommand(['--verify-evidence', ...args]), {
        env: cliEnv(server, {}),
      });
      return { code: run.exitCode, stdout: run.stdout.toString() };
    };

    test('leaves a log the verifier finds complete against the final hash the operator is given', async () => {
      const { home, project, file } = setUp({
        scope: { allow: [{ cidr: '198.51.100.0/24', ports: [443] }] },
        evidence: { dir: './evidence' },
      });
      server.handle(toolsThenText([{ name: 'bash', args: { command: 'echo evidence' } }]));
      const cli = startCli(['--sandbox', 'security', '--engagement', file, 'look'], {
        env: cliEnv(server, { HOME: home, ...bus() }),
        cwd: project,
      });
      const { code } = await cli.finished;
      expect(code).toBe(0);
      const notice = cli.events
        .filter((event) => event.type === 'info' || event.type === 'warning')
        .map((event) => String(event.message))
        .find((message) => message.startsWith('The evidence log '));
      const finalHash = /the SHA-256 of the last is ([0-9a-f]{64})/.exec(
        notice ?? '',
      )?.[1] as string;
      const log = logOf(join(file, '..', 'evidence'));
      const checked = verify([log, '--expected-hash', finalHash]);
      expect(checked.code).toBe(0);
      expect(checked.stdout).toStartWith('complete: ');
      expect(checked.stdout).toContain('the final hash is the one expected');
      expect(verify([log, '--expected-hash', '0'.repeat(64)]).code).toBe(1);
    }, 60_000);

    test('keeps a call whose host was killed during it, as one without an outcome', async () => {
      const { home, project, file } = setUp({
        scope: { allow: [{ cidr: '198.51.100.0/24', ports: [443] }] },
        evidence: { dir: './evidence' },
      });
      const sleep = uniqueSleep();
      server.handle(toolsThenText([{ name: 'bash', args: { command: sleep } }]));
      const cli = startCli(['--sandbox', 'security', '--engagement', file, 'look'], {
        env: cliEnv(server, { HOME: home, ...bus() }),
        cwd: project,
      });
      await cli.waitFor((event) => event.type === 'tool:start');
      await Bun.sleep(300);
      cli.child.kill('SIGKILL');
      await cli.finished;
      const checked = verify([logOf(join(file, '..', 'evidence'))]);
      expect(checked.code).toBe(4);
      expect(checked.stdout).toContain('- the session has no end recorded');
      expect(checked.stdout).toContain('- calls started without an outcome recorded: c1');
      // The sandbox ended with its host.
      await Bun.sleep(1_000);
      expect(Bun.spawnSync(['pgrep', '-f', sleep]).exitCode).toBe(1);
      // Its directory stays, for the next session to sweep: removed here, by the killed process's id.
      const runtime = process.env.XDG_RUNTIME_DIR as string;
      for (const name of readdirSync(runtime)) {
        if (name.startsWith(`nullrivet-${cli.child.pid}-`)) {
          rmSync(join(runtime, name), { recursive: true, force: true });
        }
      }
    }, 60_000);
  },
);
