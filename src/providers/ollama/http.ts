import { errorMessage } from '../../errors.ts';
import type { FetchLike } from '../discovery.ts';
import {
  AbortError,
  ContextOverflowError,
  isContextOverflowMessage,
  ProviderRequestError,
} from '../errors.ts';

// Client for the native `POST /api/chat` endpoint, read as an NDJSON stream with fetch so the
// request can be cancelled through its signal and parsing stays under local control.

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

// A single NDJSON line this long without a newline means a runaway or hostile stream.
const MAX_STREAM_LINE_CHARS = 16 * 1024 * 1024;

export interface OllamaToolCall {
  // Arguments arrive as an object, not as a JSON string.
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  // Ollama has no tool call ids; a tool result names the function it answers.
  tool_name?: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: unknown[];
  options?: Record<string, unknown>;
  // A boolean switch, or a level for models that take levels.
  think?: boolean | 'low' | 'medium' | 'high';
  keep_alive?: string | number;
}

// One NDJSON line. Content fields are deltas; the final line (`done: true`) carries the counts.
// `error` is set when the server fails after the response started.
export interface OllamaChatChunk {
  model?: string;
  created_at?: string;
  message?: Partial<OllamaMessage>;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

// `status` lets the generic retry treat 429 and 5xx as transient.
export class OllamaHttpError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OllamaHttpError';
    this.status = status;
  }
}

export interface OllamaHttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
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

const errorText = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as unknown;
    const error = (parsed as { error?: unknown } | null)?.error;
    if (typeof error === 'string') return error;
  } catch {
    // Not JSON; the raw body is the message.
  }
  return body;
};

const parseLine = (line: string): OllamaChatChunk => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new OllamaHttpError(
      `Ollama /api/chat sent a line that is not JSON: ${line.slice(0, 120)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OllamaHttpError(
      `Ollama /api/chat sent a line that is not an object: ${line.slice(0, 120)}`,
    );
  }
  return parsed as OllamaChatChunk;
};

export const createOllamaHttp = (options: OllamaHttpOptions) => {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  };

  const post = async (
    req: OllamaChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...req, stream: true }),
        signal: signal ?? null,
      });
    } catch (e) {
      if (signal?.aborted === true) throw new AbortError();
      // No HTTP status: the generic retry cannot classify it, and a server that is starting or
      // restarting usually answers on the next attempt.
      throw new ProviderRequestError(
        `cannot reach Ollama at ${displayOrigin(baseUrl)} (is the server running?): ${errorMessage(e)}`,
        { retryable: true, cause: e },
      );
    }
    if (res.ok) return res;
    const body = errorText((await res.text().catch(() => '')).trim());
    if (isContextOverflowMessage(body)) throw new ContextOverflowError(body);
    if (res.status === 404) {
      throw new OllamaHttpError(
        `Ollama has no model "${req.model}" (for a local server, pull it with "ollama pull ${req.model}")${body ? `: ${body}` : ''}`,
        404,
      );
    }
    throw new OllamaHttpError(
      `Ollama /api/chat failed: HTTP ${res.status}${body ? ` ${body}` : ''}`,
      res.status,
    );
  };

  async function* chatStream(
    req: OllamaChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OllamaChatChunk> {
    // Read through a function: the signal changes while the stream is awaited.
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) throw new AbortError();
    const res = await post(req, signal);
    if (res.body === null) throw new OllamaHttpError('Ollama /api/chat returned no response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (aborted()) throw new AbortError();
          throw new ProviderRequestError(`Ollama /api/chat stream failed: ${errorMessage(e)}`, {
            retryable: true,
            cause: e,
          });
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) yield parseLine(line);
          nl = buffer.indexOf('\n');
        }
        if (buffer.length > MAX_STREAM_LINE_CHARS) {
          throw new OllamaHttpError(
            `Ollama /api/chat sent more than ${MAX_STREAM_LINE_CHARS} characters without a newline`,
          );
        }
      }
      buffer += decoder.decode();
      const rest = buffer.trim();
      if (rest.length > 0) yield parseLine(rest);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    // A cancelled body can end without an error; the truncated turn must not look complete.
    if (aborted()) throw new AbortError();
  }

  return { chatStream };
};
