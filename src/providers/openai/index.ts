import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { ClientOptions } from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import { stableStringify } from '../canonical-json.ts';
import { boolFromEnv, type Env } from '../env.ts';
import type { GenerateRequest, Provider, ProviderCapabilities, StreamEvent } from '../types.ts';
import { buildCompatibleClient, type CompatibleService, streamItems } from './compatible.ts';
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

const OPENAI: CompatibleService = { name: 'OpenAI', keyEnv: 'OPENAI_API_KEY' };

const errorBody = (value: unknown): RawOpenAIError | undefined =>
  typeof value === 'object' && value !== null ? (value as RawOpenAIError) : undefined;

export const createOpenAIProvider = (
  modelName: string,
  options: CreateOpenAIProviderOptions,
): Provider => {
  const caps = options.capabilities;
  const env = options.env ?? process.env;
  const baseURL = (options.baseURL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const client = buildCompatibleClient(options, baseURL, OPENAI);
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
        (body) => {
          const error = errorBody(body);
          return error === undefined ? undefined : { error };
        },
        signal,
        OPENAI,
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
        (body) => {
          const error = errorBody(body);
          if (error === undefined) return undefined;
          const event: RawResponsesEvent = { type: 'error' };
          if (error.code !== undefined && error.code !== null) event.code = String(error.code);
          if (error.message !== undefined) event.message = error.message;
          return event;
        },
        signal,
        OPENAI,
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
