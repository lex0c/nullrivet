import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendLostError, executeToolCall } from '../../src/agent/tool-broker.ts';
import { WorkerBackend, type WorkerBackendOptions } from '../../src/sandbox/worker-backend.ts';
import { workerCommand } from '../../src/sandbox/worker-command.ts';
import { BUILTIN_TOOLS } from '../../src/tools/index.ts';
import type { Tool } from '../../src/tools/types.ts';

// The worker makes itself non-dumpable through prctl, which exists on Linux only.
const linux = process.platform === 'linux';
const FAKE_WORKER = join(import.meta.dir, 'fake-worker.ts');

const tool = (name: string): Tool => {
  const found = BUILTIN_TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: tmpdir(),
  ...extra,
});

const realWorker = (tools: string[], expected = tools): WorkerBackendOptions => ({
  launch: { command: workerCommand(tools), env: env() },
  tools: expected,
});

const fakeWorker = (scenario: string, options: Partial<WorkerBackendOptions> = {}) =>
  WorkerBackend.start({
    launch: {
      command: [process.execPath, '--no-env-file', '--config=/dev/null', FAKE_WORKER],
      env: env({ FAKE_SCENARIO: scenario }),
    },
    tools: ['read_file'],
    ...options,
  });

const context = (signal = new AbortController().signal) => ({ cwd: '/', signal });

const started: WorkerBackend[] = [];
const track = (backend: WorkerBackend): WorkerBackend => {
  started.push(backend);
  return backend;
};
afterAll(async () => {
  await Promise.all(started.map((backend) => backend.close()));
});

describe.if(linux)('WorkerBackend with the real worker', () => {
  test('runs tools in the worker and refuses calls once closed', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'nullrivet-worker-')));
    try {
      await writeFile(join(dir, 'a.txt'), 'hello from a file\n');
      const backend = await WorkerBackend.start(realWorker(['read_file', 'bash']));
      const read = await backend.execute(
        tool('read_file'),
        { path: join(dir, 'a.txt') },
        context(),
      );
      expect(read.content).toContain('hello from a file');
      expect(read.isError).toBe(false);
      const ran = await backend.execute(tool('bash'), { command: 'echo "pid $$"' }, context());
      expect(ran.content).toMatch(/pid \d+/);
      expect(backend.failure()).toBeNull();
      await backend.close();
      expect(backend.failure()).toBe('the sandbox was closed');
      await expect(backend.execute(tool('read_file'), { path: '/' }, context())).rejects.toThrow(
        BackendLostError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses to start when the worker offers other tools than expected', async () => {
    await expect(
      WorkerBackend.start(realWorker(['read_file'], ['read_file', 'bash'])),
    ).rejects.toThrow('the worker offered read_file instead of read_file, bash');
  });

  test('refuses to start when the worker reports an error, with its message', async () => {
    await expect(WorkerBackend.start(realWorker(['nope']))).rejects.toThrow(
      'the worker reported: the worker has no tool named nope',
    );
  });

  test('returns the real result of a cancelled command', async () => {
    const backend = track(await WorkerBackend.start(realWorker(['bash'])));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await backend.execute(
      tool('bash'),
      { command: 'sleep 30' },
      context(controller.signal),
    );
    expect(result.content).toContain('aborted');
    expect(backend.failure()).toBeNull();
  });

  test('a cancelled command that leaves a process holding its output still returns in time', async () => {
    const backend = track(await WorkerBackend.start(realWorker(['bash'])));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const startedAt = Date.now();
    const result = await backend.execute(
      tool('bash'),
      { command: 'setsid sh -c \'trap "" TERM; sleep 8\' & sleep 30' },
      context(controller.signal),
    );
    expect(result.isError).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(7_000);
    expect(backend.failure()).toBeNull();
  }, 15_000);

  test('a call to a tool the worker does not run is refused without losing the backend', async () => {
    const backend = track(await WorkerBackend.start(realWorker(['read_file'])));
    const result = await backend.execute(tool('bash'), { command: 'true' }, context());
    expect(result.meta?.errorCode).toBe('sandbox.unsupported');
    expect(backend.failure()).toBeNull();
  });

  test('a result over the protocol bounds is held to them instead of losing the backend', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'nullrivet-worker-')));
    try {
      const backend = track(await WorkerBackend.start(realWorker(['git'])));
      // git reports every path it was given as touched, here more than the protocol carries.
      const paths = Array.from({ length: 70 }, (_, i) => `file-${i}.txt`);
      const result = await backend.execute(
        tool('git'),
        { subcommand: 'diff', paths },
        { cwd: dir, signal: new AbortController().signal },
      );
      expect(backend.failure()).toBeNull();
      expect(result.touchedPaths?.length).toBe(64);
      expect(result.touchedPaths?.[0]).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a worker killed during a call fails it as lost, and the broker refuses the next', async () => {
    const backend = track(await WorkerBackend.start(realWorker(['bash'])));
    const pending = backend.execute(tool('bash'), { command: 'kill -9 $PPID; sleep 5' }, context());
    await expect(pending).rejects.toThrow(BackendLostError);
    expect(backend.failure()).toMatch(/^the worker (exited|closed)/);
    const next = await executeToolCall(
      { id: 'c', name: 'bash', input: { command: 'true' } },
      {
        tools: new Map([['bash', tool('bash')]]),
        mode: 'auto',
        cwd: '/',
        signal: new AbortController().signal,
        backend,
      },
    );
    expect(next.meta?.errorCode).toBe('sandbox.lost');
  });
});

