import { describe, expect, test } from 'bun:test';
import { Conversation } from '../../src/agent/conversation.ts';
import { parseConversationSnapshot } from '../../src/agent/snapshot.ts';
import { assembleHistory, emptySummary } from '../../src/context/compaction.ts';
import type { ProviderMessage } from '../../src/providers/types.ts';

const toolStep = (): Conversation => {
  const c = new Conversation();
  c.appendUser('fix it');
  c.appendAssistant([
    { type: 'reasoning', provider: 'anthropic', data: { thinking: 't', signature: 's' } },
    { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
  ]);
  c.appendToolResults([
    { type: 'tool_result', tool_use_id: 't1', name: 'read_file', content: 'x' },
  ]);
  c.appendAssistant([{ type: 'text', text: 'done' }]);
  return c;
};

const parse = (value: unknown) => parseConversationSnapshot(JSON.parse(JSON.stringify(value)));

describe('conversation snapshot', () => {
  test('a snapshot written out and read back restores the same conversation', () => {
    const original = toolStep();
    const parsed = parse(original.snapshot());
    expect(parsed.ok).toBe(true);
    const restored = new Conversation();
    if (parsed.ok) restored.restore(parsed.snapshot);
    expect(restored.messages()).toEqual(original.messages());
    expect(restored.summary()).toBeNull();
  });

  test('a compacted conversation keeps its summary state', () => {
    const c = new Conversation();
    const summary = { ...emptySummary(), llmSummary: 'GOAL:\nx', userRequests: ['fix it'] };
    c.replaceAfterCompaction(
      assembleHistory(summary, [{ role: 'user', content: 'next' }]),
      summary,
    );
    const parsed = parse(c.snapshot());
    expect(parsed.ok && parsed.snapshot.summary).toEqual(summary);
  });

  test('a snapshot is a copy that later changes do not affect', () => {
    const c = toolStep();
    const snapshot = c.snapshot();
    c.appendUser('more');
    expect(snapshot.messages).toHaveLength(4);
  });

  test('calls left unanswered by an interrupted turn are accepted at the end', () => {
    const c = new Conversation();
    c.appendUser('go');
    c.appendAssistant([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }]);
    expect(parse(c.snapshot()).ok).toBe(true);
  });

  test('fields that are not part of the history are dropped', () => {
    const parsed = parse({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cacheBreakpoint: true, extra: 1 }] },
      ],
      summary: null,
    });
    expect(parsed.ok && parsed.snapshot.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  test('histories the agent could not have produced are refused', () => {
    const cases: [string, ProviderMessage[], string][] = [
      ['starts with the assistant', [{ role: 'assistant', content: 'hi' }], 'start with a user'],
      [
        'repeats a role',
        [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
        ],
        'repeats the role',
      ],
      [
        'answers a call nobody made',
        [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] },
        ],
        'did not make',
      ],
      [
        'leaves a call unanswered in the middle',
        [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'bash', input: {} }] },
          { role: 'user', content: 'next' },
          { role: 'assistant', content: 'b' },
        ],
        'does not answer',
      ],
      [
        'puts a tool call in a user message',
        [{ role: 'user', content: [{ type: 'tool_use', id: 't', name: 'bash', input: {} }] }],
        'outside an assistant',
      ],
    ];
    for (const [name, messages, error] of cases) {
      const parsed = parse({ messages, summary: null });
      expect({ name, ok: parsed.ok }).toEqual({ name, ok: false });
      if (!parsed.ok) expect(parsed.error).toContain(error);
    }
  });

  test('the mode of the last request is kept, and absent from older files', () => {
    const c = toolStep();
    c.setRequestMode('readonly');
    const parsed = parse(c.snapshot());
    expect(parsed.ok && parsed.snapshot.requestMode).toBe('readonly');
    const older = parse({ messages: [{ role: 'user', content: 'hi' }], summary: null });
    expect(older.ok && older.snapshot.requestMode).toBeNull();
    const invalid = parse({ ...c.snapshot(), requestMode: 'root' });
    expect(invalid.ok ? 'ok' : invalid.error).toContain('requestMode');
  });

  test('unknown block types, providers and malformed summaries are refused', () => {
    const user = (content: unknown) => ({ messages: [{ role: 'user', content }], summary: null });
    expect(parse(user([{ type: 'image', data: 'x' }])).ok).toBe(false);
    expect(parse(user([{ type: 'reasoning', provider: 'other', data: {} }])).ok).toBe(false);
    expect(parse(user([])).ok).toBe(false);
    expect(
      parse({ messages: [{ role: 'user', content: 'hi' }], summary: { llmSummary: 'x' } }).ok,
    ).toBe(false);
    // A summary needs the summary block at the head of the history.
    const summary = { ...emptySummary(), llmSummary: 'GOAL:\nx' };
    expect(parse({ messages: [{ role: 'user', content: 'hi' }], summary }).ok).toBe(false);
  });
});
