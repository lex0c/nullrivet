import { createHash } from 'node:crypto';
import OpenAI, { APIConnectionError, APIError, type ClientOptions } from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import { stableStringify } from '../canonical-json.ts';
import { boolFromEnv, type Env } from '../env.ts';
import {
  AbortError,
  ContextOverflowError,
  isContextOverflowMessage,
  ProviderRequestError,
} from '../errors.ts';
import type { GenerateRequest, Provider, ProviderCapabilities, StreamEvent } from '../types.ts';
import { toOpenAITools } from './convert.ts';
import { systemText, toOpenAIChatMessages } from './messages.ts';
import { buildResponsesParams } from './responses.ts';
import { normalizeResponsesStream, type RawResponsesEvent } from './responses-stream.ts';
import { normalizeOpenAIStream, type RawOpenAIChunk, type RawOpenAIError } from './stream.ts';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface CreateOpenAIProviderOptions {
  capabilities: ProviderCapabilities;
  apiKey?: string;
  baseURL?: string;
  // Pre-built SDK client; when set, `apiKey`, `baseURL` and `fetch` are ignored. Features limited
  // to the official endpoint still follow `baseURL`.
  client?: OpenAI;
  fetch?: ClientOptions['fetch'];
  env?: Env;
  // Receives configuration the adapter cannot honor for this model.
  warn?: (message: string) => void;
}

// Requests sharing this key are routed to the same backend, which raises the prefix-cache hit
// rate. The key covers the stable prefix (system and tools), so it is the same on every turn of a
// session; stableStringify makes it independent of key order in the tool schemas.
export const openaiPromptCacheKey = (req: GenerateRequest): string =>
  createHash('sha256')
    .update(systemText(req) ?? '')
    .update(stableStringify(req.tools ?? []))
    .digest('hex');

// 24h is the default. The opt-out must be sent as `in_memory` rather than omitted, because OpenAI
// applies 24h retention to supported models when the field is absent.
const promptCacheRetentionFromEnv = (env: Env): '24h' | 'in_memory' => {
  const v = env.NULLRIVET_OPENAI_PROMPT_CACHE_RETENTION?.toLowerCase();
  return v === 'in_memory' || v === 'off' || v === '0' || v === 'false' ? 'in_memory' : '24h';
};

const isErrorBody = (value: unknown): value is RawOpenAIError =>
  typeof value === 'object' && value !== null;

const buildClient = (options: CreateOpenAIProviderOptions, baseURL: string): OpenAI => {
  if (options.client !== undefined) return options.client;
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('OpenAI API key required (set OPENAI_API_KEY)');
  }
  const sdkOptions: ClientOptions = {
    apiKey,
    baseURL,
    // The SDK otherwise reads OPENAI_ORG_ID and OPENAI_PROJECT_ID from the environment and sends
    // them as headers, which would disclose account details to a compatible endpoint.
    organization: null,
    project: null,
    // Retries happen in generateWithRetry; SDK retries would multiply the attempts.
    maxRetries: 0,
    // The SDK logs to the console, which would write into the terminal interface.
    logLevel: 'off',
  };
  if (options.fetch !== undefined) sdkOptions.fetch = options.fetch;
  return new OpenAI(sdkOptions);
};

// Connection failures and timeouts carry no HTTP status, so the generic retry classification
// cannot tell them apart from permanent errors; they are marked transient here.
const classifyError = (error: unknown, signal: AbortSignal | undefined): unknown => {
  if (signal?.aborted === true) return new AbortError();
  if (error instanceof APIConnectionError) {
    return new ProviderRequestError(`connection to OpenAI failed: ${error.message}`, {
      retryable: true,
      cause: error,
    });
  }
  if (
    error instanceof APIError &&
    error.status === 400 &&
    (error.code === 'context_length_exceeded' || isContextOverflowMessage(error.message))
  ) {
    return new ContextOverflowError(error.message, { cause: error });
  }
  return error;
};

// Opens the stream and yields its items. A stream error that the SDK throws is handed back through
// `toItem` so the normalizer reports it as an error event, and an abort that the SDK turns into a
// silent end of the stream becomes AbortError.
async function* streamItems<T>(
  open: () => Promise<unknown>,
  toItem: (error: RawOpenAIError) => T,
  signal: AbortSignal | undefined,
): AsyncIterable<T> {
  let stream: AsyncIterable<T>;
  try {
    stream = (await open()) as AsyncIterable<T>;
  } catch (e) {
    throw classifyError(e, signal);
  }
  try {
    for await (const item of stream) yield item;
  } catch (e) {
    if (
      signal?.aborted !== true &&
      e instanceof APIError &&
      e.status === undefined &&
      isErrorBody(e.error)
    ) {
      yield toItem(e.error);
      return;
    }
    throw classifyError(e, signal);
  }
  if (signal?.aborted === true) throw new AbortError();
}

