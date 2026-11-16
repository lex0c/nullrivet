export type AgentEndReason = 'done' | 'aborted' | 'error' | 'budget';

export type CompactReason = 'auto' | 'manual' | 'overflow';

export type CompactStrategy = 'llm' | 'fallback';

// Public event contract of the agent core. The TUI, the NDJSON output and library consumers
// all observe the agent exclusively through these events.
export type AgentEvent =
  | { type: 'agent:start' }
  | { type: 'agent:end'; reason: AgentEndReason; message?: string }
  | { type: 'text:delta'; text: string }
  | { type: 'thinking:delta'; text: string }
  | { type: 'tool:start'; id: string; name: string; args: Record<string, unknown> }
  | {
      type: 'tool:end';
      id: string;
      name: string;
      content: string;
      isError: boolean;
      meta?: Record<string, unknown>;
    }
  | { type: 'context:compact:start'; reason: CompactReason }
  | {
      type: 'context:compact';
      reason: CompactReason;
      strategy: CompactStrategy;
      before: number;
      after: number;
    }
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reportedCostUsd?: number;
    }
  | { type: 'error'; message: string };

export type AgentEventListener = (event: AgentEvent) => void;
