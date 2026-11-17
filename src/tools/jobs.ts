import { randomBytes } from 'node:crypto';
import type { PendingEventSource } from '../agent/events.ts';
import { formatBytes } from '../context/output-reduction.ts';
import { errorMessage } from '../errors.ts';
import { stripAnsi } from '../sanitize/ansi.ts';
import {
  InvalidArgumentError,
  optionalInteger,
  optionalString,
  requireNonEmptyString,
} from './args.ts';
import { BASH_MAX_TIMEOUT_MS, buildChildEnv, JOB_BASH_ARGS, resolveCommandCwd } from './bash.ts';
import {
  describeSavedOutput,
  jobLogs,
  type OutputFiles,
  type OutputSpool,
  type SavedOutput,
} from './output-files.ts';
import {
  MAX_TIMER_DELAY_MS,
  type ProcessHandle,
  type ProcessRunResult,
  startProcess,
} from './process.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

export const MAX_RUNNING_JOBS = 8;
// Finished jobs whose events were all delivered are forgotten beyond this many, so a long session
// does not accumulate them.
const RETAINED_FINISHED_JOBS = 50;
// A stopped job normally ends within the 4s of the two kill grace periods. A process the kernel
// cannot kill (stuck on a hung mount) must not hold the turn longer than this.
const KILL_WAIT_MS = 10_000;
const READY_PATTERN_MAX_BYTES = 256;
// The pattern is matched in the output without escape sequences, which can sit between its words
// (colors), so the end of the previous chunk is kept with room for them.
const READY_ESCAPE_ROOM_BYTES = 256;
const RECENT_OUTPUT_BYTES = 8 * 1024;
const RECENT_OUTPUT_LINES = 40;
const LISTED_COMMAND_CHARS = 100;
const REPORTED_COMMAND_CHARS = 500;

export type JobStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'timed_out';
type FinishedStatus = Exclude<JobStatus, 'running'>;

// What happened to a job, for the model. Kept apart from its text so other consumers can use the
// same events.
export type JobEvent =
  | { type: 'job.ready'; jobId: string; at: number; afterMs: number; log: SavedOutput }
  | {
      type: 'job.finished';
      jobId: string;
      at: number;
      durationMs: number;
      status: FinishedStatus;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      log: SavedOutput | null;
    };

export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

interface JobFinish {
  at: number;
  status: FinishedStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  log: SavedOutput | null;
}

export const formatJobDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
};

// The end of a job's output, kept in memory for its last lines.
class RecentOutput {
  private buffer = Buffer.alloc(0);
  private trimmed = false;

  // Copies at most RECENT_OUTPUT_BYTES per chunk, whatever the size of the chunk.
  push(chunk: Buffer): void {
    if (chunk.length >= RECENT_OUTPUT_BYTES) {
      this.buffer = Buffer.from(chunk.subarray(chunk.length - RECENT_OUTPUT_BYTES));
      this.trimmed = true;
      return;
    }
    const room = RECENT_OUTPUT_BYTES - chunk.length;
    if (this.buffer.length > room) this.trimmed = true;
    const kept = this.buffer.subarray(Math.max(0, this.buffer.length - room));
    this.buffer = Buffer.concat([kept, chunk]);
  }

  // Up to RECENT_OUTPUT_LINES lines. Once the memory bound has cut the output, the first line is
  // left out, since it is only the end of one.
  lastLines(): string {
    let text = this.buffer.toString('utf8');
    if (this.trimmed) {
      const newline = text.indexOf('\n');
      if (newline !== -1) text = text.slice(newline + 1);
    }
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-RECENT_OUTPUT_LINES).join('\n');
  }
}

class Job {
  readonly startedAt = Date.now();
  readonly recent = new RecentOutput();
  handle: ProcessHandle | null = null;
  readyAt: number | null = null;
  finish: JobFinish | null = null;
  readyDelivered = false;
  finishDelivered = false;
  // The end of the previous chunk, so a ready pattern split between two chunks is found.
  private readyCarry = Buffer.alloc(0);
  // Callbacks of waits in progress, removed when they run or when the wait gives up, so a job
  // that runs for the whole session does not accumulate them.
  private readonly waiters = { ready: new Set<() => void>(), exit: new Set<() => void>() };

