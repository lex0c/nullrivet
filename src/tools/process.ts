import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { BoundedCapture } from '../context/bounded-capture.ts';

export const KILL_GRACE_MS = 2_000;
// Timers fire at once when the delay does not fit in a signed 32-bit integer (about 24.8 days).
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Memory bound per stream while the process runs. The head and the tail are kept because the
// end of the output (a test summary, the final error) is usually what matters.
const CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;

export type Termination = 'exited' | 'timeout' | 'aborted';

export interface ProcessRunOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  // Terminates the group with the `timeout` termination; no time limit when omitted.
  timeoutMs?: number;
  // Terminates the group with the `aborted` termination; not tied to any signal when omitted.
  signal?: AbortSignal;
  // Memory bounds for each stream; default to CAPTURE_LIMIT_BYTES.
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  // Receive every chunk of output, beyond the memory bound. They must not throw.
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  termination: Termination;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
  // True when processes left in the group kept the output pipes open past the grace period and
  // were killed, so output still in the pipes was not read.
  outputCutOff: boolean;
}

// Why the output of a run ended before the command finished writing it, if it did.
export const captureInterruption = (run: ProcessRunResult): string | undefined => {
  if (run.termination === 'timeout') return 'the command timed out';
  if (run.termination === 'aborted') return 'the command was aborted';
  if (run.outputCutOff) return 'the processes the command left running were killed';
  return undefined;
};

// Process groups still running, so they can be killed when the agent exits.
const liveGroups = new Set<number>();

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: every process of the group has already exited.
  }
};

// A group signal can miss a process being forked at that moment: on macOS the child can join the
// group after the signal went through its members, and outlive its killed parent. While the agent
// runs, a group is signalled again once its main process exits; at exit nothing comes after, so
// the signal is repeated a few times, which catches a child forked during the previous one.
const EXIT_KILL_ROUNDS = 3;
const EXIT_KILL_INTERVAL_MS = 10;

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// A process group started without runProcess, such as the sandbox, so that killAllProcessGroups
// kills it too. Returns the function that stops tracking it once it has exited.
export const trackProcessGroup = (pgid: number): (() => void) => {
  liveGroups.add(pgid);
  return () => {
    liveGroups.delete(pgid);
  };
};

export const killAllProcessGroups = (): void => {
  const groups = [...liveGroups];
  liveGroups.clear();
  if (groups.length === 0) return;
  for (let round = 0; round < EXIT_KILL_ROUNDS; round++) {
    if (round > 0) pause(EXIT_KILL_INTERVAL_MS);
    for (const pgid of groups) signalGroup(pgid, 'SIGKILL');
  }
};

const capture = (
  stream: Readable | null,
  limit = CAPTURE_LIMIT_BYTES,
  onChunk?: (chunk: Buffer) => void,
): BoundedCapture => {
  const out = new BoundedCapture(limit);
  stream?.on('data', (chunk: Buffer) => {
    out.push(chunk);
    onChunk?.(chunk);
  });
  return out;
};

export interface ProcessHandle {
  pid: number;
  // Settles once the process has exited and its output pipes are closed.
  done: Promise<ProcessRunResult>;
  // Terminates the whole group: SIGTERM, then SIGKILL after a grace period. Only the first call
  // has an effect, and none once the process has exited, so the termination reported is the
  // first one requested before the exit, and a process that exited on its own reports `exited`.
  terminate(reason: Exclude<Termination, 'exited'>): void;
}

const waitForClose = (child: ChildProcess, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.stdout?.closed !== false && child.stderr?.closed !== false) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    child.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const GROUP_POLL_MS = 25;

// Whether any process of the group is left. Signal 0 checks without delivering anything; EPERM
// means a member exists that this process may not signal.
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// Resolves true once the group has no process left, or false when `ms` runs out first.
const waitForGroupExit = async (pgid: number, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(GROUP_POLL_MS);
  }
  return true;
};

// Starts a process in its own process group with stdin closed, bounded output capture and the
// optional timeout and abort. Resolves once the process exists and rejects when it cannot start,
// so a failure to start is never mistaken for the end of a run. Any process left in the group after
// the main one exits (background jobs) is terminated, so nothing outlives the run and the output
// pipes can close.
export const startProcess = (options: ProcessRunOptions): Promise<ProcessHandle> =>
  new Promise((resolveStart, rejectStart) => {
    const startedAt = Date.now();
    const child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pgid = child.pid;
    if (pgid !== undefined) liveGroups.add(pgid);
    const stdout = capture(child.stdout, options.stdoutLimitBytes, options.onStdout);
    const stderr = capture(child.stderr, options.stderrLimitBytes, options.onStderr);
    const done = Promise.withResolvers<ProcessRunResult>();
    let started = false;
    let exited = false;
    let termination: Termination = 'exited';
    let outputCutOff = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const terminate = (reason: Exclude<Termination, 'exited'>): void => {
      if (pgid === undefined || exited || termination !== 'exited') return;
      termination = reason;
      signalGroup(pgid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(pgid, 'SIGKILL'), KILL_GRACE_MS);
    };
    const onAbort = (): void => terminate('aborted');

    const stopTimers = (): void => {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const cleanup = (): void => {
      stopTimers();
      if (killTimer !== null) clearTimeout(killTimer);
      if (pgid !== undefined) liveGroups.delete(pgid);
    };

    child.once('spawn', () => {
      if (pgid === undefined) {
        rejectStart(new Error('the process started without a pid'));
        return;
      }
      started = true;
      if (options.timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs);
      }
      if (options.signal?.aborted === true) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      resolveStart({ pid: pgid, done: done.promise, terminate });
    });

    child.once('error', (error) => {
      cleanup();
      if (started) done.reject(error);
      else rejectStart(error);
    });

    child.once('exit', async (exitCode, exitSignal) => {
      exited = true;
      stopTimers();
      if (pgid !== undefined) {
        signalGroup(pgid, 'SIGTERM');
        const deadline = Date.now() + KILL_GRACE_MS;
        const closed = await waitForClose(child, KILL_GRACE_MS);
        // Closed pipes do not mean the group is gone: a process that ignores SIGTERM and writes
        // elsewhere outlives them, and once the group leaves liveGroups nothing would kill it.
        const emptied = await waitForGroupExit(pgid, deadline - Date.now());
        if (!closed || !emptied) signalGroup(pgid, 'SIGKILL');
        if (!closed) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          outputCutOff = true;
        }
      }
      cleanup();
      done.resolve({
        exitCode,
        signal: exitSignal,
        termination,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        durationMs: Date.now() - startedAt,
        outputCutOff,
      });
    });
  });

// Runs a process to its end; see startProcess.
export const runProcess = async (options: ProcessRunOptions): Promise<ProcessRunResult> => {
  const handle = await startProcess(options);
  return handle.done;
};
