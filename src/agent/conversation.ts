import type {
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolResultBlock,
  ProviderToolUseBlock,
} from '../providers/types.ts';

export const INTERRUPTED_RESULT = '[interrupted: the tool call did not complete]';

export const interruptedResult = (toolUse: ProviderToolUseBlock): ProviderToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: toolUse.id,
  name: toolUse.name,
  content: INTERRUPTED_RESULT,
  is_error: true,
});

// Conversation history held only in memory. Every append keeps the invariants the provider APIs
// require: roles alternate, every tool_use is answered by a tool_result in the next message, and
// no message is empty.
export class Conversation {
  private history: ProviderMessage[] = [];

  messages(): readonly ProviderMessage[] {
    return this.history;
  }

  get length(): number {
    return this.history.length;
  }

  clear(): void {
    this.history = [];
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
}

const toBlocks = (content: string | ProviderContentBlock[]): ProviderContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;