  constructor(
    readonly id: string,
    readonly command: string,
    readonly cwd: string,
    readonly log: OutputSpool,
    readonly readyPattern: string | null,
    // Called when an event (ready, finished) becomes pending.
    private readonly announce: () => void,
  ) {}

  get status(): JobStatus {
    return this.finish?.status ?? 'running';
  }

  // Whether the job ended, or with `ready` became ready or ended.
  reached(until: 'exit' | 'ready'): boolean {
    return this.finish !== null || (until === 'ready' && this.readyAt !== null);
  }

  // Calls `callback` when the job reaches `until`, unless the returned function cancels it first.
  whenReached(until: 'exit' | 'ready', callback: () => void): () => void {
    const waiters = this.waiters[until];
    waiters.add(callback);
    return () => waiters.delete(callback);
  }

  onOutput(chunk: Buffer): void {
    this.log.push(chunk);
    this.recent.push(chunk);
    if (this.readyPattern === null || this.readyAt !== null) return;
    const window = Buffer.concat([this.readyCarry, chunk]);
    if (stripAnsi(window.toString('utf8')).includes(this.readyPattern)) {
      this.readyAt = Date.now();
      this.readyCarry = Buffer.alloc(0);
      this.notify('ready');
      this.announce();
      return;
    }
    const keep = Buffer.byteLength(this.readyPattern) - 1 + READY_ESCAPE_ROOM_BYTES;
    this.readyCarry = Buffer.from(window.subarray(Math.max(0, window.length - keep)));
  }

  settle(result: ProcessRunResult): void {
    const interrupted = interruptionOf(result);
    this.close(
      statusOf(result),
      result.exitCode,
      result.signal,
      this.log.finish({ keep: true, ...(interrupted === undefined ? {} : { interrupted }) }),
    );
  }

  // The process could not be followed to its end; the job is reported as failed.
  fail(error: unknown): void {
    const interrupted = `following the process failed: ${errorMessage(error)}`;
    this.close('failed', null, null, this.log.finish({ keep: true, interrupted }));
  }

  private close(
    status: FinishedStatus,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    log: SavedOutput | null,
  ): void {
    if (this.finish !== null) return;
    this.finish = { at: Date.now(), status, exitCode, signal, log };
    this.notify('ready');
    this.notify('exit');
    this.announce();
  }

  private notify(until: 'exit' | 'ready'): void {
    const callbacks = [...this.waiters[until]];
    this.waiters[until].clear();
    for (const callback of callbacks) callback();
  }
}

// Marks every event the job has had so far as delivered.
const deliverAll = (job: Job): void => {
  if (job.readyAt !== null) job.readyDelivered = true;
  if (job.finish !== null) {
    job.finishDelivered = true;
    job.readyDelivered = true;
  }
};

const statusOf = (result: ProcessRunResult): FinishedStatus => {
  if (result.termination === 'timeout') return 'timed_out';
  if (result.termination === 'aborted') return 'stopped';
  return result.exitCode === 0 ? 'completed' : 'failed';
};

// Worded for jobs, which are stopped with bash_kill and limited by max_runtime_ms; command runs are
// aborted or time out instead (captureInterruption).
const interruptionOf = (result: ProcessRunResult): string | undefined => {
  if (result.termination === 'timeout') return 'the job reached its max_runtime_ms';
  if (result.termination === 'aborted') return 'the job was stopped with bash_kill';
  if (result.outputCutOff) return 'the processes the job left running were killed';
  return undefined;
};

const outcome = (finish: JobFinish): string => {
  switch (finish.status) {
    case 'completed':
      return 'completed with exit code 0';
    case 'failed':
      return finish.exitCode !== null
        ? `failed with exit code ${finish.exitCode}`
        : `failed: ended by ${finish.signal ?? 'an unknown cause'}`;
    case 'stopped':
      return 'was stopped with bash_kill';
    case 'timed_out':
      return 'was stopped at its max_runtime_ms';
  }
};

// The log of a job that is still running, which is never described as complete.
const describeGrowingLog = (log: SavedOutput): string =>
  describeSavedOutput(log, 'log', { growing: true });

