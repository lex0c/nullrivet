import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderMessage, SystemSegment } from '../types.ts';

// Prompt-cache breakpoints. A `cache_control` marker makes the prefix up to and including the
// marked block cacheable, so later requests with the same prefix read it at a fraction of the
// input price. The request prefix is ordered tools, system, messages, and the markers sit on:
//   - the system prompt (one marker for a plain string, or one per flagged segment),
//   - the last tool definition, which covers the whole tool list,
//   - the last cache-eligible block of the last message, which moves forward every request so
//     each turn reads the previous turns from the cache.
// Anthropic rejects a request with more than MAX_CACHE_BREAKPOINTS_PER_REQUEST markers.

export const MAX_CACHE_BREAKPOINTS_PER_REQUEST = 4;

// 5m is the default ephemeral cache. 1h keeps the prefix across longer pauses between turns, at a
// higher price for every cache write.
export type CacheTtl = '5m' | '1h';

export const cacheMarker = (ttl: CacheTtl): Anthropic.CacheControlEphemeral =>
  ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

// Returns undefined for an absent or empty prompt so the request omits `system`.
export const systemWithCacheBreakpoint = (
  system: string | undefined,
  marker: Anthropic.CacheControlEphemeral,
): Anthropic.TextBlockParam[] | undefined => {
  if (system === undefined || system.length === 0) return undefined;
  return [{ type: 'text', text: system, cache_control: marker }];
};

// One block per segment. Empty segments are dropped because an empty text block is rejected and
// would waste a breakpoint.
export const systemSegmentsWithCacheBreakpoints = (
  segments: readonly SystemSegment[],
  marker: Anthropic.CacheControlEphemeral,
): Anthropic.TextBlockParam[] | undefined => {
  const blocks: Anthropic.TextBlockParam[] = [];
  for (const seg of segments) {
    if (seg.text.length === 0) continue;
    blocks.push(
      seg.cacheBreakpoint === true
        ? { type: 'text', text: seg.text, cache_control: marker }
        : { type: 'text', text: seg.text },
    );
  }
  return blocks.length === 0 ? undefined : blocks;
};

export const toolsWithCacheBreakpoint = (
  tools: Anthropic.Tool[],
  marker: Anthropic.CacheControlEphemeral,
): Anthropic.Tool[] => {
  const last = tools.length - 1;
  return tools.map((t, i) => (i === last ? { ...t, cache_control: marker } : t));
};

// Anthropic rejects `cache_control` on thinking blocks, which reasoning replay places in assistant
// messages, so the marker goes on the last other block. A message made only of thinking blocks, or
// an empty one, gets no marker: the breakpoint is an optimization, not a requirement.
const isCacheEligible = (type: string): boolean =>
  type !== 'thinking' && type !== 'redacted_thinking';

export const messagesWithTailCacheBreakpoint = <B extends { type: string }>(
  messages: readonly { role: ProviderMessage['role']; content: string | B[] }[],
  marker: Anthropic.CacheControlEphemeral,
): Anthropic.MessageParam[] => {
  const tail = messages.length - 1;
  return messages.map((m, i) => {
    if (i !== tail) return m as Anthropic.MessageParam;
    const content = m.content;
    if (typeof content === 'string') {
      if (content.length === 0) return m as Anthropic.MessageParam;
      return { role: m.role, content: [{ type: 'text', text: content, cache_control: marker }] };
    }
    let markIdx = -1;
    for (let bi = content.length - 1; bi >= 0; bi--) {
      const type = content[bi]?.type;
      if (type !== undefined && isCacheEligible(type)) {
        markIdx = bi;
        break;
      }
    }
    if (markIdx === -1) return m as unknown as Anthropic.MessageParam;
    const blocks = content.map((block, bi) =>
      bi === markIdx ? { ...block, cache_control: marker } : block,
    );
    return { role: m.role, content: blocks } as unknown as Anthropic.MessageParam;
  });
};

export const countCacheBreakpoints = (req: {
  system: Anthropic.TextBlockParam[] | undefined;
  tools: Anthropic.Tool[] | undefined;
  messages: Anthropic.MessageParam[];
}): number => {
  const marked = (block: unknown): boolean =>
    (block as { cache_control?: unknown }).cache_control != null;
  let n = 0;
  for (const block of req.system ?? []) if (marked(block)) n += 1;
  for (const tool of req.tools ?? []) if (marked(tool)) n += 1;
  for (const m of req.messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) if (marked(block)) n += 1;
  }
  return n;
};
