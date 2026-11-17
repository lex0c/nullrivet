import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { BoundedCapture } from '../context/bounded-capture.ts';

const KILL_GRACE_MS = 2_000;
// Memory bound per stream while the process runs. The head and the tail are kept because the
// end of the output (a test summary, the final error) is usually what matters.
const CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;

export type Termination = 'exited' | 'timeout' | 'aborted';

export interface ProcessRunOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  // Memory bound for stdout; defaults to CAPTURE_LIMIT_BYTES.
  stdoutLimitBytes?: number;
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

export const killAllProcessGroups = (): void => {
  for (const pgid of liveGroups) signalGroup(pgid, 'SIGKILL');
  liveGroups.clear();
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

// Runs a process in its own process group with stdin closed, bounded output capture, a timeout
// and abort support. Any process left in the group after the main one exits (background jobs)
// is terminated, so nothing outlives the call and the output pipes can close.
export const runProcess = (options: ProcessRunOptions): Promise<ProcessRunResult> =>
  new Promise((resolve, reject) => {
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
    const stderr = capture(child.stderr, undefined, options.onStderr);
    let termination: Termination = 'exited';
    let outputCutOff = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const terminate = (reason: Termination): void => {
      if (pgid === undefined || termination !== 'exited') return;
      termination = reason;
      signalGroup(pgid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(pgid, 'SIGKILL'), KILL_GRACE_MS);
    };

    const timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs);
    const onAbort = (): void => terminate('aborted');
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      options.signal.removeEventListener('abort', onAbort);
      if (pgid !== undefined) liveGroups.delete(pgid);
    };

    child.once('error', (error) => {
      cleanup();
      if (killTimer !== null) clearTimeout(killTimer);
      reject(error);
    });

    child.once('exit', async (exitCode, exitSignal) => {
      clearTimeout(timeoutTimer);
      options.signal.removeEventListener('abort', onAbort);
      if (pgid !== undefined) {
        signalGroup(pgid, 'SIGTERM');
        if (!(await waitForClose(child, KILL_GRACE_MS))) {
          signalGroup(pgid, 'SIGKILL');
          child.stdout?.destroy();
          child.stderr?.destroy();
          outputCutOff = true;
        }
      }
      cleanup();
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({
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
