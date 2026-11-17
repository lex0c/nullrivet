import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  createJobTools,
  describeJobEvent,
  JobRegistry,
  MAX_RUNNING_JOBS,
} from '../../src/tools/jobs.ts';
import { OutputFiles, type OutputFilesOptions } from '../../src/tools/output-files.ts';
import type { Tool, ToolContext, ToolResult } from '../../src/tools/types.ts';
import { TempDirs } from './fixtures.ts';

const temp = new TempDirs();
let dir: string;
let logs: OutputFiles;
let registry: JobRegistry;
let tools: Map<string, Tool>;

const setUp = (options: OutputFilesOptions = {}): void => {
  logs = new OutputFiles({ root: () => dir, ...options });
  registry = new JobRegistry(logs);
  tools = new Map(createJobTools(registry, 'interactive').map((tool) => [tool.name, tool]));
};

beforeEach(() => {
  dir = temp.create('jobs');
  setUp();
});

afterEach(async () => {
  await Promise.all(registry.list().map((job) => registry.kill(job)));
  logs.removeAll();
  temp.cleanup();
});

const ctx = (signal: AbortSignal = new AbortController().signal): ToolContext => ({
  cwd: dir,
  signal,
});

const call = (name: string, input: Record<string, unknown>, signal?: AbortSignal) => {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.execute(input, ctx(signal));
};

const start = async (
  input: Record<string, unknown>,
): Promise<{ id: string; result: ToolResult }> => {
  const result = await call('bash_background', input);
  if (result.isError) throw new Error(result.content);
  return { id: String(result.meta?.jobId), result };
};

