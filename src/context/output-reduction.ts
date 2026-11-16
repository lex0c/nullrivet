// Deterministic reduction of large tool output before it enters the context. An LLM summary
// would add latency and cost to every large result; head and tail keep most of what matters.

export const HEAD_TAIL_DEFAULT_LINES = 80;

export interface HeadTailOptions {
  // Inputs at or below this many UTF-8 bytes pass through unchanged.
  maxBytes: number;
  headLines: number;
  tailLines: number;
}

export interface TextSummary {
  text: string;
  reduced: boolean;
  originalBytes: number;
}

const splitLines = (s: string): string[] => {
  if (s.length === 0) return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const isUtf8Continuation = (b: number | undefined): boolean =>
  b !== undefined && (b & 0xc0) === 0x80;

const utf8BoundaryAtOrBefore = (buf: Buffer, pos: number): number => {
  let p = Math.min(pos, buf.length);
  while (p > 0 && isUtf8Continuation(buf[p])) p--;
  return p;
};

const utf8BoundaryAtOrAfter = (buf: Buffer, pos: number): number => {
  let p = Math.max(0, pos);
  while (p < buf.length && isUtf8Continuation(buf[p])) p++;
  return p;
};

export const formatBytes = (n: number): string => {
  const format = (value: number, unit: string): string => {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${unit}`;
  };
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return format(n / 1024, 'KB');
  return format(n / (1024 * 1024), 'MB');
};

// Keeps the first and last `maxBytes / 2` bytes, cut on UTF-8 boundaries.
const byteWindow = (text: string, originalBytes: number, maxBytes: number): TextSummary => {
  const buf = Buffer.from(text, 'utf8');
  const halfBudget = Math.floor(maxBytes / 2);
  const headEnd = utf8BoundaryAtOrBefore(buf, halfBudget);
  const tailStart = utf8BoundaryAtOrAfter(buf, buf.length - halfBudget);
  // Boundary rounding on multi-byte input can make the windows meet; reducing then would
  // produce output no smaller than the input.
  if (tailStart <= headEnd) {
    return { text, reduced: false, originalBytes };
  }
  const head = buf.subarray(0, headEnd).toString('utf8');
  const tail = buf.subarray(tailStart).toString('utf8');
  return {
    text: `${head}\n[... ${formatBytes(tailStart - headEnd)} dropped ...]\n${tail}`,
    reduced: true,
    originalBytes,
  };
};

// Keeps the first `headLines` and last `tailLines` with an elision marker between them. When
// that still exceeds `maxBytes` (few lines, or very long ones such as minified files and
// base64 blobs), it falls back to a byte window, so the byte budget always holds.
export const headTailSummary = (text: string, opts: HeadTailOptions): TextSummary => {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= opts.maxBytes) {
    return { text, reduced: false, originalBytes };
  }
  const lines = splitLines(text);
  if (lines.length > opts.headLines + opts.tailLines) {
    const head = lines.slice(0, opts.headLines).join('\n');
    const tail = lines.slice(lines.length - opts.tailLines).join('\n');
    const keptBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
    if (keptBytes <= opts.maxBytes) {
      const elidedLines = lines.length - opts.headLines - opts.tailLines;
      return {
        text: `${head}\n[... ${elidedLines} lines elided (${formatBytes(originalBytes - keptBytes)} dropped) ...]\n${tail}`,
        reduced: true,
        originalBytes,
      };
    }
  }
  return byteWindow(text, originalBytes, opts.maxBytes);
};
