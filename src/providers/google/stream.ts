import { CONTEXT_OVERFLOW, INVALID_TOOL_CALL, isContextOverflowMessage } from '../errors.ts';
import type { StopReason, StreamEvent } from '../types.ts';
import { parseToolArguments } from '../types.ts';

// The subset of a `streamGenerateContent` event the normalizer reads. Function calls arrive
// complete in a single part. `thoughtSignature` is opaque reasoning state attached to the part it
// belongs to, which the API requires back on function calls of the current turn.
export interface RawGooglePart {
  text?: string;
  // Thought summary text, sent only when the request asks for thoughts.
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
}

export interface RawGoogleCandidate {
  content?: { role?: string; parts?: RawGooglePart[] };
  finishReason?: string | null;
  finishMessage?: string;
}

// `promptTokenCount` includes the cached part of the prompt. Thinking tokens are billed as output
// but reported in `thoughtsTokenCount`, apart from `candidatesTokenCount`.
export interface RawGoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

// `error` is an error the server reports after the stream started.
export interface RawGoogleChunk {
  responseId?: string;
  candidates?: RawGoogleCandidate[];
  usageMetadata?: RawGoogleUsageMetadata;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

// Data of the `reasoning` events this normalizer emits. The signature is kept as received.
export interface GoogleReasoningData {
  thoughtSignature: string;
}

// Gemini assigns no id to most function calls. Synthesized ids carry this prefix so the request
// builder does not send them back as if the API had issued them.
export const SYNTHETIC_CALL_ID_PREFIX = 'gemini_call_';

const FINISH_REASON_MAP: Readonly<Record<string, StopReason>> = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  LANGUAGE: 'refusal',
  BLOCKLIST: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  SPII: 'refusal',
  IMAGE_SAFETY: 'refusal',
  IMAGE_PROHIBITED_CONTENT: 'refusal',
  IMAGE_RECITATION: 'refusal',
};

// The model attempted a function call that cannot be executed; the agent reports it back so the
// model can issue it again.
const INVALID_CALL_FINISH_REASONS: ReadonlySet<string> = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
]);

// Canonical statuses that describe a temporary condition of the service.
const RETRYABLE_STATUSES: ReadonlySet<string> = new Set([
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'INTERNAL',
  'DEADLINE_EXCEEDED',
]);

const synthesizeMessageId = (): string => `gemini_${crypto.randomUUID()}`;

const streamErrorEvent = (error: NonNullable<RawGoogleChunk['error']>): StreamEvent => {
  const message =
    error.message ?? `Gemini API stream error (${error.status ?? error.code ?? 'unknown'})`;
  if (isContextOverflowMessage(message)) {
    return { kind: 'error', code: CONTEXT_OVERFLOW, message, retryable: false };
  }
  const code = error.code;
  return {
    kind: 'error',
    code: 'google.stream_error',
    message,
    retryable:
      (error.status !== undefined && RETRYABLE_STATUSES.has(error.status)) ||
      (typeof code === 'number' && (code === 429 || (code >= 500 && code < 600))),
  };
};