const logPath = (content: string): string => {
  const match = /`(\/[^`]+\.001\.txt)`/.exec(content);
  if (match?.[1] === undefined) throw new Error(`no log path in: ${content}`);
  return match[1];
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (check: () => boolean, ms = 3_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
};

const ended = (id: string): Promise<boolean> =>
  registry.wait(registry.get(id), 5_000, 'exit', new AbortController().signal);

// Takes every pending event, as the agent does when it has room for all of them.
const drain = () => {
  const events = registry.pendingEvents();
  registry.markDelivered(events);
  return events;
};

describe('background jobs', () => {
  test('a job runs in the background and its log keeps stdout and stderr in order', async () => {
    const { id, result } = await start({ command: 'echo a; echo b >&2; echo c' });
    expect(result.content).toStartWith(`Started background job ${id} (pid `);
    const path = logPath(result.content);
    const shown = await call('bash_jobs', { id, wait_ms: 5_000 });
    expect(shown.content).toStartWith(`job ${id}: completed with exit code 0 after `);
    expect(shown.content).toContain('[complete log (');
    expect(shown.content).toContain('last lines (up to 40, at most 8KB):\na\nb\nc');
    expect(shown.meta?.status).toBe('completed');
    expect(readFileSync(path, 'utf8')).toBe('a\nb\nc\n');
  });

  test('the log exists as soon as the job starts', async () => {
    const { result } = await start({ command: 'sleep 30' });
    expect(result.content).toContain('[log so far (0B) saved to `');
    const path = logPath(result.content);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBe(0);
  });

  test('ids carry a random prefix of their registry and a counter', async () => {
    const first = await start({ command: 'true' });
    const second = await start({ command: 'true' });
    const [prefix, n] = first.id.split('-');
    expect(prefix).toMatch(/^[0-9a-f]{16}$/);
    expect(n).toBe('1');
    expect(second.id).toBe(`${prefix}-2`);
    setUp();
    const other = await start({ command: 'true' });
    expect(other.id.split('-')[0]).not.toBe(prefix);
    expect((await call('bash_jobs', { id: first.id })).meta?.errorCode).toBe('job.unknown');
  });

  test('bash_jobs without an id lists the jobs', async () => {
    expect((await call('bash_jobs', {})).content).toBe('[no background jobs]');
    const { id } = await start({ command: 'sleep 30' });
    const listed = await call('bash_jobs', {});
    expect(listed.content).toMatch(new RegExp(`^${id}: running for \\d+m?s: sleep 30$`));
  });

  test('bash_kill stops the whole process group of a job', async () => {
    const pidFile = join(dir, 'child.pid');
    const { id } = await start({ command: `sleep 30 & echo $! > ${pidFile}; sleep 30` });
    expect(await waitUntil(() => existsSync(pidFile) && statSync(pidFile).size > 0)).toBe(true);
    const job = registry.get(id);
    const stopped = await call('bash_kill', { id });
    expect(stopped.content).toStartWith(`job ${id}: was stopped with bash_kill after `);
    expect(stopped.content).toContain('[interrupted log (');
    expect(stopped.meta?.status).toBe('stopped');
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntil(() => !isAlive(child) && !isAlive(job.handle?.pid ?? 0))).toBe(true);
  });

  test('a job past its max_runtime_ms is timed out, and a failing one failed', async () => {
    const timed = await start({ command: 'sleep 30', max_runtime_ms: 200 });
    const failing = await start({ command: 'exit 3' });
    expect((await call('bash_jobs', { id: timed.id, wait_ms: 5_000 })).content).toContain(
      'was stopped at its max_runtime_ms',
    );
    expect(registry.get(timed.id).status).toBe('timed_out');
    expect((await call('bash_jobs', { id: failing.id, wait_ms: 5_000 })).content).toContain(
      'failed with exit code 3',
    );
  });

  test('a job that ended on its own keeps its state when a stop or its time limit comes later', async () => {
    const { id } = await start({ command: 'true', max_runtime_ms: 300 });
    expect(await ended(id)).toBe(true);
    const late = await call('bash_kill', { id });
    expect(late.content).toStartWith('[the job had already ended]\n');
    await Bun.sleep(400);
    expect(registry.get(id).status).toBe('completed');
  });

  test('a job that cannot start leaves nothing behind', async () => {
    const path = process.env.PATH;
    process.env.PATH = join(dir, 'empty');
    let result: ToolResult;
    try {
      result = await call('bash_background', { command: 'true' });
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    expect(result.meta?.errorCode).toBe('job.start_failed');
    expect(registry.list()).toEqual([]);
    const [logDir = ''] = readdirSync(dir);
    expect(readdirSync(join(dir, logDir))).toEqual([]);
  });

  test('a job whose log cannot be created is not started', async () => {
    setUp();
    logs = new OutputFiles({ root: () => join(dir, 'missing') });
    registry = new JobRegistry(logs);
    tools = new Map(createJobTools(registry, 'interactive').map((tool) => [tool.name, tool]));
    const result = await call('bash_background', { command: 'true' });
    expect(result.meta?.errorCode).toBe('job.log_failed');
    expect(result.content).toContain('the job was not started');
    expect(registry.list()).toEqual([]);
  });

  test('jobs still start once the log limit is used up, and keep their last lines', async () => {
    setUp({ totalLimitBytes: 10 });
    const first = await start({ command: 'echo 0123456789abcdef' });
    expect(await ended(first.id)).toBe(true);
    const { id } = await start({ command: 'echo more output' });
    const shown = await call('bash_jobs', { id, wait_ms: 5_000 });
    expect(shown.content).toContain(
      'saving stopped: the 10B limit for the output files of this process was reached',
    );
    expect(shown.content).toEndWith('\nmore output');
  });

  test('an interrupt ends the wait of bash_kill for a job slow to stop', async () => {
    const { id } = await start({ command: "trap '' TERM; echo armed; sleep 30" });
    expect(await waitUntil(() => registry.get(id).recent.lastLines() === 'armed')).toBe(true);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();
    const result = await call('bash_kill', { id }, controller.signal);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result.content).toEndWith(
      '[the wait for the job to end was interrupted; it was sent SIGTERM, then SIGKILL]',
    );
    expect(await ended(id)).toBe(true);
    expect(registry.get(id).status).toBe('stopped');
  });

  test(`at most ${MAX_RUNNING_JOBS} jobs run at once`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_RUNNING_JOBS; i++) ids.push((await start({ command: 'sleep 30' })).id);
    const refused = await call('bash_background', { command: 'sleep 30' });
    expect(refused.meta?.errorCode).toBe('job.limit');
    await call('bash_kill', { id: ids[0] });
    expect((await call('bash_background', { command: 'true' })).isError).toBe(false);
  });

  test('starts that overlap cannot pass the limit together', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: MAX_RUNNING_JOBS + 1 }, () =>
        registry.start({ command: 'sleep 30', cwd: dir }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_RUNNING_JOBS);
    const [refused] = results.filter((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' ? refused.reason : undefined).toMatchObject({
      code: 'job.limit',
    });
  });

  test('a long command is shortened in reports', async () => {
    const { id } = await start({ command: `true # ${'x'.repeat(1_000)}` });
    const shown = await call('bash_jobs', { id, wait_ms: 5_000 });
    const line = shown.content.split('\n').find((l) => l.startsWith('command: ')) ?? '';
    expect(line.length).toBe('command: '.length + 500);
    expect(line).toEndWith('x…');
  });

  test('ready_pattern is found across chunks, and a later wait waits for the end', async () => {
    const { id } = await start({
      command: "printf 'Rea'; sleep 0.3; printf 'dy now\\n'; sleep 30",
      ready_pattern: 'Ready now',
    });
    const ready = await call('bash_jobs', { id, wait_ms: 5_000, until: 'ready' });
    expect(ready.content).toMatch(
      new RegExp(`^job ${id}: running for \\d+m?s, ready after \\d+m?s`),
    );
    const later = await call('bash_jobs', { id, wait_ms: 300 });
    expect(later.content).toEndWith('[still running after waiting 300ms]');
  });

  test('ready_pattern is matched in the output without escape sequences', async () => {
    const { id } = await start({
      command: "printf '\\033[32mReady\\033[39m on \\033[1mport 3000\\033[0m\\n'; sleep 30",
      ready_pattern: 'Ready on port 3000',
    });
    const ready = await call('bash_jobs', { id, wait_ms: 5_000, until: 'ready' });
    expect(ready.content).toContain(', ready after ');
  });

  test('ready_pattern and until are validated', async () => {
    await expect(call('bash_background', { command: 'true', ready_pattern: '' })).rejects.toThrow(
      "'ready_pattern' must be 1 to 256 bytes",
    );
    await expect(
      call('bash_background', { command: 'true', ready_pattern: 'é'.repeat(129) }),
    ).rejects.toThrow("'ready_pattern' must be 1 to 256 bytes of UTF-8, got 258");
    const { id } = await start({ command: 'sleep 30' });
    await expect(call('bash_jobs', { id, wait_ms: 10, until: 'ready' })).rejects.toThrow(
      'was started without ready_pattern',
    );
    await expect(call('bash_jobs', { id, until: 'exit' })).rejects.toThrow(
      "'until' requires 'wait_ms'",
    );
    await expect(call('bash_jobs', { wait_ms: 10 })).rejects.toThrow("'wait_ms' requires 'id'");
  });

  test('an interrupted wait returns the state and leaves the job running', async () => {
    const { id } = await start({ command: 'sleep 30' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const shown = await call('bash_jobs', { id, wait_ms: 10_000 }, controller.signal);
    expect(shown.content).toEndWith('[the wait was interrupted; the job keeps running]');
    expect(registry.get(id).status).toBe('running');
  });

  test('a running log shows only whole lines and is never called complete', async () => {
    const { id, result } = await start({ command: "printf 'partial'; sleep 30" });
    expect(await waitUntil(() => registry.get(id).recent.lastLines() === 'partial')).toBe(true);
    expect(readFileSync(logPath(result.content), 'utf8')).toBe('');
    const shown = await call('bash_jobs', { id });
    expect(shown.content).toContain('[log so far (0B) saved to `');
    expect(shown.content).not.toContain('complete log');
    expect(shown.content).toEndWith('\npartial');
  });

  test('a log over its limit is truncated while the job keeps running', async () => {
    setUp({ outputLimitBytes: 1_024 });
    const { id } = await start({ command: "head -c 5000 /dev/zero | tr '\\0' x; echo; sleep 30" });
    const log = registry.get(id).log;
    expect(await waitUntil(() => log.snapshot().stopReason !== undefined)).toBe(true);
    const shown = await call('bash_jobs', { id });
    expect(shown.content).toStartWith(`job ${id}: running for `);
    expect(shown.content).toContain('[log so far (1KB) saved to `');
    expect(shown.content).toContain('saving stopped: the 1KB limit per output was reached');
  });

  test('the agent credentials are not in the environment of a job', async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'secret-for-test';
    let id: string;
    try {
      id = (await start({ command: 'echo "key=$ANTHROPIC_API_KEY"' })).id;
    } finally {
      if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = key;
    }
    const shown = await call('bash_jobs', { id, wait_ms: 5_000 });
    expect(shown.content).toEndWith('\nkey=');
  });
});

