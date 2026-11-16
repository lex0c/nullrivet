import { describe, expect, test } from 'bun:test';
import { Conversation, INTERRUPTED_RESULT } from '../../src/agent/conversation.ts';

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
