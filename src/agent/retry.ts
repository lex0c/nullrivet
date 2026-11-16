import { ProviderRequestError } from '../providers/errors.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../providers/types.ts';
import { AbortError, abortableSleep } from './abortable.ts';

export interface RetryOptions {
  maxAttempts: number;
  // Delay before attempt n+1 is `baseDelayMs * 4^(n-1)`: 200, 800, 3200 ms with the defaults.
  baseDelayMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
};

// Caps a server-supplied Retry-After so a pathological value cannot stall a turn indefinitely.
export const MAX_RETRY_AFTER_MS = 8_000;

const NETWORK_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];

// Duck-typed so no SDK error class has to be imported: the SDKs expose `.status` on HTTP errors
// and Node exposes `.code` on network errors.
export const isRetryableError = (e: unknown): boolean => {
  if (e instanceof ProviderRequestError) return e.retryable;
  if (!(e instanceof Error)) return false;
  const status = (e as { status?: unknown }).status;
  if (typeof status === 'number') {
    return status === 429 || (status >= 500 && status < 600);
  }
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.includes(code);
};

// Reads `retry-after-ms` (milliseconds) or `retry-after` (seconds) from an SDK error. Headers may
// be a `Headers` instance or a plain object. HTTP-date values are ignored.
export const retryAfterMs = (e: unknown): number | undefined => {
  const headers = (e as { headers?: unknown }).headers;
  if (headers === null || typeof headers !== 'object') return undefined;
  const read = (key: string): string | undefined => {
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter === 'function') {
      const v = (getter as (k: string) => unknown).call(headers, key);
      return typeof v === 'string' ? v : undefined;
    }
    const v = (headers as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    return undefined;
  };
  const ms = read('retry-after-ms');
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const secs = read('retry-after');
  if (secs !== undefined) {
    const n = Number(secs);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  return undefined;
};

// Retries only failures that happen before the first event. Once an event has been yielded the
// consumer has already acted on it, and replaying the stream would duplicate output.
export async function* generateWithRetry(
  provider: Provider,
  req: GenerateRequest,
  signal?: AbortSignal,
  options: RetryOptions = DEFAULT_RETRY,
): AsyncIterable<StreamEvent> {
  const sleep = options.sleep ?? abortableSleep;
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new AbortError();
    attempt += 1;
    let yieldedAny = false;
    try {
      for await (const ev of provider.generate(req, signal)) {
        yieldedAny = true;
        yield ev;
      }
      return;
    } catch (e) {
      if (yieldedAny || attempt >= options.maxAttempts || !isRetryableError(e)) throw e;
      // Waiting less than the server asked for only spends an attempt against a saturated limit.
      const backoff = options.baseDelayMs * 4 ** (attempt - 1);
      const delay = Math.min(Math.max(backoff, retryAfterMs(e) ?? 0), MAX_RETRY_AFTER_MS);
      await sleep(delay, signal);
    }
  }
}