// The text of a runtime note for an event. It holds only facts the runtime produced, never output
// or the command: notes are trusted by the model, and command output is not. It points to the log,
// which read_file and grep read in either mode, not to bash_jobs, which readonly does not offer.
export const describeJobEvent = (event: JobEvent): string => {
  if (event.type === 'job.ready') {
    return `Background job ${event.jobId} is ready: its ready_pattern appeared in its output after ${formatJobDuration(event.afterMs)}. ${describeGrowingLog(event.log)}`;
  }
  const log = event.log === null ? '' : ` ${describeSavedOutput(event.log, 'log')}`;
  return `Background job ${event.jobId} ${outcome(event)} after ${formatJobDuration(event.durationMs)}.${log}`;
};

export interface JobStartOptions {
  command: string;
  cwd: string;
  maxRuntimeMs?: number;
  readyPattern?: string;
}

export class JobRegistry implements PendingEventSource<JobEvent> {
  // Ids carry a random prefix of this registry, so an id from an earlier process, still in a
  // resumed conversation, does not name a job of this one.
  private readonly prefix = randomBytes(8).toString('hex');
  private sequence = 0;
  private readonly jobs = new Map<string, Job>();
  // Jobs between the check of the limit and their registration, which waits for the spawn; counted
  // so starts that overlap cannot pass the limit together.
  private starting = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly logs: OutputFiles = jobLogs) {}

  // How many jobs this registry has started, counting those whose process failed to start.
  get startedCount(): number {
    return this.sequence;
  }

  // Calls `listener` whenever an event becomes pending. It carries no event: the loop alone takes
  // events, with pendingEvents and markDelivered, and delivers them. Each call runs in a microtask
  // of its own, after the job's state is recorded and only while the listener is still subscribed,
  // so it never runs inside the handling of a process's end. Listeners must not throw; a listener
  // that does is a bug and is reported as an uncaught error, not swallowed.
  onEvent(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hasPendingEvents(): boolean {
    for (const job of this.jobs.values()) {
      if (job.readyAt !== null && !job.readyDelivered) return true;
      if (job.finish !== null && !job.finishDelivered) return true;
    }
    return false;
  }

  // Stops reporting the events of the current jobs, pending and future, because the conversation
  // that started them was discarded. The jobs keep running, and bash_jobs still shows them.
  dropEvents(): void {
    for (const job of this.jobs.values()) {
      job.readyDelivered = true;
      job.finishDelivered = true;
    }
    this.prune();
  }

  private announce(): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        if (this.listeners.has(listener)) listener();
      });
    }
  }

  async start(options: JobStartOptions): Promise<Job> {
    if (this.running() + this.starting >= MAX_RUNNING_JOBS) {
      throw new JobError(
        'job.limit',
        `at most ${MAX_RUNNING_JOBS} background jobs can run at once`,
        'Stop one with bash_kill, or wait for one to end with bash_jobs and wait_ms.',
      );
    }
    this.starting += 1;
    try {
      return await this.spawn(options);
    } finally {
      this.starting -= 1;
    }
  }

  private async spawn(options: JobStartOptions): Promise<Job> {
    // No job runs without a log to observe it through.
    const log = this.logs.spool('job', 0);
    if (!log.start()) {
      const reason = log.snapshot().stopReason ?? 'it could not be created';
      log.finish({ keep: false });
      throw new JobError('job.log_failed', `the job was not started: its log failed: ${reason}`);
    }
    this.sequence += 1;
    const job = new Job(
      `${this.prefix}-${this.sequence}`,
      options.command,
      options.cwd,
      log,
      options.readyPattern ?? null,
      () => this.announce(),
    );
    try {
      job.handle = await startProcess({
        file: 'bash',
        args: JOB_BASH_ARGS,
        cwd: options.cwd,
        env: buildChildEnv(process.env, options.command),
        // The output goes to the log; the run result keeps none of it in memory.
        stdoutLimitBytes: 0,
        stderrLimitBytes: 0,
        onStdout: (chunk) => job.onOutput(chunk),
        onStderr: (chunk) => job.onOutput(chunk),
        ...(options.maxRuntimeMs === undefined ? {} : { timeoutMs: options.maxRuntimeMs }),
      });
    } catch (error) {
      log.finish({ keep: false });
      throw new JobError('job.start_failed', `could not start bash: ${errorMessage(error)}`);
    }
    job.handle.done.then(
      (result) => job.settle(result),
      (error: unknown) => job.fail(error),
    );
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new JobError(
        'job.unknown',
        `no background job ${id} in this run`,
        'Jobs end when nullrivet exits, and finished jobs are forgotten after a while; bash_jobs without an id lists the current ones.',
      );
    }
    return job;
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  running(): number {
    return this.list().filter((job) => job.finish === null).length;
  }

  // Stops the job and waits for it to end, at most KILL_WAIT_MS or until the signal aborts the
  // wait. Resolves with whether it ended; a job that had already ended is left as it was.
  kill(job: Job, signal?: AbortSignal): Promise<boolean> {
    job.handle?.terminate('aborted');
    return this.wait(job, KILL_WAIT_MS, 'exit', signal);
  }

  // Waits for the job to end, or with `ready` to become ready or end. Resolves with whether that
  // happened before the time ran out or the signal aborted the wait; the job keeps running.
  wait(job: Job, ms: number, until: 'exit' | 'ready', signal?: AbortSignal): Promise<boolean> {
    if (job.reached(until)) return Promise.resolve(true);
    if (signal?.aborted === true) return Promise.resolve(false);
    return new Promise((resolve) => {
      let cancel = (): void => undefined;
      const settle = (value: boolean): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        cancel();
        resolve(value);
      };
      const onAbort = (): void => settle(false);
      const timer = setTimeout(() => settle(false), ms);
      signal?.addEventListener('abort', onAbort, { once: true });
      cancel = job.whenReached(until, () => settle(true));
    });
  }

  // Events not delivered yet, oldest first. Reading them does not deliver them.
  pendingEvents(): JobEvent[] {
    const events: JobEvent[] = [];
    for (const job of this.jobs.values()) {
      // A job that has ended is reported by its end alone: that it became ready is no longer news.
      const finishPending = job.finish !== null && !job.finishDelivered;
      if (job.readyAt !== null && !job.readyDelivered && !finishPending) {
        events.push({
          type: 'job.ready',
          jobId: job.id,
          at: job.readyAt,
          afterMs: job.readyAt - job.startedAt,
          log: job.log.snapshot(),
        });
      }
      if (job.finish !== null && finishPending) {
        events.push({
          type: 'job.finished',
          jobId: job.id,
          at: job.finish.at,
          durationMs: job.finish.at - job.startedAt,
          status: job.finish.status,
          exitCode: job.finish.exitCode,
          signal: job.finish.signal,
          log: job.finish.log,
        });
      }
    }
    return events.sort((a, b) => a.at - b.at);
  }

  // A finished event also settles the job's ready event, if that one is still pending: once the
  // job has ended, that it became ready is no longer news.
  markDelivered(events: readonly JobEvent[]): void {
    for (const event of events) {
      const job = this.jobs.get(event.jobId);
      if (job === undefined) continue;
      if (event.type === 'job.ready') job.readyDelivered = true;
      else deliverAll(job);
    }
    this.prune();
  }

  // Records the events a report to the model showed, so no note repeats them.
  markShown(job: Job): void {
    deliverAll(job);
    this.prune();
  }

  private prune(): void {
    const finished = this.list().filter((job) => job.finish !== null);
    let excess = finished.length - RETAINED_FINISHED_JOBS;
    for (const job of finished) {
      if (excess <= 0) return;
      const pending = !job.finishDelivered || (job.readyAt !== null && !job.readyDelivered);
      if (pending) continue;
      this.jobs.delete(job.id);
      excess -= 1;
    }
  }
}

