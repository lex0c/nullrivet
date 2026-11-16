// Inline screen engine: scrollback above, a redrawn live region at the bottom. It knows
// nothing about what the rows mean; callers hand it frames.
//
// Core invariant: one stored row is one physical terminal row. Embedded newlines are split
// and every row is truncated to the terminal width, so nothing soft-wraps and the erase can
// walk back exactly `cursorRow` rows. The region is also capped below the terminal height:
// rows pushed off the top of the screen can no longer be reached by a cursor-up and would
// stay behind as stale copies.
//
// Every update is one `write()` wrapped in synchronized output, so the terminal never shows
// an erased region before the redraw. When the region keeps its height, only the rows that
// changed are rewritten, which keeps static rows (rules, footer) from flickering while the
// operator types.

import { truncateToWidth, visualWidth } from './render/width.ts';
import {
  beginSyncOutput,
  type Capabilities,
  clearDown,
  clearLine,
  clearScreen as clearScreenSequence,
  createResizeWatcher,
  cursorDown,
  cursorForward,
  cursorHide,
  cursorShow,
  cursorUp,
  endSyncOutput,
  type ResizeStream,
  type ResizeWatcher,
} from './term.ts';

export interface ScreenCursor {
  row: number;
  col: number;
}

export interface ScreenFrame {
  // Live-region rows, top to bottom. A row may contain ANSI and embedded '\n'.
  rows: readonly string[];
  // `row` indexes `rows` (when that entry spans several lines, the cursor goes on its first
  // line); `col` is a visual column. Absent, or pushed off by the height cap: the cursor is
  // hidden while the frame has rows.
  cursor?: ScreenCursor;
}

export interface ScreenSize {
  columns: number;
  rows: number;
}

export interface Screen {
  // Writes lines into the scrollback above the live region, then redraws the current frame
  // below them. Lines are not truncated. With no live region drawn, only the lines are written.
  print: (lines: readonly string[]) => void;
  // Replaces the live region and remembers the frame for later redraws (print, resize).
  render: (frame: ScreenFrame) => void;
  // Erases the live region, forgets the frame and shows the cursor.
  clearLive: () => void;
  // Clears the visible screen and redraws the current frame at the top.
  clearScreen: () => void;
  size: () => ScreenSize;
  // Called after the screen adopted a new size. A listener may call `render` with a frame
  // composed for the new size; otherwise the current frame is redrawn at the new width.
  onResize: (listener: (size: ScreenSize) => void) => () => void;
  // Restores cursor visibility, stops the resize listeners and moves the cursor to a fresh line
  // below the live region, which is left on screen. Idempotent. Every other method is a no-op
  // afterwards.
  close: () => void;
}

export interface ScreenOptions {
  write: (s: string) => void;
  caps: Capabilities;
  // Defaults to process.stdout; `false` disables resize handling.
  resizeStream?: ResizeStream | false;
}

const TAB_STOP = 8;

// Physical rows between the top of the live region and the cursor once the terminal has
// re-wrapped the drawn rows to `newCols`. The rows were truncated to the old width, but after
// a shrink the terminal wraps each one to ceil(width / newCols) rows, so the erase must walk
// this distance instead of the logical `cursorRow`. On a widen every term is 1 and the result
// equals `cursorRow`.
export const physicalCursorRowAfterRewrap = (
  prevLines: readonly string[],
  cursorRow: number,
  cursorCol: number,
  newCols: number,
): number => {
  if (newCols <= 0) return cursorRow;
  let physUp = 0;
  const upTo = Math.min(cursorRow, prevLines.length);
  for (let i = 0; i < upTo; i++) {
    physUp += Math.max(1, Math.ceil(visualWidth(prevLines[i] ?? '') / newCols));
  }
  return physUp + Math.floor(Math.max(0, cursorCol) / newCols);
};

