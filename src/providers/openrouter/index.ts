import OpenAI, { APIConnectionError, APIError, type ClientOptions } from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { boolFromEnv, type Env } from '../env.ts';
import { AbortError, ProviderRequestError } from '../errors.ts';
import { toOpenAITools } from '../openai/convert.ts';
import type { GenerateRequest, Provider, ProviderCapabilities, StreamEvent } from '../types.ts';
import { buildReasoningParam, toOpenRouterMessages } from './messages.ts';
import { normalizeOpenRouterStream, type RawORChunk } from './stream.ts';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const APP_TITLE = 'nullrivet';

export interface CreateOpenRouterProviderOptions {
  capabilities: ProviderCapabilities;
  apiKey?: string;
  baseURL?: string;
  // Pre-built SDK client; when set, `apiKey`, `baseURL` and `fetch` are ignored.
  client?: OpenAI;
  fetch?: ClientOptions['fetch'];
  env?: Env;
}

// Attribution for OpenRouter's app rankings. The default title is the application name and
// nothing derived from the user, machine or project is sent; a referer is sent only when the user
// sets one explicitly.
const attributionHeaders = (env: Env): Record<string, string> => {
  const title = env.NULLRIVET_OPENROUTER_TITLE;
  const headers: Record<string, string> = {
    'X-Title': title !== undefined && title.length > 0 ? title : APP_TITLE,
  };
  const referer = env.NULLRIVET_OPENROUTER_REFERER;
  if (referer !== undefined && referer.length > 0) headers['HTTP-Referer'] = referer;
  return headers;
};

const buildClient = (options: CreateOpenRouterProviderOptions, env: Env): OpenAI => {
  if (options.client !== undefined) return options.client;
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('OpenRouter API key required (set OPENROUTER_API_KEY)');
  }
  const sdkOptions: ClientOptions = {
    apiKey,
    baseURL: options.baseURL ?? DEFAULT_OPENROUTER_BASE_URL,
    defaultHeaders: attributionHeaders(env),
    // The SDK otherwise reads OPENAI_ORG_ID and OPENAI_PROJECT_ID from the environment and sends
    // them as headers, which would disclose the user's OpenAI account to OpenRouter.
    organization: null,
    project: null,
    // Retries happen in generateWithRetry; SDK retries would multiply the attempts.
    maxRetries: 0,
  };
  if (options.fetch !== undefined) sdkOptions.fetch = options.fetch;
  return new OpenAI(sdkOptions);
};

const isErrorBody = (value: unknown): value is { code?: number | string; message?: string } =>
  typeof value === 'object' && value !== null;

// Connection failures and timeouts carry no HTTP status, so the generic retry classification
// cannot tell them apart from permanent errors; they are marked transient here.
const classifyError = (error: unknown, signal: AbortSignal | undefined): unknown => {
  if (signal?.aborted === true) return new AbortError();
  if (error instanceof APIConnectionError) {
    return new ProviderRequestError(`connection to OpenRouter failed: ${error.message}`, {
      retryable: true,
      cause: error,
    });
  }
  return error;
};

export const createOpenRouterProvider = (
  modelName: string,
  options: CreateOpenRouterProviderOptions,
): Provider => {
  const caps = options.capabilities;
  const env = options.env ?? process.env;
  const client = buildClient(options, env);

  // Replaying reasoning on tool follow-ups is OpenRouter's continuity mechanism. It is gated on
  // the model reasoning at all, not on effort support, so models that always reason still replay.
  const reasoningReplay =
    (caps.supports_reasoning_effort === true || caps.supports_reasoning === true) &&
    boolFromEnv(env, 'NULLRIVET_OPENROUTER_REASONING_REPLAY', true);
  const acceptsSampling = caps.supports_sampling !== false;
  const explicitCache = caps.cache_explicit_breakpoints === true;

  const buildParams = (req: GenerateRequest): Record<string, unknown> => {
    const params: Record<string, unknown> = {
      model: modelName,
      messages: toOpenRouterMessages(req, reasoningReplay, explicitCache),
      stream: true,
      max_tokens: req.max_tokens,
      // Middle-out compression is on by default for small-context endpoints and drops the middle
      // of the prompt silently. Disabling it leaves truncation to the context manager.
      transforms: [],
      // Usage is documented as always returned; the flag guarantees it on routes that would
      // otherwise omit it.
      usage: { include: true },
    };
    if (req.tools !== undefined) params.tools = toOpenAITools(req.tools);
    const reasoning = buildReasoningParam(req, caps);
    if (reasoning !== undefined) params.reasoning = reasoning;
    if (acceptsSampling && req.temperature !== undefined) params.temperature = req.temperature;
    if (acceptsSampling && req.top_p !== undefined) params.top_p = req.top_p;
    if (req.stop_sequences !== undefined) params.stop = req.stop_sequences;
    return params;
  };

  const requestChunks = async function* (
    req: GenerateRequest,
    signal: AbortSignal | undefined,
  ): AsyncIterable<RawORChunk> {
    const params = buildParams(req);
    let stream: AsyncIterable<RawORChunk>;
    try {
      stream = (await client.chat.completions.create(
        params as unknown as ChatCompletionCreateParamsStreaming,
        { signal },
      )) as unknown as AsyncIterable<RawORChunk>;
    } catch (e) {
      throw classifyError(e, signal);
    }
    try {
      for await (const chunk of stream) yield chunk;
    } catch (e) {
      // The SDK throws on a stream chunk carrying an `error` field before the normalizer sees it.
      // Handing it back as a chunk lets the normalizer report it as an error event that is
      // retryable according to its code.
      if (
        signal?.aborted !== true &&
        e instanceof APIError &&
        e.status === undefined &&
        isErrorBody(e.error)
      ) {
        yield { error: e.error };
        return;
      }
      throw classifyError(e, signal);
    }
    // The SDK ends the stream without an error when its request is aborted. Without this check
    // the normalizer would report the truncated turn as a clean stop.
    if (signal?.aborted === true) throw new AbortError();
  };

  return {
    id: `openrouter/${modelName}`,
    family: 'openrouter',
    capabilities: caps,
    replaysReasoning: reasoningReplay,
    generate: (req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
      normalizeOpenRouterStream(requestChunks(req, signal)),
  };
};
