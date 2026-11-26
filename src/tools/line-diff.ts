// A line diff of a file before and after a change, for display only: edit_file and write_file
// attach it to their result so the interface can show what changed. Nothing applies it, and the
// model does not see it. It runs on the event loop for every edit or write, so its cost is
// bounded: the unchanged start and end of the file are set aside without splitting them into
// lines, only the lines the snippet shows become objects, and a change too large to compare
// within the limits below is counted as replaced whole.

export type DiffLineType = 'add' | 'del' | 'ctx';

export interface DiffLine {
  type: DiffLineType;
  // The line as in the file, cut at MAX_LINE_CHARS.
  text: string;
  // 1-based position before the change; set for removed and unchanged lines.
  oldLine?: number;
  // 1-based position after the change; set for added and unchanged lines.
  newLine?: number;
}

export interface FileDiff {
  added: number;
  removed: number;
  // The first changed region, with up to CONTEXT_LINES unchanged lines around it, in at most
  // SNIPPET_LINES lines.
  snippet: DiffLine[];
  // Changed lines that are not in the snippet.
  hiddenChanges: number;
  // The changed region was too large or too costly to compare, and is counted as replaced whole:
  // the counts are an upper bound, not the fewest lines removed and added.
  approximate?: true;
}

const CONTEXT_LINES = 2;
const SNIPPET_LINES = 10;
// A snippet line takes one terminal row, and the diff travels in events, so a minified line of
// megabytes is cut.
const MAX_LINE_CHARS = 500;
// Lines of both sides, between the unchanged start and end, that are split and compared. Past
// this, the region counts as replaced whole.
const MAX_COMPARED_LINES = 200_000;
// Steps the comparison takes before it gives up, which bounds its time. Past this, the region
// counts as replaced whole.
const MAX_COMPARISON_STEPS = 3_000_000;

// Comparison steps a series of diffs may take together, for a caller that compares many files:
// each diff takes the steps it uses, and gets no more than are left.
export interface DiffBudget {
  steps: number;
}
// The edits the snippet shows are looked for among the first lines of each side of the region
// only: recovering them takes memory in the square of their number, while counting them does
// not.
const SNIPPET_WINDOW = 100;

// A stretch of the edit script: `count` lines of one type.
type Run = [DiffLineType, number];

const noChange = (): FileDiff => ({ added: 0, removed: 0, snippet: [], hiddenChanges: 0 });

// Cut at MAX_LINE_CHARS without splitting a surrogate pair, which would leave half a character.
const cutLine = (text: string): string => {
  if (text.length <= MAX_LINE_CHARS) return text;
  const last = text.charCodeAt(MAX_LINE_CHARS - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_LINE_CHARS - 1 : MAX_LINE_CHARS);
};

// A final newline does not start another line: "a\nb\n" has two lines, like "a\nb". Returns the
// text without it, or null for an empty text, which has no lines.
const linesBody = (text: string): string | null => {
  if (text === '') return null;
  return text.endsWith('\n') ? text.slice(0, -1) : text;
};

// The lines of text[from..to), where `to` is the end of the text or a line break, without
// splitting the whole region.
const countLines = (text: string, from: number, to: number): number => {
  let count = 1;
  for (let at = text.indexOf('\n', from); at !== -1 && at < to; at = text.indexOf('\n', at + 1)) {
    count += 1;
  }
  return count;
};

// Slices are compared in native code, far faster than one character at a time, so the shared
// start and end are found by blocks first.
const COMPARE_BLOCK = 4096;

const sharedPrefix = (a: string, b: string, limit: number): number => {
  let length = 0;
  while (
    length + COMPARE_BLOCK <= limit &&
    a.slice(length, length + COMPARE_BLOCK) === b.slice(length, length + COMPARE_BLOCK)
  ) {
    length += COMPARE_BLOCK;
  }
  while (length < limit && a.charCodeAt(length) === b.charCodeAt(length)) length += 1;
  return length;
};

