import type { ProviderCapabilities } from '../types.ts';

// Curated Gemini models, keyed by the API model id. Context windows come from
// `GET /v1beta/models` as of 2026-11-16, where every listed model reports thinking support.
//
// `output_max_tokens` is a conventional 32K agentic cap rather than each model's ceiling (64K on
// most). It is clamped by the remaining window per request, and Gemini counts thinking tokens
// against it.
//
// Gemini 3 and later take a named thinking level, so their entries have no
// `max_thinking_budget`; `supports_effort_xhigh` marks the models that accept `xhigh`. They also
// carry `supports_sampling: false`: the API accepts `temperature`, but Google advises keeping its
// default on these models because lower values can make them loop. Gemini 2.5 takes a numeric
// thinking budget, capped by `max_thinking_budget`.
//
// Gemini 2.5 Pro and 2.5 Flash are left out: they are deprecated, and from 2026-12-01 their ids
// are served by other models.
const GEMINI_3: Readonly<ProviderCapabilities> = {
  context_window: 1_048_576,
  output_max_tokens: 32_768,
  supports_reasoning_effort: true,
  supports_sampling: false,
};

export const GOOGLE_CAPS: Record<string, ProviderCapabilities> = {
  'gemini-4-hydrogen': { ...GEMINI_3, supports_effort_xhigh: true },
  'gemini-4-argon': { ...GEMINI_3 },
  'gemini-4-carbon': { ...GEMINI_3 },
  'gemini-3.8-flash': { ...GEMINI_3 },
  'gemini-3.6-flash': { ...GEMINI_3 },
  'gemini-3.5-flash': { ...GEMINI_3 },
  'gemini-3.5-flash-lite': { ...GEMINI_3 },
  'gemini-3.1-pro-preview': { ...GEMINI_3 },
  'gemini-3.1-flash-lite': { ...GEMINI_3 },
  'gemini-3-flash-preview': { ...GEMINI_3 },
  // Served only to projects that used Gemini 2.5 before; others get a 404. Does not think unless
  // a budget is requested.
  'gemini-2.5-flash-lite': {
    context_window: 1_048_576,
    output_max_tokens: 32_768,
    supports_reasoning_effort: true,
    min_thinking_budget: 512,
    max_thinking_budget: 24_576,
  },
};
