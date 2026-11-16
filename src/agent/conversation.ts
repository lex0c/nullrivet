import { estimateMessagesTokens, estimatePromptTokens } from '../context/tokens.ts';
import type {
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  ProviderToolResultBlock,
  ProviderToolUseBlock,
} from '../providers/types.ts';

export const INTERRUPTED_RESULT = '[interrupted: the tool call did not complete]';

// Text the agent adds to a user message on its own (feedback about rejected tool calls, notes
// after a compaction). The tag tells it apart from what the user typed.
export const AGENT_NOTE_OPEN = '<agent-note>';
export const agentNote = (text: string): string => `${AGENT_NOTE_OPEN}${text}</agent-note>`;

export const interruptedResult = (toolUse: ProviderToolUseBlock): ProviderToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: toolUse.id,
  name: toolUse.name,
  content: INTERRUPTED_RESULT,
  is_error: true,
});

// What earlier compactions preserved, kept as data so a later compaction updates it instead of
// parsing it back out of the message text.
export interface SummaryState {
  llmSummary: string;
  userRequests: string[];
  // Oldest requests dropped to keep the list within its size limit.
  omittedRequests: number;
  filesRead: string[];
  filesModified: string[];
}

export interface PromptShape {
  // Identifies what precedes the messages in a request (provider, system prompt, tools). The
  // measured usage only describes requests with the same shape.
  key: string;
  system: string;
  tools: readonly ProviderToolDef[];
  countReasoning: boolean;
}

interface MeasurementAnchor {
  tokens: number;
  messages: number;
  key: string;
}

const toBlocks = (content: string | ProviderContentBlock[]): ProviderContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;

// Conversation history held only in memory. Every append keeps the invariants the provider APIs
// require: roles alternate, every tool_use is answered by a tool_result in the next message, and
// no message is empty.
export class Conversation {
  private history: ProviderMessage[] = [];
  private anchor: MeasurementAnchor | null = null;
  private summaryState: SummaryState | null = null;

  messages(): readonly ProviderMessage[] {
    return this.history;
  }

  get length(): number {
    return this.history.length;
  }

  // Set once the conversation has been compacted; the first message then starts with the
  // rendered summary as its first block.
  summary(): SummaryState | null {
    return this.summaryState;
  }

  clear(): void {
    this.history = [];
    this.anchor = null;
    this.summaryState = null;
  }

  appendUser(text: string): void {
    const repairs = this.unansweredToolUses().map(interruptedResult);
    const last = this.history.at(-1);
    if (last?.role === 'user') {
      // A turn that ended before the assistant answered (an abort or a provider error) leaves a
      // user message last; the new prompt joins it to keep roles alternating.
      this.history[this.history.length - 1] = {
        role: 'user',
        content: [...toBlocks(last.content), { type: 'text', text }],
      };
      return;
    }
    this.history.push({
      role: 'user',
      content: repairs.length === 0 ? text : [...repairs, { type: 'text', text }],
    });
  }

  appendAssistant(blocks: readonly ProviderContentBlock[]): void {
    if (blocks.length === 0) return;
    this.history.push({ role: 'assistant', content: [...blocks] });
  }

  appendToolResults(results: readonly ProviderToolResultBlock[]): void {
    if (results.length === 0) return;
    this.history.push({ role: 'user', content: [...results] });
  }

  // tool_use blocks of the last message when it is an assistant message, which means no results
  // were appended for them yet.
  unansweredToolUses(): ProviderToolUseBlock[] {
    const last = this.history.at(-1);
    if (last?.role !== 'assistant' || typeof last.content === 'string') return [];
    return last.content.filter((b): b is ProviderToolUseBlock => b.type === 'tool_use');
  }

  // Records the size the provider reported for the last request (prompt plus answer). Later
  // estimates start from it and only approximate what was appended since.
  recordUsage(tokens: number, shape: PromptShape): void {
    this.anchor = { tokens, messages: this.history.length, key: shape.key };
  }

  // Estimated prompt size of the next request with this shape.
  estimateTokens(shape: PromptShape): number {
    const anchor = this.anchor;
    if (anchor !== null && anchor.key === shape.key && anchor.messages <= this.history.length) {
      return (
        anchor.tokens +
        estimateMessagesTokens(this.history.slice(anchor.messages), {
          countReasoning: shape.countReasoning,
        })
      );
    }
    return estimatePromptTokens(this.history, {
      system: shape.system,
      tools: shape.tools,
      countReasoning: shape.countReasoning,
    });
  }

  // Replaces the history with its compacted form. The measurement no longer describes it.
  replaceAfterCompaction(history: ProviderMessage[], summary: SummaryState): void {
    this.history = history;
    this.summaryState = summary;
    this.anchor = null;
  }
}