const sharedSuffix = (a: string, b: string, limit: number): number => {
  const block = (text: string, length: number): string =>
    text.slice(text.length - length - COMPARE_BLOCK, text.length - length);
  let length = 0;
  while (length + COMPARE_BLOCK <= limit && block(a, length) === block(b, length)) {
    length += COMPARE_BLOCK;
  }
  while (
    length < limit &&
    a.charCodeAt(a.length - 1 - length) === b.charCodeAt(b.length - 1 - length)
  ) {
    length += 1;
  }
  return length;
};

const firstLines = (text: string, from: number, to: number, limit: number): string[] => {
  const lines: string[] = [];
  let start = from;
  while (lines.length < limit) {
    const end = text.indexOf('\n', start);
    if (end === -1 || end >= to) {
      lines.push(text.slice(start, to));
      break;
    }
    lines.push(text.slice(start, end));
    start = end + 1;
  }
  return lines;
};

// The fewest removed plus added lines that turn `a` into `b` (Myers' algorithm), found in time
// that grows with that number rather than with the length of the file. Lines are compared by
// number, one per distinct text. With `trace`, the state after each step is kept there for
// editPath; it grows with the square of the number of edits. Takes its steps from `budget`, and
// returns null once it has none left.
const editDistance = (
  a: Int32Array,
  b: Int32Array,
  budget: DiffBudget,
  trace?: Int32Array[],
): number | null => {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  // furthest[offset + k]: the furthest position in `a` reached on diagonal k (x - y).
  const furthest = new Int32Array(2 * offset + 1);
  for (let d = 0; d <= n + m; d++) {
    for (let k = -d; k <= d; k += 2) {
      const above = furthest[offset + k + 1] ?? 0;
      const left = furthest[offset + k - 1] ?? 0;
      const from = k === -d || (k !== d && above > left) ? above : left + 1;
      let x = from;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      budget.steps -= x - from;
      furthest[offset + k] = x;
      if (x >= n && y >= m) {
        trace?.push(furthest.slice(offset - d, offset + d + 1));
        return d;
      }
    }
    trace?.push(furthest.slice(offset - d, offset + d + 1));
    budget.steps -= d + 1;
    if (budget.steps < 0) return null;
  }
  return n + m;
};

// The edits behind an editDistance trace, recovered by replaying its choices from the end.
const editPath = (trace: readonly Int32Array[], n: number, m: number): Run[] => {
  const reversed: Run[] = [];
  const push = (type: DiffLineType, count: number): void => {
    if (count === 0) return;
    const last = reversed.at(-1);
    if (last !== undefined && last[0] === type) last[1] += count;
    else reversed.push([type, count]);
  };
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const previous = trace[d - 1] ?? new Int32Array(0);
    const at = (k: number): number => previous[k + d - 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k + 1) > at(k - 1));
    const fromK = down ? k + 1 : k - 1;
    const fromX = at(fromK);
    // The unchanged lines after the edit, then the edit itself.
    push('ctx', x - (down ? fromX : fromX + 1));
    push(down ? 'add' : 'del', 1);
    x = fromX;
    y = fromX - fromK;
  }
  push('ctx', x);
  return reversed.reverse();
};

const lineIds = (a: readonly string[], b: readonly string[]): [Int32Array, Int32Array] => {
  const ids = new Map<string, number>();
  const toIds = (lines: readonly string[]): Int32Array => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      out[i] = id;
    }
    return out;
  };
  return [toIds(a), toIds(b)];
};

interface Counts {
  added: number;
  removed: number;
}

const countRuns = (runs: readonly Run[]): Counts => {
  let added = 0;
  let removed = 0;
  for (const [type, count] of runs) {
    if (type === 'add') added += count;
    else if (type === 'del') removed += count;
  }
  return { added, removed };
};

