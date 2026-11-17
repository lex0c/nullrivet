export type AgentEndReason = 'done' | 'aborted' | 'error' | 'budget';

export type CompactReason = 'auto' | 'manual' | 'overflow';

export type CompactStrategy = 'llm' | 'fallback';

export type SubagentStatus = 'completed' | 'failed' | 'cancelled' | 'budget';

// Public event contract of the agent core. The TUI, the NDJSON output and library consumers
// all observe the agent exclusively through these events.
export type AgentEvent =
  | { type: 'agent:start' }
  | { type: 'agent:end'; reason: AgentEndReason; message?: string }
  | { type: 'text:delta'; text: string }
  | { type: 'thinking:delta'; text: string }
  // `step` counts the model requests of the turn that produced a response, retries excluded.
  | { type: 'tool:start'; id: string; name: string; args: Record<string, unknown>; step: number }
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
      // Set for the requests that summarize the conversation, which do not reflect its size.
      compaction?: true;
      // Set for requests made by a subagent: its id, as in the subagent events.
      subagent?: string;
    }
  // A background subagent began to run. `id` is given by the subagent registry and named in the
  // delegate result; it is not the id of the delegate call.
  | { type: 'subagent:start'; id: string; title: string }
  | {
      type: 'subagent:progress';
      id: string;
      step: number;
      tool: { name: string; args: Record<string, unknown> };
    }
  | { type: 'subagent:end'; id: string; status: SubagentStatus; steps: number }
  // A runtime notice added to the conversation for the model, such as a background job that ended.
  | { type: 'notice'; text: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string };

export type AgentEventListener = (event: AgentEvent) => void;

// Background work in progress, as the interface shows it: jobs running, and subagents running or
// waiting for a slot.
export interface BackgroundWork {
  jobs: number;
  subagents: number;
  queuedSubagents: number;
}

// A source of background events, such as finished jobs or subagents, that waits for the agent to
// show them to the model. The agent picks a batch from every source and confirms only the events it
// picked, so an event left out of a batch stays pending.
export interface PendingEventSource<T> {
  // Oldest first; reading them does not deliver them.
  pendingEvents(): readonly T[];
  markDelivered(events: readonly T[]): void;
}
