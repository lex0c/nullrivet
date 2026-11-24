import { constants } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { JobEvent } from '../tools/jobs.ts';
import { MAX_OUTPUT_PARTS, type SavedOutput } from '../tools/output-files.ts';
import type { ToolResult } from '../tools/types.ts';

// The entry point runs the sandbox worker instead of the CLI when its first argument is this. It
// is not an option of the CLI, so no prompt or flag can collide with it.
export const WORKER_ARGUMENT = '--nullrivet-sandbox-worker';

export const PROTOCOL_VERSION = 1;

// One JSON object per line in each direction. A longer line is a protocol violation.
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

// The protocol runs on these descriptors of the worker, not on its standard streams: bubblewrap's
// init process keeps the sandbox's standard streams open, and a command could write to them
// through /proc/1/fd.
export const HOST_TO_WORKER_FD = 3;
export const WORKER_TO_HOST_FD = 4;

// Bounds on what a worker result may carry. The host passes meta to the interface and the
// touched paths to the AGENTS.md discovery, so neither may be larger than the tools produce. The
// worker holds its results to them before sending, since a tool can exceed them, as git does with
// a long list of paths.
export const MAX_META_BYTES = 64 * 1024;
export const MAX_TOUCHED_PATHS = 64;
const MAX_PATH_CHARS = 4096;
const MAX_ERROR_CHARS = 4096;

export type HostToWorker =
  | {
      type: 'tool.execute';
      id: string;
      name: string;
      input: Record<string, unknown>;
      cwd: string;
    }
  | { type: 'tool.cancel'; id: string }
  | { type: 'worker.shutdown' };

// Background jobs run in the worker, which sends each fact as it happens: a job started, became
// ready or ended (with a sequence number), or was shown to the model by a tool.
export type WorkerToHost =
  | { type: 'worker.ready'; protocol: number; tools: string[] }
  | { type: 'tool.result'; id: string; result: ToolResult }
  | { type: 'worker.error'; message: string }
  | { type: 'job.started'; jobId: string }
  | { type: 'job.event'; seq: number; event: JobEvent }
  | { type: 'job.shown'; jobId: string };

export type JobMessage = Extract<WorkerToHost, { type: 'job.started' | 'job.event' | 'job.shown' }>;

type Parsed<T> = { ok: true; message: T } | { ok: false; reason: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

// Every field must be known and every required one present: a message from the sandbox with
// anything else is not one this host sent the worker to produce.
const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};

const parseObject = (line: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(line);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
};

export const isTouchedPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length > 0 &&
  path.length <= MAX_PATH_CHARS &&
  !path.includes('\0') &&
  isAbsolute(path) &&
  resolve(path) === path;

const readResult = (value: unknown): ToolResult | string => {
  if (!isPlainObject(value)) return 'the result is not an object';
  if (!hasExactKeys(value, ['content', 'isError'], ['meta', 'touchedPaths'])) {
    return 'the result has unknown or missing fields';
  }
  const { content, isError, meta, touchedPaths } = value;
  if (typeof content !== 'string') return 'the result content is not a string';
  if (typeof isError !== 'boolean') return 'the result isError is not a boolean';
  if (meta !== undefined) {
    if (!isPlainObject(meta)) return 'the result meta is not an object';
    if (Buffer.byteLength(JSON.stringify(meta), 'utf8') > MAX_META_BYTES) {
      return 'the result meta is too large';
    }
  }
  if (touchedPaths !== undefined) {
    if (!Array.isArray(touchedPaths) || touchedPaths.length > MAX_TOUCHED_PATHS) {
      return 'the result touchedPaths is not a list of at most 64 paths';
    }
    if (!touchedPaths.every(isTouchedPath)) {
      return 'the result touchedPaths holds a path that is not absolute and normalized';
    }
  }
  return {
    content,
    isError,
    ...(meta === undefined ? {} : { meta: meta as Record<string, unknown> }),
    ...(touchedPaths === undefined ? {} : { touchedPaths: touchedPaths as string[] }),
  };
};

// A job id: the registry's random prefix and a positive sequence number a JavaScript number holds
// exactly.
export const JOB_ID_PATTERN = /^([0-9a-f]{16})-([1-9][0-9]{0,14})$/;

