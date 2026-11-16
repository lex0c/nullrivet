import type { FetchLike } from '../discovery.ts';
import { boolFromEnv, type Env } from '../env.ts';
import type { GenerateRequest, Provider, ProviderCapabilities, StreamEvent } from '../types.ts';
import { createOllamaHttp, DEFAULT_OLLAMA_BASE_URL, type OllamaChatRequest } from './http.ts';
import {
  DEFAULT_OLLAMA_NUM_CTX,
  ollamaOptions,
  ollamaThink,
  toOllamaMessages,
  toOllamaTools,
} from './messages.ts';
import { normalizeOllamaStream } from './stream.ts';

export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com';

export interface CreateOllamaProviderOptions {
  capabilities: ProviderCapabilities;
  baseURL?: string;
  // Sent as a bearer token. The resolver passes it only for Ollama Cloud.
  apiKey?: string;
  fetch?: FetchLike;
  env?: Env;
}

// Ollama Cloud is the only Ollama endpoint that authenticates with OLLAMA_API_KEY. The key is
// never sent to another host, and never over plain HTTP.
export const isOllamaCloud = (baseUrl: string): boolean => {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname === 'ollama.com';
  } catch {
    return false;
  }
};

const positiveIntFromEnv = (env: Env, name: string): number | undefined => {
  const v = env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

// A bare integer is a number of seconds and must be sent as a number; a duration such as `30m`
// stays a string.
const keepAliveFromEnv = (env: Env): string | number | undefined => {
  const v = env.NULLRIVET_OLLAMA_KEEP_ALIVE;
  if (v === undefined || v === '') return undefined;
  return /^-?\d+$/.test(v) ? Number(v) : v;
};

export const createOllamaProvider = (
  modelName: string,
  options: CreateOllamaProviderOptions,
): Provider => {
  const caps = options.capabilities;
  const env = options.env ?? process.env;
  const baseUrl = options.baseURL ?? DEFAULT_OLLAMA_BASE_URL;
  const headers: Record<string, string> = {};
  if (options.apiKey !== undefined && options.apiKey.length > 0) {
    headers.authorization = `Bearer ${options.apiKey}`;
  }
  const httpOptions: Parameters<typeof createOllamaHttp>[0] = { baseUrl, headers };
  if (options.fetch !== undefined) httpOptions.fetch = options.fetch;
  const http = createOllamaHttp(httpOptions);

  // The server truncates a prompt above `num_ctx` silently, dropping the oldest tokens including
  // the system prompt, so the window it serves is what the agent must budget against. A local
  // server is capped to protect its memory; Ollama Cloud serves the full window. An explicit
  // NULLRIVET_OLLAMA_NUM_CTX overrides both, and nothing exceeds the model capacity.
  const requestedNumCtx =
    positiveIntFromEnv(env, 'NULLRIVET_OLLAMA_NUM_CTX') ??
    (isOllamaCloud(baseUrl) ? caps.context_window : DEFAULT_OLLAMA_NUM_CTX);
  const numCtx = Math.min(requestedNumCtx, caps.context_window);
  const servedCaps: ProviderCapabilities =
    numCtx === caps.context_window
      ? caps
      : {
          ...caps,
          context_window: numCtx,
          output_max_tokens: Math.min(caps.output_max_tokens, numCtx),
        };

  const keepAlive = keepAliveFromEnv(env);
  const reasoningReplay =
    (caps.supports_reasoning === true || caps.supports_reasoning_effort === true) &&
    boolFromEnv(env, 'NULLRIVET_OLLAMA_REASONING_REPLAY', true);

  const buildBody = (req: GenerateRequest): OllamaChatRequest => {
    const body: OllamaChatRequest = {
      model: modelName,
      messages: toOllamaMessages(req, reasoningReplay),
      options: ollamaOptions(req, caps, numCtx),
    };
    if (req.tools !== undefined && req.tools.length > 0) body.tools = toOllamaTools(req.tools);
    const think = ollamaThink(req, caps);
    if (think !== undefined) body.think = think;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
    return body;
  };

  return {
    id: `ollama/${modelName}`,
    family: 'ollama',
    capabilities: servedCaps,
    replaysReasoning: reasoningReplay,
    generate: (req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
      normalizeOllamaStream(
        (async function* () {
          yield* http.chatStream(buildBody(req), signal);
        })(),
      ),
  };
};
