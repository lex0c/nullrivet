import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savedOutputs } from '../helpers/saved-output.ts';
import {
  type ChatRequest,
  cliCommand,
  cliEnv,
  cliShellCommand,
  type FakeOllama,
  inTerminal,
  isSummaryRequest,
  processGone,
  processRunning,
  startCli,
  startFakeOllama,
  toolMessages,
} from './harness.ts';

let server: FakeOllama;
const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nullrivet-e2e-'));
  dirs.push(dir);
  return dir;
};

beforeAll(() => {
  server = startFakeOllama();
});

afterAll(() => {
  server.stop();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Replies with the given tool calls to the first request of the task, then with `text`.
const toolsThenText = (calls: { name: string; args: Record<string, unknown> }[], text = 'done') => {
  return (request: ChatRequest) =>
    toolMessages(request).length === 0 ? { toolCalls: calls } : { text };
};

// A sleep with a duration no other process uses, so it can be found by its command line.
const uniqueSleep = (): string => `sleep ${40 + Math.floor(Math.random() * 1_000) / 100}`;

describe('output', () => {
  test('a slow reader receives all of the output', async () => {
    const chunks = Array.from({ length: 2_000 }, () => 'x'.repeat(100));
    server.handle(() => ({ text: chunks }));
    const command = `${cliShellCommand(['--json', 'hello'])} </dev/null | (sleep 1; cat)`;
    const child = Bun.spawn(['bash', '-c', command], {
      env: cliEnv(server),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    const events = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string });
    const text = events
      .filter((e) => e.type === 'text:delta')
      .map((e) => e.text)
      .join('');
    expect(text.length).toBe(200_000);
    expect(events.at(-1)?.type).toBe('agent:end');
  }, 30_000);

  test('an interrupt after the task ends exits while the output waits for its reader', async () => {
    server.handle(() => ({ text: Array.from({ length: 2_000 }, () => 'x'.repeat(100)) }));
    const fifo = join(tempDir(), 'out');
    Bun.spawnSync(['mkfifo', fifo]);
    // The read end stays open and is never read, so the output stops once the FIFO is full.
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    const writer = openSync(fifo, constants.O_WRONLY);
    try {
      const child = Bun.spawn(cliCommand(['--json', 'hello']), {
        env: cliEnv(server),
        stdin: 'ignore',
        stdout: writer,
        stderr: 'ignore',
      });
      await Bun.sleep(1_500);
      child.kill('SIGINT');
      const exited = await Promise.race([
        child.exited,
        Bun.sleep(3_000).then(() => 'still running'),
      ]);
      if (exited === 'still running') child.kill('SIGKILL');
      expect(exited).toBe(130);
    } finally {
      closeSync(writer);
      closeSync(reader);
    }
  }, 30_000);
});

describe('cancellation', () => {
  test('an interrupt stops a running command and every process it started', async () => {
    const sleep = uniqueSleep();
    server.handle(toolsThenText([{ name: 'bash', args: { command: `${sleep} & ${sleep}` } }]));
    const cli = startCli(['run it'], { env: cliEnv(server), cwd: tempDir() });
    await cli.waitFor((e) => e.type === 'tool:start');
    await Bun.sleep(500);
    expect(processRunning(sleep)).toBe(true);
    cli.child.kill('SIGINT');
    const { code } = await cli.finished;
    expect(code).toBe(130);
    expect(await processGone(sleep)).toBe(true);
  }, 30_000);

  test('the time limit ends the task at a limit and stops its commands', async () => {
    const sleep = uniqueSleep();
    server.handle(toolsThenText([{ name: 'bash', args: { command: sleep } }]));
    const cli = startCli(['--timeout', '2s', 'run it'], { env: cliEnv(server), cwd: tempDir() });
    const { code } = await cli.finished;
    expect(code).toBe(3);
    expect(cli.events.at(-1)).toMatchObject({
      type: 'agent:end',
      reason: 'budget',
      message: 'time limit of 2s reached',
    });
    expect(await processGone(sleep)).toBe(true);
  }, 30_000);
});

describe('saved output', () => {
  test('a reduced result names files that exist during the run and are removed at exit', async () => {
    const tmp = tempDir();
    let named: string[] = [];
    let existedDuringRun = false;
    server.handle((request) => {
      const results = toolMessages(request);
      if (results.length === 0) {
        return { toolCalls: [{ name: 'bash', args: { command: 'seq 1 100000' } }] };
      }
      named = savedOutputs(results[0]?.content ?? '')[0] ?? [];
      existedDuringRun = named.length > 0 && named.every((part) => existsSync(part));
      return { text: 'done' };
    });
    const cli = startCli(['run it'], { env: cliEnv(server, { TMPDIR: tmp }), cwd: tempDir() });
    const { code } = await cli.finished;
    expect(code).toBe(0);
    expect(named).toHaveLength(1);
    expect(named[0]?.startsWith(join(tmp, 'nullrivet-'))).toBe(true);
    expect(existedDuringRun).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  test('the files are removed when an interrupt ends the run', async () => {
    const tmp = tempDir();
    const sleep = uniqueSleep();
    server.handle(toolsThenText([{ name: 'bash', args: { command: `seq 1 100000; ${sleep}` } }]));
    const cli = startCli(['run it'], { env: cliEnv(server, { TMPDIR: tmp }), cwd: tempDir() });
    await cli.waitFor((e) => e.type === 'tool:start');
    const deadline = Date.now() + 10_000;
    while (readdirSync(tmp).length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(readdirSync(tmp)).toHaveLength(1);
    cli.child.kill('SIGINT');
    const { code } = await cli.finished;
    expect(code).toBe(130);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  test('a hangup stops running commands and removes the files', async () => {
    const tmp = tempDir();
    const sleep = uniqueSleep();
    server.handle(toolsThenText([{ name: 'bash', args: { command: `seq 1 100000; ${sleep}` } }]));
    const cli = startCli(['run it'], { env: cliEnv(server, { TMPDIR: tmp }), cwd: tempDir() });
    await cli.waitFor((e) => e.type === 'tool:start');
    const deadline = Date.now() + 10_000;
    while (readdirSync(tmp).length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(processRunning(sleep)).toBe(true);
    cli.child.kill('SIGHUP');
    const { code } = await cli.finished;
    expect(code).toBe(129);
    expect(await processGone(sleep)).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);
});

describe('background jobs', () => {
  test('a job still running when the task ends is stopped on exit, and its log removed', async () => {
    const tmp = tempDir();
    const sleep = uniqueSleep();
    let started = '';
    server.handle((request) => {
      const results = toolMessages(request);
      if (results.length === 0) {
        return { toolCalls: [{ name: 'bash_background', args: { command: `echo up; ${sleep}` } }] };
      }
      started = results[0]?.content ?? '';
      return { text: 'done' };
    });
    const cli = startCli(['run it'], { env: cliEnv(server, { TMPDIR: tmp }), cwd: tempDir() });
    const { code } = await cli.finished;
    expect(code).toBe(0);
    expect(started).toStartWith('Started background job ');
    // A one-shot run must wait for what it needs before it ends, so it is not told to end its turn.
    expect(started).not.toContain('end your turn');
    expect(await processGone(sleep)).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);
});

describe('subagents', () => {
  test('a one-shot run does the work itself: delegate is not offered', async () => {
    server.handle(() => ({ text: 'ok' }));
    const cli = startCli(['look around'], { env: cliEnv(server), cwd: tempDir() });
    expect((await cli.finished).code).toBe(0);
    const request = server.requests[0];
    const offered = (request?.tools ?? []).map((t) => t.function.name);
    expect(offered).toContain('grep');
    expect(offered).not.toContain('delegate');
    expect(request?.messages[0]?.content).not.toContain('# Delegation');
  }, 30_000);
});

describe('readonly mode', () => {
  test('a write or a command requested by the model is refused and has no effect', async () => {
    const cwd = tempDir();
    server.handle(
      toolsThenText([
        { name: 'write_file', args: { path: 'created.txt', content: 'x' } },
        { name: 'bash', args: { command: 'touch touched.txt' } },
      ]),
    );
    const cli = startCli(['--permission', 'readonly', 'change things'], {
      env: cliEnv(server),
      cwd,
    });
    expect((await cli.finished).code).toBe(0);
    expect(existsSync(join(cwd, 'created.txt'))).toBe(false);
    expect(existsSync(join(cwd, 'touched.txt'))).toBe(false);
    const results = toolMessages(server.requests.at(-1)).map((m) => m.content);
    expect(results).toHaveLength(2);
    for (const result of results) expect(result).toContain('[policy.denied]');
    const offered = (server.requests[0]?.tools ?? []).map((t) => t.function.name);
    expect(offered).not.toContain('write_file');
    expect(offered).not.toContain('bash');
  }, 30_000);
});

describe('tools', () => {
  test('grep searches in its worker', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'a.txt'), 'hay\nneedle here\n');
    server.handle(toolsThenText([{ name: 'grep', args: { pattern: 'needle' } }]));
    const cli = startCli(['find it'], { env: cliEnv(server), cwd });
    expect((await cli.finished).code).toBe(0);
    expect(toolMessages(server.requests.at(-1))[0]?.content).toBe('a.txt:2: needle here');
  }, 30_000);
});

describe('context', () => {
  test('a long task is compacted with a summary and carries on', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'big.txt'), 'line of text\n'.repeat(700));
    // Counted here: compaction removes earlier tool results from the requests.
    let reads = 0;
    server.handle((request) => {
      if (isSummaryRequest(request)) {
        return { text: 'GOAL:\nread big.txt\nNEXT:\nfinish\nERRORS:\n(none)' };
      }
      reads++;
      return reads <= 4
        ? { toolCalls: [{ name: 'read_file', args: { path: 'big.txt' } }] }
        : { text: 'done' };
    });
    const cli = startCli(['--context-window', '12000', 'read it a few times'], {
      env: cliEnv(server),
      cwd,
    });
    expect((await cli.finished).code).toBe(0);
    expect(cli.events.find((e) => e.type === 'context:compact')).toMatchObject({
      strategy: 'llm',
    });
    expect(cli.events.at(-1)).toMatchObject({ type: 'agent:end', reason: 'done' });
  }, 30_000);

  test('piped input reaches the model as fenced data after the prompt', async () => {
    server.handle(() => ({ text: 'reviewed' }));
    const cli = startCli(['review this'], {
      env: cliEnv(server),
      cwd: tempDir(),
      stdin: 'the diff',
    });
    expect((await cli.finished).code).toBe(0);
    const user = server.requests[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toMatch(/^review this\n\n<input fence="[0-9a-f]{12}">\nthe diff\n<\/input fence=/);
  }, 30_000);
});

describe('sessions', () => {
  test('two runs with the same session file form one conversation', async () => {
    const cwd = tempDir();
    server.handle(() => ({ text: 'noted' }));
    const first = startCli(['--session', 'run.json', 'remember the number 7'], {
      env: cliEnv(server),
      cwd,
    });
    expect((await first.finished).code).toBe(0);
    // No model is given the second time: the session's is used.
    const env = cliEnv(server);
    delete env.NULLRIVET_MODEL;
    const second = startCli(['--session', 'run.json', 'which number?'], { env, cwd });
    expect((await second.finished).code).toBe(0);
    const users = (server.requests.at(-1)?.messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(users.some((c) => c.includes('remember the number 7'))).toBe(true);
    expect(users.at(-1)).toContain('which number?');
  }, 30_000);

  test('a run killed mid-task resumes from the last completed step', async () => {
    const cwd = tempDir();
    const sleep = uniqueSleep();
    server.handle((request) =>
      toolMessages(request).length === 0
        ? { toolCalls: [{ name: 'bash', args: { command: 'echo first-step-done' } }] }
        : { toolCalls: [{ name: 'bash', args: { command: sleep } }] },
    );
    const killed = startCli(['--session', 's.json', 'two steps'], { env: cliEnv(server), cwd });
    await killed.waitFor((e) => e.type === 'tool:start' && e.step === 2);
    killed.child.kill('SIGKILL');
    await killed.finished;
    Bun.spawnSync(['pkill', '-f', sleep]);

    server.handle(() => ({ text: 'continuing' }));
    const resumed = startCli(['--session', 's.json', 'go on'], { env: cliEnv(server), cwd });
    expect((await resumed.finished).code).toBe(0);
    // Only the first step was saved: the second was cut off before its results.
    const results = toolMessages(server.requests.at(-1)).map((m) => m.content);
    expect(results).toHaveLength(1);
    expect(results[0]).toStartWith('first-step-done');
  }, 30_000);

  test('the permission mode is never taken from the session', async () => {
    const cwd = tempDir();
    server.handle(() => ({ text: 'ok' }));
    const first = startCli(['--permission', 'readonly', '--session', 's.json', 'look'], {
      env: cliEnv(server),
      cwd,
    });
    expect((await first.finished).code).toBe(0);
    const second = startCli(['--session', 's.json', 'now change things'], {
      env: cliEnv(server),
      cwd,
    });
    expect((await second.finished).code).toBe(0);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringContaining('last run in readonly mode'),
      }),
    );
    const offered = (server.requests.at(-1)?.tools ?? []).map((t) => t.function.name);
    expect(offered).toContain('bash');
  }, 30_000);

  test('a file that is not a session is refused and left as it was', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'notes.json'), '{"keep":"me"}');
    const cli = startCli(['--session', 'notes.json', 'hello'], { env: cliEnv(server), cwd });
    const { code } = await cli.finished;
    expect(code).toBe(2);
    expect(cli.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('not a nullrivet session file'),
    });
    expect(readFileSync(join(cwd, 'notes.json'), 'utf8')).toBe('{"keep":"me"}');
  }, 30_000);
});

