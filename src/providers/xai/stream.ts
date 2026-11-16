import { CONTEXT_OVERFLOW, INVALID_TOOL_CALL, isContextOverflowMessage } from '../errors.ts';
import type { StopReason, StreamEvent } from '../types.ts';
import { parseToolArguments } from '../types.ts';

// xAI streams the OpenAI Chat Completions chunk shape with two differences: some models stream
// their reasoning as `delta.reasoning_content`, and `completion_tokens` counts only the visible
// answer, with the reasoning tokens reported separately in `completion_tokens_details`.

export interface RawXaiToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface RawXaiChoice {
  index?: number;
  delta?: {
    role?: string;
    content?: string | null;
    refusal?: string | null;
    reasoning_content?: string | null;
    tool_calls?: RawXaiToolCallDelta[];
  };
  finish_reason?: string | null;
}

// Present on the final chunk when the request sets `stream_options.include_usage`.
export interface RawXaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

// `error` is a stream error, which the SDK throws instead of yielding; the adapter turns it back
// into a chunk.
export interface RawXaiChunk {
  id?: string;
  choices?: RawXaiChoice[];
  usage?: RawXaiUsage | null;
  error?: { code?: string | number | null; message?: string } | null;
}

interface ToolCallInProgress {
  id: string;
  // Name fragments are appended until the call starts, so a name split across deltas is not
  // truncated to its first fragment.
  name: string;
  partialArgs: string;
  // `tool_use_start` waits for the first argument fragment, which always follows the complete
  // name, or for finalization when the call has no arguments.
  started: boolean;
}

const FINISH_REASON_MAP: Readonly<Record<string, StopReason>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

const synthesizeMessageId = (): string => `xai_${crypto.randomUUID()}`;

// Stream errors carry no documented code vocabulary, so only codes that mirror a transient HTTP
// status are retried.
const isRetryableErrorCode = (code: string | number | null | undefined): boolean => {
  const n = typeof code === 'string' ? Number(code) : code;
  return typeof n === 'number' && Number.isFinite(n) && (n === 429 || (n >= 500 && n < 600));
};

const streamErrorEvent = (error: NonNullable<RawXaiChunk['error']>): StreamEvent => {
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

export async function* normalizeXaiStream(
  raw: AsyncIterable<RawXaiChunk>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let stopReason: StopReason = 'end_turn';
  const toolCalls = new Map<number, ToolCallInProgress>();
  let rawPrompt = 0;
  let rawCompletion = 0;
  let rawReasoning = 0;
  let rawCached = 0;
  let usageSeen = false;
  let usageEmitted = false;

  // `prompt_tokens` includes cached tokens, so `input` subtracts them to avoid counting them
  // twice. Reasoning tokens are billed as output but excluded from `completion_tokens`, so they
  // are added back. xAI reports no cache writes.
  const emitUsage = function* (): Iterable<StreamEvent> {
    if (usageSeen && !usageEmitted) {
      usageEmitted = true;
      yield {
        kind: 'usage',
        usage: {
          input: Math.max(0, rawPrompt - rawCached),
          output: rawCompletion + rawReasoning,
          cache_read: rawCached,
          cache_creation: 0,
        },
      };
    }
  };

  try {
    for await (const chunk of raw) {
      if (!messageStarted) {
        yield { kind: 'start', message_id: chunk.id ?? synthesizeMessageId() };
        messageStarted = true;
      }

      if (chunk.error !== undefined && chunk.error !== null) {
        yield streamErrorEvent(chunk.error);
        yield* emitUsage();
        return;
      }

      if (chunk.usage !== undefined && chunk.usage !== null) {
        const u = chunk.usage;
        if (typeof u.prompt_tokens === 'number') {
          rawPrompt = Math.max(rawPrompt, u.prompt_tokens);
          usageSeen = true;
        }
        if (typeof u.completion_tokens === 'number') {
          rawCompletion = Math.max(rawCompletion, u.completion_tokens);
          usageSeen = true;
        }
        if (typeof u.completion_tokens_details?.reasoning_tokens === 'number') {
          rawReasoning = Math.max(rawReasoning, u.completion_tokens_details.reasoning_tokens);
          usageSeen = true;
        }
        if (typeof u.prompt_tokens_details?.cached_tokens === 'number') {
          rawCached = Math.max(rawCached, u.prompt_tokens_details.cached_tokens);
          usageSeen = true;
        }
      }

      const choice = chunk.choices?.[0];
      if (choice === undefined) continue;

      const delta = choice.delta;
      if (delta !== undefined) {
        // Display only: Chat Completions has no input slot for reasoning, so nothing is replayed.
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { kind: 'thinking_delta', text: delta.reasoning_content };
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { kind: 'text_delta', text: delta.content };
        }
        if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
          yield { kind: 'text_delta', text: delta.refusal };
        }
        for (const tc of delta.tool_calls ?? []) {
          let inProgress = toolCalls.get(tc.index);
          if (inProgress === undefined) {
            const id = tc.id ?? `call_${tc.index}_${crypto.randomUUID()}`;
            inProgress = { id, name: '', partialArgs: '', started: false };
            toolCalls.set(tc.index, inProgress);
          }
          if (!inProgress.started && typeof tc.function?.name === 'string') {
            inProgress.name += tc.function.name;
          }
          const argsChunk = tc.function?.arguments;
          const hasArgs = typeof argsChunk === 'string' && argsChunk.length > 0;
          if (hasArgs) inProgress.partialArgs += argsChunk;

          if (!inProgress.started && hasArgs && inProgress.name.length > 0) {
            yield { kind: 'tool_use_start', id: inProgress.id, name: inProgress.name };
            inProgress.started = true;
            yield {
              kind: 'tool_use_delta',
              id: inProgress.id,
              partial_args: inProgress.partialArgs,
            };
          } else if (inProgress.started && hasArgs) {
            yield { kind: 'tool_use_delta', id: inProgress.id, partial_args: argsChunk };
          }
        }
      }

      if (typeof choice.finish_reason === 'string') {
        stopReason = FINISH_REASON_MAP[choice.finish_reason] ?? 'end_turn';
      }
    }

    // Chat Completions has no per-call stop, so calls are finalized at the end of the stream, in
    // index order.
    const sortedTools = Array.from(toolCalls.entries()).sort(([a], [b]) => a - b);
    for (const [, tool] of sortedTools) {
      if (tool.name.length === 0) {
        yield {
          kind: 'error',
          code: INVALID_TOOL_CALL,
          message: `tool_call ${tool.id} ended without a function name`,
          retryable: false,
        };
        continue;
      }
      if (!tool.started) {
        yield { kind: 'tool_use_start', id: tool.id, name: tool.name };
        tool.started = true;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = parseToolArguments(tool.partialArgs);
      } catch (e) {
        yield {
          kind: 'error',
          code: INVALID_TOOL_CALL,
          message: `failed to parse tool_use args for ${tool.id}: ${(e as Error).message}`,
          retryable: false,
        };
        continue;
      }
      yield { kind: 'tool_use_stop', id: tool.id, final_args: parsed };
    }

    if (!messageStarted) yield { kind: 'start', message_id: synthesizeMessageId() };
    yield* emitUsage();
    yield { kind: 'stop', reason: stopReason };
  } finally {
    // A turn that failed mid-stream was still billed, so its usage is reported before the error
    // propagates.
    yield* emitUsage();
  }
}
