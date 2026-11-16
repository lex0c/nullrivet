import type { ExecutionMode } from '../tools/policy.ts';

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
      // Set for requests made by a subagent: the id of the delegate call that started it.
      subagent?: string;
    }
  // A subagent started by a delegate call; `id` is the id of that call.
  | { type: 'subagent:start'; id: string; title: string; mode: ExecutionMode }
  | {
      type: 'subagent:progress';
      id: string;
      step: number;
      tool: { name: string; args: Record<string, unknown> };
    }
  | { type: 'subagent:end'; id: string; status: SubagentStatus; steps: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string };

export type AgentEventListener = (event: AgentEvent) => void;
