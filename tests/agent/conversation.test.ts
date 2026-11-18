import { describe, expect, test } from 'bun:test';
import { Conversation, INTERRUPTED_RESULT } from '../../src/agent/conversation.ts';
import { emptySummary } from '../../src/context/compaction.ts';
import type { ProviderContentBlock } from '../../src/providers/types.ts';

describe('Conversation', () => {
  test('a new prompt answers tool calls left without results', () => {
    const c = new Conversation();
    c.appendUser('first');
    c.appendAssistant([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]);
    c.appendUser('second');
    const last = c.messages().at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        name: 'bash',
        content: INTERRUPTED_RESULT,
        is_error: true,
      },
      { type: 'text', text: 'second' },
    ]);
  });

  test('a prompt after an unanswered user message joins it to keep roles alternating', () => {
    const c = new Conversation();
    c.appendUser('first');
    c.appendUser('second');
    expect(c.messages()).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    ]);
  });

  test('empty assistant turns and empty result lists are not stored', () => {
    const c = new Conversation();
    c.appendUser('hi');
    c.appendAssistant([]);
    c.appendToolResults([]);
    expect(c.length).toBe(1);
  });

  test('unanswered tool uses are only reported while the assistant message is last', () => {
    const c = new Conversation();
    c.appendUser('go');
    c.appendAssistant([{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }]);
    expect(c.unansweredToolUses().map((t) => t.id)).toEqual(['t1']);
    c.appendToolResults([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
    expect(c.unansweredToolUses()).toEqual([]);
  });

  test('clear discards the history', () => {
    const c = new Conversation();
    c.appendUser('hi');
    c.clear();
    expect(c.messages()).toEqual([]);
  });
});

describe('dropStaleReasoning', () => {
  const thinking = (id: string): ProviderContentBlock => ({
    type: 'reasoning',
    provider: 'anthropic',
    data: { thinking: id, signature: `sig-${id}` },
  });

  // A conversation whose reasoning was produced by requests with prefix P.
  const withReasoning = (): Conversation => {
    const c = new Conversation();
    c.appendUser('task');
    c.dropStaleReasoning('P', true);
    c.appendAssistant([
      thinking('r1'),
      { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
    ]);
    c.appendToolResults([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
    c.dropStaleReasoning('P', true);
    c.appendAssistant([thinking('r2'), { type: 'text', text: 'done' }]);
    return c;
  };

  const reasoningCount = (c: Conversation): number =>
    c
      .messages()
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .filter((b) => b.type === 'reasoning').length;

  test('reasoning produced under the same prefix is kept', () => {
    const c = withReasoning();
    const revision = c.revision;
    c.dropStaleReasoning('P', true);
    expect(reasoningCount(c)).toBe(2);
    expect(c.revision).toBe(revision);
  });

  test('a new prefix removes every reasoning block and keeps the rest of each message', () => {
    const c = withReasoning();
    const revision = c.revision;
    c.dropStaleReasoning('Q', true);
    expect(c.messages()).toEqual([
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]);
    expect(c.revision).toBeGreaterThan(revision);
  });

  test('a provider that does not bind reasoning keeps it, and a later one that does removes it', () => {
    const c = withReasoning();
    c.dropStaleReasoning('Q', false);
    expect(reasoningCount(c)).toBe(2);
    // Blocks produced under P and Q are now mixed, so returning to P does not make them valid.
    c.dropStaleReasoning('P', true);
    expect(reasoningCount(c)).toBe(0);
  });

  test('after a compaction or a restore, reasoning is removed even under the same prefix', () => {
    const compacted = withReasoning();
    compacted.replaceAfterCompaction([...compacted.messages()], emptySummary());
    compacted.dropStaleReasoning('P', true);
    expect(reasoningCount(compacted)).toBe(0);

    const restored = new Conversation();
    restored.restore(withReasoning().snapshot());
    restored.dropStaleReasoning('P', true);
    expect(reasoningCount(restored)).toBe(0);
  });

  test('a history without reasoning is left as it is and takes the new prefix', () => {
    const c = new Conversation();
    c.appendUser('task');
    const revision = c.revision;
    c.dropStaleReasoning('P', true);
    expect(c.revision).toBe(revision);
    c.appendAssistant([thinking('r1'), { type: 'text', text: 'done' }]);
    c.dropStaleReasoning('P', true);
    expect(reasoningCount(c)).toBe(1);
  });
});
