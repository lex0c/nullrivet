import { CONTEXT_OVERFLOW, INVALID_TOOL_CALL, isContextOverflowMessage } from '../errors.ts';
import type { StopReason, StreamEvent, UsageInfo } from '../types.ts';
import { parseToolArguments } from '../types.ts';

// `input_tokens` excludes cache hits; cache reads and writes are reported separately. Any field
// may be missing on compatible endpoints.
export interface RawAnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

// The subset of the raw stream events the normalizer reads. `error` is the SSE error event, which
// the SDK throws instead of yielding; the adapter turns it back into an event.
export type RawAnthropicEvent =
  | { type: 'message_start'; message: { id: string; usage?: RawAnthropicUsage } }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'text'; text?: string }
        | { type: 'tool_use'; id: string; name: string; input?: unknown }
        | { type: 'thinking'; thinking?: string }
        | { type: 'redacted_thinking'; data?: string };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string | null }; usage?: RawAnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type?: string; message?: string } };

interface ToolUseInProgress {
  id: string;
  partialArgs: string;
}

const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set<StopReason>([
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
  'refusal',
  // Must not fall back to `end_turn`, or a turn cut off by the full window reads as complete.
  'model_context_window_exceeded',
]);

const mapStopReason = (raw: string): StopReason =>
  KNOWN_STOP_REASONS.has(raw) ? (raw as StopReason) : 'end_turn';

// Error types that describe a temporary condition of the service rather than of the request.
const RETRYABLE_ERROR_TYPES: ReadonlySet<string> = new Set([
  'overloaded_error',
  'api_error',
  'rate_limit_error',
  'timeout_error',
]);

const streamErrorEvent = (error: { type?: string; message?: string }): StreamEvent => {
  const message = error.message ?? `Anthropic stream error (${error.type ?? 'unknown'})`;
  if (isContextOverflowMessage(message)) {
    return { kind: 'error', code: CONTEXT_OVERFLOW, message, retryable: false };
  }
  return {
    kind: 'error',
    code: 'anthropic.stream_error',
    message,
    retryable: error.type !== undefined && RETRYABLE_ERROR_TYPES.has(error.type),
  };
};

// Tool arguments are parsed at the block's stop; arguments that are not a JSON object become an
// INVALID_TOOL_CALL error and the call is dropped. Signed thinking blocks are emitted as
// `reasoning` events so they can be replayed: the signature must round-trip byte-identical.
export async function* normalizeAnthropicStream(
  raw: AsyncIterable<RawAnthropicEvent>,
): AsyncIterable<StreamEvent> {
  const toolUses = new Map<number, ToolUseInProgress>();
  const thinkingBlocks = new Map<number, { thinking: string; signature: string }>();
  const redactedBlocks = new Map<number, string>();
  let stopReason: StopReason = 'end_turn';
  // Input and cache counts arrive on `message_start`, output on the final `message_delta`.
  const usage: UsageInfo = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  let usageSeen = false;
  let usageEmitted = false;

  // The counts are cumulative; the running maximum keeps a partial later report from shrinking
  // them.
  const mergeUsage = (u: RawAnthropicUsage | undefined): void => {
    if (u === undefined) return;
    if (typeof u.input_tokens === 'number') {
      usage.input = Math.max(usage.input, u.input_tokens);
      usageSeen = true;
    }
    if (typeof u.output_tokens === 'number') {
      usage.output = Math.max(usage.output, u.output_tokens);
      usageSeen = true;
    }
    if (typeof u.cache_read_input_tokens === 'number') {
      usage.cache_read = Math.max(usage.cache_read, u.cache_read_input_tokens);
      usageSeen = true;
    }
    if (typeof u.cache_creation_input_tokens === 'number') {
      usage.cache_creation = Math.max(usage.cache_creation, u.cache_creation_input_tokens);
      usageSeen = true;
    }
  };

  const emitUsage = function* (): Iterable<StreamEvent> {
    if (usageSeen && !usageEmitted) {
      usageEmitted = true;
      yield { kind: 'usage', usage: { ...usage } };
    }
  };

  try {
    for await (const event of raw) {
      switch (event.type) {
        case 'message_start':
          yield { kind: 'start', message_id: event.message.id };
          mergeUsage(event.message.usage);
          break;

        case 'content_block_start': {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            toolUses.set(event.index, { id: block.id, partialArgs: '' });
            yield { kind: 'tool_use_start', id: block.id, name: block.name };
          } else if (block.type === 'thinking') {
            thinkingBlocks.set(event.index, { thinking: block.thinking ?? '', signature: '' });
          } else if (block.type === 'redacted_thinking') {
            redactedBlocks.set(event.index, block.data ?? '');
          }
          break;
        }

        case 'content_block_delta': {
          const { delta } = event;
          if (delta.type === 'text_delta') {
            yield { kind: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta') {
            const tool = toolUses.get(event.index);
            if (tool !== undefined) {
              tool.partialArgs += delta.partial_json;
              yield { kind: 'tool_use_delta', id: tool.id, partial_args: delta.partial_json };
            }
          } else if (delta.type === 'thinking_delta') {
            const block = thinkingBlocks.get(event.index);
            if (block !== undefined) block.thinking += delta.thinking;
            yield { kind: 'thinking_delta', text: delta.thinking };
          } else if (delta.type === 'signature_delta') {
            const block = thinkingBlocks.get(event.index);
            if (block !== undefined) block.signature += delta.signature;
          }
          break;
        }

        case 'content_block_stop': {
          const redacted = redactedBlocks.get(event.index);
          if (redacted !== undefined) {
            redactedBlocks.delete(event.index);
            yield {
              kind: 'reasoning',
              provider: 'anthropic',
              data: { redacted_thinking: redacted },
            };
            break;
          }
          const thinking = thinkingBlocks.get(event.index);
          if (thinking !== undefined) {
            thinkingBlocks.delete(event.index);
            // An unsigned block cannot be replayed: the API rejects it next to a tool result.
            if (thinking.signature.length > 0) {
              yield {
                kind: 'reasoning',
                provider: 'anthropic',
                data: { thinking: thinking.thinking, signature: thinking.signature },
              };
            }
            break;
          }
          const tool = toolUses.get(event.index);
          if (tool === undefined) break;
          toolUses.delete(event.index);
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
            break;
          }
          yield { kind: 'tool_use_stop', id: tool.id, final_args: parsed };
          break;
        }

        case 'message_delta':
          // Interim deltas may carry a null stop reason, which must not clobber a real one.
          if (typeof event.delta.stop_reason === 'string') {
            stopReason = mapStopReason(event.delta.stop_reason);
          }
          mergeUsage(event.usage);
          break;

        case 'message_stop':
          yield* emitUsage();
          yield { kind: 'stop', reason: stopReason };
          break;

        case 'error':
          yield streamErrorEvent(event.error);
          yield* emitUsage();
          return;
      }
    }
  } finally {
    // A turn that failed mid-stream was still billed, so its usage is reported before the error
    // propagates.
    yield* emitUsage();
  }
}
