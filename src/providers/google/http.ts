import { errorMessage } from '../../errors.ts';
import type { FetchLike } from '../discovery.ts';
import {
  AbortError,
  ContextOverflowError,
  isContextOverflowMessage,
  ProviderRequestError,
} from '../errors.ts';
import type { RawGoogleChunk } from './stream.ts';

// Client for `models/{model}:streamGenerateContent`, read as server-sent events with fetch, so
// the request can be cancelled through its signal and no SDK reads credentials or settings from
// the environment.

export const DEFAULT_GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// An event this long without its terminating blank line means a runaway or hostile stream.
const MAX_EVENT_CHARS = 16 * 1024 * 1024;

// `status` lets the generic retry treat 429 and 5xx as transient.
export class GoogleHttpError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GoogleHttpError';
    this.status = status;
  }
}

export interface GoogleHttpOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
}

// Messages may reach logs, so they never carry credentials or query parameters from the URL.
const displayOrigin = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '<invalid url>';
  }
};

interface ErrorDetails {
  message: string;
  // Canonical status name, such as INVALID_ARGUMENT or RESOURCE_EXHAUSTED.
  status: string | undefined;
}

// Error bodies are `{ error: { code, message, status } }`, or an array holding one such object,
// and may be framed as a server-sent event.
const errorDetails = (body: string): ErrorDetails => {
  try {
    const parsed = JSON.parse(body.startsWith('data:') ? body.slice(5) : body) as unknown;
    const first = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
    const error = (first as { error?: { message?: unknown; status?: unknown } } | null)?.error;
    if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
      return {
        message: error.message.trim(),
        status: typeof error.status === 'string' ? error.status : undefined,
      };
    }
  } catch {
    // Not JSON; the raw body is the message.
  }
  return { message: body, status: undefined };
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
    const details = errorDetails((await res.text().catch(() => '')).trim());
    if (isContextOverflowMessage(details.message)) throw new ContextOverflowError(details.message);
    const status = details.status === undefined ? '' : ` ${details.status}`;
    const message = details.message.length > 0 ? `: ${details.message}` : '';
    throw new GoogleHttpError(
      `Gemini API request for "${model}" failed: HTTP ${res.status}${status}${message}`,
      res.status,
    );
  };

  // Each event is one or more `data:` lines ended by a blank line; other fields are not used.
  async function* streamGenerateContent(
    model: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncIterable<RawGoogleChunk> {
    // Read through a function: the signal changes while the stream is awaited.
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) throw new AbortError();
    const res = await post(model, body, signal);
    if (res.body === null) throw new GoogleHttpError('Gemini API returned no response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    let dataChars = 0;

    const takeEvent = (): RawGoogleChunk | undefined => {
      const joined = data.join('\n');
      data = [];
      dataChars = 0;
      return joined.length > 0 ? parseEvent(joined) : undefined;
    };

    // Returns the event completed by this line, if any.
    const readLine = (line: string): RawGoogleChunk | undefined => {
      if (line.length === 0) return takeEvent();
      if (line.startsWith('data:')) {
        const value = line.slice(line.startsWith('data: ') ? 6 : 5);
        data.push(value);
        dataChars += value.length;
      }
      return undefined;
    };

    try {
      while (true) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (aborted()) throw new AbortError();
          throw new ProviderRequestError(`Gemini API stream failed: ${errorMessage(e)}`, {
            retryable: true,
            cause: e,
          });
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          const event = readLine(line);
          if (event !== undefined) yield event;
          nl = buffer.indexOf('\n');
        }
        if (buffer.length + dataChars > MAX_EVENT_CHARS) {
          throw new GoogleHttpError(
            `Gemini API sent an event longer than ${MAX_EVENT_CHARS} characters`,
          );
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) readLine(buffer.replace(/\r$/, ''));
      const last = takeEvent();
      if (last !== undefined) yield last;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    // A cancelled body can end without an error; the truncated turn must not look complete.
    if (aborted()) throw new AbortError();
  }

  return { streamGenerateContent };
};
