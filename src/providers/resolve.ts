import { errorMessage } from '../errors.ts';
import {
  FAMILY_ADAPTERS,
  type FamilyAdapter,
  findCatalogEntry,
  type ModelEntry,
  type ProviderFactoryOptions,
} from './catalog.ts';
import type { DiscoveryCache, DiscoveryOptions, FetchLike } from './discovery.ts';
import type { Env } from './env.ts';
import type { Provider, ProviderCapabilities, ProviderFamily } from './types.ts';

// Used when a model is neither in the catalog nor discoverable. Conservative values keep requests
// valid on small models; every optional feature stays off because nothing confirms it.
export const DEFAULT_CAPABILITIES: Readonly<ProviderCapabilities> = {
  context_window: 32_768,
  output_max_tokens: 8_192,
  supports_sampling: false,
};

export const isProviderFamily = (s: string): s is ProviderFamily =>
  Object.hasOwn(FAMILY_ADAPTERS, s);

export interface ModelOverrides {
  contextWindow?: number;
  maxOutput?: number;
}

export interface ResolveOptions {
  env?: Env;
  overrides?: ModelOverrides;
  fetch?: FetchLike;
  discoveryCache?: DiscoveryCache;
  signal?: AbortSignal;
}

export type ModelSource = 'catalog' | 'discovery' | 'defaults';

export type ResolveResult =
  | { ok: true; provider: Provider; source: ModelSource; warnings: string[] }
  | { ok: false; error: string };

const supportedFamilies = (): string => Object.keys(FAMILY_ADAPTERS).sort().join(', ');

const isPositiveInt = (v: number): boolean => Number.isSafeInteger(v) && v > 0;

const validateOverrides = (overrides: ModelOverrides): string | undefined => {
  if (overrides.contextWindow !== undefined && !isPositiveInt(overrides.contextWindow)) {
    return `invalid context window override ${overrides.contextWindow}: expected a positive integer`;
  }
  if (overrides.maxOutput !== undefined && !isPositiveInt(overrides.maxOutput)) {
    return `invalid max output override ${overrides.maxOutput}: expected a positive integer`;
  }
  return undefined;
};

const applyOverrides = (
  caps: ProviderCapabilities,
  overrides: ModelOverrides,
): ProviderCapabilities => {
  const out: ProviderCapabilities = { ...caps };
  if (overrides.contextWindow !== undefined) out.context_window = overrides.contextWindow;
  if (overrides.maxOutput !== undefined) out.output_max_tokens = overrides.maxOutput;
  return out;
};

// Returns undefined when the value is not an http(s) URL. The value is never echoed in errors
// because a proxy URL may embed credentials.
const normalizeBaseUrl = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return value.replace(/\/+$/, '');
};

type CapabilityResolution =
  | { ok: true; source: ModelSource; capabilities: ProviderCapabilities; warnings: string[] }
  | { ok: false; error: string };

const resolveCapabilities = async (
  id: string,
  model: string,
  entry: ModelEntry | undefined,
  adapter: FamilyAdapter,
  endpoint: { baseUrl: string; apiKey: string | undefined },
  options: ResolveOptions,
): Promise<CapabilityResolution> => {
  if (entry !== undefined) {
    return { ok: true, source: 'catalog', capabilities: entry.capabilities, warnings: [] };
  }

  let reason = 'the provider has no discovery endpoint';
  if (adapter.discover !== undefined) {
    const discoveryOptions: DiscoveryOptions = { baseUrl: endpoint.baseUrl };
    if (endpoint.apiKey !== undefined) discoveryOptions.apiKey = endpoint.apiKey;
    if (options.fetch !== undefined) discoveryOptions.fetch = options.fetch;
    if (options.discoveryCache !== undefined) discoveryOptions.cache = options.discoveryCache;
    if (options.signal !== undefined) discoveryOptions.signal = options.signal;
    const discovered = await adapter.discover(model, discoveryOptions);
    if (discovered.ok) {
      return { ok: true, source: 'discovery', capabilities: discovered.capabilities, warnings: [] };
    }
    if (discovered.kind !== 'unavailable') {
      return { ok: false, error: `cannot use model "${id}": ${discovered.error}` };
    }
    reason = discovered.error;
  }

  const defaults = DEFAULT_CAPABILITIES;
  return {
    ok: true,
    source: 'defaults',
    capabilities: defaults,
    warnings: [
      `capabilities of "${id}" are unknown (${reason}); using defaults: context window ${defaults.context_window}, max output ${defaults.output_max_tokens}, reasoning and sampling disabled`,
    ],
  };
};

// Capabilities come from the compiled catalog first, then from the family's discovery endpoint,
// then from DEFAULT_CAPABILITIES; overrides apply last over any source. Nothing is read from or
// written to disk. An abort of `options.signal` during discovery throws AbortError.
export const resolveModel = async (
  id: string,
  options: ResolveOptions = {},
): Promise<ResolveResult> => {
  const env = options.env ?? process.env;
  const overrides = options.overrides ?? {};

  // Split at the first slash only: OpenRouter model names contain slashes themselves.
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) {
    return {
      ok: false,
      error: `invalid model id "${id}": expected <family>/<model>, for example openrouter/deepseek/deepseek-v4-flash`,
    };
  }
  const familyName = id.slice(0, slash);
  const model = id.slice(slash + 1);

  if (!isProviderFamily(familyName)) {
    return {
      ok: false,
      error: `unknown provider family "${familyName}" in model id "${id}"; supported families: ${supportedFamilies()}`,
    };
  }
  const adapter = FAMILY_ADAPTERS[familyName];

  const overrideError = validateOverrides(overrides);
  if (overrideError !== undefined) return { ok: false, error: overrideError };

  const entry = findCatalogEntry(id);
  const configuredBaseUrl = env[adapter.baseUrlEnv];
  const baseURL =
    configuredBaseUrl === undefined || configuredBaseUrl.length === 0
      ? (entry?.baseUrl ?? adapter.defaultBaseUrl)
      : normalizeBaseUrl(configuredBaseUrl);
  if (baseURL === undefined) {
    return { ok: false, error: `${adapter.baseUrlEnv} must be an http or https URL` };
  }

  let apiKey: string | undefined;
  if (adapter.usesApiKey?.(baseURL) ?? true) {
    apiKey = env[adapter.apiKeyEnv];
    if (apiKey === undefined || apiKey.length === 0) {
      const scope =
        adapter.usesApiKey === undefined
          ? `${familyName} models`
          : `${familyName} models served by ${new URL(baseURL).origin}`;
      return { ok: false, error: `${adapter.apiKeyEnv} is not set; it is required for ${scope}` };
    }
  }

  const resolved = await resolveCapabilities(
    id,
    model,
    entry,
    adapter,
    { baseUrl: baseURL, apiKey },
    options,
  );
  if (!resolved.ok) return resolved;

  const warnings = [...resolved.warnings];
  const factoryOptions: ProviderFactoryOptions = {
    baseURL,
    capabilities: applyOverrides(resolved.capabilities, overrides),
    env,
    warn: (message) => warnings.push(message),
  };
  if (apiKey !== undefined) factoryOptions.apiKey = apiKey;
  try {
    const provider = adapter.create(model, factoryOptions);
    return { ok: true, provider, source: resolved.source, warnings };
  } catch (e) {
    return {
      ok: false,
      error: `cannot create provider for "${id}": ${errorMessage(e)}`,
    };
  }
};
