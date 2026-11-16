import {
  type DiscoveryOptions,
  type DiscoveryResult,
  discoverOpenRouterModel,
} from './discovery.ts';
import type { Env } from './env.ts';
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
}

export const MODEL_CATALOG: readonly ModelEntry[] = Object.entries(OPENROUTER_CAPS).map(
  ([model, capabilities]): ModelEntry => ({
    id: `openrouter/${model}`,
    family: 'openrouter',
    model,
    capabilities,
  }),
);

export const findCatalogEntry = (id: string): ModelEntry | undefined =>
  MODEL_CATALOG.find((entry) => entry.id === id);

export interface ProviderFactoryOptions {
  apiKey: string;
  baseURL: string;
  capabilities: ProviderCapabilities;
  env: Env;
}

// Credentials and endpoints follow a fixed convention per family rather than per model, so every
// model of a family is configured by the same environment variables.
export interface FamilyAdapter {
  apiKeyEnv: string;
  baseUrlEnv: string;
  defaultBaseUrl: string;
  create: (model: string, options: ProviderFactoryOptions) => Provider;
  // Looks up capabilities for a model missing from the catalog.
  discover?: (model: string, options: DiscoveryOptions) => Promise<DiscoveryResult>;
}

export const FAMILY_ADAPTERS: Partial<Record<ProviderFamily, FamilyAdapter>> = {
  openrouter: {
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'NULLRIVET_OPENROUTER_BASE_URL',
    defaultBaseUrl: DEFAULT_OPENROUTER_BASE_URL,
    create: createOpenRouterProvider,
    discover: discoverOpenRouterModel,
  },
};
