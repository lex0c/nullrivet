import { describe, expect, test } from 'bun:test';
import { buildAssistantContent } from '../../src/agent/assistant-content.ts';
import type { CollectedBlock, CollectedToolUse } from '../../src/agent/collect.ts';
import type { ProviderReasoningBlock } from '../../src/providers/types.ts';

const reasoning = (data: unknown): ProviderReasoningBlock => ({
  type: 'reasoning',
  provider: 'anthropic',
  data,
});

const r = (block: ProviderReasoningBlock): CollectedBlock => ({
  kind: 'reasoning',
  reasoning: block,
});
const t = (text: string): CollectedBlock => ({ kind: 'text', text });
const tu = (toolUse: CollectedToolUse): CollectedBlock => ({ kind: 'tool_use', toolUse });

describe('buildAssistantContent', () => {
  test('keeps emission order', () => {
    const out = buildAssistantContent({
      order: [
        r(reasoning({ thinking: 't', signature: 's' })),
        t('hello'),
        tu({ id: 'c1', name: 'read', input: { path: '/x' } }),
      ],
    });
    expect(out.map((b) => b.type)).toEqual(['reasoning', 'text', 'tool_use']);
  });

  test('keeps thinking interleaved with tool_use (thinking1, tool1, thinking2, tool2)', () => {
    // Anthropic rejects replayed thinking blocks that were regrouped ahead of the tool calls.
    const r1 = reasoning({ thinking: 't1', signature: 's1' });
    const r2 = reasoning({ thinking: 't2', signature: 's2' });
    const out = buildAssistantContent({
      order: [
        r(r1),
        tu({ id: 'c1', name: 'read', input: { p: '/a' } }),
        r(r2),
        tu({ id: 'c2', name: 'read', input: { p: '/b' } }),
      ],
    });
    expect(out.map((b) => b.type)).toEqual(['reasoning', 'tool_use', 'reasoning', 'tool_use']);
    expect((out[0] as { data: unknown }).data).toBe(r1.data);
    expect((out[2] as { data: unknown }).data).toBe(r2.data);
  });

  test('omits a turn that has only reasoning', () => {
    // Once a non-replaying adapter drops the block, the message would be sent with empty content.
    const out = buildAssistantContent({ order: [r(reasoning({ thinking: 't', signature: 's' }))] });
    expect(out).toEqual([]);
  });

  test('keeps reasoning when accompanied by a tool_use without text', () => {
    const out = buildAssistantContent({
      order: [
        r(reasoning({ thinking: 't', signature: 's' })),
        tu({ id: 'c1', name: 'read', input: { path: '/x' } }),
      ],
    });
    expect(out.map((b) => b.type)).toEqual(['reasoning', 'tool_use']);
  });

  test('carries reasoning data verbatim', () => {
    const data = { z: 1, a: 2, signature: 'sig' };
    const out = buildAssistantContent({ order: [r(reasoning(data)), t('x')] });
    expect((out[0] as { data: unknown }).data).toBe(data);
  });

  test('canonicalizes tool_use input keys', () => {
    const out = buildAssistantContent({
      order: [t('x'), tu({ id: 'c1', name: 'read', input: { b: 1, a: 2 } })],
    });
    const block = out.find((b) => b.type === 'tool_use') as { input: Record<string, unknown> };
    expect(Object.keys(block.input)).toEqual(['a', 'b']);
  });

  test('empty order produces empty content', () => {
    expect(buildAssistantContent({ order: [] })).toEqual([]);
  });
});