// The command on one line, cut with an ellipsis: the model wrote it and has it in its own tool
// call, so reports repeat only enough to recognize it. Escape sequences are stripped from tool
// results later.
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const stateLine = (job: Job, now: number): string => {
  const ready =
    job.readyPattern === null
      ? ''
      : job.readyAt === null
        ? ', not ready'
        : `, ready after ${formatJobDuration(job.readyAt - job.startedAt)}`;
  if (job.finish === null) return `running for ${formatJobDuration(now - job.startedAt)}${ready}`;
  return `${outcome(job.finish)} after ${formatJobDuration(job.finish.at - job.startedAt)}${ready}`;
};

const logLine = (job: Job): string => {
  if (job.finish === null) return describeGrowingLog(job.log.snapshot());
  return job.finish.log === null ? '[log not saved]' : describeSavedOutput(job.finish.log, 'log');
};

const report = (job: Job): string => {
  const recent = job.recent.lastLines();
  return [
    `job ${job.id}: ${stateLine(job, Date.now())}`,
    `pid ${job.handle?.pid ?? 'unknown'}, cwd ${job.cwd}`,
    `command: ${oneLine(job.command, REPORTED_COMMAND_CHARS)}`,
    logLine(job),
    recent === ''
      ? '[no output yet]'
      : `last lines (up to ${RECENT_OUTPUT_LINES}, at most ${formatBytes(RECENT_OUTPUT_BYTES)}):\n${recent}`,
  ].join('\n');
};