// A signature is emitted as a `reasoning` event before the content of its part, so the request
// builder can attach it to the same part when the turn is replayed.
export async function* normalizeGoogleStream(
  raw: AsyncIterable<RawGoogleChunk>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  // Set only by a finish reason or a blocked prompt: a stream that ends without one was cut short,
  // and the step collector reports it as incomplete.
  let stopReason: StopReason | undefined;
  let toolCallSeen = false;
  let rawPrompt = 0;
  let rawCandidates = 0;
  let rawThoughts = 0;
  let rawCached = 0;
  let usageSeen = false;
  let usageEmitted = false;

  // The counts are cumulative; the running maximum keeps a partial later report from shrinking
  // them. `input` excludes cached tokens so they are not counted twice. Gemini reports no cache
  // writes.
  const emitUsage = function* (): Iterable<StreamEvent> {
    if (usageSeen && !usageEmitted) {
      usageEmitted = true;
      yield {
        kind: 'usage',
        usage: {
          input: Math.max(0, rawPrompt - rawCached),
          output: rawCandidates + rawThoughts,
          cache_read: rawCached,
          cache_creation: 0,
        },
      };
    }
  };

  try {
    for await (const chunk of raw) {
      if (!messageStarted) {
        yield { kind: 'start', message_id: chunk.responseId ?? synthesizeMessageId() };
        messageStarted = true;
      }

      if (chunk.error !== undefined && chunk.error !== null) {
        yield streamErrorEvent(chunk.error);
        yield* emitUsage();
        return;
      }

      const u = chunk.usageMetadata;
      if (u !== undefined) {
        if (typeof u.promptTokenCount === 'number') {
          rawPrompt = Math.max(rawPrompt, u.promptTokenCount);
          usageSeen = true;
        }
        if (typeof u.candidatesTokenCount === 'number') {
          rawCandidates = Math.max(rawCandidates, u.candidatesTokenCount);
          usageSeen = true;
        }
        if (typeof u.thoughtsTokenCount === 'number') {
          rawThoughts = Math.max(rawThoughts, u.thoughtsTokenCount);
          usageSeen = true;
        }
        if (typeof u.cachedContentTokenCount === 'number') {
          rawCached = Math.max(rawCached, u.cachedContentTokenCount);
          usageSeen = true;
        }
      }

      // A blocked prompt produces no candidates.
      if (typeof chunk.promptFeedback?.blockReason === 'string') stopReason = 'refusal';

      const candidate = chunk.candidates?.[0];
      if (candidate === undefined) continue;

      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0) {
          const data: GoogleReasoningData = { thoughtSignature: part.thoughtSignature };
          yield { kind: 'reasoning', provider: 'google', data };
        }
        if (part.functionCall !== undefined) {
          toolCallSeen = true;
          const call = part.functionCall;
          const id =
            typeof call.id === 'string' && call.id.length > 0
              ? call.id
              : `${SYNTHETIC_CALL_ID_PREFIX}${crypto.randomUUID()}`;
          if (typeof call.name !== 'string' || call.name.length === 0) {
            yield {
              kind: 'error',
              code: INVALID_TOOL_CALL,
              message: `function call ${id} has no name`,
              retryable: false,
            };
            continue;
          }
          const args = JSON.stringify(call.args ?? {});
          let parsed: Record<string, unknown>;
          try {
            parsed = parseToolArguments(args);
          } catch (e) {
            yield {
              kind: 'error',
              code: INVALID_TOOL_CALL,
              message: `invalid arguments for function call ${call.name} (${id}): ${(e as Error).message}`,
              retryable: false,
            };
            continue;
          }
          yield { kind: 'tool_use_start', id, name: call.name };
          yield { kind: 'tool_use_delta', id, partial_args: args };
          yield { kind: 'tool_use_stop', id, final_args: parsed };
        } else if (typeof part.text === 'string' && part.text.length > 0) {
          yield part.thought === true
            ? { kind: 'thinking_delta', text: part.text }
            : { kind: 'text_delta', text: part.text };
        }
      }

      const finish = candidate.finishReason;
      if (typeof finish === 'string') {
        if (INVALID_CALL_FINISH_REASONS.has(finish)) {
          const detail =
            candidate.finishMessage === undefined ? '' : `: ${candidate.finishMessage}`;
          yield {
            kind: 'error',
            code: INVALID_TOOL_CALL,
            message: `the model produced a function call that cannot be executed (${finish})${detail}`,
            retryable: false,
          };
        } else if (FINISH_REASON_MAP[finish] !== undefined) {
          stopReason = FINISH_REASON_MAP[finish];
        } else {
          // OTHER, TOO_MANY_TOOL_CALLS, an unspecified reason or one added later: the model
          // stopped for a reason this adapter cannot vouch for, which must not look like a clean
          // finish.
          const detail =
            candidate.finishMessage === undefined ? '' : `: ${candidate.finishMessage}`;
          yield {
            kind: 'error',
            code: 'google.finish_reason',
            message: `the model stopped with finish reason ${finish}${detail}`,
            retryable: false,
          };
        }
      }
    }

    if (!messageStarted) yield { kind: 'start', message_id: synthesizeMessageId() };
    yield* emitUsage();
    // Gemini finishes a step with function calls as STOP.
    if (stopReason !== undefined) {
      yield {
        kind: 'stop',
        reason: toolCallSeen && stopReason === 'end_turn' ? 'tool_use' : stopReason,
      };
    }
  } finally {
    // A turn that failed mid-stream was still billed, so its usage is reported before the error
    // propagates.
    yield* emitUsage();
  }
}
