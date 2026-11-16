import { CONTEXT_OVERFLOW, isContextOverflowMessage } from '../errors.ts';
import {
  normalizeOpenAIStream,
  type RawOpenAIChunk,
  type RawOpenAIError,
} from '../openai/stream.ts';
import type { StreamEvent } from '../types.ts';

// xAI streams the Chat Completions chunk shape with two differences: some models stream their
// reasoning as `delta.reasoning_content`, and `completion_tokens` counts only the visible answer,
// with the reasoning tokens reported separately in `completion_tokens_details`.
export type RawXaiChunk = RawOpenAIChunk;

// Stream errors carry no documented code vocabulary, so only codes that mirror a transient HTTP
// status are retried.
const isRetryableErrorCode = (code: string | number | null | undefined): boolean => {
  const n = typeof code === 'string' ? Number(code) : code;
  return typeof n === 'number' && Number.isFinite(n) && (n === 429 || (n >= 500 && n < 600));
};

const streamErrorEvent = (error: RawOpenAIError): StreamEvent => {
  const message = error.message ?? `xAI stream error (${String(error.code ?? 'unknown')})`;
  if (isContextOverflowMessage(message)) {
    return { kind: 'error', code: CONTEXT_OVERFLOW, message, retryable: false };
  }
  return {
    kind: 'error',
    code: 'xai.stream_error',
    message,
    retryable: isRetryableErrorCode(error.code),
  };
};

export const normalizeXaiStream = (raw: AsyncIterable<RawXaiChunk>): AsyncIterable<StreamEvent> =>
  normalizeOpenAIStream(raw, {
    idPrefix: 'xai',
    reasoningExcludedFromCompletion: true,
    streamError: streamErrorEvent,
  });