// The diff with the first changed region of `runs` as its snippet. The runs read both line
// lists from index `skip`, and `firstLine` is the number of lines of the file before index 0.
const summarize = (
  { added, removed }: Counts,
  runs: readonly Run[],
  a: readonly string[],
  b: readonly string[],
  skip: number,
  firstLine: number,
): FileDiff => {
  if (added === 0 && removed === 0) return noChange();

  // The snippet ends CONTEXT_LINES unchanged lines after the first changed region, or at
  // SNIPPET_LINES; later regions are counted in hiddenChanges.
  const snippet: DiffLine[] = [];
  let shown = 0;
  let changed = false;
  let unchangedAfter = 0;
  let i = skip;
  let j = skip;
  collect: for (const [type, count] of runs) {
    for (let r = 0; r < count; r++) {
      if (snippet.length >= SNIPPET_LINES) break collect;
      if (type === 'ctx') {
        if (changed) {
          unchangedAfter += 1;
          if (unchangedAfter > CONTEXT_LINES) break collect;
        }
        const text = cutLine(a[i] ?? '');
        snippet.push({ type, text, oldLine: firstLine + i + 1, newLine: firstLine + j + 1 });
        i += 1;
        j += 1;
        continue;
      }
      changed = true;
      unchangedAfter = 0;
      shown += 1;
      if (type === 'del') {
        snippet.push({ type, text: cutLine(a[i] ?? ''), oldLine: firstLine + i + 1 });
        i += 1;
      } else {
        snippet.push({ type, text: cutLine(b[j] ?? ''), newLine: firstLine + j + 1 });
        j += 1;
      }
    }
  }
  // The snippet can come from a part of the region compared on its own, whose edits may not be
  // exactly those counted for the whole region.
  return { added, removed, snippet, hiddenChanges: Math.max(0, added + removed - shown) };
};

// Every line of one side as removed or added, with the snippet from its first lines.
const wholeSide = (type: 'add' | 'del', text: string): FileDiff => {
  const runs: Run[] = [[type, countLines(text, 0, text.length)]];
  const lines = firstLines(text, 0, text.length, SNIPPET_LINES);
  return type === 'add'
    ? summarize(countRuns(runs), runs, [], lines, 0, 0)
    : summarize(countRuns(runs), runs, lines, [], 0, 0);
};

