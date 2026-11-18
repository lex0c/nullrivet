import { errorMessage } from '../errors.ts';
import { AbortError, certificateErrorCode, certificateRejection } from './errors.ts';
import type { ProviderCapabilities } from './types.ts';

export const DISCOVERY_TIMEOUT_MS = 5_000;
// Used when the source reports no completion limit for the model.
export const DISCOVERED_OUTPUT_FALLBACK = 8_192;
// Agentic answers rarely need more, and a larger limit only shrinks the room left for context.
export const DISCOVERED_OUTPUT_CAP = 32_768;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// The subset of what a source reports about one model that discovery reads. A field is undefined
// when the payload omitted it or gave it the wrong type. `features` keeps the vocabulary of the
// source: OpenRouter `supported_parameters` or Ollama `capabilities`.
interface ListedModel {
  contextLength: number | undefined;
  maxCompletionTokens: number | undefined;
  features: readonly string[] | undefined;
  // Set by sources that report capabilities directly (Anthropic).
  capabilities?: ProviderCapabilities;
}

// Parsed models per source. Kept in memory only, for the lifetime of the process.
export type DiscoveryCache = Map<string, ReadonlyMap<string, ListedModel>>;

const processCache: DiscoveryCache = new Map();

export interface DiscoveryOptions {
  baseUrl: string;
  // Sent only by sources that require authentication.
  apiKey?: string;
  fetch?: FetchLike;
  cache?: DiscoveryCache;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// `unavailable` means the source could not be used, so the caller may fall back to defaults.
// `not_found` and `rejected` are definite answers from a valid response.
export type DiscoveryResult =
  | { ok: true; capabilities: ProviderCapabilities }
  | { ok: false; kind: 'unavailable' | 'not_found' | 'rejected'; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const positiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;

const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : undefined;

// Messages may reach logs, so they never carry credentials or query parameters from the URL.
export const displayUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
};

type JsonResult =
  | { ok: true; payload: unknown }
  | { ok: false; status: number | undefined; error: string };

interface JsonRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const fetchJson = async (
  request: JsonRequest,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<JsonResult> => {
  const shown = `${request.method} ${displayUrl(request.url)}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const init: RequestInit = {
    method: request.method,
    signal: combined,
    headers: { accept: 'application/json', ...request.headers },
  };
  if (request.body !== undefined) init.body = request.body;
  try {
    const res = await fetchImpl(request.url, init);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, error: `${shown} returned HTTP ${res.status}` };
    }
    return { ok: true, payload: await res.json() };
  } catch (e) {
    if (signal?.aborted === true) throw new AbortError();
    if (timeout.aborted) {
      return { ok: false, status: undefined, error: `${shown} timed out after ${timeoutMs} ms` };
    }
    const certificate = certificateErrorCode(e);
    if (certificate !== undefined) {
      return {
        ok: false,
        status: undefined,
        error: `${shown} failed: ${certificateRejection(certificate)}`,
      };
    }
    return { ok: false, status: undefined, error: `${shown} failed: ${errorMessage(e)}` };
  }
};

// The payload is untrusted. Entries without a string id are skipped, and a malformed field only
// affects its own entry, so one bad entry does not invalidate the whole listing.
const parseModelList = (payload: unknown): Map<string, ListedModel> | undefined => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
  const models = new Map<string, ListedModel>();
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) continue;
    if (models.has(item.id)) continue;
    const topProvider = isRecord(item.top_provider) ? item.top_provider : undefined;
    const listed = positiveInt(item.context_length);
    const served = positiveInt(topProvider?.context_length);
    models.set(item.id, {
      // The default-routed provider may serve a smaller window than the headline maximum, and
      // requests are sent without OpenRouter's automatic truncation, so the smaller one is used.
      contextLength:
        listed !== undefined && served !== undefined ? Math.min(listed, served) : listed,
      maxCompletionTokens: positiveInt(topProvider?.max_completion_tokens),
      features: stringList(item.supported_parameters),
    });
  }
  return models;
};

const toOpenRouterCapabilities = (model: string, entry: ListedModel): DiscoveryResult => {
  if (entry.features === undefined) {
    return {
      ok: false,
      kind: 'unavailable',
      error: `OpenRouter listing for "${model}" has no valid supported_parameters`,
    };
  }
  if (!entry.features.includes('tools')) {
    return {
      ok: false,
      kind: 'rejected',
      error: `OpenRouter model "${model}" does not support tool calling (supported_parameters has no "tools")`,
    };
  }
  if (entry.contextLength === undefined) {
    return {
      ok: false,
      kind: 'unavailable',
      error: `OpenRouter listing for "${model}" has no valid context_length`,
    };
  }
  const capabilities: ProviderCapabilities = {
    context_window: entry.contextLength,
    output_max_tokens: Math.min(
      entry.maxCompletionTokens ?? DISCOVERED_OUTPUT_FALLBACK,
      DISCOVERED_OUTPUT_CAP,
      entry.contextLength,
    ),
  };
  // Effort levels are never inferred: the listing does not say which levels a model accepts, and
  // an unsupported level is rejected by the API.
  if (entry.features.includes('reasoning')) capabilities.supports_reasoning = true;
  if (!entry.features.includes('temperature')) capabilities.supports_sampling = false;
  return { ok: true, capabilities };
};

// Reads the public model listing, which needs no API key. Only successful listings are cached,
// so a timeout or network failure is retried on the next call. An abort from the caller's signal
// throws AbortError instead of producing a result.
export const discoverOpenRouterModel = async (
  model: string,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> => {
  if (options.signal?.aborted === true) throw new AbortError();
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const cache = options.cache ?? processCache;
  let models = cache.get(baseUrl);
  if (models === undefined) {
    const url = `${baseUrl}/models`;
    const fetched = await fetchJson(
      { method: 'GET', url, headers: {} },
      options.fetch ?? fetch,
      options.signal,
      options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    );
    if (!fetched.ok) return { ok: false, kind: 'unavailable', error: fetched.error };
    const parsed = parseModelList(fetched.payload);
    if (parsed === undefined) {
      return {
        ok: false,
        kind: 'unavailable',
        error: `GET ${displayUrl(url)} returned an unexpected payload (no "data" array)`,
      };
    }
    models = parsed;
    cache.set(baseUrl, models);
  }
  const entry = models.get(model);
  if (entry === undefined) {
    return { ok: false, kind: 'not_found', error: `OpenRouter does not list model "${model}"` };
  }
  return toOpenRouterCapabilities(model, entry);
};

// `/api/show` reports the context length under an architecture-specific key such as
// `llama.context_length`. When the architecture is missing, a single unambiguous
// `*.context_length` entry is accepted instead.
const ollamaContextLength = (info: Record<string, unknown>): number | undefined => {
  const arch = info['general.architecture'];
  if (typeof arch === 'string' && arch.length > 0) {
    const direct = positiveInt(info[`${arch}.context_length`]);
    if (direct !== undefined) return direct;
  }
  const candidates = new Set<number>();
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith('.context_length')) continue;
    const n = positiveInt(value);
    if (n !== undefined) candidates.add(n);
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
};

const parseOllamaShow = (payload: unknown): ListedModel | undefined => {
  if (!isRecord(payload)) return undefined;
  const info = isRecord(payload.model_info) ? payload.model_info : undefined;
  return {
    contextLength: info === undefined ? undefined : ollamaContextLength(info),
    maxCompletionTokens: undefined,
    features: stringList(payload.capabilities),
  };
};

const toOllamaCapabilities = (model: string, entry: ListedModel): DiscoveryResult => {
  // Servers older than the `capabilities` field do not say whether a model supports tools, so
  // only a model whose reported capabilities lack tools is rejected.
  if (entry.features !== undefined && !entry.features.includes('tools')) {
    return {
      ok: false,
      kind: 'rejected',
      error: `Ollama model "${model}" does not support tool calling (capabilities has no "tools")`,
    };
  }
  if (entry.contextLength === undefined) {
    return {
      ok: false,
      kind: 'unavailable',
      error: `Ollama reports no context length for "${model}"`,
    };
  }
  const capabilities: ProviderCapabilities = {
    context_window: entry.contextLength,
    output_max_tokens: Math.min(DISCOVERED_OUTPUT_FALLBACK, entry.contextLength),
  };
  if (entry.features?.includes('thinking') === true) capabilities.supports_reasoning = true;
  return { ok: true, capabilities };
};

// Asks the server about one model with `POST /api/show`. A 404 means the server does not have the
// model, which is a definite answer; other failures leave the capabilities unknown. Successful
// answers are cached per base URL and model; a missing model is not, so it can be pulled and
// resolved again in the same process.
export const discoverOllamaModel = async (
  model: string,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> => {
  if (options.signal?.aborted === true) throw new AbortError();
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/api/show`;
  const cache = options.cache ?? processCache;
  const cached = cache.get(url);
  let entry = cached?.get(model);
  if (entry === undefined) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;
    const fetched = await fetchJson(
      { method: 'POST', url, headers, body: JSON.stringify({ model }) },
      options.fetch ?? fetch,
      options.signal,
      options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    );
    if (!fetched.ok) {
      if (fetched.status === 404) {
        return {
          ok: false,
          kind: 'not_found',
          error: `Ollama at ${displayUrl(baseUrl)} has no model "${model}" (for a local server, pull it with "ollama pull ${model}")`,
        };
      }
      return { ok: false, kind: 'unavailable', error: fetched.error };
    }
    entry = parseOllamaShow(fetched.payload);
    if (entry === undefined) {
      return {
        ok: false,
        kind: 'unavailable',
        error: `POST ${displayUrl(url)} returned an unexpected payload (not a JSON object)`,
      };
    }
    cache.set(url, new Map([...(cached ?? []), [model, entry]]));
  }
  return toOllamaCapabilities(model, entry);
};

const isTrue = (value: unknown, ...path: string[]): boolean => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return false;
    current = current[key];
  }
  return current === true;
};

