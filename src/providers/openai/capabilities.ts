import type { ProviderCapabilities } from '../types.ts';

// Curated OpenAI models, keyed by the API model id.
//
// Models with `supports_reasoning_effort` are served through the Responses API, because Chat
// Completions rejects tools combined with `reasoning_effort` on them; they also reject
// `temperature`/`top_p`. The others use Chat Completions.
//
// `output_max_tokens` is a conventional 32K agentic cap where the model's ceiling is far larger
// (128K on the gpt-5 and gpt-6 families). It is clamped by the remaining window per request.
//
// `extended_prompt_cache` is set only on the ids OpenAI lists for 24h prompt-cache retention, and
// `extended_prompt_cache_24h_only` on those that reject the `in_memory` value.

// The GPT-6 models keep the prompt cache for 30 minutes or 12 hours, without a 24h retention, so
// no retention is sent and the API default applies.
const GPT_6: Readonly<ProviderCapabilities> = {
  context_window: 1_050_000,
  output_max_tokens: 32_768,
  supports_reasoning_effort: true,
  supports_sampling: false,
};

export const OPENAI_CAPS: Record<string, ProviderCapabilities> = {
  'gpt-6.2-astra': { ...GPT_6 },
  'gpt-6.2-sol': { ...GPT_6 },
  'gpt-6.1-terra': { ...GPT_6 },
  'gpt-6-luna': { ...GPT_6 },
  'gpt-5.5': {
    context_window: 1_050_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    supports_sampling: false,
    extended_prompt_cache: true,
    extended_prompt_cache_24h_only: true,
  },
  'gpt-5.4': {
    context_window: 1_050_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    supports_sampling: false,
    extended_prompt_cache: true,
  },
  // The mini variant has a smaller window than gpt-5.4 and no extended cache retention.
  'gpt-5.4-mini': {
    context_window: 400_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    supports_sampling: false,
  },
  // Available through the Responses API only.
  'gpt-5.3-codex': {
    context_window: 400_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    supports_sampling: false,
  },
  // Shut down by OpenAI on 2026-12-11.
  'gpt-5-nano': {
    context_window: 400_000,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    supports_sampling: false,
  },
  'gpt-4o': {
    context_window: 128_000,
    output_max_tokens: 16_384,
  },
  'gpt-4o-mini': {
    context_window: 128_000,
    output_max_tokens: 16_384,
  },
};
