import type { ProviderCapabilities } from '../types.ts';

// Curated xAI models served by the native API (https://api.x.ai/v1), keyed by the API model id.
// Context windows and effort levels come from `GET /v1/models` as of 2026-11-16.
//
// `output_max_tokens` is a conventional 32K agentic cap rather than each model's ceiling. It is
// clamped by the remaining window per request.
//
// Reasoning models reject `stop`. They are marked with `supports_reasoning_effort` when they
// accept `reasoning_effort`, and with `supports_reasoning` when they always reason and reject the
// parameter. `supports_effort_xhigh` marks the models that list `xhigh` among their levels.
export const XAI_CAPS: Record<string, ProviderCapabilities> = {
  'grok-4.7': {
    context_window: 500_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    supports_effort_xhigh: true,
  },
  'grok-4.6': {
    context_window: 500_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    supports_effort_xhigh: true,
  },
  'grok-4.5': {
    context_window: 500_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    supports_effort_xhigh: true,
  },
  // Defaults to `low` effort when none is requested.
  'grok-4.3': {
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    supports_effort_xhigh: true,
  },
  // Coding model, also served under the alias grok-code-fast-1.
  'grok-build-0.1': {
    context_window: 256_000,
    output_max_tokens: 32_768,
    supports_reasoning: true,
  },
  'grok-4.20-0309-reasoning': {
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning: true,
  },
  'grok-4.20-0309-non-reasoning': {
    context_window: 1_000_000,
    output_max_tokens: 32_768,
  },
};