export const createOpenAIProvider = (
  modelName: string,
  options: CreateOpenAIProviderOptions,
): Provider => {
  const caps = options.capabilities;
  const env = options.env ?? process.env;
  const baseURL = (options.baseURL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const client = buildClient(options, baseURL);
  // Cache routing, cache retention and encrypted reasoning are OpenAI parameters that a compatible
  // endpoint may reject, so they are sent to the official endpoint only.
  const official = baseURL === DEFAULT_OPENAI_BASE_URL;

  let promptCacheRetention: '24h' | 'in_memory' | undefined;
  if (official && caps.extended_prompt_cache === true) {
    const intent = promptCacheRetentionFromEnv(env);
    if (intent === 'in_memory' && caps.extended_prompt_cache_24h_only === true) {
      options.warn?.(
        `${modelName} accepts only 24h prompt-cache retention; NULLRIVET_OPENAI_PROMPT_CACHE_RETENTION=in_memory cannot be honored for this model`,
      );
    } else {
      promptCacheRetention = intent;
    }
  }
  const includeUsage = boolFromEnv(env, 'NULLRIVET_OPENAI_INCLUDE_USAGE', true);
  const acceptsSampling = caps.supports_sampling !== false;
  // Chat Completions rejects tools combined with reasoning effort on reasoning models, which the
  // Responses API accepts. The route is chosen per model.
  const useResponses = caps.supports_reasoning_effort === true;
  // Only the Responses route can send reasoning back; Chat Completions drops it.
  const reasoningReplay =
    useResponses && official && boolFromEnv(env, 'NULLRIVET_OPENAI_REASONING_REPLAY', true);

  const chatParams = (req: GenerateRequest): Record<string, unknown> => {
    const params: Record<string, unknown> = {
      model: modelName,
      messages: toOpenAIChatMessages(req),
      stream: true,
      // The official endpoint deprecated `max_tokens` and reasoning models reject it; compatible
      // endpoints do not all accept the replacement.
      [official ? 'max_completion_tokens' : 'max_tokens']: req.max_tokens,
    };
    // Some compatible endpoints reject `stream_options`; NULLRIVET_OPENAI_INCLUDE_USAGE=0 omits it
    // at the cost of usage reporting.
    if (includeUsage) params.stream_options = { include_usage: true };
    if (req.tools !== undefined && req.tools.length > 0) params.tools = toOpenAITools(req.tools);
    if (official) params.prompt_cache_key = openaiPromptCacheKey(req);
    if (promptCacheRetention !== undefined) params.prompt_cache_retention = promptCacheRetention;
    if (acceptsSampling && req.temperature !== undefined) params.temperature = req.temperature;
    if (acceptsSampling && req.top_p !== undefined) params.top_p = req.top_p;
    if (req.stop_sequences !== undefined) params.stop = req.stop_sequences;
    return params;
  };

  const generateChat = (req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
    normalizeOpenAIStream(
      streamItems<RawOpenAIChunk>(
        () =>
          client.chat.completions.create(
            chatParams(req) as unknown as ChatCompletionCreateParamsStreaming,
            { signal },
          ),
        (error) => ({ error }),
        signal,
      ),
    );

  const generateResponses = (
    req: GenerateRequest,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> =>
    normalizeResponsesStream(
      streamItems<RawResponsesEvent>(
        () =>
          client.responses.create(
            buildResponsesParams(modelName, caps, req, {
              promptCacheKey: official ? openaiPromptCacheKey(req) : undefined,
              promptCacheRetention,
              reasoningReplay,
            }) as unknown as ResponseCreateParamsStreaming,
            { signal },
          ),
        (error) => {
          const event: RawResponsesEvent = { type: 'error' };
          if (error.code !== undefined && error.code !== null) event.code = String(error.code);
          if (error.message !== undefined) event.message = error.message;
          return event;
        },
        signal,
      ),
    );

  return {
    id: `openai/${modelName}`,
    family: 'openai',
    capabilities: caps,
    replaysReasoning: reasoningReplay,
    generate: useResponses ? generateResponses : generateChat,
  };
};