describe.if(linux)('WorkerBackend with a worker that breaks the protocol', () => {
  const violations: [string, string][] = [
    ['malformed', 'the worker sent a line that is not a JSON object'],
    ['oversized', 'the worker sent a line over the size limit'],
    ['unknown-id', 'the worker sent a result for an unknown call id other'],
    ['job-event', 'the worker sent a message of an unknown type'],
    ['relative-path', 'touchedPaths holds a path that is not absolute and normalized'],
    ['large-meta', 'the result meta is too large'],
    ['extra-field', 'the result has unknown or missing fields'],
  ];
  for (const [scenario, reason] of violations) {
    test(`${scenario}: the backend is lost and the call fails`, async () => {
      const backend = track(await fakeWorker(scenario));
      await expect(backend.execute(tool('read_file'), { path: '/' }, context())).rejects.toThrow(
        BackendLostError,
      );
      expect(backend.failure()).toContain(reason);
    });
  }

  test('a second result for the same call is a violation', async () => {
    const backend = track(await fakeWorker('duplicate'));
    const first = await backend.execute(tool('read_file'), { path: '/' }, context());
    expect(first.content).toBe('first');
    // The second result arrives right after the first.
    await Bun.sleep(100);
    expect(backend.failure()).toContain('a result for an unknown call id');
  });

  test('worker.ready twice is a violation', async () => {
    const backend = track(await fakeWorker('ready-twice'));
    await Bun.sleep(100);
    expect(backend.failure()).toContain('worker.ready twice');
  });

  test('a worker that never gets ready is stopped, with the time it was given', async () => {
    await expect(fakeWorker('no-ready', { readyTimeoutMs: 300 })).rejects.toThrow(
      'the worker was not ready within 300 ms',
    );
  });

  test('a worker that exits before ready reports its diagnostics', async () => {
    await expect(fakeWorker('stderr-then-exit')).rejects.toThrow(
      /the worker (exited with code 3|closed its protocol descriptor).*setting up the namespace failed/,
    );
  });

  test('a call whose cancellation goes unanswered loses the backend after the grace', async () => {
    const backend = track(await fakeWorker('ignore-cancel', { cancelGraceMs: 200 }));
    const controller = new AbortController();
    const pending = backend.execute(tool('read_file'), { path: '/' }, context(controller.signal));
    controller.abort();
    await expect(pending).rejects.toThrow(
      'read_file did not return within 200 ms of its cancellation',
    );
  });
});
