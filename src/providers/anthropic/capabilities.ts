import type { ProviderCapabilities } from '../types.ts';

// Curated Anthropic models, keyed by the API model id.
//
// `output_max_tokens` is a conventional 32K agentic cap rather than each model's ceiling (128K on
// Opus and Sonnet, 64K on Haiku 4.5). It is clamped by the remaining window per request, and a
// default that large would reserve most of the window for output.
export const ANTHROPIC_CAPS: Record<string, ProviderCapabilities> = {
  // Opus 4.7 and 4.8 reject `temperature`/`top_p` and a manual thinking budget: adaptive thinking
  // is their only thinking mode. Both accept the `xhigh` effort level.
  'claude-opus-4-8': {
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_sampling: false,
    supports_adaptive_thinking: true,
    supports_reasoning_effort: true,
    supports_effort_xhigh: true,
  },
  'claude-opus-4-7': {
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_sampling: false,
    supports_adaptive_thinking: true,
    supports_reasoning_effort: true,
    supports_effort_xhigh: true,
  },
  // Sonnet 4.6 accepts sampling and effort up to `max`, but not `xhigh`.
  'claude-sonnet-4-6': {
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_adaptive_thinking: true,
    supports_reasoning_effort: true,
  },
  // Haiku 4.5 has no effort parameter and thinks only with a manual budget, which the adapter
  // derives from the requested effort.
  'claude-haiku-4-5': {
    context_window: 200_000,
    output_max_tokens: 32_768,
    supports_reasoning: true,
  },
};
