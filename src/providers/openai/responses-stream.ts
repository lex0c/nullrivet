import { INVALID_TOOL_CALL } from '../errors.ts';
import type { StopReason, StreamEvent, UsageInfo } from '../types.ts';
import { parseToolArguments } from '../types.ts';
import { openAIStreamErrorEvent, type RawOpenAIError } from './stream.ts';

// Normalizer for the Responses API stream:
//   response.created / in_progress        -> start
//   response.output_text.delta            -> text_delta
//   response.reasoning_summary_text.delta -> thinking_delta
//   response.output_item.added (call)     -> tool_use_start (id = call_id)
//   response.function_call_arguments.delta-> tool_use_delta
//   response.output_item.done (call)      -> tool_use_stop
//   response.output_item.done (reasoning) -> reasoning (the item, replayed verbatim)
//   response.completed / incomplete       -> usage and the stop reason
//   response.failed / error               -> error

// Key of the reasoning-channel record that carries an assistant message `phase`.
export const MESSAGE_PHASE_KEY = '__nullrivet_message_phase';

export interface RawResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
}

// The subset of a Responses stream event the normalizer reads.
export interface RawResponsesEvent {
  type: string;
  delta?: string;
  item_id?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    // Codex models mark assistant messages as commentary or final answer; the mark must be sent
    // back with the message.
    phase?: string;
  };
  response?: {
    id?: string;
    incomplete_details?: { reason?: string } | null;
    usage?: RawResponsesUsage | null;
    error?: RawOpenAIError | null;
  };
  // `error` events carry these at the top level.
  code?: string | null;
  message?: string;
}

const synthesizeMessageId = (): string => `openai_${crypto.randomUUID()}`;

// `input_tokens` includes cached tokens, so `input` subtracts them to avoid counting them twice.
// The Responses API reports no cache writes.
const toUsage = (u: RawResponsesUsage): UsageInfo => {
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, (u.input_tokens ?? 0) - cached),
    output: u.output_tokens ?? 0,
    cache_read: cached,
    cache_creation: 0,
  };
};

export async function* normalizeResponsesStream(
  raw: AsyncIterable<RawResponsesEvent>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let stopReason: StopReason | undefined;
  let usageEmitted = false;
  let sawToolCall = false;
  // Argument deltas are keyed by output item id; calls are tracked by call_id.
  const callIdByItem = new Map<string, string>();
  const argsByItem = new Map<string, string>();
  // Summary parts arrive as separate runs of deltas with nothing between them, so a blank line is
  // inserted before every part after the first.
  let summaryTextSeen = false;

  const start = function* (id: string | undefined): Iterable<StreamEvent> {
    if (!messageStarted) {
      messageStarted = true;
      yield { kind: 'start', message_id: id ?? synthesizeMessageId() };
    }
  };

  const emitUsage = function* (usage: RawResponsesUsage | null | undefined): Iterable<StreamEvent> {
    if (usage !== null && usage !== undefined && !usageEmitted) {
      usageEmitted = true;
      yield { kind: 'usage', usage: toUsage(usage) };
    }
  };

  for await (const ev of raw) {
    switch (ev.type) {
      case 'response.created':
      case 'response.in_progress':
        yield* start(ev.response?.id);
        break;

      case 'response.output_text.delta':
        if (ev.delta !== undefined && ev.delta.length > 0) {
          yield { kind: 'text_delta', text: ev.delta };
        }
        break;

      case 'response.reasoning_summary_part.added':
        if (summaryTextSeen) yield { kind: 'thinking_delta', text: '\n\n' };
        break;

      case 'response.reasoning_summary_text.delta':
        if (ev.delta !== undefined && ev.delta.length > 0) {
          yield { kind: 'thinking_delta', text: ev.delta };
          summaryTextSeen = true;
        }
        break;

      case 'response.output_item.added':
        if (ev.item?.type === 'function_call' && ev.item.call_id && ev.item.name) {
          sawToolCall = true;
          if (ev.item.id) callIdByItem.set(ev.item.id, ev.item.call_id);
          yield { kind: 'tool_use_start', id: ev.item.call_id, name: ev.item.name };
        }
        break;

      case 'response.function_call_arguments.delta':
        if (ev.item_id !== undefined && ev.delta !== undefined && ev.delta.length > 0) {
          argsByItem.set(ev.item_id, (argsByItem.get(ev.item_id) ?? '') + ev.delta);
          const callId = callIdByItem.get(ev.item_id);
          if (callId !== undefined) {
            yield { kind: 'tool_use_delta', id: callId, partial_args: ev.delta };
          }
        }
        break;

      case 'response.output_item.done': {
        const item = ev.item;
        if (item?.type === 'function_call' && item.call_id) {
          // The done item normally carries the full arguments; the accumulated deltas are the
          // fallback when it does not.
          const fromItem = item.arguments ?? '';
          const args =
            fromItem.length > 0 ? fromItem : item.id ? (argsByItem.get(item.id) ?? '') : '';
          let parsed: Record<string, unknown>;
          try {
            parsed = parseToolArguments(args);
          } catch (e) {
            yield {
              kind: 'error',
              code: INVALID_TOOL_CALL,
              message: `failed to parse tool_use args for ${item.call_id}: ${(e as Error).message}`,
              retryable: false,
            };
            break;
          }
          yield { kind: 'tool_use_stop', id: item.call_id, final_args: parsed };
        } else if (item?.type === 'reasoning') {
          // Opaque: it carries the id, the summary and, when requested, the encrypted content
          // that a stateless replay needs.
          yield { kind: 'reasoning', provider: 'openai', data: item };
        } else if (item?.type === 'message' && typeof item.phase === 'string') {
          // The agent rebuilds assistant messages from text and would lose the phase, so it
          // travels on the reasoning channel and is stamped back on replay.
          yield {
            kind: 'reasoning',
            provider: 'openai',
            data: { [MESSAGE_PHASE_KEY]: item.phase },
          };
        }
        break;
      }

      case 'response.completed':
        yield* emitUsage(ev.response?.usage);
        stopReason = sawToolCall ? 'tool_use' : 'end_turn';
        break;

      case 'response.incomplete':
        yield* emitUsage(ev.response?.usage);
        stopReason =
          ev.response?.incomplete_details?.reason === 'max_output_tokens'
            ? 'max_tokens'
            : 'end_turn';
        break;

      case 'response.failed':
        yield* start(ev.response?.id);
        yield openAIStreamErrorEvent(ev.response?.error ?? {});
        yield* emitUsage(ev.response?.usage);
        return;

      case 'error': {
        yield* start(undefined);
        const error: RawOpenAIError = {};
        if (ev.code !== undefined) error.code = ev.code;
        if (ev.message !== undefined) error.message = ev.message;
        yield openAIStreamErrorEvent(error);
        return;
      }
    }
  }

  yield* start(undefined);
  // Without response.completed or response.incomplete the stream was cut short: no stop is
  // emitted, and the step collector reports it as incomplete.
  if (stopReason !== undefined) yield { kind: 'stop', reason: stopReason };
}
