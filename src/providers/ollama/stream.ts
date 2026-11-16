import { CONTEXT_OVERFLOW, INVALID_TOOL_CALL, isContextOverflowMessage } from '../errors.ts';
import type { StopReason, StreamEvent } from '../types.ts';
import type { OllamaChatChunk } from './http.ts';

interface PendingToolCall {
  name: unknown;
  args: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Ollama has no message ids; `created_at` identifies the response.
const messageId = (chunk: OllamaChatChunk): string =>
  chunk.created_at ?? `ollama_${crypto.randomUUID()}`;

const errorEvent = (message: string): StreamEvent =>
  isContextOverflowMessage(message)
    ? { kind: 'error', code: CONTEXT_OVERFLOW, message, retryable: false }
    : { kind: 'error', code: 'ollama.stream_error', message, retryable: false };

// Text and thinking are streamed as deltas. Tool calls are collected and emitted at the end with
// synthesized ids, because Ollama sends complete calls without ids. Usage and the stop reason come
// from the final (`done`) chunk; a stream without one was cut short and is reported as an error.
export async function* normalizeOllamaStream(
  chunks: AsyncIterable<OllamaChatChunk>,
): AsyncIterable<StreamEvent> {
  let started = false;
  let thinkingText = '';
  const toolCalls: PendingToolCall[] = [];
  let final: OllamaChatChunk | undefined;

  for await (const chunk of chunks) {
    if (!started) {
      started = true;
      yield { kind: 'start', message_id: messageId(chunk) };
    }
    if (typeof chunk.error === 'string') {
      yield errorEvent(`Ollama /api/chat stream error: ${chunk.error}`);
      return;
    }
    const msg = chunk.message;
    if (msg !== undefined) {
      if (typeof msg.thinking === 'string' && msg.thinking.length > 0) {
        yield { kind: 'thinking_delta', text: msg.thinking };
        thinkingText += msg.thinking;
      }
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        yield { kind: 'text_delta', text: msg.content };
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls as unknown[]) {
          const fn = isRecord(call) && isRecord(call.function) ? call.function : undefined;
          toolCalls.push({ name: fn?.name, args: fn?.arguments });
        }
      }
    }
    if (chunk.done === true) final = chunk;
  }

  if (!started) {
    yield errorEvent('Ollama /api/chat returned an empty stream');
    return;
  }
  if (final === undefined) {
    yield errorEvent('Ollama /api/chat stream ended without a final chunk');
    return;
  }

  // The thinking leads the assistant turn so it can be sent back on the next tool follow-up.
  if (thinkingText.length > 0) {
    yield { kind: 'reasoning', provider: 'ollama', data: { thinking: thinkingText } };
  }

  for (const call of toolCalls) {
    const id = `ollama_${crypto.randomUUID()}`;
    if (typeof call.name !== 'string' || call.name.length === 0) {
      yield {
        kind: 'error',
        code: INVALID_TOOL_CALL,
        message: `tool call ${id} has no function name`,
        retryable: false,
      };
      continue;
    }
    const args = call.args ?? {};
    if (!isRecord(args)) {
      yield {
        kind: 'error',
        code: INVALID_TOOL_CALL,
        message: `arguments of tool call ${call.name} are not a JSON object`,
        retryable: false,
      };
      continue;
    }
    yield { kind: 'tool_use_start', id, name: call.name };
    yield { kind: 'tool_use_stop', id, final_args: args };
  }

  yield {
    kind: 'usage',
    usage: {
      input: final.prompt_eval_count ?? 0,
      output: final.eval_count ?? 0,
      cache_read: 0,
      cache_creation: 0,
    },
  };
  // A truncation is reported as such even when a tool call was also produced.
  const reason: StopReason =
    final.done_reason === 'length' ? 'max_tokens' : toolCalls.length > 0 ? 'tool_use' : 'end_turn';
  yield { kind: 'stop', reason };
}
