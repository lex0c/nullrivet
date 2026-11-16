import type { StopReason, StreamEvent } from '../types.ts';

// OpenRouter streams the OpenAI Chat Completions chunk shape plus a few fields: plaintext
// (`delta.reasoning`) and structured (`delta.reasoning_details`) reasoning, cache writes in
// `usage.prompt_tokens_details.cache_write_tokens`, and in-band errors (HTTP 200 with
// `finish_reason: "error"` or an `error` object on the chunk or choice).

export interface RawORToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface RawORChoiceDelta {
  role?: string;
  content?: string | null;
  refusal?: string | null;
  reasoning?: string | null;
  // Some upstream providers stream this alias instead of `reasoning`; the content is the same.
  reasoning_content?: string | null;
  reasoning_details?: unknown[];
  tool_calls?: RawORToolCallDelta[];
}

export interface RawORChoice {
  index?: number;
  delta?: RawORChoiceDelta;
  finish_reason?: string | null;
  error?: { code?: number | string; message?: string } | null;
}

export interface RawORUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  // Billed amount in credits. Not mapped: UsageInfo carries token counts only.
  cost?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}

export interface RawORChunk {
  id?: string;
  choices?: RawORChoice[];
  usage?: RawORUsage | null;
  error?: { code?: number | string; message?: string } | null;
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

const synthesizeMessageId = (): string => `openrouter_${crypto.randomUUID()}`;

// In-band error codes mirror HTTP statuses: 429 and 5xx are transient.
const isRetryableErrorCode = (code: number | string | undefined): boolean => {
  const n = typeof code === 'string' ? Number(code) : code;
  return typeof n === 'number' && Number.isFinite(n) && (n === 429 || (n >= 500 && n < 600));
};

export async function* normalizeOpenRouterStream(
  raw: AsyncIterable<RawORChunk>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let stopReason: StopReason = 'end_turn';
  const toolCalls = new Map<number, ToolCallInProgress>();
  const reasoningDetails: unknown[] = [];
  // Kept for replay when the model streams no structured reasoning_details.
  let reasoningText = '';
  let rawPrompt = 0;
  let rawCompletion = 0;
  let rawCached = 0;
  let rawCacheWrite = 0;
  let usageSeen = false;
  let usageEmitted = false;

  // OpenRouter's prompt_tokens includes cached tokens, so `input` subtracts them to avoid counting
  // them twice.
  const emitUsage = function* (): Iterable<StreamEvent> {
    if (usageSeen && !usageEmitted) {
      yield {
        kind: 'usage',
        usage: {
          input: Math.max(0, rawPrompt - rawCached),
          output: rawCompletion,
          cache_read: rawCached,
          cache_creation: rawCacheWrite,
        },
      };
      usageEmitted = true;
    }
  };

  try {
    for await (const chunk of raw) {
      if (!messageStarted) {
        yield { kind: 'start', message_id: chunk.id ?? synthesizeMessageId() };
        messageStarted = true;
      }

      // The stream may end without a finish_reason after an in-band error, so it stops here.
      const choice = chunk.choices?.[0];
      const err = chunk.error ?? choice?.error;
      if (err !== undefined && err !== null) {
        yield {
          kind: 'error',
          code: 'openrouter.stream_error',
          message: err.message ?? `OpenRouter stream error (code=${err.code ?? 'unknown'})`,
          retryable: isRetryableErrorCode(err.code),
        };
        yield* emitUsage();
        return;
      }

      if (chunk.usage !== undefined && chunk.usage !== null) {
        const u = chunk.usage;
        let touched = false;
        if (typeof u.prompt_tokens === 'number') {
          rawPrompt = Math.max(rawPrompt, u.prompt_tokens);
          touched = true;
        }
        if (typeof u.completion_tokens === 'number') {
          rawCompletion = Math.max(rawCompletion, u.completion_tokens);
          touched = true;
        }
        if (typeof u.prompt_tokens_details?.cached_tokens === 'number') {
          rawCached = Math.max(rawCached, u.prompt_tokens_details.cached_tokens);
          touched = true;
        }
        if (typeof u.prompt_tokens_details?.cache_write_tokens === 'number') {
          rawCacheWrite = Math.max(rawCacheWrite, u.prompt_tokens_details.cache_write_tokens);
          touched = true;
        }
        if (touched) usageSeen = true;
      }

      if (choice === undefined) continue;

      const delta = choice.delta;
      if (delta !== undefined) {
        const plaintextReasoning =
          typeof delta.reasoning === 'string' && delta.reasoning.length > 0
            ? delta.reasoning
            : typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
              ? delta.reasoning_content
              : undefined;
        if (plaintextReasoning !== undefined) {
          yield { kind: 'thinking_delta', text: plaintextReasoning };
          reasoningText += plaintextReasoning;
        }
        if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
          reasoningDetails.push(...delta.reasoning_details);
          // Some providers stream only structured details; their text is surfaced so the
          // reasoning is still displayed.
          if (plaintextReasoning === undefined) {
            for (const d of delta.reasoning_details) {
              const t = (d as { text?: unknown }).text;
              if (typeof t === 'string' && t.length > 0) {
                yield { kind: 'thinking_delta', text: t };
              }
            }
          }
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { kind: 'text_delta', text: delta.content };
        }
        if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
          yield { kind: 'text_delta', text: delta.refusal };
        }
        if (delta.tool_calls !== undefined) {
          for (const tc of delta.tool_calls) {
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
      }

      if (typeof choice.finish_reason === 'string') {
        if (choice.finish_reason === 'error') {
          // OpenRouter reports an upstream failure during generation this way, without details.
          // It is usually transient, so the step may be retried when nothing was produced yet.
          yield {
            kind: 'error',
            code: 'openrouter.stream_error',
            message: 'OpenRouter stream ended with finish_reason=error',
            retryable: true,
          };
          yield* emitUsage();
          return;
        }
        stopReason = FINISH_REASON_MAP[choice.finish_reason] ?? 'end_turn';
      }
    }

    // The reasoning block leads the assistant turn, ahead of the tool calls. Structured details
    // are preferred; accumulated plaintext is the fallback so plaintext-only models still replay.
    if (reasoningDetails.length > 0) {
      yield {
        kind: 'reasoning',
        provider: 'openrouter',
        data: { reasoning_details: reasoningDetails },
      };
    } else if (reasoningText.length > 0) {
      yield { kind: 'reasoning', provider: 'openrouter', data: { reasoning: reasoningText } };
    }

    const sortedTools = Array.from(toolCalls.entries()).sort(([a], [b]) => a - b);
    for (const [, tool] of sortedTools) {
      if (tool.name.length === 0) {
        yield {
          kind: 'error',
          code: 'openrouter.tool_use_no_name',
          message: `tool_call ${tool.id} ended without a function name`,
          retryable: false,
        };
        continue;
      }
      if (!tool.started) {
        yield { kind: 'tool_use_start', id: tool.id, name: tool.name };
        tool.started = true;
      }
      let parsed: Record<string, unknown> = {};
      if (tool.partialArgs.length > 0) {
        try {
          const obj = JSON.parse(tool.partialArgs) as unknown;
          if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            throw new Error('tool args must decode to a JSON object');
          }
          parsed = obj as Record<string, unknown>;
        } catch (e) {
          yield {
            kind: 'error',
            code: 'tool_args_parse_error',
            message: `failed to parse tool_use args for ${tool.id}: ${(e as Error).message}`,
            retryable: false,
          };
          continue;
        }
      }
      yield { kind: 'tool_use_stop', id: tool.id, final_args: parsed };
    }

    if (!messageStarted) {
      yield { kind: 'start', message_id: synthesizeMessageId() };
    }
    yield* emitUsage();
    yield { kind: 'stop', reason: stopReason };
  } finally {
    // A turn that failed mid-stream was still billed, so its usage is reported before the error
    // propagates.
    yield* emitUsage();
  }
}
