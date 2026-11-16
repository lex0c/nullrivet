import {
  flattenSystemSegments,
  type GenerateRequest,
  type ProviderCapabilities,
  type ProviderEffort,
  type ProviderToolDef,
  TEXT_BLOCK_SEPARATOR,
} from '../types.ts';
import type { OllamaChatRequest, OllamaMessage, OllamaToolCall } from './http.ts';

// Ceiling for `num_ctx` on a local server. The server sizes its KV cache to `num_ctx`, so the full
// capacity of a 128K or 256K model would exhaust the memory of typical hardware.
export const DEFAULT_OLLAMA_NUM_CTX = 32_768;

// The system prompt comes from the request. Each tool result becomes its own `role: 'tool'`
// message that names the function it answers, because Ollama has no tool call ids; the name is
// looked up from the call when the result does not carry it.
export const toOllamaMessages = (
  req: GenerateRequest,
  reasoningReplay: boolean,
): OllamaMessage[] => {
  const out: OllamaMessage[] = [];
  const system = req.systemSegments ? flattenSystemSegments(req.systemSegments) : req.system;
  if (system !== undefined && system.length > 0) out.push({ role: 'system', content: system });

  const toolNames = new Map<string, string>();
  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const textParts: string[] = [];
    let thinking = '';
    const toolCalls: OllamaToolCall[] = [];
    const toolResults: OllamaMessage[] = [];
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'tool_use':
          toolNames.set(block.id, block.name);
          toolCalls.push({ function: { name: block.name, arguments: block.input } });
          break;
        case 'tool_result': {
          // Ollama tool messages have no error flag, so a failure is marked in the content.
          const content = block.is_error === true ? `[tool error] ${block.content}` : block.content;
          const result: OllamaMessage = { role: 'tool', content };
          const name = block.name ?? toolNames.get(block.tool_use_id);
          if (name !== undefined) result.tool_name = name;
          toolResults.push(result);
          break;
        }
        case 'reasoning':
          // The model's thinking is sent back on tool follow-ups, as Ollama's tool-calling
          // guidance describes.
          if (reasoningReplay && block.provider === 'ollama') {
            const t = (block.data as { thinking?: unknown } | null)?.thinking;
            if (typeof t === 'string') thinking += t;
          }
          break;
      }
    }
    // Tool results answer the previous assistant turn, so they precede any new user text.
    out.push(...toolResults);
    const text = textParts.join(TEXT_BLOCK_SEPARATOR);
    if (text.length > 0 || toolCalls.length > 0 || thinking.length > 0) {
      const m: OllamaMessage = { role: msg.role, content: text };
      if (thinking.length > 0) m.thinking = thinking;
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      out.push(m);
    }
  }
  return out;
};

export const toOllamaTools = (tools: readonly ProviderToolDef[]): unknown[] =>
  tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

// Models that take levels accept low|medium|high, so the higher levels clamp to `high`.
const THINK_LEVEL: Record<ProviderEffort, 'low' | 'medium' | 'high'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

// Without a requested effort the model default applies.
export const ollamaThink = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
): OllamaChatRequest['think'] => {
  if (req.effort === undefined) return undefined;
  if (caps.supports_reasoning_effort === true) return THINK_LEVEL[req.effort];
  if (caps.supports_reasoning === true) return true;
  return undefined;
};

export const ollamaOptions = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
  numCtx: number,
): Record<string, unknown> => {
  const options: Record<string, unknown> = { num_ctx: numCtx, num_predict: req.max_tokens };
  if (caps.supports_sampling !== false) {
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.top_p !== undefined) options.top_p = req.top_p;
  }
  if (req.stop_sequences !== undefined && req.stop_sequences.length > 0) {
    options.stop = req.stop_sequences;
  }
  return options;
};
