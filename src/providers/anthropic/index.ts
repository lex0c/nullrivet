import Anthropic, { APIConnectionError, APIError, type ClientOptions } from '@anthropic-ai/sdk';
import type { MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/messages/messages';
import { anthropicEffort, effortThinkingBudget } from '../effort.ts';
import { boolFromEnv, type Env } from '../env.ts';
import {
  AbortError,
  ContextOverflowError,
  isContextOverflowMessage,
  ProviderRequestError,
} from '../errors.ts';
import type {
  GenerateRequest,
  Provider,
  ProviderCapabilities,
  ProviderContentBlock,
  ProviderMessage,
  ProviderReasoningBlock,
  ProviderTextBlock,
  ProviderToolDef,
  ProviderToolResultBlock,
  StreamEvent,
} from '../types.ts';
import {
  type CacheTtl,
  cacheMarker,
  countCacheBreakpoints,
  MAX_CACHE_BREAKPOINTS_PER_REQUEST,
  messagesWithTailCacheBreakpoint,
  systemSegmentsWithCacheBreakpoints,
  systemWithCacheBreakpoint,
  toolsWithCacheBreakpoint,
} from './cache.ts';
import { normalizeAnthropicStream, type RawAnthropicEvent } from './stream.ts';

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

// The API rejects a manual thinking budget below this value.
const MIN_THINKING_BUDGET = 1_024;

export interface CreateAnthropicProviderOptions {
  capabilities: ProviderCapabilities;
  apiKey?: string;
  baseURL?: string;
  // Pre-built SDK client; when set, `apiKey`, `baseURL` and `fetch` are ignored.
  client?: Anthropic;
  fetch?: ClientOptions['fetch'];
  env?: Env;
}

// Only the exact value `1h` opts into the extended cache; anything else keeps the 5-minute default.
const cacheTtlFromEnv = (env: Env): CacheTtl =>
  env.NULLRIVET_ANTHROPIC_CACHE_TTL === '1h' ? '1h' : '5m';

const buildClient = (options: CreateAnthropicProviderOptions): Anthropic => {
  if (options.client !== undefined) return options.client;
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('Anthropic API key required (set ANTHROPIC_API_KEY)');
  }
  const sdkOptions: ClientOptions = {
    apiKey,
    // The SDK otherwise sends ANTHROPIC_AUTH_TOKEN from the environment as a second credential.
    authToken: null,
    baseURL: options.baseURL ?? DEFAULT_ANTHROPIC_BASE_URL,
    // Retries happen in generateWithRetry; SDK retries would multiply the attempts.
    maxRetries: 0,
    // The SDK logs to the console, which would write into the terminal interface.
    logLevel: 'off',
  };
  if (options.fetch !== undefined) sdkOptions.fetch = options.fetch;
  return new Anthropic(sdkOptions);
};

// Connection failures and timeouts carry no HTTP status, so the generic retry classification
// cannot tell them apart from permanent errors; they are marked transient here.
const classifyError = (error: unknown, signal: AbortSignal | undefined): unknown => {
  if (signal?.aborted === true) return new AbortError();
  if (error instanceof APIConnectionError) {
    return new ProviderRequestError(`connection to Anthropic failed: ${error.message}`, {
      retryable: true,
      cause: error,
    });
  }
  if (
    error instanceof APIError &&
    error.status === 400 &&
    isContextOverflowMessage(error.message)
  ) {
    return new ContextOverflowError(error.message, { cause: error });
  }
  return error;
};

const isErrorBody = (value: unknown): value is { error: { type?: string; message?: string } } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { error?: unknown }).error === 'object' &&
  (value as { error?: unknown }).error !== null;

// Native thinking blocks exist only on the wire: they are rebuilt from captured reasoning blocks.
type ThinkingWireBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };
type TextWireBlock = {
  type: 'text';
  text: string;
  cache_control?: Anthropic.CacheControlEphemeral;
};
type WireBlock =
  | Exclude<ProviderContentBlock, ProviderReasoningBlock | ProviderTextBlock>
  | TextWireBlock
  | ThinkingWireBlock;

