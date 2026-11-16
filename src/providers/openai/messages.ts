import { flattenSystemSegments, type GenerateRequest } from '../types.ts';

// The OpenAI message shapes carry one string per message. Separate text blocks (two prompts merged
// after an interrupted turn, or text split around tool calls) must not run together.
export const TEXT_BLOCK_SEPARATOR = '\n\n';

// Tool results have no error flag in the OpenAI shapes, so a failure is marked in the content.
export const toolResultText = (content: string, isError: boolean | undefined): string =>
  isError === true ? `[tool error] ${content}` : content;

export const systemText = (req: GenerateRequest): string | undefined =>
  req.systemSegments !== undefined ? flattenSystemSegments(req.systemSegments) : req.system;

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

// Chat Completions has no input slot for reasoning items, so reasoning blocks are dropped. Each
// tool result becomes its own `role: 'tool'` message, placed before any new user text because it
// answers the previous assistant turn.
export const toOpenAIChatMessages = (req: GenerateRequest): OpenAIChatMessage[] => {
  const out: OpenAIChatMessage[] = [];
  const system = systemText(req);
  if (system !== undefined && system.length > 0) out.push({ role: 'system', content: system });

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: OpenAIChatMessage[] = [];
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
        case 'tool_result':
          if (msg.role !== 'user') {
            throw new Error('tool_result blocks must appear on user messages');
          }
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultText(block.content, block.is_error),
          });
          break;
        case 'reasoning':
          break;
      }
    }
    out.push(...toolResults);
    if (msg.role === 'assistant') {
      const content = textParts.length > 0 ? textParts.join(TEXT_BLOCK_SEPARATOR) : null;
      // An assistant message with neither content nor tool calls is invalid in this shape.
      if (content !== null || toolCalls.length > 0) {
        const m: OpenAIChatMessage = { role: 'assistant', content };
        if (toolCalls.length > 0) m.tool_calls = toolCalls;
        out.push(m);
      }
    } else if (textParts.length > 0) {
      out.push({ role: 'user', content: textParts.join(TEXT_BLOCK_SEPARATOR) });
    }
  }
  return out;
};
