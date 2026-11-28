import type { AgentEndReason } from '../agent/events.ts';

export const EXIT_CODES: Record<AgentEndReason | 'usage', number> = {
  done: 0,
  error: 1,
  usage: 2,
  budget: 3,
  aborted: 130,
};

// What --verify-evidence exits with: apart from the codes above, so that a script tells an
// incomplete log from a mistyped option.
export const EVIDENCE_EXIT_CODES = { complete: 0, corrupted: 1, incomplete: 4 } as const;
