import { OPENAI_REASONING_EFFORT } from '../effort.ts';
import {
  flattenSystemSegments,
  type GenerateRequest,
  type ProviderCapabilities,
} from '../types.ts';

// The OpenAI message shape carries one string per message. Separate text blocks (two prompts merged
// after an interrupted turn, or text split around tool calls) must not run together.
const TEXT_BLOCK_SEPARATOR = '\n\n';

// OpenRouter messages are OpenAI-shaped plus a reasoning slot (`reasoning_details` or
// `reasoning`) that carries the model's reasoning across tool turns. The plain OpenAI mapping
// drops reasoning, which is why this conversion is separate.

export interface ORToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// Structured content is used only to place prompt-cache markers on the system prompt.
export interface ORTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ORMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | ORTextBlock[];
  tool_calls?: ORToolCall[];
  tool_call_id?: string;
  // `reasoning_details` is the structured array, replayed verbatim; `reasoning` is the plaintext
  // form for models that stream no structured details.
  reasoning_details?: unknown;
  reasoning?: string;
}

// Models with explicit prompt caching get structured blocks with an ephemeral marker on each
// `cacheBreakpoint` segment, so the stable system prefix is cached across the agent loop. Other
// models get the flat string.
const buildSystemMessage = (
  req: GenerateRequest,
  explicitCache: boolean,
): ORMessage | undefined => {
  if (explicitCache && req.systemSegments !== undefined) {
    // The wire concatenates content parts with no separator. Re-adding the joiner used by
    // flattenSystemSegments keeps the bytes identical to the canonical system string.
    const nonEmpty = req.systemSegments.filter((seg) => seg.text.length > 0);
    const blocks: ORTextBlock[] = nonEmpty.map((seg, i) => {
      const text = i < nonEmpty.length - 1 ? `${seg.text}\n\n` : seg.text;
      return seg.cacheBreakpoint
        ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text };
    });
    return blocks.length > 0 ? { role: 'system', content: blocks } : undefined;
  }
  const sys = req.systemSegments ? flattenSystemSegments(req.systemSegments) : req.system;
  if (sys === undefined || sys.length === 0) return undefined;
  if (explicitCache) {
    return {
      role: 'system',
      content: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    };
  }
  return { role: 'system', content: sys };
};

// The system prompt comes from the request, not from a message role. Each `tool_result` block
// becomes its own `role: 'tool'` message because the OpenAI shape does not nest tool results in
// user content.
export const toOpenRouterMessages = (
  req: GenerateRequest,
  reasoningReplay = false,
  explicitCache = false,
): ORMessage[] => {
  const out: ORMessage[] = [];

  const systemMessage = buildSystemMessage(req, explicitCache);
  if (systemMessage !== undefined) {
    out.push(systemMessage);
  }

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: ORToolCall[] = [];
    const toolResults: ORMessage[] = [];
    let reasoningData: unknown;

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'tool_use':
          if (msg.role !== 'assistant') {
            throw new Error('tool_use blocks must appear on assistant messages');
          }
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
          break;
        case 'tool_result': {
          if (msg.role !== 'user') {
            throw new Error('tool_result blocks must appear on user messages');
          }
          // Tool messages have no error flag, so the failure is marked in the content.
          const content = block.is_error === true ? `[tool error] ${block.content}` : block.content;
          toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
          break;
        }
        case 'reasoning':
          if (reasoningReplay && block.provider === 'openrouter') {
            reasoningData = block.data;
          }
          break;
      }
    }

    // Tool results answer the prior assistant turn, so they precede any new user text.
    out.push(...toolResults);

    if (msg.role === 'assistant') {
      const content = textParts.length > 0 ? textParts.join(TEXT_BLOCK_SEPARATOR) : null;
      // An assistant message with neither content nor tool calls is invalid in the OpenAI shape,
      // and its reasoning has no value without the turn it belongs to, so it is dropped.
      if (content !== null || toolCalls.length > 0) {
        const m: ORMessage = { role: 'assistant', content };
        if (toolCalls.length > 0) m.tool_calls = toolCalls;
        // The stream normalizer emits a tagged object; a bare array is the older raw-details shape.
        if (Array.isArray(reasoningData)) {
          m.reasoning_details = reasoningData;
        } else if (reasoningData !== null && typeof reasoningData === 'object') {
          const rd = reasoningData as { reasoning_details?: unknown; reasoning?: unknown };
          if (rd.reasoning_details !== undefined) {
            m.reasoning_details = rd.reasoning_details;
          } else if (typeof rd.reasoning === 'string') {
            m.reasoning = rd.reasoning;
          }
        }
        out.push(m);
      }
    } else if (textParts.length > 0) {
      out.push({ role: 'user', content: textParts.join(TEXT_BLOCK_SEPARATOR) });
    }
  }

  return out;
};

export interface ORReasoningParam {
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  enabled?: boolean;
}

// Effort-capable models receive the mapped level. Models that reason without effort levels are
// only switched on, since an effort level would be rejected or silently ignored. Without a
// requested effort the model default applies.
export const buildReasoningParam = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
): ORReasoningParam | undefined => {
  if (req.effort === undefined) return undefined;
  if (caps.supports_reasoning_effort === true) {
    return { effort: OPENAI_REASONING_EFFORT[req.effort] };
  }
  if (caps.supports_reasoning === true) {
    return { enabled: true };
  }
  return undefined;
};
