import { isAbsolute, resolve } from 'node:path';
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

export type WorkerToHost =
  | { type: 'worker.ready'; protocol: number; tools: string[] }
  | { type: 'tool.result'; id: string; result: ToolResult }
  | { type: 'worker.error'; message: string };

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
