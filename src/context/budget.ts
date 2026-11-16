import type { ProviderCapabilities } from '../providers/types.ts';

// Room kept free for estimation error between the prompt and the answer.
const SAFETY_MARGIN_TOKENS = 4_096;
const TRIGGER_RATIO = 0.7;
const MAX_KEEP_RECENT_TOKENS = 20_000;
const KEEP_RECENT_RATIO = 0.25;
const TARGET_RATIO = 0.6;
const OUTPUT_RATIO = 0.25;

export interface ContextBudget {
  window: number;
  // Output tokens requested at most; a quarter of the window so the prompt keeps most of it.
  maxOutput: number;
  // Tokens kept free for the answer and estimation error.
  reserve: number;
  // Above this estimated prompt size the conversation is compacted before the next request.
  trigger: number;
  // Recent conversation kept verbatim when compacting.
  keepRecent: number;
  // Size a compaction aims for, well below the trigger, so compactions do not follow each other
  // every few turns (each one invalidates the provider's prompt cache).
  target: number;
}

// Two rules bound the trigger: the ratio keeps large windows from filling with costly, degraded
// context, and the reserve keeps room for the answer when the output limit is large relative to
// the window.
export const contextBudget = (caps: ProviderCapabilities): ContextBudget => {
  const window = caps.context_window;
  const maxOutput = Math.min(caps.output_max_tokens, Math.floor(window * OUTPUT_RATIO));
  const reserve = maxOutput + SAFETY_MARGIN_TOKENS;
  const trigger = Math.max(0, Math.min(Math.floor(window * TRIGGER_RATIO), window - reserve));
  return {
    window,
    maxOutput,
    reserve,
    trigger,
    keepRecent: Math.min(MAX_KEEP_RECENT_TOKENS, Math.floor(window * KEEP_RECENT_RATIO)),
    target: Math.floor(trigger * TARGET_RATIO),
  };
};