describe('job events', () => {
  test('an ended job gives one event, with facts but no output or command', async () => {
    const { id } = await start({ command: 'echo visible-output' });
    expect(await ended(id)).toBe(true);
    const events = drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'job.finished', jobId: id, status: 'completed' });
    const note = events.map(describeJobEvent).join('\n');
    expect(note).toStartWith(`Background job ${id} completed with exit code 0 after `);
    expect(note).toContain('[complete log (');
    // bash_jobs is not offered in readonly mode, where the note still arrives.
    expect(note).not.toContain('bash_jobs');
    expect(note).not.toContain('visible-output');
    expect(note).not.toContain('echo');
    expect(drain()).toEqual([]);
  });

  test('a ready job gives a ready event while it runs, then a finished one', async () => {
    const { id } = await start({ command: 'echo Ready; sleep 0.3', ready_pattern: 'Ready' });
    expect(
      await registry.wait(registry.get(id), 5_000, 'ready', new AbortController().signal),
    ).toBe(true);
    const [ready, ...rest] = drain();
    expect(rest).toEqual([]);
    if (ready === undefined) throw new Error('no ready event');
    expect(describeJobEvent(ready)).toStartWith(
      `Background job ${id} is ready: its ready_pattern appeared in its output after `,
    );
    expect(await ended(id)).toBe(true);
    expect(drain().map((e) => e.type)).toEqual(['job.finished']);
  });

  test('a job that ended before its ready event was taken is reported by its end alone', async () => {
    const { id } = await start({ command: 'echo Ready; sleep 0.2', ready_pattern: 'Ready' });
    expect(await ended(id)).toBe(true);
    expect(registry.hasPendingEvents()).toBe(true);
    expect(drain().map((e) => e.type)).toEqual(['job.finished']);
    expect(drain()).toEqual([]);
  });

  test('what a report showed is not repeated by an event', async () => {
    const shownEnd = await start({ command: 'true' });
    expect(await ended(shownEnd.id)).toBe(true);
    await call('bash_jobs', { id: shownEnd.id });

    const shownReady = await start({ command: 'echo up; sleep 30', ready_pattern: 'up' });
    await call('bash_jobs', { id: shownReady.id, wait_ms: 5_000, until: 'ready' });

    const killed = await start({ command: 'sleep 30' });
    await call('bash_kill', { id: killed.id });

    expect(drain()).toEqual([]);
  });

  test('listeners hear of each new event in a microtask, after its state is recorded', async () => {
    const heard: string[] = [];
    registry.onEvent(() => {
      // The ready event can come before start() returns the id.
      const [job] = registry.list();
      heard.push(
        job === undefined ? 'unknown' : `${job.status}${job.readyAt === null ? '' : ', ready'}`,
      );
    });
    const { id } = await start({ command: 'sleep 0.1; echo up; sleep 0.2', ready_pattern: 'up' });
    expect(await ended(id)).toBe(true);
    await Promise.resolve();
    expect(heard).toEqual(['running, ready', 'completed, ready']);
  });

  test('a listener removed before its microtask runs is not called', async () => {
    let second = 0;
    let stopSecond = (): void => undefined;
    registry.onEvent(() => stopSecond());
    stopSecond = registry.onEvent(() => {
      second += 1;
    });
    const { id } = await start({ command: 'true' });
    expect(await ended(id)).toBe(true);
    await Promise.resolve();
    expect(second).toBe(0);
  });

  test('pending events are tracked until a note or a report delivers them', async () => {
    expect(registry.hasPendingEvents()).toBe(false);
    const { id } = await start({ command: 'true' });
    expect(await ended(id)).toBe(true);
    expect(registry.hasPendingEvents()).toBe(true);
    await call('bash_jobs', {});
    expect(registry.hasPendingEvents()).toBe(true);
    await call('bash_jobs', { id });
    expect(registry.hasPendingEvents()).toBe(false);
  });

  test('dropped events stay dropped for jobs that end later, which keep running', async () => {
    const ended1 = await start({ command: 'true' });
    expect(await ended(ended1.id)).toBe(true);
    const running = await start({ command: 'sleep 0.3' });
    registry.dropEvents();
    expect(registry.hasPendingEvents()).toBe(false);
    expect(registry.get(running.id).status).toBe('running');
    expect(await ended(running.id)).toBe(true);
    expect(registry.hasPendingEvents()).toBe(false);
    expect(drain()).toEqual([]);
    expect(registry.list()).toHaveLength(2);
  });

  test('a listing, which has no log details, leaves the events to their notes', async () => {
    const { id } = await start({ command: 'true' });
    expect(await ended(id)).toBe(true);
    expect((await call('bash_jobs', {})).content).toContain(`${id}: completed with exit code 0`);
    expect(drain().map((e) => e.jobId)).toEqual([id]);
  });

  test('a wait that runs out of time marks nothing as delivered', async () => {
    const { id } = await start({ command: 'sleep 30', ready_pattern: 'never' });
    await call('bash_jobs', { id, wait_ms: 50, until: 'ready' });
    await registry.kill(registry.get(id));
    const events = drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'job.finished', status: 'stopped' });
  });

  test('finished jobs are forgotten beyond the most recent, unless an event is pending', async () => {
    const pending = await start({ command: 'true' });
    expect(await ended(pending.id)).toBe(true);
    for (let i = 0; i < 55; i++) {
      const { id } = await start({ command: 'true' });
      await call('bash_jobs', { id, wait_ms: 5_000 });
    }
    const ids = registry.list().map((job) => job.id);
    expect(ids).toHaveLength(50);
    expect(ids).toContain(pending.id);
    expect(drain().map((e) => e.jobId)).toEqual([pending.id]);
  });
});
