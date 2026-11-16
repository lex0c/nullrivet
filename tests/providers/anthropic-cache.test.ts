import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  cacheMarker,
  countCacheBreakpoints,
  MAX_CACHE_BREAKPOINTS_PER_REQUEST,
  messagesWithTailCacheBreakpoint,
  systemSegmentsWithCacheBreakpoints,
  systemWithCacheBreakpoint,
  toolsWithCacheBreakpoint,
} from '../../src/providers/anthropic/cache.ts';
import type {
  ProviderContentBlock,
  ProviderMessage,
  SystemSegment,
} from '../../src/providers/types.ts';

const EPHEMERAL = cacheMarker('5m');

const tool = (name: string): Anthropic.Tool => ({
  name,
  description: `${name} description`,
  input_schema: { type: 'object' as const, properties: {} },
});

const userMsg = (
  content: string | ProviderContentBlock[],
): { role: ProviderMessage['role']; content: string | ProviderContentBlock[] } => ({
  role: 'user',
  content,
});

describe('cacheMarker', () => {
  test('5m is the bare ephemeral marker (no ttl)', () => {
    expect(cacheMarker('5m')).toEqual({ type: 'ephemeral' });
  });

  test('1h carries an explicit ttl', () => {
    expect(cacheMarker('1h')).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('the marker propagates to every breakpoint helper', () => {
    const m = cacheMarker('1h');
    expect(systemWithCacheBreakpoint('SYS', m)?.[0]?.cache_control).toEqual(m);
    expect(toolsWithCacheBreakpoint([tool('grep')], m)[0]?.cache_control).toEqual(m);
    const segs = systemSegmentsWithCacheBreakpoints(
      [{ id: 'stable', text: 'stable', cacheBreakpoint: true }],
      m,
    );
    expect(segs?.[0]?.cache_control).toEqual(m);
    const tail = messagesWithTailCacheBreakpoint([userMsg('hi')], m)[0]?.content;
    expect((tail as Array<{ cache_control?: unknown }>)[0]?.cache_control).toEqual(m);
  });
});

describe('systemWithCacheBreakpoint', () => {
  test('returns undefined when system is absent or empty', () => {
    expect(systemWithCacheBreakpoint(undefined, EPHEMERAL)).toBeUndefined();
    expect(systemWithCacheBreakpoint('', EPHEMERAL)).toBeUndefined();
  });

  test('wraps a string system prompt into one cached text block', () => {
    expect(systemWithCacheBreakpoint('you are a helpful agent', EPHEMERAL)).toEqual([
      { type: 'text', text: 'you are a helpful agent', cache_control: EPHEMERAL },
    ]);
  });
});

describe('systemSegmentsWithCacheBreakpoints', () => {
  test('emits one block per segment with cache_control where flagged', () => {
    const segments: SystemSegment[] = [
      { id: 'stable', text: 'identity + env', cacheBreakpoint: true },
      { id: 'volatile', text: 'unmarked' },
    ];
    expect(systemSegmentsWithCacheBreakpoints(segments, EPHEMERAL)).toEqual([
      { type: 'text', text: 'identity + env', cache_control: EPHEMERAL },
      { type: 'text', text: 'unmarked' },
    ]);
  });

  test('drops empty-text segments and returns undefined when none remain', () => {
    expect(
      systemSegmentsWithCacheBreakpoints(
        [
          { id: 'stable', text: 'body', cacheBreakpoint: true },
          { id: 'memory', text: '', cacheBreakpoint: true },
        ],
        EPHEMERAL,
      ),
    ).toEqual([{ type: 'text', text: 'body', cache_control: EPHEMERAL }]);
    expect(systemSegmentsWithCacheBreakpoints([], EPHEMERAL)).toBeUndefined();
    expect(
      systemSegmentsWithCacheBreakpoints([{ id: 'stable', text: '' }], EPHEMERAL),
    ).toBeUndefined();
  });
});

describe('toolsWithCacheBreakpoint', () => {
  test('passes an empty tool list through unchanged', () => {
    expect(toolsWithCacheBreakpoint([], EPHEMERAL)).toEqual([]);
  });

  test('attaches cache_control only to the last tool without mutating the input', () => {
    const tools = [tool('read_file'), tool('grep'), tool('write_file')];
    const snapshot = structuredClone(tools);
    const out = toolsWithCacheBreakpoint(tools, EPHEMERAL);
    expect(out[0]?.cache_control).toBeUndefined();
    expect(out[1]?.cache_control).toBeUndefined();
    expect(out[2]?.cache_control).toEqual(EPHEMERAL);
    expect(tools).toEqual(snapshot);
  });
});

describe('messagesWithTailCacheBreakpoint', () => {
  test('returns an empty list unchanged', () => {
    expect(messagesWithTailCacheBreakpoint([], EPHEMERAL)).toEqual([]);
  });

  test('expands string content on the tail message into a cached text block', () => {
    expect(messagesWithTailCacheBreakpoint([userMsg('hello')], EPHEMERAL)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: EPHEMERAL }] },
    ]);
  });

  test('attaches cache_control to the last block of the tail message only', () => {
    const out = messagesWithTailCacheBreakpoint(
      [
        userMsg('first'),
        { role: 'assistant', content: 'second' },
        userMsg([
          { type: 'tool_result', tool_use_id: 'a1', content: 'ok' },
          { type: 'text', text: 'next' },
        ]),
      ],
      EPHEMERAL,
    );
    expect(out[0]?.content).toBe('first');
    expect(out[1]?.content).toBe('second');
    const tail = (out[2]?.content ?? []) as Array<{ cache_control?: unknown }>;
    expect(tail[0]?.cache_control).toBeUndefined();
    expect(tail[1]?.cache_control).toEqual(EPHEMERAL);
  });

  test('leaves empty tail content alone', () => {
    expect(messagesWithTailCacheBreakpoint([userMsg('')], EPHEMERAL)[0]?.content).toBe('');
    expect(messagesWithTailCacheBreakpoint([userMsg([])], EPHEMERAL)[0]?.content).toEqual([]);
  });

  test('never anchors on a thinking block', () => {
    const blocks = [
      { type: 'thinking', thinking: 'reasoned', signature: 'sig' },
      { type: 'text', text: 'the answer' },
      { type: 'thinking', thinking: 'more', signature: 'sig2' },
    ];
    const out = messagesWithTailCacheBreakpoint(
      [{ role: 'assistant', content: blocks }],
      EPHEMERAL,
    );
    const tail = (out[0]?.content ?? []) as Array<{ cache_control?: unknown }>;
    expect(tail.map((b) => b.cache_control)).toEqual([undefined, EPHEMERAL, undefined]);
  });

  test('skips the breakpoint when the tail holds only thinking blocks', () => {
    const blocks = [
      { type: 'thinking', thinking: 'just thinking', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
    ];
    const out = messagesWithTailCacheBreakpoint(
      [{ role: 'assistant', content: blocks }],
      EPHEMERAL,
    );
    const tail = (out[0]?.content ?? []) as Array<{ cache_control?: unknown }>;
    expect(tail.every((b) => b.cache_control === undefined)).toBe(true);
  });
});

describe('countCacheBreakpoints', () => {
  test('returns 0 for a request with no cache markers', () => {
    expect(
      countCacheBreakpoints({
        system: undefined,
        tools: [tool('a'), tool('b')],
        messages: [userMsg('hi')] as Anthropic.MessageParam[],
      }),
    ).toBe(0);
  });

  test('a string system prompt, tools and a tail use three of the four breakpoints', () => {
    const count = countCacheBreakpoints({
      system: systemWithCacheBreakpoint('SYS', EPHEMERAL),
      tools: toolsWithCacheBreakpoint([tool('grep'), tool('read_file')], EPHEMERAL),
      messages: messagesWithTailCacheBreakpoint([userMsg('analyze')], EPHEMERAL),
    });
    expect(count).toBe(3);
    expect(count).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS_PER_REQUEST);
  });
});
