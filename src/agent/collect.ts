import { STREAM_INCOMPLETE } from '../providers/errors.ts';
import type {
  ProviderReasoningBlock,
  StopReason,
  StreamEvent,
  UsageInfo,
} from '../providers/types.ts';
import { emptyUsage } from '../providers/usage.ts';

export interface CollectedToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Content blocks in emission order. Anthropic rejects replayed thinking blocks that were
// reordered relative to the tool_use blocks around them, so the assistant turn is rebuilt
// from this list rather than from the per-kind buckets.
export type CollectedBlock =
  | { kind: 'reasoning'; reasoning: ProviderReasoningBlock }
  | { kind: 'tool_use'; toolUse: CollectedToolUse }
  | { kind: 'text'; text: string };

export interface CollectedError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CollectedStep {
  message_id: string;
  text: string;
  tool_uses: CollectedToolUse[];
  // Display text only; the replayable artifacts are in `reasoning`.
  thinking: string;
  reasoning: ProviderReasoningBlock[];
  order: CollectedBlock[];
  stop_reason: StopReason;
  errors: CollectedError[];
  usage: UsageInfo;
  // Distinguishes "the provider reported zero" from "the provider reported nothing", which
  // decides whether the usage can anchor the context measurement.
  usageSeen: boolean;
}

// Carries what was collected before the stream threw, including usage that some adapters emit
// from a `finally` block for turns that were billed but failed.
export class CollectStepError extends Error {
  override readonly cause: unknown;
  readonly partial: CollectedStep;
  constructor(cause: unknown, partial: CollectedStep) {
    const message =
      cause instanceof Error ? cause.message || cause.name || String(cause) : String(cause);
    super(message);
    this.name = 'CollectStepError';
    this.cause = cause;
    this.partial = partial;
  }
}

// Shown between two text blocks of one response, so the second starts a new paragraph instead of
// continuing the last line of the first, which may be a code fence that would then stay open.
const blockSeparator = (shown: string): string =>
  shown.endsWith('\n\n') ? '' : shown.endsWith('\n') ? '\n' : '\n\n';

const emptyStep = (): CollectedStep => ({
  message_id: '',
  text: '',
  tool_uses: [],
  thinking: '',
  reasoning: [],
  order: [],
  stop_reason: 'end_turn',
  errors: [],
  usage: emptyUsage(),
  usageSeen: false,
});

export const collectStep = async (
  events: AsyncIterable<StreamEvent>,
  onEvent?: (event: StreamEvent) => void,
): Promise<CollectedStep> => {
  const out = emptyStep();
  let stopSeen = false;
  const toolNamesById = new Map<string, string>();
  // Contiguous text deltas become one ordered block, flushed before the next non-text block.
  let pendingText = '';
  const flushText = (): void => {
    if (pendingText.length > 0) {
      out.order.push({ kind: 'text', text: pendingText });
      pendingText = '';
    }
  };

  try {
    for await (const ev of events) {
      // A text block that starts after an earlier one (they are separated by reasoning or a tool
      // call, as when OpenAI's Responses API returns several messages) is displayed as a new
      // paragraph. Only the displayed text gets the separator; the blocks in `order` are kept as
      // the provider sent them.
      const separator =
        ev.kind === 'text_delta' &&
        ev.text.length > 0 &&
        pendingText.length === 0 &&
        out.text.length > 0
          ? blockSeparator(out.text)
          : '';
      if (onEvent !== undefined) {
        try {
          onEvent(
            ev.kind === 'text_delta' && separator.length > 0
              ? { kind: 'text_delta', text: separator + ev.text }
              : ev,
          );
        } catch {
          // An observer failure must not abort the provider stream.
        }
      }
      switch (ev.kind) {
        case 'start':
          out.message_id = ev.message_id;
          break;
        case 'text_delta':
          out.text += separator + ev.text;
          pendingText += ev.text;
          break;
        case 'thinking_delta':
          out.thinking += ev.text;
          break;
        case 'reasoning': {
          flushText();
          const block: ProviderReasoningBlock = {
            type: 'reasoning',
            provider: ev.provider,
            data: ev.data,
          };
          out.reasoning.push(block);
          out.order.push({ kind: 'reasoning', reasoning: block });
          break;
        }
        case 'tool_use_start':
          toolNamesById.set(ev.id, ev.name);
          break;
        case 'tool_use_delta':
          break;
        case 'tool_use_stop': {
          const name = toolNamesById.get(ev.id);
          if (name === undefined) {
            out.errors.push({
              code: 'agent.orphan_tool_use_stop',
              message: `tool_use_stop for unknown id ${ev.id}`,
              retryable: false,
            });
            break;
          }
          flushText();
          const toolUse: CollectedToolUse = { id: ev.id, name, input: ev.final_args };
          out.tool_uses.push(toolUse);
          out.order.push({ kind: 'tool_use', toolUse });
          break;
        }
        case 'usage':
          // Usage reports final values, so the last event wins rather than being summed.
          out.usage = ev.usage;
          out.usageSeen = true;
          break;
        case 'stop':
          out.stop_reason = ev.reason;
          stopSeen = true;
          break;
        case 'error':
          out.errors.push({ code: ev.code, message: ev.message, retryable: ev.retryable });
          break;
      }
    }
  } catch (e) {
    flushText();
    throw new CollectStepError(e, out);
  }

  flushText();
  // Adapters emit a stop only when the provider reports how the response finished, so a stream
  // that ended without one was cut short (a dropped connection, a proxy closing it). Partial output
  // must not pass for a complete answer: the step fails, and is retried when nothing came through.
  if (!stopSeen && out.errors.length === 0) {
    out.errors.push({
      code: STREAM_INCOMPLETE,
      message: 'the response stream ended before the model finished',
      retryable: true,
    });
  }
  return out;
};
