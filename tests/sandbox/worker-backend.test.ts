import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendLostError, executeToolCall } from '../../src/agent/tool-broker.ts';
import { WorkerBackend, type WorkerBackendOptions } from '../../src/sandbox/worker-backend.ts';
import { workerCommand } from '../../src/sandbox/worker-command.ts';
import { BUILTIN_TOOLS } from '../../src/tools/index.ts';
import { createJobTools } from '../../src/tools/jobs.ts';
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
    ['malformed', 'the worker broke the protocol: a line that is not a JSON object'],
    ['oversized', 'the worker sent a line over the size limit'],
    ['unknown-id', 'the worker sent a result for an unknown call id other'],
    ['job-event', 'the worker broke the protocol: a malformed job.event message'],
    ['job-started', 'the worker sent job.started, but it runs no background jobs'],
    ['unknown-type', 'the worker broke the protocol: a message of an unknown type'],
    ['relative-path', 'touchedPaths holds a path that is not absolute and normalized'],
    ['large-meta', 'the result meta is too large'],
    ['extra-field', 'the worker broke the protocol: the result has unknown or missing fields'],
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

  test('a job message from a worker without jobs is reported once, as it was sent', async () => {
    const backend = track(await fakeWorker('job-started'));
    await expect(backend.execute(tool('read_file'), { path: '/' }, context())).rejects.toThrow(
      BackendLostError,
    );
    expect(backend.failure()).toBe('the worker sent job.started, but it runs no background jobs');
  });

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

describe.if(linux)('background jobs in the worker', () => {
  const jobTools = createJobTools(null, 'one-shot');
  const jobTool = (name: string): Tool => {
    const found = jobTools.find((t) => t.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
  const startWithJobs = async () => {
    const tools = ['bash', ...jobTools.map((t) => t.name)];
    const backend = track(
      await WorkerBackend.start({
        launch: { command: workerCommand(tools, 'one-shot'), env: env() },
        tools,
        jobs: true,
      }),
    );
    const jobs = backend.jobs;
    if (jobs === undefined) throw new Error('no job projection');
    return { backend, jobs };
  };
  const waitUntil = async (check: () => boolean, ms = 10_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Bun.sleep(20);
    return check();
  };
  const jobIdOf = (content: string): string => {
    const match = /Started background job (\S+) /.exec(content);
    if (match?.[1] === undefined) throw new Error(`no job id in: ${content}`);
    return match[1];
  };

  test('a job is known before its start returns, and its end arrives as it happens', async () => {
    const { backend, jobs } = await startWithJobs();
    const result = await backend.execute(
      jobTool('bash_background'),
      { command: 'echo hi; sleep 0.2' },
      context(),
    );
    const id = jobIdOf(result.content);
    expect(jobs.startedCount).toBe(1);
    expect(jobs.running()).toBe(1);
    expect(await waitUntil(() => jobs.pendingEvents().length === 1)).toBe(true);
    expect(jobs.pendingEvents()[0]).toMatchObject({
      type: 'job.finished',
      jobId: id,
      status: 'completed',
    });
    expect(jobs.running()).toBe(0);
  });

  test('a job ready and ended in one chunk gives a single note', async () => {
    const { backend, jobs } = await startWithJobs();
    await backend.execute(
      jobTool('bash_background'),
      { command: 'echo READY', ready_pattern: 'READY' },
      context(),
    );
    expect(await waitUntil(() => jobs.running() === 0)).toBe(true);
    expect(jobs.pendingEvents().map((event) => event.type)).toEqual(['job.finished']);
  });

  test('a job shown by bash_jobs or bash_kill leaves no note to repeat it', async () => {
    const { backend, jobs } = await startWithJobs();
    const quick = jobIdOf(
      (await backend.execute(jobTool('bash_background'), { command: 'sleep 0.3' }, context()))
        .content,
    );
    const waited = await backend.execute(
      jobTool('bash_jobs'),
      { id: quick, wait_ms: 5_000 },
      context(),
    );
    expect(waited.content).toContain('completed with exit code 0');
    const slow = jobIdOf(
      (await backend.execute(jobTool('bash_background'), { command: 'sleep 30' }, context()))
        .content,
    );
    const killed = await backend.execute(jobTool('bash_kill'), { id: slow }, context());
    expect(killed.content).toContain('was stopped with bash_kill');
    expect(jobs.running()).toBe(0);
    expect(jobs.pendingEvents()).toEqual([]);
  });

  test('an end arriving during another call, and a read during a wait, are handled in order', async () => {
    const { backend, jobs } = await startWithJobs();
    const quick = jobIdOf(
      (await backend.execute(jobTool('bash_background'), { command: 'sleep 0.2' }, context()))
        .content,
    );
    // The job ends while this command runs; its event is received before the command's result.
    const ran = await backend.execute(
      tool('bash'),
      { command: 'sleep 0.6; echo after' },
      context(),
    );
    expect(ran.content).toContain('after');
    expect(jobs.pendingEvents()).toMatchObject([{ type: 'job.finished', jobId: quick }]);
    const slow = jobIdOf(
      (await backend.execute(jobTool('bash_background'), { command: 'sleep 0.5' }, context()))
        .content,
    );
    const waiting = backend.execute(jobTool('bash_jobs'), { id: slow, wait_ms: 5_000 }, context());
    const echoed = await backend.execute(tool('bash'), { command: 'echo meanwhile' }, context());
    expect(echoed.content).toContain('meanwhile');
    expect(jobs.running()).toBe(1);
    expect((await waiting).content).toContain('completed with exit code 0');
    expect(jobs.running()).toBe(0);
  });

  test('a job the worker forgets as soon as it ends is still counted as ended here', async () => {
    const { backend, jobs } = await startWithJobs();
    const long = jobIdOf(
      (await backend.execute(jobTool('bash_background'), { command: 'sleep 60' }, context()))
        .content,
    );
    for (let i = 0; i < 50; i++) {
      await backend.execute(jobTool('bash_background'), { command: 'true' }, context());
    }
    expect(await waitUntil(() => jobs.running() === 1, 20_000)).toBe(true);
    jobs.markDelivered(jobs.pendingEvents());
    // Ending the long job makes it the oldest of 51 finished jobs, which the worker then forgets.
    await backend.execute(jobTool('bash_kill'), { id: long }, context());
    expect(jobs.running()).toBe(0);
    expect(backend.failure()).toBeNull();
  }, 60_000);
});