// Anthropic's model endpoint reports the window, the output limit and which effort levels and
// thinking modes a model accepts, so models newer than the catalog resolve with exact values.
// Answers are cached in memory per endpoint and model.
export const discoverAnthropicModel = async (
  model: string,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> => {
  if (options.signal?.aborted === true) throw new AbortError();
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/v1/models/${encodeURIComponent(model)}`;
  const cache = options.cache ?? processCache;
  const cachedModels = cache.get(baseUrl);
  const cached = cachedModels?.get(model)?.capabilities;
  if (cached !== undefined) return { ok: true, capabilities: cached };
  if (options.apiKey === undefined) {
    return {
      ok: false,
      kind: 'unavailable',
      error: 'the Anthropic model endpoint requires an API key',
    };
  }
  const fetched = await fetchJson(
    {
      method: 'GET',
      url,
      headers: { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
    },
    options.fetch ?? fetch,
    options.signal,
    options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
  );
  if (!fetched.ok) {
    if (fetched.status === 404) {
      return { ok: false, kind: 'not_found', error: `Anthropic has no model "${model}"` };
    }
    return { ok: false, kind: 'unavailable', error: fetched.error };
  }
  const payload = fetched.payload;
  const window = isRecord(payload) ? positiveInt(payload.max_input_tokens) : undefined;
  if (!isRecord(payload) || window === undefined) {
    return {
      ok: false,
      kind: 'unavailable',
      error: `GET ${displayUrl(url)} returned no valid max_input_tokens`,
    };
  }
  const features = payload.capabilities;
  const capabilities: ProviderCapabilities = {
    context_window: window,
    output_max_tokens: Math.min(
      positiveInt(payload.max_tokens) ?? DISCOVERED_OUTPUT_FALLBACK,
      DISCOVERED_OUTPUT_CAP,
      window,
    ),
    // Thinking models reject sampling parameters and several cannot turn thinking off, so the
    // only request that would send them (the conversation summary) does not.
    supports_sampling: false,
  };
  if (isTrue(features, 'thinking', 'types', 'adaptive', 'supported')) {
    capabilities.supports_adaptive_thinking = true;
    // The listing does not say whether a model binds replayed thinking to the history. The newest
    // models do, and one that binds without the flag fails on every request after a compaction,
    // so a model outside the catalog is assumed to bind. On one that does not, the cost is the
    // thinking removed when the history changes.
    capabilities.reasoning_bound_to_history = true;
  } else if (isTrue(features, 'thinking', 'types', 'enabled', 'supported')) {
    capabilities.supports_reasoning = true;
  }
  if (isTrue(features, 'effort', 'supported')) capabilities.supports_reasoning_effort = true;
  if (isTrue(features, 'effort', 'xhigh', 'supported')) capabilities.supports_effort_xhigh = true;
  const entry: ListedModel = {
    contextLength: window,
    maxCompletionTokens: capabilities.output_max_tokens,
    features: undefined,
    capabilities,
  };
  cache.set(baseUrl, new Map([...(cachedModels ?? []), [model, entry]]));
  return { ok: true, capabilities };
};