// The parts of a job log, in the sandbox's /tmp. The directory can change during a job, when
// something removed it and the output code made a new one, so each part is checked on its own.
const JOB_LOG_PART = /^\/tmp\/nullrivet-[A-Za-z0-9]{6}\/[0-9]{1,15}-job\.[0-9]{3}\.txt$/;
// The most parts the output code makes within its limit per output; a line that does not fit at
// the end of a part starts the next, so parts can hold less than their size.
const MAX_JOB_LOG_PARTS = MAX_OUTPUT_PARTS;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// The reasons the output code writes end with an error message from the system; the note gets
// only the kind of failure. Any other text is replaced, since the note is trusted by the model.
const STOP_CATEGORIES = [
  'saving failed',
  'write failed',
  'could not create an output file',
  'closing an output file failed',
];
const LIMIT_REASON =
  /^the [0-9]+(\.[0-9])?(B|KB|MB) limit (per output|for the output files of this process) was reached$/;
const JOB_INTERRUPTIONS = [
  'the job reached its max_runtime_ms',
  'the job was stopped with bash_kill',
  'the processes the job left running were killed',
];

const reduceStopReason = (text: string): string => {
  if (LIMIT_REASON.test(text)) return text;
  const category = STOP_CATEGORIES.find(
    (prefix) => text === prefix || text.startsWith(`${prefix}:`),
  );
  return category ?? 'saving failed';
};

const reduceInterruption = (text: string): string =>
  JOB_INTERRUPTIONS.includes(text) ? text : 'following the process failed';

const readSavedOutput = (value: unknown): SavedOutput | string => {
  if (!isPlainObject(value)) return 'a job log that is not an object';
  if (
    !hasExactKeys(
      value,
      ['parts', 'savedBytes', 'receivedBytes'],
      ['stopReason', 'interrupted', 'binary'],
    )
  ) {
    return 'a job log with unknown or missing fields';
  }
  const { parts, savedBytes, receivedBytes, stopReason, interrupted, binary } = value;
  if (
    !Array.isArray(parts) ||
    parts.length > MAX_JOB_LOG_PARTS ||
    !parts.every((part) => typeof part === 'string' && JOB_LOG_PART.test(part))
  ) {
    return 'a job log whose parts are not log files of the sandbox';
  }
  if (!isCount(savedBytes) || !isCount(receivedBytes) || savedBytes > receivedBytes) {
    return 'a job log with invalid sizes';
  }
  if (
    stopReason !== undefined &&
    (typeof stopReason !== 'string' || stopReason.length > MAX_ERROR_CHARS)
  ) {
    return 'a job log with an invalid stop reason';
  }
  if (
    interrupted !== undefined &&
    (typeof interrupted !== 'string' || interrupted.length > MAX_ERROR_CHARS)
  ) {
    return 'a job log with an invalid interruption';
  }
  if (binary !== undefined && typeof binary !== 'boolean') return 'a job log with an invalid flag';
  return {
    parts: parts as string[],
    savedBytes,
    receivedBytes,
    ...(stopReason === undefined ? {} : { stopReason: reduceStopReason(stopReason) }),
    ...(interrupted === undefined ? {} : { interrupted: reduceInterruption(interrupted) }),
    ...(binary === undefined ? {} : { binary }),
  };
};

const FINISHED_STATUSES = ['completed', 'failed', 'stopped', 'timed_out'];

const readJobEvent = (value: unknown): JobEvent | string => {
  if (!isPlainObject(value)) return 'a job event that is not an object';
  const { type, jobId, at } = value;
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId))
    return 'a job event with an invalid job id';
  if (!isCount(at)) return 'a job event with an invalid time';
  if (type === 'job.ready') {
    if (
      !hasExactKeys(value, ['type', 'jobId', 'at', 'afterMs', 'log']) ||
      !isCount(value.afterMs)
    ) {
      return 'a malformed job.ready event';
    }
    const log = readSavedOutput(value.log);
    if (typeof log === 'string') return log;
    return { type, jobId, at, afterMs: value.afterMs, log };
  }
  if (type === 'job.finished') {
    const { durationMs, status, exitCode, signal } = value;
    if (
      !hasExactKeys(value, [
        'type',
        'jobId',
        'at',
        'durationMs',
        'status',
        'exitCode',
        'signal',
        'log',
      ]) ||
      !isCount(durationMs) ||
      typeof status !== 'string' ||
      !FINISHED_STATUSES.includes(status) ||
      !(exitCode === null || (isCount(exitCode) && exitCode <= 255)) ||
      !(signal === null || (typeof signal === 'string' && Object.hasOwn(constants.signals, signal)))
    ) {
      return 'a malformed job.finished event';
    }
    const log = value.log === null ? null : readSavedOutput(value.log);
    if (typeof log === 'string') return log;
    return {
      type,
      jobId,
      at,
      durationMs,
      status: status as Extract<JobEvent, { type: 'job.finished' }>['status'],
      exitCode,
      signal: signal as NodeJS.Signals | null,
      log,
    };
  }
  return 'a job event of an unknown type';
};

