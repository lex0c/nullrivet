import { describe, expect, test } from 'bun:test';
import {
  anthropicEffort,
  cappedEffortLevel,
  EFFORT_THINKING_BUDGET,
  effortThinkingBudget,
  OPENAI_REASONING_EFFORT,
  openaiEffortLevel,
} from '../../src/providers/effort.ts';
import type { ProviderEffort } from '../../src/providers/types.ts';

const LEVELS: ProviderEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('anthropicEffort', () => {
  test('clamps xhigh → high when the model does not expose it', () => {
    expect(anthropicEffort('xhigh', false)).toBe('high');
  });

  test('passes xhigh through when supported (Opus 4.7/4.8)', () => {
    expect(anthropicEffort('xhigh', true)).toBe('xhigh');
  });

  test('every other level is identity, regardless of xhigh support', () => {
    for (const e of ['low', 'medium', 'high', 'max'] as ProviderEffort[]) {
      expect(anthropicEffort(e, false)).toBe(e);
      expect(anthropicEffort(e, true)).toBe(e);
    }
  });
});

describe('openaiEffortLevel', () => {
  test('levels up to the model top one are 1:1, and higher ones become the top one', () => {
    const top = (xhigh: boolean, max: boolean) =>
      LEVELS.map((level) => openaiEffortLevel(level, xhigh, max));
    expect(top(true, true)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(top(true, false)).toEqual(['low', 'medium', 'high', 'xhigh', 'xhigh']);
    expect(top(false, false)).toEqual(['low', 'medium', 'high', 'high', 'high']);
  });
});

describe('OPENAI_REASONING_EFFORT', () => {
  test('low/medium/high/xhigh are 1:1; max also maps to xhigh (OpenRouter tops at xhigh)', () => {
    expect(OPENAI_REASONING_EFFORT.low).toBe('low');
    expect(OPENAI_REASONING_EFFORT.medium).toBe('medium');
    expect(OPENAI_REASONING_EFFORT.high).toBe('high');
    expect(OPENAI_REASONING_EFFORT.xhigh).toBe('xhigh');
    expect(OPENAI_REASONING_EFFORT.max).toBe('xhigh');
  });
});

describe('cappedEffortLevel', () => {
  test('low/medium/high are 1:1 regardless of xhigh support', () => {
    for (const e of ['low', 'medium', 'high'] as const) {
      expect(cappedEffortLevel(e, false)).toBe(e);
      expect(cappedEffortLevel(e, true)).toBe(e);
    }
  });

  test('xhigh and max clamp to high when the model does not accept xhigh', () => {
    expect(cappedEffortLevel('xhigh', false)).toBe('high');
    expect(cappedEffortLevel('max', false)).toBe('high');
  });

  test('xhigh passes through and max maps to xhigh when the model accepts xhigh', () => {
    expect(cappedEffortLevel('xhigh', true)).toBe('xhigh');
    expect(cappedEffortLevel('max', true)).toBe('xhigh');
  });
});

describe('EFFORT_THINKING_BUDGET', () => {
  test('monotonic and capped at the smallest numeric ceiling we ship', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(EFFORT_THINKING_BUDGET[LEVELS[i] as ProviderEffort]).toBeGreaterThan(
        EFFORT_THINKING_BUDGET[LEVELS[i - 1] as ProviderEffort],
      );
    }
    // `max` equals Gemini 2.5 Flash's thinking ceiling, so one ladder fits every numeric provider.
    expect(EFFORT_THINKING_BUDGET.max).toBeLessThanOrEqual(24_576);
  });
});

describe('effortThinkingBudget', () => {
  test('returns the ladder value when max_tokens has headroom', () => {
    expect(effortThinkingBudget('medium', 100_000)).toBe(EFFORT_THINKING_BUDGET.medium);
  });

  test('clamps to strictly below max_tokens', () => {
    expect(effortThinkingBudget('max', 1_000)).toBe(999);
  });

  test('returns undefined when there is no headroom (API rejects budget >= max_tokens)', () => {
    expect(effortThinkingBudget('low', 1)).toBeUndefined();
    expect(effortThinkingBudget('low', 0)).toBeUndefined();
  });

  test('returns undefined when headroom is below the model thinking floor (Gemini Pro ≥128)', () => {
    // A ceiling of 99 is below MIN_THINKING_BUDGET (128), so the budget is omitted.
    expect(effortThinkingBudget('low', 100)).toBeUndefined();
    expect(effortThinkingBudget('low', 200)).toBe(199);
  });
});
