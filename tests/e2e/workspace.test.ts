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
import { overlayTestsRun, tmpfsDirectory } from '../helpers/sandbox.ts';
import {
  type ChatRequest,
  type CliEvent,
  cliCommand,
  cliEnv,
  type FakeOllama,
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
afterEach(() => {
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
