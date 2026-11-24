import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxTestsRun } from '../helpers/sandbox.ts';
import {
  type ChatRequest,
  cliCommand,
  cliEnv,
  type FakeOllama,
  inTerminal,
  processGone,
  processRunning,
  startCli,
  startFakeOllama,
  toolMessages,
} from './harness.ts';

let server: FakeOllama;
const dirs: string[] = [];
const tempDir = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-e2e-sandbox-')));
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

// A home with a key the sandbox must hide, and a repository beside it.
const workspace = () => {
  const base = tempDir();
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY OF THE HOST\n');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, 'notes.txt'), 'project notes\n');
  return { home, project };
};

const uniqueSleep = (): string => `sleep ${50 + Math.floor(Math.random() * 1_000) / 100}`;

describe.if(sandboxTestsRun)('--sandbox inspect', () => {
  test('runs the tools in the sandbox and tells the model its limits', async () => {
    const { home, project } = workspace();
    server.handle(
      toolsThenText([
        { name: 'read_file', args: { path: join(home, '.ssh', 'id_rsa') } },
        { name: 'bash', args: { command: `cat ${join(home, '.ssh', 'id_rsa')}; cat notes.txt` } },
      ]),
    );
    const cli = startCli(['--sandbox', 'inspect', 'look'], {
      env: cliEnv(server, { HOME: home, OTHER_SECRET: 'secret-of-the-host' }),
      cwd: project,
    });
    const { code } = await cli.finished;
    expect(code).toBe(0);
    const request = server.requests.at(-1);
    const results = toolMessages(request).map((m) => m.content);
    expect(results.join('\n')).not.toContain('PRIVATE KEY');
    expect(results[1]).toContain('project notes');
    const offered = (server.requests[0]?.tools ?? []).map((t) => t.function.name);
    expect(offered).toContain('bash');
    expect(offered).not.toContain('bash_background');
    expect(server.requests[0]?.messages[0]?.content).toContain('# Sandbox: inspect');
  }, 30_000);

  test('a process left in the sandbox ends when nullrivet is killed', async () => {
    for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
      const { home, project } = workspace();
      const sleep = uniqueSleep();
      server.handle(
        toolsThenText([
          {
            name: 'bash',
            args: {
              command: `setsid sh -c 'trap "" TERM; exec ${sleep}' >/dev/null 2>&1 & sleep 30`,
            },
          },
        ]),
      );
      const cli = startCli(['--sandbox', 'inspect', 'run it'], {
        env: cliEnv(server, { HOME: home }),
        cwd: project,
      });
      await cli.waitFor((e) => e.type === 'tool:start');
      const deadline = Date.now() + 5_000;
      while (!processRunning(sleep) && Date.now() < deadline) await Bun.sleep(50);
      expect(processRunning(sleep)).toBe(true);
      cli.child.kill(signal);
      await cli.finished;
      expect(await processGone(sleep, 5_000)).toBe(true);
    }
  }, 60_000);

  test.skipIf(Bun.which('python3') === null)(
    'the interactive session keeps its sandbox until it ends, and shows the profile',
    async () => {
      const { home, project } = workspace();
      server.handle(
        toolsThenText([{ name: 'bash', args: { command: 'echo in-sandbox; ls /run 2>&1' } }]),
      );
      const before = server.requests.length;
      const child = Bun.spawn(inTerminal(cliCommand(['--sandbox', 'inspect'])), {
        env: { ...cliEnv(server, { HOME: home }), TERM: 'xterm-256color' },
        cwd: project,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await Bun.sleep(1_500);
      child.stdin.write('look\r');
      child.stdin.flush();
      const answered = (): boolean =>
        server.requests.slice(before).some((request) => toolMessages(request).length > 0);
      const deadline = Date.now() + 15_000;
      while (!answered() && Date.now() < deadline) await Bun.sleep(100);
      await Bun.sleep(300);
      child.stdin.write('/exit\r');
      child.stdin.flush();
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      const result = server.requests
        .slice(before)
        .flatMap((request) => toolMessages(request))
        .map((m) => m.content)
        .join('\n');
      expect(result).toContain('in-sandbox');
      expect(result).toContain('No such file or directory');
      expect(output).toContain('inspect sandbox');
    },
    40_000,
  );

  test('a session saved in the sandbox warns when it continues without one', async () => {
    const { home, project } = workspace();
    server.handle(() => ({ text: 'ok' }));
    const env = cliEnv(server, { HOME: home });
    const first = startCli(['--sandbox', 'inspect', '--session', 's.json', 'look'], {
      env,
      cwd: project,
    });
    expect((await first.finished).code).toBe(0);
    expect(JSON.parse(readFileSync(join(project, 's.json'), 'utf8')).sandbox).toBe('inspect');
    const second = startCli(['--session', 's.json', 'go on'], { env, cwd: project });
    expect((await second.finished).code).toBe(0);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringContaining(
          'last ran its tools in the inspect sandbox and continues without one; pass --sandbox inspect',
        ),
      }),
    );
  }, 30_000);

  test('refuses a project that contains the home directory', async () => {
    const { home } = workspace();
    const cli = startCli(['--sandbox', 'inspect', 'look'], {
      env: cliEnv(server, { HOME: home }),
      cwd: home,
    });
    expect((await cli.finished).code).toBe(1);
    expect(cli.events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('contains the home directory'),
      }),
    );
  }, 30_000);
});

describe('--sandbox and the host it runs on', () => {
  test('never runs a bwrap found on PATH, such as one a project put there', async () => {
    const { home, project } = workspace();
    const planted = join(project, 'node_modules', '.bin');
    mkdirSync(planted, { recursive: true });
    const marker = join(project, 'planted-bwrap-ran');
    writeFileSync(join(planted, 'bwrap'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
      mode: 0o755,
    });
    symlinkSync(process.execPath, join(planted, 'bun'));
    server.handle(toolsThenText([{ name: 'bash', args: { command: 'echo ran' } }]));
    const cli = startCli(['--sandbox', 'inspect', 'look'], {
      env: cliEnv(server, { HOME: home, PATH: `${planted}:${process.env.PATH ?? ''}` }),
      cwd: project,
    });
    await cli.finished;
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test.if(process.platform !== 'linux')(
    'stops the session with the reason where there is no sandbox, without a request',
    async () => {
      const { home, project } = workspace();
      const requestsBefore = server.requests.length;
      const cli = startCli(['--sandbox', 'inspect', 'look'], {
        env: cliEnv(server, { HOME: home }),
        cwd: project,
      });
      expect((await cli.finished).code).toBe(1);
      expect(cli.events).toContainEqual(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('need Linux') }),
      );
      expect(server.requests.length).toBe(requestsBefore);
    },
    30_000,
  );
});
