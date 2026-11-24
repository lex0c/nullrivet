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
    expect(offered).toContain('bash_background');
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

  test('background jobs run in the sandbox and their end reaches the model', async () => {
    const { home, project } = workspace();
    server.handle((request) => {
      const results = toolMessages(request);
      if (results.length === 0) {
        return {
          toolCalls: [
            { name: 'bash_background', args: { command: 'echo from-job; ls /run; sleep 0.3' } },
          ],
        };
      }
      if (results.length === 1) {
        const id = /Started background job (\S+) /.exec(results[0]?.content ?? '')?.[1] ?? '';
        return { toolCalls: [{ name: 'bash_jobs', args: { id, wait_ms: 5_000 } }] };
      }
      return { text: 'done' };
    });
    const cli = startCli(['--sandbox', 'inspect', 'run it'], {
      env: cliEnv(server, { HOME: home }),
      cwd: project,
    });
    expect((await cli.finished).code).toBe(0);
    const results = toolMessages(server.requests.at(-1)).map((m) => m.content);
    expect(results[0]).toContain('Started background job');
    expect(results[1]).toContain('completed with exit code');
    expect(results[1]).toContain('from-job');
    expect(results[1]).toContain('No such file or directory');
  }, 30_000);

  test.skipIf(Bun.which('python3') === null)(
    'in the interactive session, a job that ends while it is idle starts a turn',
    async () => {
      const { home, project } = workspace();
      server.handle((request) => {
        const text = JSON.stringify(request.messages);
        if (text.includes('Background job')) return { text: 'noted the end' };
        return toolMessages(request).length === 0
          ? { toolCalls: [{ name: 'bash_background', args: { command: 'sleep 1' } }] }
          : { text: 'started' };
      });
      const before = server.requests.length;
      const child = Bun.spawn(inTerminal(cliCommand(['--sandbox', 'inspect'])), {
        env: { ...cliEnv(server, { HOME: home }), TERM: 'xterm-256color' },
        cwd: project,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await Bun.sleep(1_500);
      child.stdin.write('go\r');
      child.stdin.flush();
      const noted = (): boolean =>
        server.requests
          .slice(before)
          .some((r) => JSON.stringify(r.messages).includes('Background job'));
      const deadline = Date.now() + 20_000;
      while (!noted() && Date.now() < deadline) await Bun.sleep(100);
      await Bun.sleep(500);
      child.stdin.write('/exit\r');
      child.stdin.flush();
      const [, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      expect(noted()).toBe(true);
    },
    40_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'a job of a cleared conversation ends without a turn, and a new job is reported',
    async () => {
      const { home, project } = workspace();
      server.handle((request) => {
        const text = JSON.stringify(request.messages);
        if (text.includes('Background job')) return { text: 'noted the end' };
        if (toolMessages(request).length > 0) return { text: 'started' };
        const command = text.includes('second task') ? 'sleep 0.5' : 'sleep 2';
        return { toolCalls: [{ name: 'bash_background', args: { command } }] };
      });
      const before = server.requests.length;
      const sent = () => server.requests.slice(before).map((r) => JSON.stringify(r.messages));
      const waitFor = async (check: () => boolean, ms: number) => {
        const deadline = Date.now() + ms;
        while (!check() && Date.now() < deadline) await Bun.sleep(100);
        return check();
      };
      const child = Bun.spawn(inTerminal(cliCommand(['--sandbox', 'inspect'])), {
        env: { ...cliEnv(server, { HOME: home }), TERM: 'xterm-256color' },
        cwd: project,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const type = (text: string) => {
        child.stdin.write(`${text}\r`);
        child.stdin.flush();
      };
      await Bun.sleep(1_500);
      type('first task');
      expect(
        await waitFor(() => sent().some((m) => m.includes('Started background job')), 10_000),
      ).toBe(true);
      const firstJob = /Started background job (\S+) /.exec(
        sent().find((m) => m.includes('Started background job')) ?? '',
      )?.[1];
      expect(firstJob).toBeDefined();
      await Bun.sleep(500);
      type('/clear');
      const afterClear = server.requests.length;
      // The first job ends about two seconds after it started; its end must not start a turn.
      await Bun.sleep(3_000);
      expect(server.requests.length).toBe(afterClear);
      type('second task');
      expect(await waitFor(() => sent().some((m) => m.includes('Background job')), 15_000)).toBe(
        true,
      );
      await Bun.sleep(500);
      type('/exit');
      const [, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      const notes = sent().filter((m) => m.includes('Background job'));
      expect(notes.join('\n')).not.toContain(`${firstJob} `);
      expect(notes.join('\n')).toContain('completed with exit code 0');
    },
    60_000,
  );

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
