import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../../src/sanitize/ansi.ts';
import { overlayTestsRun, tmpfsDirectory } from '../helpers/sandbox.ts';
import {
  type ChatRequest,
  type CliEvent,
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

beforeAll(() => {
  server = startFakeOllama();
});
afterAll(() => server.stop());
// Sessions in a terminal still running when their test ends, as one that failed leaves them.
const terminals: { kill: () => void }[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.kill();
  for (const dir of dirs.splice(0)) {
    Bun.spawnSync(['chmod', '-R', 'u+rwx', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A repository and a home, and the runtime directory a login session provides, on a tmpfs.
const setup = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-e2e-workspace-')));
  const runtime = tmpfsDirectory('nullrivet-e2e-runtime-');
  dirs.push(base, runtime);
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(home);
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, 'app.txt'), 'one\n');
  writeFileSync(join(project, 'notes.txt'), 'notes\n');
  return {
    project,
    runtime,
    env: cliEnv(server, { HOME: home, XDG_RUNTIME_DIR: runtime }),
    file: (name: string) => join(project, name),
  };
};

const CHANGES =
  "printf 'one\\ntwo\\n' > app.txt; echo new > added.txt; rm notes.txt; echo ref > .git/HEAD";

// One bash call that changes the project, then the answer.
const changesThenText = (afterTools?: () => void) => (request: ChatRequest) => {
  if (toolMessages(request).length === 0) {
    return { toolCalls: [{ name: 'bash', args: { command: CHANGES } }] };
  }
  afterTools?.();
  return { text: 'done' };
};

const preview = (events: CliEvent[]): string[] => {
  const event = events.find((e) => e.type === 'changes:preview') as
    | { changes: { change: string; path: string }[] }
    | undefined;
  return (event?.changes ?? []).map((entry) => `${entry.change} ${entry.path}`).sort();
};

const untouched = (w: ReturnType<typeof setup>): void => {
  expect(readFileSync(w.file('app.txt'), 'utf8')).toBe('one\n');
  expect(readFileSync(w.file('notes.txt'), 'utf8')).toBe('notes\n');
  expect(existsSync(w.file('added.txt'))).toBe(false);
  expect(readdirSync(w.file('.git'))).toEqual([]);
};

describe.if(overlayTestsRun)('--sandbox workspace', () => {
  test('keeps the changes in the sandbox, shows them and discards them without --apply', async () => {
    const w = setup();
    server.handle(changesThenText());
    const cli = startCli(['--sandbox', 'workspace', 'change it'], { env: w.env, cwd: w.project });
    const { code, stderr } = await cli.finished;
    expect(code, stderr).toBe(0);
    untouched(w);
    expect(preview(cli.events)).toEqual([
      'added added.txt',
      'modified app.txt',
      'refused .git',
      'removed notes.txt',
    ]);
    expect(cli.events).toContainEqual(
      expect.objectContaining({ type: 'changes:discarded', reason: 'not-requested', count: 4 }),
    );
    expect(server.requests[0]?.messages[0]?.content).toContain('# Sandbox: workspace');
    // The session's directory goes with it.
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 30_000);

  test('applies the changes with --apply when the task finishes, .git aside', async () => {
    const w = setup();
    server.handle(changesThenText());
    const cli = startCli(['--sandbox', 'workspace', '--apply', 'change it'], {
      env: w.env,
      cwd: w.project,
    });
    const { code, stderr } = await cli.finished;
    expect(code, stderr).toBe(0);
    expect(readFileSync(w.file('app.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(w.file('added.txt'), 'utf8')).toBe('new\n');
    expect(existsSync(w.file('notes.txt'))).toBe(false);
    expect(readdirSync(w.file('.git'))).toEqual([]);
    const applied = cli.events.find((e) => e.type === 'changes:applied') as unknown as {
      applied: string[];
      notApplied: { path: string; status: string; reason?: string }[];
      stopped: unknown;
    };
    expect(applied.applied.sort()).toEqual(['added.txt', 'app.txt', 'notes.txt']);
    expect(applied.notApplied).toEqual([
      { path: '.git', status: 'refused', reason: '.git is never changed' },
    ]);
    expect(applied.stopped).toBeNull();
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 30_000);

  test('exits with 4 when a change conflicts with the host, and applies the rest', async () => {
    const w = setup();
    server.handle(changesThenText(() => writeFileSync(w.file('app.txt'), 'operator\n')));
    const cli = startCli(['--sandbox', 'workspace', '--apply', 'change it'], {
      env: w.env,
      cwd: w.project,
    });
    const { code, stderr } = await cli.finished;
    expect(code, stderr).toBe(4);
    expect(readFileSync(w.file('app.txt'), 'utf8')).toBe('operator\n');
    expect(readFileSync(w.file('added.txt'), 'utf8')).toBe('new\n');
    const applied = cli.events.find((e) => e.type === 'changes:applied') as unknown as {
      notApplied: { path: string; status: string; reason?: string }[];
    };
    expect(applied.notApplied).toContainEqual({
      path: 'app.txt',
      status: 'conflict',
      reason: 'the file changed on the host',
    });
  }, 30_000);

  test('discards the changes of a task that does not finish, even with --apply', async () => {
    const w = setup();
    server.handle(changesThenText());
    const cli = startCli(['--sandbox', 'workspace', '--apply', '--max-steps', '1', 'change it'], {
      env: w.env,
      cwd: w.project,
    });
    const { code, stderr } = await cli.finished;
    expect(code, stderr).toBe(3);
    untouched(w);
    expect(cli.events).toContainEqual(
      expect.objectContaining({ type: 'changes:discarded', reason: 'task-not-done' }),
    );
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 30_000);

  test('discards the changes of an interrupted task, and removes its directory', async () => {
    const w = setup();
    server.handle((request) =>
      toolMessages(request).length === 0
        ? { toolCalls: [{ name: 'bash', args: { command: `${CHANGES}; sleep 30` } }] }
        : { text: 'done' },
    );
    const cli = startCli(['--sandbox', 'workspace', '--apply', 'change it'], {
      env: w.env,
      cwd: w.project,
    });
    await cli.waitFor((e) => e.type === 'tool:start');
    // The changes are made before the sleep.
    await Bun.sleep(500);
    cli.child.kill('SIGINT');
    const { code, stderr } = await cli.finished;
    expect(code, stderr).toBe(130);
    untouched(w);
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 30_000);

  test('shows the changes on stderr with their names escaped', async () => {
    const w = setup();
    server.handle((request) =>
      toolMessages(request).length === 0
        ? {
            toolCalls: [
              {
                name: 'bash',
                args: {
                  command: `${CHANGES}; printf x > "$(printf 'two\\nlines\\342\\200\\256')"; echo 'echo hi' > .envrc`,
                },
              },
            ],
          }
        : { text: 'done' },
    );
    const child = Bun.spawn(cliCommand(['--sandbox', 'workspace', 'change it']), {
      env: w.env,
      cwd: w.project,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stderr).toContain('Changes in the sandbox:');
    expect(stderr).toContain('modified app.txt');
    expect(stderr).toContain('+ two');
    expect(stderr).toContain('added    two\\nlines\\u{202e}');
    expect(stderr).toContain('.envrc');
    expect(stderr).toContain('! runs when a shell enters its directory');
    expect(stderr).toContain('run the task with --apply to apply them');
    untouched(w);
  }, 30_000);

  test('refuses a session file inside the project', async () => {
    const w = setup();
    const cli = startCli(['--sandbox', 'workspace', '--session', 's.json', 'change it'], {
      env: w.env,
      cwd: w.project,
    });
    const { code } = await cli.finished;
    expect(code).toBe(2);
    expect(cli.events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('is in the project'),
      }),
    );
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 30_000);

  test('refuses to start without a runtime directory of the user', async () => {
    const w = setup();
    const { XDG_RUNTIME_DIR: _, ...env } = w.env;
    const cli = startCli(['--sandbox', 'workspace', 'change it'], { env, cwd: w.project });
    const { code } = await cli.finished;
    expect(code).toBe(1);
    expect(cli.events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('XDG_RUNTIME_DIR'),
      }),
    );
  }, 30_000);
});

// An interactive session in a terminal, whose output is read as it comes.
const interactive = (w: ReturnType<typeof setup>) => {
  const child = Bun.spawn(inTerminal(cliCommand(['--sandbox', 'workspace'])), {
    env: { ...w.env, TERM: 'xterm-256color' },
    cwd: w.project,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  terminals.push(child);
  let output = '';
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
  })();
  // The terminal output with its escape sequences removed.
  const text = (): string => stripAnsi(output);
  const waitFor = async (pattern: RegExp, from = 0): Promise<RegExpExecArray> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const found = pattern.exec(text().slice(from));
      if (found !== null) return found;
      if (Date.now() > deadline) throw new Error(`no ${pattern} in:\n${text().slice(from)}`);
      await Bun.sleep(50);
    }
  };
  const type = (input: string): void => {
    child.stdin.write(input);
    child.stdin.flush();
  };
  const exited = async (): Promise<number> => {
    const code = await child.exited;
    await reading;
    return code;
  };
  return { child, text, waitFor, type, exited };
};

// The prompt `change it` makes the changes; `look` reads the project in the sandbox.
const byPrompt = (request: ChatRequest) => {
  const last = request.messages.at(-1);
  if (last?.role === 'user' && last.content.includes('change it')) {
    return { toolCalls: [{ name: 'bash', args: { command: CHANGES } }] };
  }
  if (last?.role === 'user' && last.content.includes('look')) {
    return { toolCalls: [{ name: 'bash', args: { command: 'cat app.txt; ls' } }] };
  }
  return { text: 'done' };
};

describe.if(overlayTestsRun)('an interactive session in the workspace sandbox', () => {
  test('applies the changes with the code it shows, and goes on in a new sandbox', async () => {
    const w = setup();
    server.handle(byPrompt);
    const before = server.requests.length;
    const session = interactive(w);
    await session.waitFor(/Type \/help/);
    session.type('change it\r');
    await session.waitFor(/done/);
    untouched(w);
    const mark = session.text().length;
    session.type('/apply\r');
    const [, code] = await session.waitFor(/Type apply ([0-9A-F]{4}) to confirm/, mark);
    expect(session.text().slice(mark)).toContain('Apply 3 changes to the project?');
    session.type(`apply ${code}\r`);
    await session.waitFor(/A new sandbox runs on the project as it is now/, mark);
    expect(readFileSync(w.file('app.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(w.file('added.txt'), 'utf8')).toBe('new\n');
    expect(existsSync(w.file('notes.txt'))).toBe(false);
    expect(readdirSync(w.file('.git'))).toEqual([]);
    // The new sandbox shows the project as it is now, and the model is told what was applied.
    session.type('look\r');
    const seen = () =>
      server.requests
        .slice(before)
        .some((r) => toolMessages(r).some((m) => m.content.includes('added.txt')));
    const deadline = Date.now() + 20_000;
    while (!seen() && Date.now() < deadline) await Bun.sleep(50);
    const requests = server.requests.slice(before);
    const looked = requests.find((r) => r.messages.at(-1)?.content.includes('look'));
    expect(looked?.messages.at(-1)?.content).toContain("The user applied the sandbox's changes");
    const result = toolMessages(requests.at(-1)).at(-1)?.content ?? '';
    expect(result).toContain('two');
    expect(result).toContain('added.txt');
    expect(result).not.toContain('notes.txt');
    await Bun.sleep(300);
    // Nothing is pending in the new sandbox: the session ends without a question.
    session.type('/exit\r');
    expect(await session.exited()).toBe(0);
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 60_000);

  test('applies nothing on another answer, and asks before an exit discards the changes', async () => {
    const w = setup();
    server.handle(byPrompt);
    const session = interactive(w);
    await session.waitFor(/Type \/help/);
    session.type('change it\r');
    await session.waitFor(/done/);
    let mark = session.text().length;
    session.type('/apply\r');
    const [, code] = await session.waitFor(/Type apply ([0-9A-F]{4}) to confirm/, mark);
    session.type(`apply ${code === '0000' ? '0001' : '0000'}\r`);
    await session.waitFor(/Nothing was applied/, mark);
    untouched(w);
    // The changes at one path.
    mark = session.text().length;
    session.type('/changes app.txt\r');
    await session.waitFor(/modified app\.txt/, mark);
    expect(session.text().slice(mark)).not.toContain('added.txt');
    mark = session.text().length;
    session.type('/exit\r');
    await session.waitFor(/Type apply [0-9A-F]{4} to apply them and exit/, mark);
    session.type('stay\r');
    await session.waitFor(/The session goes on/, mark);
    mark = session.text().length;
    session.type('/exit\r');
    await session.waitFor(/or discard to\s+discard them and exit/, mark);
    session.type('discard\r');
    expect(await session.exited()).toBe(0);
    untouched(w);
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 60_000);

  test('applies the changes on the way out with the code', async () => {
    const w = setup();
    server.handle(byPrompt);
    const session = interactive(w);
    await session.waitFor(/Type \/help/);
    session.type('change it\r');
    await session.waitFor(/done/);
    const mark = session.text().length;
    session.type('/exit\r');
    const [, code] = await session.waitFor(/Type apply ([0-9A-F]{4}) to apply them and exit/, mark);
    session.type(`apply ${code}\r`);
    expect(await session.exited()).toBe(0);
    expect(readFileSync(w.file('added.txt'), 'utf8')).toBe('new\n');
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 60_000);

  test('reads AGENTS.md again once a task during which it was applied ends', async () => {
    const w = setup();
    server.handle(async (request) => {
      const last = request.messages.at(-1);
      if (last?.role === 'user' && last.content.includes('write rules')) {
        return {
          toolCalls: [
            { name: 'bash', args: { command: "echo 'Use tabs.' > AGENTS.md; sleep 20" } },
          ],
        };
      }
      // The task goes on after the application, so the instructions wait for its end.
      await Bun.sleep(3_000);
      return { text: 'done' };
    });
    const session = interactive(w);
    await session.waitFor(/Type \/help/);
    session.type('write rules\r');
    await session.waitFor(/Running echo/);
    await Bun.sleep(1_000);
    const mark = session.text().length;
    // Applied while the task runs: the command it runs is cut short by the new sandbox.
    session.type('/apply\r');
    const [, code] = await session.waitFor(/Type apply ([0-9A-F]{4}) to confirm/, mark);
    session.type(`apply ${code}\r`);
    await session.waitFor(/the instructions are read again once the task ends/, mark);
    expect(readFileSync(w.file('AGENTS.md'), 'utf8')).toBe('Use tabs.\n');
    await session.waitFor(/Loaded AGENTS\.md files:/, mark);
    session.type('/exit\r');
    expect(await session.exited()).toBe(0);
  }, 60_000);

  test('refuses --apply, which /apply replaces', async () => {
    const w = setup();
    const session = Bun.spawn(inTerminal(cliCommand(['--sandbox', 'workspace', '--apply'])), {
      env: { ...w.env, TERM: 'xterm-256color' },
      cwd: w.project,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, output] = await Promise.all([session.exited, new Response(session.stdout).text()]);
    expect(code).toBe(2);
    expect(output).toContain('in the interactive session, /apply applies them');
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 30_000);

  test('discards the changes when Ctrl+C is pressed twice, and says how many first', async () => {
    const w = setup();
    server.handle(byPrompt);
    const session = interactive(w);
    await session.waitFor(/Type \/help/);
    session.type('change it\r');
    await session.waitFor(/done/);
    const mark = session.text().length;
    session.type('\x03');
    await session.waitFor(/Press Ctrl\+C again to exit and discard 3 changes/, mark);
    session.type('\x03');
    expect(await session.exited()).toBe(0);
    untouched(w);
    expect(readdirSync(w.runtime)).toEqual([]);
  }, 60_000);
});
