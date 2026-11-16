import type { ProviderEffort } from './types.ts';

// Every adapter receives the same `ProviderEffort` vocabulary and translates it locally: providers
// with a named effort level map through a table, and providers whose only knob is a token count
// read the budget ladder below.

// Thinking-token budget per effort level for numeric-budget providers. `max` equals the smallest
// thinking ceiling among them (Gemini 2.5 Flash, 24_576), so one ladder is valid for all of them
// without per-model branching. Adapters still clamp to the request's `max_tokens`, because the
// APIs reject a budget >= max_tokens.
export const EFFORT_THINKING_BUDGET: Record<ProviderEffort, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 20_480,
  max: 24_576,
};

// OpenAI's top level is `xhigh`, so `max` has no counterpart and maps onto it.
export const OPENAI_REASONING_EFFORT: Record<ProviderEffort, 'low' | 'medium' | 'high' | 'xhigh'> =
  {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'xhigh',
  };

// xAI accepts only low|medium|high, and `high` is its top level, so `xhigh` and `max` clamp to it.
export const XAI_REASONING_EFFORT: Record<ProviderEffort, 'low' | 'medium' | 'high'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

// Anthropic rejects `xhigh` with a 400 on models that do not expose it, so it is clamped to `high`.
export const anthropicEffort = (effort: ProviderEffort, supportsXhigh: boolean): ProviderEffort =>
  effort === 'xhigh' && !supportsXhigh ? 'high' : effort;

// Numeric-budget providers reject a budget below their model minimum (Gemini 2.5 Pro requires
// >= 128), so a budget that would fall under this floor is omitted instead of sent.
export const MIN_THINKING_BUDGET = 128;

// Clamped strictly below `maxTokens` and at or above MIN_THINKING_BUDGET. Returns undefined when
// the headroom cannot satisfy the floor; the caller then omits the thinking configuration.
export const effortThinkingBudget = (
  effort: ProviderEffort,
  maxTokens: number,
): number | undefined => {
  const ceiling = maxTokens - 1;
  if (ceiling < MIN_THINKING_BUDGET) return undefined;
  return Math.min(EFFORT_THINKING_BUDGET[effort], ceiling);
};