// The width library counts a tab as zero columns while the terminal advances to the next tab
// stop, which would let a truncated row overflow and wrap. Tabs become spaces up to the stop.
const expandTabs = (row: string): string => {
  if (!row.includes('\t')) return row;
  const parts = row.split('\t');
  let out = parts[0] ?? '';
  for (let i = 1; i < parts.length; i++) {
    out += ' '.repeat(TAB_STOP - (visualWidth(out) % TAB_STOP)) + (parts[i] ?? '');
  }
  return out;
};

const moveRows = (delta: number): string => (delta > 0 ? cursorDown(delta) : cursorUp(-delta));

export const createScreen = (options: ScreenOptions): Screen => {
  const { write } = options;
  let columns = options.caps.cols;
  let height = options.caps.rows;
  let frame: ScreenFrame = { rows: [] };
  // Physical rows of the live region currently on screen.
  let liveHeight = 0;
  // Rows as last written, the baseline for the differential path. Emptied whenever the next
  // draw must repaint everything (after a resize the terminal has re-wrapped the old rows).
  let drawn: readonly string[] = [];
  // Where the terminal cursor sits, relative to the top-left of the live region.
  let cursorRow = 0;
  let cursorCol = 0;
  // Set by a resize: the physical erase distance at the new width, consumed by the next erase.
  let pendingResizeEraseRows: number | null = null;
  let cursorVisible = true;
  let closed = false;
  let renderCount = 0;
  const resizeListeners = new Set<(size: ScreenSize) => void>();

  const layout = (f: ScreenFrame): { lines: string[]; cursor: ScreenCursor | null } => {
    const lines: string[] = [];
    let cursorLine = -1;
    for (let i = 0; i < f.rows.length; i++) {
      if (f.cursor !== undefined && f.cursor.row === i) cursorLine = lines.length;
      for (const part of (f.rows[i] ?? '').split('\n')) {
        lines.push(truncateToWidth(expandTabs(part), columns));
      }
    }
    // Rows are dropped from the top: the bottom holds the input and the footer.
    const maxHeight = Math.max(1, height - 1);
    const drop = Math.max(0, lines.length - maxHeight);
    const visible = drop > 0 ? lines.slice(drop) : lines;
    const row = cursorLine - drop;
    if (f.cursor === undefined || cursorLine < 0 || row < 0) {
      return { lines: visible, cursor: null };
    }
    const col = Number.isFinite(f.cursor.col) ? Math.trunc(f.cursor.col) : 0;
    return { lines: visible, cursor: { row, col: Math.max(0, Math.min(col, columns - 1)) } };
  };

  const erase = (): string => {
    const up = pendingResizeEraseRows ?? cursorRow;
    pendingResizeEraseRows = null;
    if (liveHeight === 0) return '';
    liveHeight = 0;
    drawn = [];
    cursorRow = 0;
    cursorCol = 0;
    return `\r${cursorUp(up)}${clearDown}`;
  };

  // Assumes the cursor sits at column 0 of the row where the region starts.
  const fullDraw = (lines: string[], cursor: ScreenCursor | null): string => {
    drawn = lines;
    liveHeight = lines.length;
    if (lines.length === 0) {
      cursorRow = 0;
      cursorCol = 0;
      return '';
    }
    let s = lines.join('\n');
    // Without a cursor target it parks at column 0 of the last row, so the recorded column
    // is exact and the resize arithmetic stays correct.
    const targetRow = cursor?.row ?? lines.length - 1;
    const targetCol = cursor?.col ?? 0;
    s += `${cursorUp(lines.length - 1 - targetRow)}\r${cursorForward(targetCol)}`;
    cursorRow = targetRow;
    cursorCol = targetCol;
    return s;
  };

  // Same height as what is on screen: rewrite only the rows that changed, then reposition.
  const differentialDraw = (lines: string[], cursor: ScreenCursor | null): string => {
    let buf = '';
    let row = cursorRow;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === drawn[i]) continue;
      buf += `${moveRows(i - row)}\r${clearLine}${lines[i]}`;
      row = i;
    }
    drawn = lines;
    const targetRow = cursor?.row ?? lines.length - 1;
    const targetCol = cursor?.col ?? 0;
    if (buf === '' && targetRow === cursorRow && targetCol === cursorCol) return '';
    buf += `${moveRows(targetRow - row)}\r${cursorForward(targetCol)}`;
    cursorRow = targetRow;
    cursorCol = targetCol;
    return buf;
  };

  // The cursor is hidden while a live region without a cursor target is drawn; with no live
  // region the terminal is in its normal state and the cursor is shown. Hiding goes first and
  // showing last, so a terminal without synchronized output never shows the cursor travelling
  // through the frame.
  const emit = (body: string, lines: readonly string[], cursor: ScreenCursor | null): void => {
    const wantCursor = cursor !== null || lines.length === 0;
    let buf = body;
    if (!wantCursor && cursorVisible) {
      buf = cursorHide + buf;
      cursorVisible = false;
    } else if (wantCursor && !cursorVisible) {
      buf += cursorShow;
      cursorVisible = true;
    }
    if (buf !== '') write(`${beginSyncOutput}${buf}${endSyncOutput}`);
  };

  const render = (next: ScreenFrame): void => {
    if (closed) return;
    frame = next;
    renderCount++;
    const { lines, cursor } = layout(next);
    const full = liveHeight === 0 || lines.length === 0 || drawn.length !== lines.length;
    const body = full ? erase() + fullDraw(lines, cursor) : differentialDraw(lines, cursor);
    emit(body, lines, cursor);
  };

  const handleResize = (cols: number, rows: number): void => {
    if (closed || cols <= 0 || rows <= 0) return;
    if (cols === columns && rows === height) return;
    if (liveHeight > 0 && drawn.length > 0) {
      pendingResizeEraseRows = physicalCursorRowAfterRewrap(drawn, cursorRow, cursorCol, cols);
    }
    drawn = [];
    columns = cols;
    height = rows;
    const before = renderCount;
    try {
      for (const listener of [...resizeListeners]) listener({ columns, rows: height });
    } finally {
      if (renderCount === before) render(frame);
    }
  };

  let watcher: ResizeWatcher | null = null;
  if (options.resizeStream !== false) {
    watcher = createResizeWatcher(options.resizeStream);
    watcher.onResize(({ cols, rows }) => handleResize(cols, rows));
  }

  return {
    print: (lines) => {
      if (closed || lines.length === 0) return;
      const text = `${lines.join('\n')}\n`;
      const { lines: live, cursor } = layout(frame);
      if (liveHeight === 0 && live.length === 0) {
        pendingResizeEraseRows = null;
        write(text);
        return;
      }
      emit(erase() + text + fullDraw(live, cursor), live, cursor);
    },
    render,
    clearLive: () => {
      if (closed) return;
      frame = { rows: [] };
      emit(erase(), [], null);
    },
    clearScreen: () => {
      if (closed) return;
      liveHeight = 0;
      drawn = [];
      cursorRow = 0;
      cursorCol = 0;
      pendingResizeEraseRows = null;
      const { lines, cursor } = layout(frame);
      emit(clearScreenSequence + fullDraw(lines, cursor), lines, cursor);
    },
    size: () => ({ columns, rows: height }),
    onResize: (listener) => {
      resizeListeners.add(listener);
      return () => {
        resizeListeners.delete(listener);
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      watcher?.close();
      watcher = null;
      resizeListeners.clear();
      let buf = '';
      if (liveHeight > 0) buf += `${moveRows(liveHeight - 1 - cursorRow)}\r\n`;
      if (!cursorVisible) {
        buf += cursorShow;
        cursorVisible = true;
      }
      liveHeight = 0;
      drawn = [];
      if (buf !== '') write(buf);
    },
  };
};
