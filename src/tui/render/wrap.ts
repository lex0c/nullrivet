// Soft-wrap chunker for the input box. A buffer line is split into chunks that each fit
// `innerWidth` terminal columns (visual width, not code units: a chunk of wide glyphs
// measured in code units would wrap again on the terminal and break the row count).
//
// The walk is per codepoint, so a surrogate pair is never split across chunks. Each chunk is
// a code-unit range [start, end) so the input renderer and the cursor computation consume
// the same list and cannot disagree. A single glyph wider than the budget gets its own
// over-budget chunk; the walk always advances, so it terminates.

import { visualWidth } from './width.ts';

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

// An empty line yields no chunks; callers render it as a single empty row.
export interface WrapChunk {
  start: number;
  end: number;
}

export const wrapInputLine = (line: string, innerWidth: number): readonly WrapChunk[] => {
  if (line.length === 0) return [];
  const budget = Math.max(1, innerWidth);
  const chunks: WrapChunk[] = [];
  let start = 0;
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const cpLen = isHighSurrogate(line.charCodeAt(i)) && i + 1 < line.length ? 2 : 1;
    const w = visualWidth(line.slice(i, i + cpLen));
    if (col + w > budget && i > start) {
      chunks.push({ start, end: i });
      start = i;
      col = 0;
    }
    col += w;
    i += cpLen;
  }
  chunks.push({ start, end: line.length });
  return chunks;
};
