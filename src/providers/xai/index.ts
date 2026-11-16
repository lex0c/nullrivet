import type OpenAI from 'openai';
import type { ClientOptions } from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { cappedEffortLevel } from '../effort.ts';
import {
  buildCompatibleClient,
  type CompatibleService,
  streamItems,
} from '../openai/compatible.ts';
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

const XAI: CompatibleService = { name: 'xAI', keyEnv: 'XAI_API_KEY' };

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
  const client = buildCompatibleClient(options, baseURL, XAI);
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
    yield* streamItems<RawXaiChunk>(
      () =>
        client.chat.completions.create(
          params as unknown as ChatCompletionCreateParamsStreaming,
          headers === undefined ? { signal } : { signal, headers },
        ),
      streamErrorChunk,
      signal,
      XAI,
    );
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
