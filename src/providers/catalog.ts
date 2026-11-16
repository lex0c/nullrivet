import { ANTHROPIC_CAPS } from './anthropic/capabilities.ts';
import { createAnthropicProvider, DEFAULT_ANTHROPIC_BASE_URL } from './anthropic/index.ts';
import {
  type DiscoveryOptions,
  type DiscoveryResult,
  discoverOllamaModel,
  discoverOpenRouterModel,
} from './discovery.ts';
import type { Env } from './env.ts';
import { OLLAMA_CLOUD_CAPS, OLLAMA_LOCAL_CAPS } from './ollama/capabilities.ts';
import { DEFAULT_OLLAMA_BASE_URL } from './ollama/http.ts';
import { createOllamaProvider, isOllamaCloud, OLLAMA_CLOUD_BASE_URL } from './ollama/index.ts';
import { OPENAI_CAPS } from './openai/capabilities.ts';
import { createOpenAIProvider, DEFAULT_OPENAI_BASE_URL } from './openai/index.ts';
import { OPENROUTER_CAPS } from './openrouter/capabilities.ts';
import { createOpenRouterProvider, DEFAULT_OPENROUTER_BASE_URL } from './openrouter/index.ts';
import type { Provider, ProviderCapabilities, ProviderFamily } from './types.ts';

export interface ModelEntry {
  // `<family>/<model>`, as typed by the user.
  id: string;
  family: ProviderFamily;
  // Model name sent to the API.
  model: string;
  capabilities: ProviderCapabilities;
  // Endpoint used when the family's base URL variable is unset, for a model served by another
  // host than the family default (Ollama Cloud models).
  baseUrl?: string;
}

const entriesOf = (
  family: ProviderFamily,
  caps: Record<string, ProviderCapabilities>,
  baseUrl?: string,
): ModelEntry[] =>
  Object.entries(caps).map(([model, capabilities]): ModelEntry => {
    const entry: ModelEntry = { id: `${family}/${model}`, family, model, capabilities };
    if (baseUrl !== undefined) entry.baseUrl = baseUrl;
    return entry;
  });

export const MODEL_CATALOG: readonly ModelEntry[] = [
  ...entriesOf('anthropic', ANTHROPIC_CAPS),
  ...entriesOf('openai', OPENAI_CAPS),
  ...entriesOf('ollama', OLLAMA_LOCAL_CAPS),
  ...entriesOf('ollama', OLLAMA_CLOUD_CAPS, OLLAMA_CLOUD_BASE_URL),
  ...entriesOf('openrouter', OPENROUTER_CAPS),
];

export const findCatalogEntry = (id: string): ModelEntry | undefined =>
  MODEL_CATALOG.find((entry) => entry.id === id);

export interface ProviderFactoryOptions {
  // Absent when the endpoint does not authenticate with the family's key.
  apiKey?: string;
  baseURL: string;
  capabilities: ProviderCapabilities;
  env: Env;
  // Reports configuration the adapter cannot honor; the resolver returns it as a warning.
  warn: (message: string) => void;
}

// Credentials and endpoints follow a fixed convention per family rather than per model, so every
// model of a family is configured by the same environment variables.
export interface FamilyAdapter {
  apiKeyEnv: string;
  baseUrlEnv: string;
  defaultBaseUrl: string;
  // Whether requests to `baseUrl` authenticate with the key in `apiKeyEnv`; unset means always.
  // Where it returns false the key is neither required nor sent, so it never reaches a server that
  // has no use for it.
  usesApiKey?: (baseUrl: string) => boolean;
  create: (model: string, options: ProviderFactoryOptions) => Provider;
  // Looks up capabilities for a model missing from the catalog.
  discover?: (model: string, options: DiscoveryOptions) => Promise<DiscoveryResult>;
}

export const FAMILY_ADAPTERS: Partial<Record<ProviderFamily, FamilyAdapter>> = {
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'NULLRIVET_ANTHROPIC_BASE_URL',
    defaultBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    create: createAnthropicProvider,
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'NULLRIVET_OPENAI_BASE_URL',
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    create: createOpenAIProvider,
  },
  ollama: {
    apiKeyEnv: 'OLLAMA_API_KEY',
    baseUrlEnv: 'NULLRIVET_OLLAMA_BASE_URL',
    defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    usesApiKey: isOllamaCloud,
    create: createOllamaProvider,
    discover: discoverOllamaModel,
  },
  openrouter: {
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'NULLRIVET_OPENROUTER_BASE_URL',
    defaultBaseUrl: DEFAULT_OPENROUTER_BASE_URL,
    create: createOpenRouterProvider,
    discover: discoverOpenRouterModel,
  },
};
