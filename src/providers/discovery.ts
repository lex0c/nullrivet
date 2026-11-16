import { errorMessage } from '../errors.ts';
import { AbortError } from './errors.ts';
import type { ProviderCapabilities } from './types.ts';

export const DISCOVERY_TIMEOUT_MS = 5_000;
// Used when the listing reports no completion limit for the model.
export const DISCOVERED_OUTPUT_FALLBACK = 8_192;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// The subset of one listing entry that discovery reads. A field is undefined when the payload
// omitted it or gave it the wrong type.
interface ListedModel {
  contextLength: number | undefined;
  maxCompletionTokens: number | undefined;
  supportedParameters: readonly string[] | undefined;
}

// Parsed listings per base URL. Kept in memory only, for the lifetime of the process.
export type DiscoveryCache = Map<string, ReadonlyMap<string, ListedModel>>;

const processCache: DiscoveryCache = new Map();

export interface DiscoveryOptions {
  baseUrl: string;
  fetch?: FetchLike;
  cache?: DiscoveryCache;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// `unavailable` means the listing could not be used, so the caller may fall back to defaults.
// `not_found` and `rejected` are definite answers from a valid listing.
export type DiscoveryResult =
  | { ok: true; capabilities: ProviderCapabilities }
  | { ok: false; kind: 'unavailable' | 'not_found' | 'rejected'; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const positiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;

// The payload is untrusted. Entries without a string id are skipped, and a malformed field only
// affects its own entry, so one bad entry does not invalidate the whole listing.
const parseModelList = (payload: unknown): Map<string, ListedModel> | undefined => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
  const models = new Map<string, ListedModel>();
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) continue;
    if (models.has(item.id)) continue;
    const topProvider = isRecord(item.top_provider) ? item.top_provider : undefined;
    const params = item.supported_parameters;
    const listed = positiveInt(item.context_length);
    const served = positiveInt(topProvider?.context_length);
    models.set(item.id, {
      // The default-routed provider may serve a smaller window than the headline maximum, and
      // requests are sent without OpenRouter's automatic truncation, so the smaller one is used.
      contextLength:
        listed !== undefined && served !== undefined ? Math.min(listed, served) : listed,
      maxCompletionTokens: positiveInt(topProvider?.max_completion_tokens),
      supportedParameters: Array.isArray(params)
        ? params.filter((p): p is string => typeof p === 'string')
        : undefined,
    });
  }
  return models;
};

// Messages may reach logs, so they never carry credentials or query parameters from the URL.
const displayUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
};

type ListResult = { ok: true; models: Map<string, ListedModel> } | { ok: false; error: string };

const fetchModelList = async (
  url: string,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ListResult> => {
  const shown = displayUrl(url);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let payload: unknown;
  try {
    const res = await fetchImpl(url, {
      signal: combined,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, error: `GET ${shown} returned HTTP ${res.status}` };
    }
    payload = await res.json();
  } catch (e) {
    if (signal?.aborted === true) throw new AbortError();
    if (timeout.aborted) {
      return { ok: false, error: `GET ${shown} timed out after ${timeoutMs} ms` };
    }
    return { ok: false, error: `GET ${shown} failed: ${errorMessage(e)}` };
  }
  const models = parseModelList(payload);
  if (models === undefined) {
    return { ok: false, error: `GET ${shown} returned an unexpected payload (no "data" array)` };
  }
  return { ok: true, models };
};

const toCapabilities = (model: string, entry: ListedModel): DiscoveryResult => {
  if (entry.supportedParameters === undefined) {
    return {
      ok: false,
      kind: 'unavailable',
      error: `OpenRouter listing for "${model}" has no valid supported_parameters`,
    };
  }
  if (!entry.supportedParameters.includes('tools')) {
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
      entry.contextLength,
    ),
  };
  // Effort levels are never inferred: the listing does not say which levels a model accepts, and
  // an unsupported level is rejected by the API.
  if (entry.supportedParameters.includes('reasoning')) capabilities.supports_reasoning = true;
  if (!entry.supportedParameters.includes('temperature')) capabilities.supports_sampling = false;
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
    const listed = await fetchModelList(
      `${baseUrl}/models`,
      options.fetch ?? fetch,
      options.signal,
      options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    );
    if (!listed.ok) return { ok: false, kind: 'unavailable', error: listed.error };
    models = listed.models;
    cache.set(baseUrl, models);
  }
  const entry = models.get(model);
  if (entry === undefined) {
    return { ok: false, kind: 'not_found', error: `OpenRouter does not list model "${model}"` };
  }
  return toCapabilities(model, entry);
};
