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

// OpenRouter takes OpenAI's level names and stops at `xhigh`, so `max` maps onto it.
export const OPENAI_REASONING_EFFORT: Record<ProviderEffort, 'low' | 'medium' | 'high' | 'xhigh'> =
  {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'xhigh',
  };

// For providers whose named levels end at `high`, or at `xhigh` on some models (xAI, Gemini 3 and
// later). Both reject a level the model does not list, so `xhigh` is clamped to `high` unless the
// model accepts it, and `max`, which has no counterpart, maps to the highest accepted level.
export const cappedEffortLevel = (
  effort: ProviderEffort,
  supportsXhigh: boolean,
): 'low' | 'medium' | 'high' | 'xhigh' => {
  if (effort === 'xhigh' || effort === 'max') return supportsXhigh ? 'xhigh' : 'high';
  return effort;
};

// OpenAI models stop at different levels (`high` on gpt-5-nano, `xhigh` on the other gpt-5
// models, `max` on the gpt-6 models) and reject a higher one, so a level above the model's top one
// is sent as that top level.
export const openaiEffortLevel = (
  effort: ProviderEffort,
  supportsXhigh: boolean,
  supportsMax: boolean,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' =>
  effort === 'max' && supportsMax ? 'max' : cappedEffortLevel(effort, supportsXhigh);

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