export const lineDiff = (before: string, after: string, budget?: DiffBudget): FileDiff => {
  const a = linesBody(before);
  const b = linesBody(after);
  if (a === b) return noChange();
  if (a === null) return wholeSide('add', b as string);
  if (b === null) return wholeSide('del', a);

  // The region that changed, found on the text: from the line of the first difference, and to
  // the line of the last one, each widened by CONTEXT_LINES lines for the snippet.
  const prefix = sharedPrefix(a, b, Math.min(a.length, b.length));
  const changeStart = prefix === 0 ? 0 : a.lastIndexOf('\n', prefix - 1) + 1;
  let start = changeStart;
  let contextBefore = 0;
  while (contextBefore < CONTEXT_LINES && start > 0) {
    start = start < 2 ? 0 : a.lastIndexOf('\n', start - 2) + 1;
    contextBefore += 1;
  }
  const firstLine = countLines(a, 0, changeStart) - 1 - contextBefore;
  // The shared end stops at the shared start, so the two never count the same characters.
  const suffix = sharedSuffix(a, b, Math.min(a.length, b.length) - prefix);
  // The lines after the first line break inside the shared end are unchanged.
  let endA = a.length;
  let contextAfter = 0;
  const unchangedFrom = a.indexOf('\n', a.length - suffix);
  if (unchangedFrom !== -1) {
    endA = unchangedFrom;
    while (contextAfter < CONTEXT_LINES) {
      contextAfter += 1;
      const next = a.indexOf('\n', endA + 1);
      endA = next === -1 ? a.length : next;
      if (next === -1) break;
    }
  }
  const endB = endA + b.length - a.length;

  const countA = countLines(a, start, endA);
  const countB = countLines(b, start, endB);
  if (countA + countB > MAX_COMPARED_LINES) {
    const unchanged = contextBefore + contextAfter;
    const runs: Run[] = [
      ['ctx', contextBefore],
      ['del', countA - unchanged],
      ['add', countB - unchanged],
      ['ctx', contextAfter],
    ];
    return {
      ...summarize(
        countRuns(runs),
        runs,
        firstLines(a, start, endA, SNIPPET_LINES),
        firstLines(b, start, endB, SNIPPET_LINES),
        0,
        firstLine,
      ),
      approximate: true,
    };
  }

  const linesA = a.slice(start, endA).split('\n');
  const linesB = b.slice(start, endB).split('\n');
  // Whole lines can still match at the edges, such as a last line that only gained a newline.
  let head = 0;
  while (head < linesA.length && head < linesB.length && linesA[head] === linesB[head]) head += 1;
  let tailA = linesA.length;
  let tailB = linesB.length;
  while (tailA > head && tailB > head && linesA[tailA - 1] === linesB[tailB - 1]) {
    tailA -= 1;
    tailB -= 1;
  }
  const skip = Math.max(0, head - CONTEXT_LINES);
  const leading: Run = ['ctx', head - skip];
  const trailing: Run = ['ctx', Math.min(CONTEXT_LINES, linesA.length - tailA)];
  const show = (runs: readonly Run[], counts: Counts): FileDiff =>
    summarize(counts, runs, linesA, linesB, skip, firstLine);

  const n = tailA - head;
  const m = tailB - head;
  const replaced: Run[] = [leading, ['del', n], ['add', m], trailing];
  if (n === 0 || m === 0) return show(replaced, countRuns(replaced));
  const [idsA, idsB] = lineIds(linesA.slice(head, tailA), linesB.slice(head, tailB));
  const allowed = Math.min(MAX_COMPARISON_STEPS, budget?.steps ?? MAX_COMPARISON_STEPS);
  const left = { steps: allowed };
  const distance = editDistance(idsA, idsB, left);
  if (budget !== undefined) budget.steps -= allowed - left.steps;
  if (distance === null) return { ...show(replaced, countRuns(replaced)), approximate: true };
  // Each edit removes or adds one line, and the sides differ by m - n lines.
  const counts = { added: (distance + m - n) / 2, removed: (distance - m + n) / 2 };
  const windowA = idsA.subarray(0, SNIPPET_WINDOW);
  const windowB = idsB.subarray(0, SNIPPET_WINDOW);
  const trace: Int32Array[] = [];
  // The window is short enough for its steps to go uncounted.
  editDistance(windowA, windowB, { steps: MAX_COMPARISON_STEPS }, trace);
  const edits = editPath(trace, windowA.length, windowB.length);
  // The lines after the region follow the edits only when the window covers the whole region.
  const whole = windowA.length === n && windowB.length === m;
  return show(whole ? [leading, ...edits, trailing] : [leading, ...edits], counts);
};

const isDiffLine = (value: unknown): value is DiffLine => {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Record<string, unknown>;
  const position = (key: string): boolean =>
    line[key] === undefined || (typeof line[key] === 'number' && Number.isInteger(line[key]));
  return (
    (line.type === 'add' || line.type === 'del' || line.type === 'ctx') &&
    typeof line.text === 'string' &&
    position('oldLine') &&
    position('newLine')
  );
};

// The diff in a tool result's meta, or null when there is none or it is not well formed. The meta
// may come from a process outside nullrivet, such as a sandboxed worker, so a diff larger than the
// one lineDiff produces is refused rather than rendered.
export const readFileDiff = (meta: Record<string, unknown> | undefined): FileDiff | null => {
  const value = meta?.diff;
  if (typeof value !== 'object' || value === null) return null;
  const diff = value as Record<string, unknown>;
  const count = (key: string): boolean =>
    typeof diff[key] === 'number' && Number.isInteger(diff[key]) && (diff[key] as number) >= 0;
  if (!count('added') || !count('removed') || !count('hiddenChanges')) return null;
  if (diff.approximate !== undefined && diff.approximate !== true) return null;
  if (!Array.isArray(diff.snippet) || diff.snippet.length > SNIPPET_LINES) return null;
  if (!diff.snippet.every((line) => isDiffLine(line) && line.text.length <= MAX_LINE_CHARS)) {
    return null;
  }
  return value as FileDiff;
};