// Reads a line from the worker. The worker runs commands the model chose, so the line is
// untrusted: anything that is not exactly one of the messages above is refused with the reason.
export const parseWorkerMessage = (line: string): Parsed<WorkerToHost> => {
  const value = parseObject(line);
  if (value === null) return { ok: false, reason: 'a line that is not a JSON object' };
  switch (value.type) {
    case 'worker.ready': {
      const { protocol, tools } = value;
      if (
        !hasExactKeys(value, ['type', 'protocol', 'tools']) ||
        typeof protocol !== 'number' ||
        !Array.isArray(tools) ||
        !tools.every((name) => typeof name === 'string')
      ) {
        return { ok: false, reason: 'a malformed worker.ready message' };
      }
      return { ok: true, message: { type: 'worker.ready', protocol, tools: tools as string[] } };
    }
    case 'tool.result': {
      if (!hasExactKeys(value, ['type', 'id', 'result']) || typeof value.id !== 'string') {
        return { ok: false, reason: 'a malformed tool.result message' };
      }
      const result = readResult(value.result);
      if (typeof result === 'string') return { ok: false, reason: result };
      return { ok: true, message: { type: 'tool.result', id: value.id, result } };
    }
    case 'worker.error': {
      const { message } = value;
      if (
        !hasExactKeys(value, ['type', 'message']) ||
        typeof message !== 'string' ||
        message.length > MAX_ERROR_CHARS
      ) {
        return { ok: false, reason: 'a malformed worker.error message' };
      }
      return { ok: true, message: { type: 'worker.error', message } };
    }
    case 'job.started':
    case 'job.shown': {
      const { jobId } = value;
      if (
        !hasExactKeys(value, ['type', 'jobId']) ||
        typeof jobId !== 'string' ||
        !JOB_ID_PATTERN.test(jobId)
      ) {
        return { ok: false, reason: `a malformed ${value.type} message` };
      }
      return { ok: true, message: { type: value.type, jobId } };
    }
    case 'job.event': {
      const { seq } = value;
      if (!hasExactKeys(value, ['type', 'seq', 'event']) || !isCount(seq) || seq < 1) {
        return { ok: false, reason: 'a malformed job.event message' };
      }
      const event = readJobEvent(value.event);
      if (typeof event === 'string') return { ok: false, reason: event };
      return { ok: true, message: { type: 'job.event', seq, event } };
    }
    default:
      return { ok: false, reason: 'a message of an unknown type' };
  }
};

// Reads a line from the host. The host is trusted, but a line it did not mean to send, such as
// one cut short, is still refused rather than guessed at.
export const parseHostMessage = (line: string): HostToWorker | null => {
  const value = parseObject(line);
  if (value === null) return null;
  switch (value.type) {
    case 'tool.execute': {
      const { id, name, input, cwd } = value;
      if (
        !hasExactKeys(value, ['type', 'id', 'name', 'input', 'cwd']) ||
        typeof id !== 'string' ||
        typeof name !== 'string' ||
        !isPlainObject(input) ||
        typeof cwd !== 'string'
      ) {
        return null;
      }
      return { type: 'tool.execute', id, name, input, cwd };
    }
    case 'tool.cancel':
      return hasExactKeys(value, ['type', 'id']) && typeof value.id === 'string'
        ? { type: 'tool.cancel', id: value.id }
        : null;
    case 'worker.shutdown':
      return hasExactKeys(value, ['type']) ? { type: 'worker.shutdown' } : null;
    default:
      return null;
  }
};

export const encodeMessage = (message: HostToWorker | WorkerToHost): string =>
  `${JSON.stringify(message)}\n`;
