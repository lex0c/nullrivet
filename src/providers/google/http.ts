import { errorMessage } from '../../errors.ts';
import type { FetchLike } from '../discovery.ts';
import {
  AbortError,
  ContextOverflowError,
  isContextOverflowMessage,
  ProviderRequestError,
} from '../errors.ts';
import { displayOrigin, readLines } from '../http-stream.ts';
import type { RawGoogleChunk } from './stream.ts';

// Client for `models/{model}:streamGenerateContent`, read as server-sent events with fetch, so
// the request can be cancelled through its signal and no SDK reads credentials or settings from
// the environment.

export const DEFAULT_GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// An event this long without its terminating blank line means a runaway or hostile stream.
const MAX_EVENT_CHARS = 16 * 1024 * 1024;

// `status` lets the generic retry treat 429 and 5xx as transient, and `headers` carries the
// server's advice on when to retry, which the retry reads.
export class GoogleHttpError extends Error {
  readonly status: number | undefined;
  readonly headers: Record<string, string> | undefined;
  constructor(message: string, status?: number, headers?: Record<string, string>) {
    super(message);
    this.name = 'GoogleHttpError';
    this.status = status;
    this.headers = headers;
  }
}

export interface GoogleHttpOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
}

interface ErrorDetails {
  message: string;
  // Canonical status name, such as INVALID_ARGUMENT or RESOURCE_EXHAUSTED.
  status: string | undefined;
  // From a RetryInfo detail, which quota errors carry instead of a Retry-After header.
  retryDelayMs: number | undefined;
}

// A protobuf Duration in its JSON form, such as "30s" or "1.5s".
const durationMs = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match === null ? undefined : Math.round(Number(match[1]) * 1_000);
};

const retryDelayOf = (details: unknown): number | undefined => {
  if (!Array.isArray(details)) return undefined;
  for (const detail of details as unknown[]) {
    const entry = detail as { '@type'?: unknown; retryDelay?: unknown } | null;
    if (typeof entry?.['@type'] === 'string' && entry['@type'].endsWith('RetryInfo')) {
      return durationMs(entry.retryDelay);
    }
  }
  return undefined;
};

// Error bodies are `{ error: { code, message, status } }`, or an array holding one such object,
// and may be framed as a server-sent event.
const errorDetails = (body: string): ErrorDetails => {
  try {
    const parsed = JSON.parse(body.startsWith('data:') ? body.slice(5) : body) as unknown;
    const first = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
    const error = (
      first as { error?: { message?: unknown; status?: unknown; details?: unknown } } | null
    )?.error;
    if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
      return {
        message: error.message.trim(),
        status: typeof error.status === 'string' ? error.status : undefined,
        retryDelayMs: retryDelayOf(error.details),
      };
    }
  } catch {
    // Not JSON; the raw body is the message.
  }
  return { message: body, status: undefined, retryDelayMs: undefined };
};

const parseEvent = (data: string): RawGoogleChunk => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new GoogleHttpError(`Gemini API sent an event that is not JSON: ${data.slice(0, 120)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GoogleHttpError(
      `Gemini API sent an event that is not an object: ${data.slice(0, 120)}`,
    );
  }
  return parsed as RawGoogleChunk;
};

export const createGoogleHttp = (options: GoogleHttpOptions) => {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    // Sent as a header rather than the `key` query parameter, so it never appears in a URL.
    'x-goog-api-key': options.apiKey,
  };

  const post = async (
    model: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    } catch (e) {
      if (signal?.aborted === true) throw new AbortError();
      // No HTTP status: the generic retry cannot classify it, and a dropped connection usually
      // succeeds on the next attempt.
      throw new ProviderRequestError(
        `connection to the Gemini API at ${displayOrigin(baseUrl)} failed: ${errorMessage(e)}`,
        { retryable: true, cause: e },
      );
    }
    if (res.ok) return res;
    const raw = await res.text().catch(() => '');
    // An abort while the error body is read is a cancellation, not the server's failure.
    if (signal?.aborted === true) throw new AbortError();
    const details = errorDetails(raw.trim());
    if (isContextOverflowMessage(details.message)) throw new ContextOverflowError(details.message);
    const status = details.status === undefined ? '' : ` ${details.status}`;
    const message = details.message.length > 0 ? `: ${details.message}` : '';
    const retryAfter = res.headers.get('retry-after');
    const retryHeaders =
      details.retryDelayMs !== undefined
        ? { 'retry-after-ms': String(details.retryDelayMs) }
        : retryAfter !== null
          ? { 'retry-after': retryAfter }
          : undefined;
    throw new GoogleHttpError(
      `Gemini API request for "${model}" failed: HTTP ${res.status}${status}${message}`,
      res.status,
      retryHeaders,
    );
  };

  // Each event is one or more `data:` lines ended by a blank line; other fields are not used.
  async function* streamGenerateContent(
    model: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncIterable<RawGoogleChunk> {
    if (signal?.aborted === true) throw new AbortError();
    const res = await post(model, body, signal);
    let data: string[] = [];
    let dataChars = 0;
    const takeEvent = (): RawGoogleChunk | undefined => {
      const joined = data.join('\n');
      data = [];
      dataChars = 0;
      return joined.length > 0 ? parseEvent(joined) : undefined;
    };
    const lines = readLines(res, {
      label: 'Gemini API',
      maxLineChars: MAX_EVENT_CHARS,
      signal,
      fail: (message) => new GoogleHttpError(message),
    });
    for await (const line of lines) {
      if (line.length === 0) {
        const event = takeEvent();
        if (event !== undefined) yield event;
      } else if (line.startsWith('data:')) {
        const value = line.slice(line.startsWith('data: ') ? 6 : 5);
        data.push(value);
        dataChars += value.length;
        if (dataChars > MAX_EVENT_CHARS) {
          throw new GoogleHttpError(
            `Gemini API sent an event longer than ${MAX_EVENT_CHARS} characters`,
          );
        }
      }
    }
    const last = takeEvent();
    if (last !== undefined) yield last;
  }

  return { streamGenerateContent };
};
