import type { ProviderCapabilities } from '../types.ts';

// Curated OpenRouter models for agentic coding, keyed by the exact OpenRouter slug. Slugs contain
// a vendor prefix, so the full model id carries two slashes (`openrouter/deepseek/...`).
//
// Values come from OpenRouter's `GET /models` payload as of 2026-07-11.
//
// `context_window` is the window served by the default-routed provider
// (`top_provider.context_length`), which is smaller than the model maximum for some models. The
// adapter disables OpenRouter's middle-out compression, so a prompt larger than the served window
// fails instead of being silently truncated; budgeting against the served window avoids that.
//
// `output_max_tokens` is a conventional 32K agentic cap rather than each model's completion
// ceiling (some allow 384K). It is a ceiling clamped by the remaining window per request, and a
// default `max_tokens` that large would reserve most of the window for output.
//
// `supports_reasoning_effort` marks models that accept `reasoning.effort`. Models that reason but
// expose no effort levels declare `supports_reasoning`; the adapter toggles them with
// `reasoning.enabled` instead of sending a level they would reject.
export const OPENROUTER_CAPS: Record<string, ProviderCapabilities> = {
  'deepseek/deepseek-v4-flash': {
    context_window: 1_024_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
  },
  'deepseek/deepseek-v4-pro': {
    context_window: 1_024_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
  },
  'minimax/minimax-m3': {
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning: true,
  },
  'z-ai/glm-5.2': {
    context_window: 1_024_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
  },
  'moonshotai/kimi-k2.6': {
    context_window: 262_144,
    output_max_tokens: 32_768,
    supports_reasoning: true,
  },
  // Alibaba caches only behind explicit `cache_control` breakpoints, not automatically.
  'qwen/qwen3.6-plus': {
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning: true,
    cache_explicit_breakpoints: true,
  },
  'x-ai/grok-4.5': {
    context_window: 500_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
  },
  // Free routes disappear without notice, so only free models verified to complete agentic
  // tasks with tools are kept here; other free models resolve through discovery. This route is
  // heavily rate-limited, and the free endpoint collects prompt data.
  'nvidia/nemotron-3-ultra-550b-a55b:free': {
    context_window: 1_000_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
  },
};
