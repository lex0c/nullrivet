import { estimateMessagesTokens, estimatePromptTokens } from '../context/tokens.ts';
import type {
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  ProviderToolResultBlock,
  ProviderToolUseBlock,
} from '../providers/types.ts';
import { contentBlocks } from '../providers/types.ts';
import { FENCE, fenced } from '../sanitize/fence.ts';

export const INTERRUPTED_RESULT = '[interrupted: the tool call did not complete]';

// The character estimate overestimates by 10-25% for English and underestimates dense text; a
// reported prompt below half of it is treated as incomplete.
const MIN_TRUSTED_USAGE_RATIO = 0.5;

// Text the agent adds to a user message on its own (feedback about rejected tool calls, notes
// after a compaction). The tag tells it apart from what the user typed.
export const AGENT_NOTE_OPEN = '<agent-note>';
export const agentNote = (text: string): string => `${AGENT_NOTE_OPEN}${text}</agent-note>`;

// Text the user supplied as material for a prompt (piped on stdin), kept in its own block after
// the prompt and fenced as data. The fence value is known only to this process, so a block that
// starts with it was made here.
const PIPED_INPUT_TAG = 'stdin';
const PIPED_INPUT_OPEN = `<${PIPED_INPUT_TAG} fence="${FENCE}">`;
export const isPipedInput = (text: string): boolean => text.startsWith(PIPED_INPUT_OPEN);

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
  // Sent at the start of the first user message; see TurnDependencies.projectContext.
  context: string;
  tools: readonly ProviderToolDef[];
  countReasoning: boolean;
}

// What a request carries besides the history, in the form the token estimate takes.
export const requestOverhead = (shape: PromptShape) => ({
  system: shape.system,
  context: shape.context,
  tools: shape.tools,
  countReasoning: shape.countReasoning,
});

interface MeasurementAnchor {
  tokens: number;
  messages: number;
  key: string;
}

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

  // `input` is material the prompt refers to, such as piped stdin; it is added as data.
  appendUser(text: string, input?: string): void {
    const repairs = this.unansweredToolUses().map(interruptedResult);
    const added: ProviderContentBlock[] = [{ type: 'text', text }];
    if (input !== undefined && input.length > 0) {
      added.push({ type: 'text', text: fenced(PIPED_INPUT_TAG, input) });
    }
    const last = this.history.at(-1);
    if (last?.role === 'user') {
      // A turn that ended before the assistant answered (an abort or a provider error) leaves a
      // user message last; the new prompt joins it to keep roles alternating.
      this.history[this.history.length - 1] = {
        role: 'user',
        content: [...contentBlocks(last.content), ...added],
      };
      return;
    }
    this.history.push({
      role: 'user',
      content: repairs.length === 0 && added.length === 1 ? text : [...repairs, ...added],
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

  // Records the prompt size the provider reported for the request just made, before its answer
  // is appended. Later estimates start from it and only approximate what was appended since; the
  // answer itself is estimated from its text, so output the provider never receives back (such as
  // reasoning that is not replayed) does not inflate the measurement.
  //
  // A report far below the character estimate is not a measurement of the whole prompt: some
  // servers count only the tokens they did not reuse from their cache. It is ignored, and the
  // estimate stays in use.
  recordPromptUsage(promptTokens: number, shape: PromptShape): void {
    const estimated = estimatePromptTokens(this.history, requestOverhead(shape));
    this.anchor =
      promptTokens >= estimated * MIN_TRUSTED_USAGE_RATIO
        ? { tokens: promptTokens, messages: this.history.length, key: shape.key }
        : null;
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
    return estimatePromptTokens(this.history, requestOverhead(shape));
  }

  // Replaces the history with its compacted form. The measurement no longer describes it.
  replaceAfterCompaction(history: ProviderMessage[], summary: SummaryState): void {
    this.history = history;
    this.summaryState = summary;
    this.anchor = null;
  }
}