// The data is replayed verbatim because the signature must round-trip byte-identical. Blocks
// captured by another family, or without a signature, cannot be replayed and are dropped.
const reasoningToWireBlock = (block: ProviderReasoningBlock): ThinkingWireBlock | undefined => {
  if (block.provider !== 'anthropic') return undefined;
  const data = block.data as {
    thinking?: unknown;
    signature?: unknown;
    redacted_thinking?: unknown;
  } | null;
  if (data === null || typeof data !== 'object') return undefined;
  if (typeof data.redacted_thinking === 'string') {
    return { type: 'redacted_thinking', data: data.redacted_thinking };
  }
  if (typeof data.thinking === 'string' && typeof data.signature === 'string') {
    if (data.signature.length === 0) return undefined;
    return { type: 'thinking', thinking: data.thinking, signature: data.signature };
  }
  return undefined;
};

// Anthropic rejects fields it does not know ("Extra inputs are not permitted"), so blocks are
// rebuilt with the wire fields only: a text block's cache hint becomes a marker or is dropped, and
// a tool result loses `name`, which exists for providers that correlate results by function name.
const toWireBlock = (
  block: Exclude<ProviderContentBlock, ProviderReasoningBlock>,
  hintMarker: Anthropic.CacheControlEphemeral | undefined,
): WireBlock => {
  if (block.type === 'text') {
    return hintMarker !== undefined && block.cacheBreakpoint === true
      ? { type: 'text', text: block.text, cache_control: hintMarker }
      : { type: 'text', text: block.text };
  }
  if (block.type !== 'tool_result') return block;
  const cleaned: ProviderToolResultBlock = {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: block.content,
  };
  if (block.is_error !== undefined) cleaned.is_error = block.is_error;
  return cleaned;
};

const toAnthropicMessage = (
  m: ProviderMessage,
  reasoningReplay: boolean,
  hintMarker: Anthropic.CacheControlEphemeral | undefined,
): { role: ProviderMessage['role']; content: string | WireBlock[] } => {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  const out: WireBlock[] = [];
  for (const b of m.content) {
    if (b.type === 'reasoning') {
      if (!reasoningReplay) continue;
      const wire = reasoningToWireBlock(b);
      if (wire !== undefined) out.push(wire);
      continue;
    }
    out.push(toWireBlock(b, hintMarker));
  }
  return { role: m.role, content: out };
};

const toAnthropicTool = (t: ProviderToolDef): Anthropic.Tool => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Tool.InputSchema,
});

type ThinkingParam = { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number };

// Adaptive models choose their own thinking depth, guided by `output_config.effort`; they think by
// default unless `adaptiveByDefault` is off or the caller pinned sampling, which thinking would
// discard. Models with only a manual budget think when an effort is requested, with the budget
// derived from it.
//
// When a thinking block precedes a tool call, the API requires it back with the tool result.
// Without reasoning replay that cannot happen, so thinking is limited to requests without tools.
export const anthropicThinkingParam = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
  reasoningReplay: boolean,
  adaptiveByDefault: boolean,
): ThinkingParam | undefined => {
  if (!reasoningReplay && req.tools !== undefined && req.tools.length > 0) return undefined;
  if (caps.supports_adaptive_thinking === true) {
    const samplingPinned = req.temperature !== undefined || req.top_p !== undefined;
    return adaptiveByDefault && !samplingPinned ? { type: 'adaptive' } : undefined;
  }
  if (caps.supports_reasoning === true && req.effort !== undefined) {
    const budget = effortThinkingBudget(req.effort, req.max_tokens);
    if (budget === undefined || budget < MIN_THINKING_BUDGET) return undefined;
    return { type: 'enabled', budget_tokens: budget };
  }
  return undefined;
};

// Anthropic rejects `temperature` and `top_p` sent together, so only `temperature` is kept when
// both are set.
const samplingParams = (req: GenerateRequest): { temperature?: number; top_p?: number } => {
  if (req.temperature !== undefined) return { temperature: req.temperature };
  if (req.top_p !== undefined) return { top_p: req.top_p };
  return {};
};

