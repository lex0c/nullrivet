export type ProviderFamily = 'anthropic' | 'openai' | 'ollama' | 'google' | 'openrouter' | 'xai';

// `max_tokens` is the per-call output cap. `model_context_window_exceeded` means the whole
// window (input included) was exhausted, so the remedy is compaction, not a larger output cap.
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'refusal'
  | 'model_context_window_exceeded';

// Only fields that describe the API contract of a model id. Commercial data such as pricing is
// deliberately absent: it changes without the id changing, which would make the catalog stale.
export interface ProviderCapabilities {
  context_window: number;
  output_max_tokens: number;
  // Absent means the model accepts `temperature`/`top_p`. Some newer models reject them with a 400.
  supports_sampling?: boolean;
  // Accepts an effort level, which each adapter maps to its native surface.
  supports_reasoning_effort?: boolean;
  // Produces reasoning behind an on/off toggle without selectable levels.
  supports_reasoning?: boolean;
  // Anthropic: adaptive thinking is the only accepted mode; a manual budget is rejected.
  supports_adaptive_thinking?: boolean;
  // Accepts `xhigh`; otherwise the adapter clamps it down to `high`.
  supports_effort_xhigh?: boolean;
  // Google: ceiling for the numeric thinking budget; larger values are rejected.
  max_thinking_budget?: number;
  // Prompt caching requires explicit `cache_control` markers instead of automatic caching.
  cache_explicit_breakpoints?: boolean;
  // OpenAI: extended prompt-cache retention, and whether only the extended mode is accepted.
  extended_prompt_cache?: boolean;
  extended_prompt_cache_24h_only?: boolean;
}

// `cache_read` and `cache_creation` are zero when the provider has no cache or the turn did
// not touch it. Adapters normalize `input` so cached tokens are not counted twice.
export interface UsageInfo {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export type StreamEvent =
  | { kind: 'start'; message_id: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_use_delta'; id: string; partial_args: string }
  | { kind: 'tool_use_stop'; id: string; final_args: Record<string, unknown> }
  | { kind: 'thinking_delta'; text: string }
  // Opaque provider reasoning state, replayed verbatim on later requests of the same turn.
  | { kind: 'reasoning'; provider: ProviderFamily; data: unknown }
  | { kind: 'usage'; usage: UsageInfo }
  | { kind: 'stop'; reason: StopReason }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

export type ProviderMessageRole = 'user' | 'assistant';

export interface ProviderTextBlock {
  type: 'text';
  text: string;
}

export interface ProviderToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  // Gemini correlates results by function name instead of call id.
  name?: string;
  content: string;
  is_error?: boolean;
}

// Only the adapter of the same `provider` reads `data`; other adapters drop the block. `data`
// must never be normalized because signatures have to round-trip byte-identical.
export interface ProviderReasoningBlock {
  type: 'reasoning';
  provider: ProviderFamily;
  data: unknown;
}

export type ProviderContentBlock =
  | ProviderTextBlock
  | ProviderToolUseBlock
  | ProviderToolResultBlock
  | ProviderReasoningBlock;

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string | ProviderContentBlock[];
}

// Anthropic and OpenAI reject tool schemas whose root is not an object.
export interface ProviderToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [k: string]: unknown;
}

export interface ProviderToolDef {
  name: string;
  description: string;
  input_schema: ProviderToolInputSchema;
}

// A slice of the system prompt. Adapters with per-segment caching emit a cache marker after a
// segment flagged with `cacheBreakpoint`; the others use the flattened string.
export interface SystemSegment {
  id: string;
  text: string;
  cacheBreakpoint?: boolean;
}

export const flattenSystemSegments = (segments: readonly SystemSegment[]): string =>
  segments
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join('\n\n');

export type ProviderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface GenerateRequest {
  model: string;
  // When `systemSegments` is set, `system` must equal `flattenSystemSegments(systemSegments)`.
  system?: string;
  systemSegments?: SystemSegment[];
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  effort?: ProviderEffort;
  stop_sequences?: string[];
}

export interface Provider {
  id: string;
  family: ProviderFamily;
  capabilities: ProviderCapabilities;
  // Whether reasoning blocks are sent back to the API. Token estimates only count them when true.
  replaysReasoning?: boolean;
  generate(req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

export const contentBlocks = (content: string | ProviderContentBlock[]): ProviderContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;

// Joins text blocks for APIs that take one string per message, so separate blocks (two prompts
// merged after an interrupted turn, or text split around tool calls) do not run together.
export const TEXT_BLOCK_SEPARATOR = '\n\n';

// Tool arguments streamed by a provider, which must form a JSON object. Throws with a message the
// stream normalizers report as an invalid tool call.
export const parseToolArguments = (text: string): Record<string, unknown> => {
  if (text.length === 0) return {};
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool arguments must be a JSON object');
  }
  return value as Record<string, unknown>;
};