describe('working directory', () => {
  test('a .env or bunfig.toml in the directory is neither loaded nor run', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, '.env'), 'NULLRIVET_PERMISSION=not-a-mode\n');
    writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
    writeFileSync(
      join(cwd, 'preload.ts'),
      `await Bun.write(${JSON.stringify(join(cwd, 'ran'))}, 'x');\n`,
    );
    server.handle(() => ({ text: 'ok' }));
    const cli = startCli(['hello'], { env: cliEnv(server), cwd });
    const { code, stderr } = await cli.finished;
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  }, 30_000);
});

describe('terminal', () => {
  test.skipIf(Bun.which('python3') === null)(
    'the interactive session starts in a terminal and exits with /exit',
    async () => {
      server.handle(() => ({ text: 'ok' }));
      const cwd = tempDir();
      mkdirSync(join(cwd, 'sub'));
      const child = Bun.spawn(inTerminal(cliCommand([])), {
        env: { ...cliEnv(server), TERM: 'xterm-256color' },
        cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await Bun.sleep(1_500);
      child.stdin.write('/exit\r');
      child.stdin.flush();
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      expect(output).toContain('Type /help for commands');
    },
    30_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'Ctrl+C twice on an idle session exits with code 0',
    async () => {
      const child = Bun.spawn(inTerminal(cliCommand([])), {
        env: { ...cliEnv(server), TERM: 'xterm-256color' },
        cwd: tempDir(),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await Bun.sleep(1_500);
      child.stdin.write('\x03');
      child.stdin.flush();
      await Bun.sleep(200);
      child.stdin.write('\x03');
      child.stdin.flush();
      const [, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
    },
    30_000,
  );

  // Starts a session, sends `prompt`, and waits until that turn has ended on screen, so a slash
  // command typed next is not refused.
  const interactiveSession = async (prompt: string) => {
    const child = Bun.spawn(inTerminal(cliCommand([])), {
      env: { ...cliEnv(server), TERM: 'xterm-256color' },
      cwd: tempDir(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let output = '';
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
    })();
    const type = (text: string): void => {
      child.stdin.write(text);
      child.stdin.flush();
    };
    const until = async (check: () => boolean, ms = 10_000): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (!check() && Date.now() < deadline) await Bun.sleep(50);
      return check();
    };
    const requests = (count: number): Promise<boolean> =>
      until(() => server.requests.length >= count);
    // `Worked for` closes every turn that ends with done.
    const turnsEnded = (count: number): Promise<boolean> =>
      until(() => output.split('Worked for').length - 1 >= count);
    const exit = async (): Promise<{ code: number; output: string }> => {
      type('/exit\r');
      const code = await child.exited;
      await reading;
      return { code, output };
    };
    expect(await until(() => output.includes('Type /help for commands'))).toBe(true);
    type(`${prompt}\r`);
    expect(await turnsEnded(1)).toBe(true);
    return { type, until, requests, turnsEnded, exit, screen: () => output };
  };

  // A session whose first task starts `sleep <seconds>` in the background.
  const sessionWithJob = async (seconds: number) => {
    server.handle((request) => {
      const last = request.messages.at(-1);
      if (last?.role === 'user' && last.content.includes('<agent-note>Background job')) {
        return { text: 'reacted' };
      }
      if (last?.role === 'user' && last.content.includes('hello')) return { text: 'hi' };
      return toolMessages(request).length === 0
        ? { toolCalls: [{ name: 'bash_background', args: { command: `sleep ${seconds}` } }] }
        : { text: 'started' };
    });
    const session = await interactiveSession('start the job');
    expect(server.requests).toHaveLength(2);
    return session;
  };

  const isSubagentRequest = (request: ChatRequest | undefined): boolean =>
    request?.messages[0]?.role === 'system' && request.messages[0].content.includes('# Subagent');

  // A session whose first task delegates one investigation. The subagent's request is answered
  // only once `release` is called.
  const sessionWithSubagent = async () => {
    const gate = Promise.withResolvers<void>();
    server.handle(async (request) => {
      if (isSubagentRequest(request)) {
        await gate.promise;
        return { text: 'The parser is in src/parse.ts.' };
      }
      const last = request.messages.at(-1);
      if (last?.role === 'user' && last.content.includes('<agent-note>Subagent')) {
        return { text: 'reacted' };
      }
      if (last?.role === 'user' && last.content.includes('what now')) return { text: 'noted' };
      return toolMessages(request).length === 0
        ? {
            toolCalls: [
              {
                name: 'delegate',
                args: { title: 'find the parser', objective: 'Find the parser.' },
              },
            ],
          }
        : { text: 'delegated' };
    });
    const session = await interactiveSession('look into it');
    const parentRequests = (): ChatRequest[] =>
      server.requests.filter((request) => !isSubagentRequest(request));
    expect(parentRequests()).toHaveLength(2);
    return { ...session, parentRequests, release: () => gate.resolve() };
  };

  test.skipIf(Bun.which('python3') === null)(
    'a job that ends while the session is idle starts a turn of its own',
    async () => {
      const session = await sessionWithJob(0.5);
      expect(await session.turnsEnded(2)).toBe(true);
      expect(server.requests).toHaveLength(3);
      const last = server.requests[2]?.messages.at(-1);
      expect(last?.role).toBe('user');
      expect(last?.content).toMatch(/^<agent-note>Background job \S+ completed with exit code 0/);
      expect(last?.content).not.toContain('start the job');
      const { code, output } = await session.exit();
      expect(code).toBe(0);
      expect(output).toContain('Continuing on background events.');
    },
    30_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'after /clear and a new prompt, a job of the discarded conversation does not start a turn',
    async () => {
      const session = await sessionWithJob(2);
      // The footer counts the job while it runs.
      expect(await session.until(() => session.screen().includes('1 job'))).toBe(true);
      session.type('/clear\r');
      expect(await session.until(() => session.screen().includes('Conversation cleared.'))).toBe(
        true,
      );
      session.type('hello\r');
      expect(await session.turnsEnded(2)).toBe(true);
      // The job ends about 2s after it started; a turn would follow within the 250ms delay.
      await Bun.sleep(2_500);
      expect(server.requests).toHaveLength(3);
      expect(JSON.stringify(server.requests[2]?.messages)).not.toContain('Background job');
      expect((await session.exit()).code).toBe(0);
    },
    30_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'text being typed holds back the automatic turn, and the prompt then carries the event',
    async () => {
      const session = await sessionWithJob(0.5);
      session.type('what now');
      // The job ends about 0.5s after it started, while the text is still in the prompt.
      await Bun.sleep(1_500);
      expect(server.requests).toHaveLength(2);
      session.type('\r');
      expect(await session.turnsEnded(2)).toBe(true);
      await Bun.sleep(1_000);
      expect(server.requests).toHaveLength(3);
      const last = server.requests[2]?.messages.at(-1);
      expect(last?.content).toContain('what now');
      expect(last?.content).toContain('<agent-note>Background job');
      expect((await session.exit()).code).toBe(0);
    },
    30_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'a subagent that reports while the session is idle starts a turn with its report',
    async () => {
      const session = await sessionWithSubagent();
      expect(await session.until(() => session.screen().includes('Subagent find the parser'))).toBe(
        true,
      );
      // The footer counts the subagent and says how to cancel it.
      expect(await session.until(() => session.screen().includes('1 subagent'))).toBe(true);
      expect(session.screen()).toContain('esc to cancel subagents');
      session.release();
      expect(await session.turnsEnded(2)).toBe(true);
      const requests = session.parentRequests();
      expect(requests).toHaveLength(3);
      const last = requests[2]?.messages.at(-1);
      expect(last?.role).toBe('user');
      expect(last?.content).toMatch(/^<agent-note>Subagent \S+ completed after 1 step/);
      expect(last?.content).toContain('Title: find the parser');
      expect(last?.content).toContain('The parser is in src/parse.ts.');
      const { code, output } = await session.exit();
      expect(code).toBe(0);
      expect(output).toContain('Continuing on background events.');
    },
    30_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'Esc on an idle session cancels its subagents without starting a turn',
    async () => {
      const session = await sessionWithSubagent();
      expect(await session.until(() => session.screen().includes('Subagent find the parser'))).toBe(
        true,
      );
      session.type('\x1b');
      expect(
        await session.until(() => session.screen().includes('Background subagents cancelled.')),
      ).toBe(true);
      await Bun.sleep(1_000);
      expect(session.parentRequests()).toHaveLength(2);
      // The cancellation reaches the model with the next prompt.
      session.type('what now\r');
      expect(await session.turnsEnded(2)).toBe(true);
      const last = session.parentRequests()[2]?.messages.at(-1);
      expect(last?.content).toMatch(/<agent-note>Subagent \S+ cancelled \(cancelled\)/);
      expect(last?.content).toContain('what now');
      session.release();
      expect((await session.exit()).code).toBe(0);
    },
    30_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'Shift+Tab switches the session to readonly before the next tool call',
    async () => {
      server.handle(
        toolsThenText([{ name: 'write_file', args: { path: 'created.txt', content: 'x' } }]),
      );
      const cwd = tempDir();
      const child = Bun.spawn(inTerminal(cliCommand(['--session', 's.json'])), {
        env: { ...cliEnv(server), TERM: 'xterm-256color' },
        cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await Bun.sleep(1_500);
      child.stdin.write('\x1b[Z');
      child.stdin.flush();
      await Bun.sleep(300);
      child.stdin.write('create the file\r');
      child.stdin.flush();
      await Bun.sleep(1_500);
      child.stdin.write('/exit\r');
      child.stdin.flush();
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      expect(output).toContain('readonly mode on');
      expect(output).toContain(
        'Execution mode set to readonly; it applies from the next tool call.',
      );
      expect(existsSync(join(cwd, 'created.txt'))).toBe(false);
      const results = toolMessages(server.requests.at(-1)).map((m) => m.content);
      expect(results).toHaveLength(1);
      expect(results[0]).toContain('[policy.denied]');
      expect(JSON.parse(readFileSync(join(cwd, 's.json'), 'utf8')).mode).toBe('readonly');
    },
    30_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'a prompt of a saved session is recalled with ↑ and sent again',
    async () => {
      server.handle(() => ({ text: 'ok' }));
      const cwd = tempDir();
      const first = startCli(['--session', 's.json', 'the first prompt'], {
        env: cliEnv(server),
        cwd,
      });
      expect((await first.finished).code).toBe(0);
      const child = Bun.spawn(inTerminal(cliCommand(['--session', 's.json'])), {
        env: { ...cliEnv(server), TERM: 'xterm-256color' },
        cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await Bun.sleep(1_500);
      child.stdin.write('\x1b[A');
      child.stdin.flush();
      await Bun.sleep(300);
      child.stdin.write('\r');
      child.stdin.flush();
      await Bun.sleep(1_500);
      child.stdin.write('/exit\r');
      child.stdin.flush();
      const [, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      expect(server.requests).toHaveLength(2);
      const prompts = (server.requests[1]?.messages ?? []).filter(
        (m) => m.role === 'user' && m.content.includes('the first prompt'),
      );
      expect(prompts).toHaveLength(2);
      expect(JSON.parse(readFileSync(join(cwd, 's.json'), 'utf8')).history).toEqual([
        'the first prompt',
        '/exit',
      ]);
    },
    30_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'a recalled prompt reaches the terminal without its escape sequences',
    async () => {
      server.handle(() => ({ text: 'ok' }));
      const cwd = tempDir();
      const first = startCli(['--session', 's.json', 'say \x1b]0;injected\x07hello'], {
        env: cliEnv(server),
        cwd,
      });
      expect((await first.finished).code).toBe(0);
      const child = Bun.spawn(inTerminal(cliCommand(['--session', 's.json'])), {
        env: { ...cliEnv(server), TERM: 'xterm-256color' },
        cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await Bun.sleep(1_500);
      child.stdin.write('\x1b[A');
      child.stdin.flush();
      await Bun.sleep(300);
      // Ctrl+C clears the recalled prompt without sending it.
      child.stdin.write('\x03');
      child.stdin.flush();
      await Bun.sleep(200);
      child.stdin.write('/exit\r');
      child.stdin.flush();
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      expect(output).toContain('say hello');
      expect(output).not.toContain('\x1b]0;injected');
    },
    30_000,
  );

  test.skipIf(Bun.which('python3') === null)(
    'leaving the interactive session in the middle of a turn still saves the session',
    async () => {
      // The command ignores SIGTERM, so after the first Ctrl+C the turn keeps running for the
      // grace period before SIGKILL; the second Ctrl+C leaves during it.
      const sleep = uniqueSleep();
      server.handle(toolsThenText([{ name: 'bash', args: { command: `trap '' TERM; ${sleep}` } }]));
      const cwd = tempDir();
      const child = Bun.spawn(inTerminal(cliCommand(['--session', 's.json'])), {
        env: { ...cliEnv(server), TERM: 'xterm-256color' },
        cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await Bun.sleep(1_500);
      child.stdin.write('a prompt worth keeping\r');
      child.stdin.flush();
      await Bun.sleep(1_000);
      expect(processRunning(sleep)).toBe(true);
      // Ctrl+C twice: interrupt the turn, then leave while it is still stopping.
      child.stdin.write('\x03');
      child.stdin.flush();
      await Bun.sleep(200);
      child.stdin.write('\x03');
      child.stdin.flush();
      const [, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(130);
      expect(readFileSync(join(cwd, 's.json'), 'utf8')).toContain('a prompt worth keeping');
      Bun.spawnSync(['pkill', '-KILL', '-f', sleep]);
    },
    30_000,
  );
});