export const createAnthropicProvider = (
  modelName: string,
  options: CreateAnthropicProviderOptions,
): Provider => {
  const caps = options.capabilities;
  const env = options.env ?? process.env;
  const client = buildClient(options);
  const marker = cacheMarker(cacheTtlFromEnv(env));

  // Replay is required for thinking across tool calls. It is limited to adaptive models, which
  // interleave thinking with tool calls without a beta header.
  const reasoningReplay =
    caps.supports_adaptive_thinking === true &&
    boolFromEnv(env, 'NULLRIVET_ANTHROPIC_REASONING_REPLAY', true);
  const adaptiveByDefault = boolFromEnv(env, 'NULLRIVET_ANTHROPIC_THINKING', true);
  const acceptsSampling = caps.supports_sampling !== false;

  const buildParams = (req: GenerateRequest): Record<string, unknown> => {
    const system =
      req.systemSegments !== undefined
        ? systemSegmentsWithCacheBreakpoints(req.systemSegments, marker)
        : systemWithCacheBreakpoint(req.system, marker);
    const tools =
      req.tools !== undefined && req.tools.length > 0
        ? toolsWithCacheBreakpoint(req.tools.map(toAnthropicTool), marker)
        : undefined;
    const buildMessages = (hintMarker: Anthropic.CacheControlEphemeral | undefined) =>
      messagesWithTailCacheBreakpoint(
        req.messages.map((m) => toAnthropicMessage(m, reasoningReplay, hintMarker)),
        marker,
      );
    // Markers requested by message blocks are an optimization, so they are dropped first when the
    // request would exceed the breakpoint limit.
    let messages = buildMessages(marker);
    if (countCacheBreakpoints({ system, tools, messages }) > MAX_CACHE_BREAKPOINTS_PER_REQUEST) {
      messages = buildMessages(undefined);
    }
    const breakpoints = countCacheBreakpoints({ system, tools, messages });
    if (breakpoints > MAX_CACHE_BREAKPOINTS_PER_REQUEST) {
      throw new Error(
        `Anthropic request has ${breakpoints} cache breakpoints; the API accepts at most ${MAX_CACHE_BREAKPOINTS_PER_REQUEST} (reduce the system segments flagged as cache breakpoints)`,
      );
    }

    const params: Record<string, unknown> = {
      model: modelName,
      max_tokens: req.max_tokens,
      messages,
      stream: true,
    };
    if (system !== undefined) params.system = system;
    if (tools !== undefined) params.tools = tools;
    const thinking = anthropicThinkingParam(req, caps, reasoningReplay, adaptiveByDefault);
    if (thinking !== undefined) params.thinking = thinking;
    // The API rejects sampling parameters together with thinking.
    if (acceptsSampling && thinking === undefined) Object.assign(params, samplingParams(req));
    if (req.effort !== undefined && caps.supports_reasoning_effort === true) {
      params.output_config = {
        effort: anthropicEffort(req.effort, caps.supports_effort_xhigh === true),
      };
    }
    if (req.stop_sequences !== undefined) params.stop_sequences = req.stop_sequences;
    return params;
  };

  const requestEvents = async function* (
    req: GenerateRequest,
    signal: AbortSignal | undefined,
  ): AsyncIterable<RawAnthropicEvent> {
    const params = buildParams(req);
    let stream: AsyncIterable<RawAnthropicEvent>;
    try {
      stream = (await client.messages.create(params as unknown as MessageCreateParamsStreaming, {
        signal,
      })) as unknown as AsyncIterable<RawAnthropicEvent>;
    } catch (e) {
      throw classifyError(e, signal);
    }
    try {
      for await (const event of stream) yield event;
    } catch (e) {
      // The SDK throws on an SSE `error` event before the normalizer sees it. Handing it back as an
      // event lets the normalizer report it with a code and a retry decision.
      if (
        signal?.aborted !== true &&
        e instanceof APIError &&
        e.status === undefined &&
        isErrorBody(e.error)
      ) {
        yield { type: 'error', error: e.error.error };
        return;
      }
      throw classifyError(e, signal);
    }
    // The SDK ends the stream without an error when its request is aborted. Without this check
    // the truncated turn would look like a stream that simply ended.
    if (signal?.aborted === true) throw new AbortError();
  };

  return {
    id: `anthropic/${modelName}`,
    family: 'anthropic',
    capabilities: caps,
    replaysReasoning: reasoningReplay,
    generate: (req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
      normalizeAnthropicStream(requestEvents(req, signal)),
  };
};