const jobResult = (content: string, job: Job): ToolResult => ({
  content,
  isError: false,
  meta: { jobId: job.id, status: job.status },
});

const asToolError = (error: unknown): ToolResult => {
  if (error instanceof JobError) return toolError(error.code, error.message, error.hint);
  throw error;
};

const readyPatternArgument = (input: Record<string, unknown>): string | undefined => {
  const pattern = optionalString(input, 'ready_pattern');
  if (pattern === undefined) return undefined;
  const bytes = Buffer.byteLength(pattern, 'utf8');
  if (bytes === 0 || bytes > READY_PATTERN_MAX_BYTES) {
    throw new InvalidArgumentError(
      `'ready_pattern' must be 1 to ${READY_PATTERN_MAX_BYTES} bytes of UTF-8, got ${bytes}`,
    );
  }
  return pattern;
};

const untilArgument = (input: Record<string, unknown>): 'exit' | 'ready' | undefined => {
  const until = optionalString(input, 'until');
  if (until === undefined || until === 'exit' || until === 'ready') return until;
  throw new InvalidArgumentError(`'until' must be exit or ready, got ${JSON.stringify(until)}`);
};

// How the session reacts to job events: an interactive session starts a turn on them once the
// model has finished; a one-shot run exits when the model finishes, stopping its jobs.
export type JobSession = 'interactive' | 'one-shot';

const NOTICE_DESCRIPTION: Record<JobSession, string> = {
  interactive:
    "You are told when the job ends, and when its output first contains ready_pattern (such as a server's listening message): at your next step, or, once you have finished, usually by a new turn of your own; the session can hold that turn back until the user's next message. To block until then, use bash_jobs with wait_ms.",
  'one-shot':
    "You are told at your next step when the job ends, and when its output first contains ready_pattern (such as a server's listening message); to block until then, use bash_jobs with wait_ms. nullrivet exits when you finish, which stops running jobs: wait for any result you still need before finishing.",
};

