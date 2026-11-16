import type { AgentEndReason, AgentEvent } from '../agent/events.ts';
import type { ExecutionMode } from '../tools/policy.ts';
import type { InputState } from './input-editor.ts';
import { splitSettledMarkdown } from './markdown-stream.ts';

export type NoticeLevel = 'info' | 'warning' | 'error';

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

export interface StatusState {
  model: string;
  mode: ExecutionMode;
  effort: string | undefined;
  cwd: string;
  home: string;
  contextWindow: number;
  // Tokens of the last request (prompt plus answer) as reported by the provider; null until a
  // request reports usage, and again after the conversation is cleared.
  contextTokens: number | null;
  totals: UsageTotals;
}

export interface ActiveTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
}

export interface TurnState {
  startedAt: number;
  // Assistant markdown received but not settled yet; it is drawn in the live region.
  pendingText: string;
  // Set while the model streams reasoning before producing text or tool calls.
  thinkingSince: number | null;
  // Characters of text received in this turn, shown as a progress hint.
  outputChars: number;
  tools: ActiveTool[];
  interrupting: boolean;
}

export interface SlashMenu {
  items: { name: string; description: string }[];
  selected: number;
  // Argument hint of the command typed so far, e.g. "[auto|readonly]".
  hint?: string;
}

export interface TuiState {
  input: InputState;
  slash: SlashMenu | null;
  status: StatusState;
  turn: TurnState | null;
  // When Ctrl+C was pressed on an empty, idle prompt; a second press before it expires exits.
  exitArmedAt: number | null;
}

// Items written once to the scrollback, above the live region.
export type PermanentItem =
  | {
      kind: 'banner';
      version: string;
      model: string;
      mode: ExecutionMode;
      effort: string | undefined;
      cwd: string;
      home: string;
      instructions: number;
    }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; markdown: string }
  | {
      kind: 'tool';
      name: string;
      args: Record<string, unknown>;
      isError: boolean;
      content: string;
      meta: Record<string, unknown> | undefined;
      durationMs: number;
    }
  | { kind: 'turn-end'; reason: AgentEndReason; message: string | undefined; durationMs: number }
  | { kind: 'notice'; level: NoticeLevel; text: string };

export type Action =
  | { type: 'input'; input: InputState }
  | { type: 'slash'; menu: SlashMenu | null }
  | { type: 'submit'; text: string }
  | { type: 'agent'; event: AgentEvent; now: number }
  | { type: 'status'; patch: Partial<Omit<StatusState, 'totals'>> }
  | { type: 'notice'; level: NoticeLevel; text: string }
  | { type: 'interrupting' }
  | { type: 'exit-arm'; now: number }
  | { type: 'exit-disarm' };

export interface Reduction {
  state: TuiState;
  permanent: PermanentItem[];
}

export const emptyTotals = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
});

export const createInitialState = (
  status: Omit<StatusState, 'totals' | 'contextTokens'>,
): TuiState => ({
  input: { value: '', cursor: 0 },
  slash: null,
  status: { ...status, contextTokens: null, totals: emptyTotals() },
  turn: null,
  exitArmedAt: null,
});

const assistantItem = (markdown: string): PermanentItem[] =>
  markdown.trim().length === 0 ? [] : [{ kind: 'assistant', markdown: markdown.trimEnd() }];

