import { openaiEffortLevel } from '../effort.ts';
import type {
  GenerateRequest,
  ProviderCapabilities,
  ProviderMessage,
  ProviderToolDef,
} from '../types.ts';
import { TEXT_BLOCK_SEPARATOR } from '../types.ts';
import { systemText, toolResultText } from './messages.ts';
import { MESSAGE_PHASE_KEY } from './responses-stream.ts';

// Request shape of the Responses API, used for reasoning models. Requests are stateless
// (`store: false`, the full input every turn), so the conversation held by the agent stays the
// single source of truth.

// Reasoning models suppress Markdown unless the developer message starts with this line. Assistant
// output is rendered as Markdown, and the constant prefix does not disturb the cached prefix.
const MARKDOWN_MARKER = 'Formatting re-enabled';

const instructionsWithMarker = (system: string | undefined): string =>
  system !== undefined && system.length > 0 ? `${MARKDOWN_MARKER}\n${system}` : MARKDOWN_MARKER;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const messagePhase = (m: ProviderMessage): string | undefined => {
  if (typeof m.content === 'string') return undefined;
  let phase: string | undefined;
  for (const block of m.content) {
    if (block.type !== 'reasoning' || block.provider !== 'openai' || !isRecord(block.data))
      continue;
    const value = block.data[MESSAGE_PHASE_KEY];
    if (typeof value === 'string') phase = value;
  }
  return phase;
};

// Assistant blocks keep their original order so each reasoning item is directly followed by the
// item it produced; the API rejects a replayed reasoning item without its following item.
// Reasoning is replayed only on turns with tool calls: a text-only turn would need its message
// item rebuilt from text, and a reasoning item paired with a rebuilt message can be rejected. The
// reasoning of a final answer has no tool round-trip to continue, so little is lost.
const assistantItems = (m: ProviderMessage, reasoningReplay: boolean): unknown[] => {
  if (typeof m.content === 'string') return [{ role: 'assistant', content: m.content }];
  const items: unknown[] = [];
  const phase = reasoningReplay ? messagePhase(m) : undefined;
  const hasToolUse = m.content.some((b) => b.type === 'tool_use');
  const pendingText: string[] = [];
  const flushText = (): void => {
    if (pendingText.length === 0) return;
    const item: Record<string, unknown> = {
      role: 'assistant',
      content: pendingText.join(TEXT_BLOCK_SEPARATOR),
    };
    if (phase !== undefined) item.phase = phase;
    items.push(item);
    pendingText.length = 0;
  };
  for (const block of m.content) {
    if (block.type === 'text') {
      pendingText.push(block.text);
    } else if (block.type === 'tool_use') {
      flushText();
      items.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    } else if (block.type === 'reasoning') {
      if (!reasoningReplay || !hasToolUse || block.provider !== 'openai') continue;
      if (!isRecord(block.data) || MESSAGE_PHASE_KEY in block.data) continue;
      // Stateless requests reject a reasoning item without its encrypted content, which an item
      // captured while replay was off does not have.
      const encrypted = block.data.encrypted_content;
      if (typeof encrypted !== 'string' || encrypted.length === 0) continue;
      flushText();
      items.push(block.data);
    }
  }
  flushText();
  return items;
};

const userItems = (m: ProviderMessage): unknown[] => {
  if (typeof m.content === 'string') return [{ role: 'user', content: m.content }];
  const items: unknown[] = [];
  const textParts: string[] = [];
  for (const block of m.content) {
    if (block.type === 'tool_result') {
      items.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: toolResultText(block.content, block.is_error),
      });
    } else if (block.type === 'text') {
      textParts.push(block.text);
    }
  }
  // Tool outputs come first because they answer the previous calls.
  if (textParts.length > 0) {
    items.push({ role: 'user', content: textParts.join(TEXT_BLOCK_SEPARATOR) });
  }
  return items;
};

export const toResponsesInput = (
  messages: readonly ProviderMessage[],
  reasoningReplay: boolean,
): unknown[] =>
  messages.flatMap((m) =>
    m.role === 'assistant' ? assistantItems(m, reasoningReplay) : userItems(m),
  );

// Responses function tools are flat, unlike the nested Chat Completions shape.
const toResponsesTools = (tools: readonly ProviderToolDef[]): unknown[] =>
  tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));

export interface ResponsesOptions {
  promptCacheKey: string | undefined;
  promptCacheRetention: '24h' | 'in_memory' | undefined;
  reasoningReplay: boolean;
}

export const buildResponsesParams = (
  modelName: string,
  caps: ProviderCapabilities,
  req: GenerateRequest,
  options: ResponsesOptions,
): Record<string, unknown> => {
  const params: Record<string, unknown> = {
    model: modelName,
    instructions: instructionsWithMarker(systemText(req)),
    input: toResponsesInput(req.messages, options.reasoningReplay),
    max_output_tokens: req.max_tokens,
    store: false,
    stream: true,
  };
  if (req.tools !== undefined && req.tools.length > 0) params.tools = toResponsesTools(req.tools);
  if (options.promptCacheKey !== undefined) params.prompt_cache_key = options.promptCacheKey;
  if (options.promptCacheRetention !== undefined) {
    params.prompt_cache_retention = options.promptCacheRetention;
  }
  // Replay needs the encrypted reasoning content, which a stateless request only returns on ask.
  if (options.reasoningReplay) params.include = ['reasoning.encrypted_content'];
  if (req.effort !== undefined && caps.supports_reasoning_effort === true) {
    // OpenAI never streams raw reasoning; `summary: 'auto'` streams a summary, which is the only
    // reasoning text that can be shown.
    params.reasoning = {
      effort: openaiEffortLevel(
        req.effort,
        caps.supports_effort_xhigh === true,
        caps.supports_effort_max === true,
      ),
      summary: 'auto',
    };
  }
  if (caps.supports_sampling !== false) {
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.top_p !== undefined) params.top_p = req.top_p;
  }
  return params;
};