// The tools that start, inspect and stop the background jobs of one registry.
export const createJobTools = (registry: JobRegistry, session: JobSession): Tool[] => [
  {
    name: 'bash_background',
    description: [
      'Start a shell command in the background and return at once, for work that must keep running while you do other things: a dev server, a watcher, a long build or test run. For a command you can wait for, use bash.',
      'stdout and stderr go to one log file, named in the result, that grows as the job writes: read it with read_file and search it with grep.',
      NOTICE_DESCRIPTION[session],
      `At most ${MAX_RUNNING_JOBS} jobs run at once. Jobs are stopped when nullrivet exits.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run.' },
        cwd: {
          type: 'string',
          description: 'Working directory for the command. Defaults to the session directory.',
        },
        max_runtime_ms: {
          type: 'integer',
          description:
            'Stop the job after this many milliseconds. Without it, the job runs until it ends or is stopped.',
        },
        ready_pattern: {
          type: 'string',
          description: `Text whose first appearance in the output marks the job as ready. Matched as is, not as a regular expression, in the output without terminal escape sequences such as colors; up to ${READY_PATTERN_MAX_BYTES} bytes.`,
        },
      },
      required: ['command'],
    },
    effect: 'exec',
    async execute(input, ctx): Promise<ToolResult> {
      const command = requireNonEmptyString(input, 'command');
      const maxRuntimeMs = optionalInteger(input, 'max_runtime_ms', {
        min: 100,
        max: MAX_TIMER_DELAY_MS,
      });
      const readyPattern = readyPatternArgument(input);
      const resolved = await resolveCommandCwd(optionalString(input, 'cwd'), ctx.cwd);
      if ('error' in resolved) return resolved.error;
      let job: Job;
      try {
        job = await registry.start({
          command,
          cwd: resolved.cwd,
          ...(maxRuntimeMs === undefined ? {} : { maxRuntimeMs }),
          ...(readyPattern === undefined ? {} : { readyPattern }),
        });
      } catch (error) {
        return asToolError(error);
      }
      const ready =
        readyPattern === undefined ? '' : ' You are told when ready_pattern appears in its output.';
      return {
        ...jobResult(
          `Started background job ${job.id} (pid ${job.handle?.pid ?? 'unknown'}). ${logLine(job)}${ready} You are told when it ends.`,
          job,
        ),
        touchedPaths: [resolved.cwd],
      };
    },
  },
  {
    name: 'bash_jobs',
    description: [
      'Show background jobs started with bash_background. Without id, list them; with id, show one: its state, exit code, log and last lines.',
      'With id and wait_ms, wait up to wait_ms for the job to end (until "exit", the default) or to become ready or end (until "ready", for a job started with ready_pattern). The wait leaves the job running when the time runs out.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id returned by bash_background.' },
        wait_ms: {
          type: 'integer',
          description: `Milliseconds to wait for the job (0-${BASH_MAX_TIMEOUT_MS}).`,
        },
        until: { type: 'string', enum: ['exit', 'ready'] },
      },
    },
    effect: 'exec',
    async execute(input, ctx): Promise<ToolResult> {
      const id = optionalString(input, 'id');
      const waitMs = optionalInteger(input, 'wait_ms', { min: 0, max: BASH_MAX_TIMEOUT_MS });
      const until = untilArgument(input);
      if (until !== undefined && waitMs === undefined) {
        throw new InvalidArgumentError("'until' requires 'wait_ms'");
      }
      if (id === undefined) {
        if (waitMs !== undefined) throw new InvalidArgumentError("'wait_ms' requires 'id'");
        const jobs = registry.list();
        const now = Date.now();
        // A listing has no log details, so it leaves the events to their notes.
        const lines = jobs.map(
          (job) =>
            `${job.id}: ${stateLine(job, now)}: ${oneLine(job.command, LISTED_COMMAND_CHARS)}`,
        );
        return {
          content: lines.length === 0 ? '[no background jobs]' : lines.join('\n'),
          isError: false,
          meta: { jobs: jobs.length },
        };
      }
      let job: Job;
      try {
        job = registry.get(id);
      } catch (error) {
        return asToolError(error);
      }
      if (until === 'ready' && job.readyPattern === null) {
        throw new InvalidArgumentError(
          `'until' is ready, but job ${id} was started without ready_pattern`,
        );
      }
      let waited = '';
      if (waitMs !== undefined) {
        const target = until ?? 'exit';
        const reached = await registry.wait(job, waitMs, target, ctx.signal);
        if (!reached) {
          waited = ctx.signal.aborted
            ? '\n[the wait was interrupted; the job keeps running]'
            : `\n[${target === 'ready' ? 'not ready' : 'still running'} after waiting ${formatJobDuration(waitMs)}]`;
        }
      }
      const content = `${report(job)}${waited}`;
      registry.markShown(job);
      return jobResult(content, job);
    },
  },
  {
    name: 'bash_kill',
    description:
      'Stop a background job started with bash_background: its whole process group receives SIGTERM, then SIGKILL after 2s. Returns the final state of the job; a job that has already ended is left as it was.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id returned by bash_background.' },
      },
      required: ['id'],
    },
    effect: 'exec',
    async execute(input, ctx): Promise<ToolResult> {
      const id = requireNonEmptyString(input, 'id');
      let job: Job;
      try {
        job = registry.get(id);
      } catch (error) {
        return asToolError(error);
      }
      const alreadyEnded = job.finish !== null;
      const ended = await registry.kill(job, ctx.signal);
      const before = alreadyEnded ? '[the job had already ended]\n' : '';
      const after = ended
        ? ''
        : ctx.signal.aborted
          ? '\n[the wait for the job to end was interrupted; it was sent SIGTERM, then SIGKILL]'
          : `\n[the job had not ended ${formatJobDuration(KILL_WAIT_MS)} after it was stopped; it was sent SIGTERM, then SIGKILL]`;
      const content = `${before}${report(job)}${after}`;
      registry.markShown(job);
      return jobResult(content, job);
    },
  },
];