const reduceAgentEvent = (state: TuiState, event: AgentEvent, now: number): Reduction => {
  const turn = state.turn;
  switch (event.type) {
    case 'agent:start':
      return {
        state: {
          ...state,
          turn: {
            startedAt: now,
            pendingText: '',
            thinkingSince: null,
            outputChars: 0,
            tools: [],
            interrupting: false,
          },
        },
        permanent: [],
      };
    case 'thinking:delta': {
      if (turn === null || turn.thinkingSince !== null || turn.pendingText.length > 0) {
        return { state, permanent: [] };
      }
      return { state: { ...state, turn: { ...turn, thinkingSince: now } }, permanent: [] };
    }
    case 'text:delta': {
      if (turn === null) return { state, permanent: [] };
      const { settled, pending } = splitSettledMarkdown(turn.pendingText + event.text);
      return {
        state: {
          ...state,
          turn: {
            ...turn,
            pendingText: pending,
            thinkingSince: null,
            outputChars: turn.outputChars + event.text.length,
          },
        },
        permanent: assistantItem(settled),
      };
    }
    case 'tool:start': {
      if (turn === null) return { state, permanent: [] };
      // Text written before a tool call is complete, so it is settled before the tool appears.
      return {
        state: {
          ...state,
          turn: {
            ...turn,
            pendingText: '',
            thinkingSince: null,
            tools: [
              ...turn.tools,
              { id: event.id, name: event.name, args: event.args, startedAt: now },
            ],
          },
        },
        permanent: assistantItem(turn.pendingText),
      };
    }
    case 'tool:end': {
      if (turn === null) return { state, permanent: [] };
      const tool = turn.tools.find((t) => t.id === event.id);
      return {
        state: { ...state, turn: { ...turn, tools: turn.tools.filter((t) => t.id !== event.id) } },
        permanent: [
          {
            kind: 'tool',
            name: event.name,
            args: tool?.args ?? {},
            isError: event.isError,
            content: event.content,
            meta: event.meta,
            durationMs: tool === undefined ? 0 : now - tool.startedAt,
          },
        ],
      };
    }
    case 'usage': {
      const totals = state.status.totals;
      return {
        state: {
          ...state,
          status: {
            ...state.status,
            contextTokens: event.input + event.cacheRead + event.cacheWrite + event.output,
            totals: {
              input: totals.input + event.input,
              output: totals.output + event.output,
              cacheRead: totals.cacheRead + event.cacheRead,
              cacheWrite: totals.cacheWrite + event.cacheWrite,
              requests: totals.requests + 1,
            },
          },
        },
        permanent: [],
      };
    }
    case 'warning':
      return { state, permanent: [{ kind: 'notice', level: 'warning', text: event.message }] };
    case 'error':
      return { state, permanent: [{ kind: 'notice', level: 'error', text: event.message }] };
    case 'context:compact:start':
    case 'context:compact':
      return { state, permanent: [] };
    case 'agent:end': {
      if (turn === null) return { state, permanent: [] };
      return {
        state: { ...state, turn: null },
        permanent: [
          ...assistantItem(turn.pendingText),
          {
            kind: 'turn-end',
            reason: event.reason,
            message: event.message,
            durationMs: now - turn.startedAt,
          },
        ],
      };
    }
  }
};

export const reduce = (state: TuiState, action: Action): Reduction => {
  switch (action.type) {
    case 'input':
      return { state: { ...state, input: action.input, exitArmedAt: null }, permanent: [] };
    case 'slash':
      return { state: { ...state, slash: action.menu }, permanent: [] };
    case 'submit':
      return {
        state: { ...state, input: { value: '', cursor: 0 }, slash: null, exitArmedAt: null },
        permanent: [{ kind: 'user', text: action.text }],
      };
    case 'agent':
      return reduceAgentEvent(state, action.event, action.now);
    case 'status':
      return { state: { ...state, status: { ...state.status, ...action.patch } }, permanent: [] };
    case 'notice':
      return { state, permanent: [{ kind: 'notice', level: action.level, text: action.text }] };
    case 'interrupting':
      return state.turn === null
        ? { state, permanent: [] }
        : { state: { ...state, turn: { ...state.turn, interrupting: true } }, permanent: [] };
    case 'exit-arm':
      return { state: { ...state, exitArmedAt: action.now }, permanent: [] };
    case 'exit-disarm':
      return { state: { ...state, exitArmedAt: null }, permanent: [] };
  }
};
