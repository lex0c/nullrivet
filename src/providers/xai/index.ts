import OpenAI, { APIConnectionError, APIError, type ClientOptions } from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { cappedEffortLevel } from '../effort.ts';
import {
  AbortError,
  ContextOverflowError,
  isContextOverflowMessage,
  ProviderRequestError,
} from '../errors.ts';
import { toOpenAITools } from '../openai/convert.ts';
import { openaiPromptCacheKey } from '../openai/index.ts';
import { toOpenAIChatMessages } from '../openai/messages.ts';
import type { GenerateRequest, Provider, ProviderCapabilities, StreamEvent } from '../types.ts';
import { normalizeXaiStream, type RawXaiChunk } from './stream.ts';

// The native xAI API speaks OpenAI Chat Completions, so the OpenAI SDK and message conversion are
// reused. It is a family of its own because the OpenAI adapter sends reasoning models to the
// Responses API and limits caching options to OpenAI's endpoint, neither of which fits Grok.
export const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1';

export interface CreateXaiProviderOptions {
  capabilities: ProviderCapabilities;
  apiKey?: string;
  baseURL?: string;
  // Pre-built SDK client; when set, `apiKey`, `baseURL` and `fetch` are ignored. Features limited
  // to the official endpoint still follow `baseURL`.
  client?: OpenAI;
  fetch?: ClientOptions['fetch'];
}

const buildClient = (options: CreateXaiProviderOptions, baseURL: string): OpenAI => {
  if (options.client !== undefined) return options.client;
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('xAI API key required (set XAI_API_KEY)');
  }
  const sdkOptions: ClientOptions = {
    apiKey,
    baseURL,
    // The SDK otherwise reads OPENAI_ORG_ID and OPENAI_PROJECT_ID from the environment and sends
    // them as headers, which would disclose the user's OpenAI account to xAI.
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
    return new ProviderRequestError(`connection to xAI failed: ${error.message}`, {
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

// xAI error bodies carry the message as a plain string in `error`, while the OpenAI shape nests
// an object there; both are accepted.
const streamErrorChunk = (body: unknown): RawXaiChunk | undefined => {
  if (typeof body === 'string') return { error: { message: body } };
  if (typeof body !== 'object' || body === null) return undefined;
  const { code, message } = body as { code?: unknown; message?: unknown };
  const error: NonNullable<RawXaiChunk['error']> = {};
  if (typeof code === 'string' || typeof code === 'number') error.code = code;
  if (typeof message === 'string') error.message = message;
  return { error };
};

export const createXaiProvider = (
  modelName: string,
  options: CreateXaiProviderOptions,
): Provider => {
  const caps = options.capabilities;
  const baseURL = (options.baseURL ?? DEFAULT_XAI_BASE_URL).replace(/\/+$/, '');
  const client = buildClient(options, baseURL);
  // The conversation routing header is an xAI feature; another server behind the base URL has its
  // own routing.
  const official = baseURL === DEFAULT_XAI_BASE_URL;
  const acceptsSampling = caps.supports_sampling !== false;
  // xAI rejects `stop` on every reasoning model, including those without effort levels.
  const reasoningModel =
    caps.supports_reasoning_effort === true || caps.supports_reasoning === true;

  const buildParams = (req: GenerateRequest): Record<string, unknown> => {
    const params: Record<string, unknown> = {
      model: modelName,
      messages: toOpenAIChatMessages(req),
      stream: true,
      // xAI documents `max_completion_tokens` and deprecates `max_tokens`.
      max_completion_tokens: req.max_tokens,
      stream_options: { include_usage: true },
    };
    if (req.tools !== undefined && req.tools.length > 0) params.tools = toOpenAITools(req.tools);
    if (req.effort !== undefined && caps.supports_reasoning_effort === true) {
      params.reasoning_effort = cappedEffortLevel(req.effort, caps.supports_effort_xhigh === true);
    }
    if (acceptsSampling && req.temperature !== undefined) params.temperature = req.temperature;
    if (acceptsSampling && req.top_p !== undefined) params.top_p = req.top_p;
    if (req.stop_sequences !== undefined && !reasoningModel) params.stop = req.stop_sequences;
    return params;
  };

  const requestChunks = async function* (
    req: GenerateRequest,
    signal: AbortSignal | undefined,
  ): AsyncIterable<RawXaiChunk> {
    const params = buildParams(req);
    // The prompt cache is per server. Requests with the same conversation id are routed to the
    // same server, and the id is derived from the system prompt and tools, which stay the same for
    // the whole session.
    const headers = official ? { 'x-grok-conv-id': openaiPromptCacheKey(req) } : undefined;
    let stream: AsyncIterable<RawXaiChunk>;
    try {
      stream = (await client.chat.completions.create(
        params as unknown as ChatCompletionCreateParamsStreaming,
        headers === undefined ? { signal } : { signal, headers },
      )) as unknown as AsyncIterable<RawXaiChunk>;
    } catch (e) {
      throw classifyError(e, signal);
    }
    try {
      for await (const chunk of stream) yield chunk;
    } catch (e) {
      // The SDK throws on a stream chunk carrying an `error` field before the normalizer sees it.
      // Handing it back as a chunk lets the normalizer report it as an error event.
      const chunk =
        signal?.aborted !== true && e instanceof APIError && e.status === undefined
          ? streamErrorChunk(e.error)
          : undefined;
      if (chunk !== undefined) {
        yield chunk;
        return;
      }
      throw classifyError(e, signal);
    }
    // The SDK ends the stream without an error when its request is aborted. Without this check
    // the normalizer would report the truncated turn as a clean stop.
    if (signal?.aborted === true) throw new AbortError();
  };

  return {
    id: `xai/${modelName}`,
    family: 'xai',
    capabilities: caps,
    // Chat Completions has no input slot for reasoning, so none is sent back.
    replaysReasoning: false,
    generate: (req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
      normalizeXaiStream(requestChunks(req, signal)),
  };
};
