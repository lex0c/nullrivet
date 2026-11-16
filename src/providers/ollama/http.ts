import { errorMessage } from '../../errors.ts';
import type { FetchLike } from '../discovery.ts';
import {
  AbortError,
  ContextOverflowError,
  isContextOverflowMessage,
  ProviderRequestError,
} from '../errors.ts';
import { displayOrigin, readLines } from '../http-stream.ts';

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
    const raw = await res.text().catch(() => '');
    // An abort while the error body is read is a cancellation, not the server's failure.
    if (signal?.aborted === true) throw new AbortError();
    const body = errorText(raw.trim());
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
    if (signal?.aborted === true) throw new AbortError();
    const res = await post(req, signal);
    const lines = readLines(res, {
      label: 'Ollama /api/chat',
      maxLineChars: MAX_STREAM_LINE_CHARS,
      signal,
      fail: (message) => new OllamaHttpError(message),
    });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) yield parseLine(trimmed);
    }
  }

  return { chatStream };
};
