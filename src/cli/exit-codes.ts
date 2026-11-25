import type { AgentEndReason } from '../agent/events.ts';

export const EXIT_CODES: Record<AgentEndReason | 'usage', number> = {
  done: 0,
  error: 1,
  usage: 2,
  budget: 3,
  aborted: 130,
};
