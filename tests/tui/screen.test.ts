import { describe, expect, test } from 'bun:test';
import { createScreen, physicalCursorRowAfterRewrap, type Screen } from '../../src/tui/screen.ts';
import { type Capabilities, CSI, type ResizeStream } from '../../src/tui/term.ts';
import { createVirtualTerminal, type VirtualTerminal } from './virtual-terminal.ts';

const SYNC_BEGIN = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;
const HIDE = `${CSI}?25l`;
const SHOW = `${CSI}?25h`;

const capsOf = (cols: number, rows: number): Capabilities => ({
  isTTY: true,
  cols,
  rows,
  color: 'none',
  unicode: true,
});

interface FakeResize {
  stream: ResizeStream & { columns: number; rows: number };
  fire: (cols: number, rows: number) => void;
  listening: () => boolean;
}

const makeResizeStream = (cols: number, rows: number): FakeResize => {
  const listener: { current: (() => void) | null } = { current: null };
  const stream = {
    columns: cols,
    rows,
    on: (_event: 'resize', l: () => void) => {
      listener.current = l;
    },
    off: () => {
      listener.current = null;
    },
  };
  return {
    stream,
    fire: (c, r) => {
      stream.columns = c;
      stream.rows = r;
      listener.current?.();
    },
    listening: () => listener.current !== null,
  };
};

interface Harness {
  vt: VirtualTerminal;
  screen: Screen;
  writes: string[];
  resize: FakeResize;
  // Resizes the terminal model, then notifies the screen, in the order a terminal does.
  resizeTo: (cols: number, rows: number) => void;
  // Returns everything written since the last call and clears it.
  take: () => string;
}

const setup = (cols = 80, rows = 24): Harness => {
  const vt = createVirtualTerminal(cols, rows);
  const writes: string[] = [];
  const resize = makeResizeStream(cols, rows);
  const screen = createScreen({
    write: (s) => {
      writes.push(s);
      vt.write(s);
    },
    caps: capsOf(cols, rows),
    resizeStream: resize.stream,
  });
  return {
    vt,
    screen,
    writes,
    resize,
    resizeTo: (c, r) => {
      vt.resize(c, r);
      resize.fire(c, r);
    },
    take: () => writes.splice(0).join(''),
  };
};

// Screen rows up to the last non-empty one.
const visibleRows = (vt: VirtualTerminal): string[] => {
  const rows = vt.screen();
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows;
};

describe('full draw', () => {
  test('draws every row and places the cursor', () => {
    const h = setup();
    h.screen.render({ rows: ['header', '> abc', 'footer'], cursor: { row: 1, col: 5 } });
    expect(visibleRows(h.vt)).toEqual(['header', '> abc', 'footer']);
    expect(h.vt.cursor()).toEqual({ row: 1, col: 5 });
    expect(h.vt.cursorVisible()).toBe(true);
    h.screen.close();
  });

  test('one render is one write wrapped in synchronized output', () => {
    const h = setup();
    h.screen.render({ rows: ['a', 'b'], cursor: { row: 1, col: 0 } });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.startsWith(SYNC_BEGIN)).toBe(true);
    expect(h.writes[0]?.endsWith(SYNC_END)).toBe(true);
    h.screen.close();
  });

  test('the cursor is placed with cursor-up, carriage return and cursor-forward', () => {
    const h = setup();
    h.screen.render({ rows: ['line a', '> abc', 'footer'], cursor: { row: 1, col: 5 } });
    expect(h.take()).toContain(`footer${CSI}1A\r${CSI}5C`);
    h.screen.close();
  });

  test('embedded newlines split into physical rows; the cursor follows its row', () => {
    const h = setup();
    h.screen.render({ rows: ['a\nb', 'c', '> x'], cursor: { row: 2, col: 3 } });
    expect(visibleRows(h.vt)).toEqual(['a', 'b', 'c', '> x']);
    expect(h.vt.cursor()).toEqual({ row: 3, col: 3 });
    h.screen.close();
  });

  test('rows are truncated to the width, so nothing wraps', () => {
    const h = setup(20, 10);
    h.screen.render({ rows: ['x'.repeat(100), 'y'.repeat(20), 'z'] });
    expect(visibleRows(h.vt)).toEqual(['x'.repeat(20), 'y'.repeat(20), 'z']);
    h.screen.close();
  });

  test('tabs are expanded to spaces before truncation', () => {
    const h = setup(20, 10);
    h.screen.render({ rows: ['a\tb', `\t${'c'.repeat(30)}`] });
    expect(visibleRows(h.vt)).toEqual([`a${' '.repeat(7)}b`, `${' '.repeat(8)}${'c'.repeat(12)}`]);
    h.screen.close();
  });

  test('truncating colored content leaves no orphan escape bytes', () => {
    const h = setup(12, 10);
    h.screen.render({ rows: [`${CSI}33mwarning content here${CSI}0m`] });
    const out = h.take();
    expect(out).toContain(`${CSI}33mwarning cont`);
    expect(out).toContain(`${CSI}0m`);
    expect(visibleRows(h.vt)).toEqual(['warning cont']);
    h.screen.close();
  });

  test('the cursor column is clamped to the last column', () => {
    const h = setup(10, 10);
    h.screen.render({ rows: ['> abc'], cursor: { row: 0, col: 50 } });
    expect(h.vt.cursor()).toEqual({ row: 0, col: 9 });
    h.screen.close();
  });

  test('a frame without a cursor hides it; a later cursor shows it again', () => {
    const h = setup();
    h.screen.render({ rows: ['modal', 'hint'] });
    expect(h.take().startsWith(`${SYNC_BEGIN}${HIDE}`)).toBe(true);
    expect(h.vt.cursorVisible()).toBe(false);
    h.screen.render({ rows: ['> ', 'footer'], cursor: { row: 0, col: 2 } });
    expect(h.take().endsWith(`${SHOW}${SYNC_END}`)).toBe(true);
    expect(h.vt.cursorVisible()).toBe(true);
    h.screen.close();
  });

  test('a cursor row outside the frame hides the cursor', () => {
    const h = setup();
    h.screen.render({ rows: ['a'], cursor: { row: 3, col: 0 } });
    expect(h.vt.cursorVisible()).toBe(false);
    h.screen.close();
  });
});

describe('differential draw', () => {
  test('only changed rows are written when the height is unchanged', () => {
    const h = setup();
    h.screen.render({
      rows: ['STATIC-HEADER', 'INPUT: ', 'STATIC-FOOTER'],
      cursor: { row: 1, col: 7 },
    });
    h.take();
    h.screen.render({
      rows: ['STATIC-HEADER', 'INPUT: h', 'STATIC-FOOTER'],
      cursor: { row: 1, col: 8 },
    });
    const out = h.take();
    expect(out).toContain('INPUT: h');
    expect(out).not.toContain('STATIC-HEADER');
    expect(out).not.toContain('STATIC-FOOTER');
    expect(out).not.toContain(`${CSI}J`);
    expect(visibleRows(h.vt)).toEqual(['STATIC-HEADER', 'INPUT: h', 'STATIC-FOOTER']);
    expect(h.vt.cursor()).toEqual({ row: 1, col: 8 });
    h.screen.close();
  });

  test('several changed rows: unchanged rows between them are skipped', () => {
    const h = setup();
    h.screen.render({ rows: ['A: 0', 'MIDDLE', 'INPUT: '], cursor: { row: 2, col: 7 } });
    h.take();
    h.screen.render({ rows: ['A: 1', 'MIDDLE', 'INPUT: h'], cursor: { row: 2, col: 8 } });
    const out = h.take();
    expect(out).toContain('A: 1');
    expect(out).toContain('INPUT: h');
    expect(out).not.toContain('MIDDLE');
    expect(out).toContain(`${CSI}2B`);
    expect(visibleRows(h.vt)).toEqual(['A: 1', 'MIDDLE', 'INPUT: h']);
    expect(h.vt.cursor()).toEqual({ row: 2, col: 8 });
    h.screen.close();
  });

  test('a cursor move with identical rows writes only the reposition', () => {
    const h = setup();
    h.screen.render({ rows: ['> abc', 'footer'], cursor: { row: 0, col: 5 } });
    h.take();
    h.screen.render({ rows: ['> abc', 'footer'], cursor: { row: 0, col: 3 } });
    const out = h.take();
    expect(out).not.toContain('> abc');
    expect(out).toContain(`${CSI}3C`);
    expect(h.vt.cursor()).toEqual({ row: 0, col: 3 });
    h.screen.close();
  });

  test('an identical frame writes nothing', () => {
    const h = setup();
    const frame = { rows: ['> abc', 'footer'], cursor: { row: 0, col: 5 } };
    h.screen.render(frame);
    h.take();
    h.screen.render({ ...frame, rows: [...frame.rows] });
    expect(h.writes).toEqual([]);
    h.screen.close();
  });

  test('a height change erases and redraws everything without ghost rows', () => {
    const h = setup();
    h.screen.render({ rows: ['HEADER', 'INPUT', 'FOOTER', 'EXTRA'], cursor: { row: 1, col: 0 } });
    h.take();
    h.screen.render({ rows: ['HEADER', 'INPUT', 'FOOTER'], cursor: { row: 1, col: 0 } });
    const out = h.take();
    expect(out).toContain(`\r${CSI}1A${CSI}J`);
    expect(out).toContain('HEADER');
    expect(visibleRows(h.vt)).toEqual(['HEADER', 'INPUT', 'FOOTER']);
    h.screen.close();
  });

  test('an empty frame erases the region', () => {
    const h = setup();
    h.screen.render({ rows: ['a', 'b', 'c'] });
    h.screen.render({ rows: [] });
    expect(visibleRows(h.vt)).toEqual([]);
    expect(h.vt.cursor()).toEqual({ row: 0, col: 0 });
    expect(h.vt.cursorVisible()).toBe(true);
    h.screen.close();
  });
});

describe('print', () => {
  test('lines land above the live region, which is redrawn below them in one write', () => {
    const h = setup();
    h.screen.render({ rows: ['> abc', 'footer'], cursor: { row: 0, col: 5 } });
    h.take();
    h.screen.print(['log 1', 'log 2']);
    expect(h.writes).toHaveLength(1);
    const out = h.writes[0] ?? '';
    expect(out.startsWith(SYNC_BEGIN)).toBe(true);
    expect(out.indexOf(`${CSI}J`)).toBeLessThan(out.indexOf('log 1'));
    expect(visibleRows(h.vt)).toEqual(['log 1', 'log 2', '> abc', 'footer']);
    expect(h.vt.cursor()).toEqual({ row: 2, col: 5 });
    h.screen.close();
  });

  test('consecutive prints accumulate in order and the region keeps working', () => {
    const h = setup();
    h.screen.render({ rows: ['live'], cursor: { row: 0, col: 4 } });
    h.screen.print(['one']);
    h.screen.print(['two', 'three']);
    h.screen.render({ rows: ['live!'], cursor: { row: 0, col: 5 } });
    expect(visibleRows(h.vt)).toEqual(['one', 'two', 'three', 'live!']);
    h.screen.close();
  });

  test('with no live region the lines are written as they are', () => {
    const h = setup();
    h.screen.print(['l1', 'l2']);
    expect(h.writes).toEqual(['l1\nl2\n']);
    expect(visibleRows(h.vt)).toEqual(['l1', 'l2']);
    h.screen.close();
  });

  test('printed lines are not truncated', () => {
    const h = setup(10, 10);
    h.screen.print(['x'.repeat(15)]);
    expect(visibleRows(h.vt)).toEqual(['x'.repeat(10), 'x'.repeat(5)]);
    h.screen.close();
  });

  test('an empty print writes nothing', () => {
    const h = setup();
    h.screen.render({ rows: ['live'] });
    h.take();
    h.screen.print([]);
    expect(h.writes).toEqual([]);
    h.screen.close();
  });

  test('scrollback pushed off the top keeps the region intact at the bottom', () => {
    const h = setup(20, 5);
    h.screen.render({ rows: ['> ', 'footer'], cursor: { row: 0, col: 2 } });
    h.screen.print(['a', 'b', 'c', 'd', 'e']);
    expect(h.vt.screen()).toEqual(['c', 'd', 'e', '>', 'footer']);
    expect(h.vt.scrollback()).toEqual(['a', 'b']);
    expect(h.vt.cursor()).toEqual({ row: 3, col: 2 });
    h.screen.close();
  });
});

describe('height clamp', () => {
  const tall = (n: number): string[] => Array.from({ length: n }, (_, i) => `r${i}`);

  test('a frame taller than the terminal keeps its bottom rows-1 rows', () => {
    const h = setup(20, 6);
    h.screen.render({ rows: tall(10), cursor: { row: 9, col: 2 } });
    expect(visibleRows(h.vt)).toEqual(['r5', 'r6', 'r7', 'r8', 'r9']);
    expect(h.vt.cursor()).toEqual({ row: 4, col: 2 });
    expect(h.vt.scrollback()).toEqual([]);
    h.screen.close();
  });

  test('the next frame erases a clamped region completely', () => {
    const h = setup(20, 6);
    h.screen.print(['p1', 'p2', 'p3']);
    h.screen.render({ rows: tall(10), cursor: { row: 9, col: 0 } });
    h.screen.render({ rows: ['x', 'y'], cursor: { row: 1, col: 0 } });
    const everything = [...h.vt.scrollback(), ...visibleRows(h.vt)];
    expect(everything).toEqual(['p1', 'p2', 'p3', 'x', 'y']);
    h.screen.close();
  });

  test('a cursor in a dropped row is hidden', () => {
    const h = setup(20, 6);
    h.screen.render({ rows: tall(10), cursor: { row: 2, col: 0 } });
    expect(h.vt.cursorVisible()).toBe(false);
    expect(visibleRows(h.vt)).toEqual(['r5', 'r6', 'r7', 'r8', 'r9']);
    h.screen.close();
  });

  test('embedded newlines count toward the clamp', () => {
    const h = setup(20, 4);
    h.screen.render({ rows: ['a\nb\nc', 'd', '> e'], cursor: { row: 2, col: 3 } });
    expect(visibleRows(h.vt)).toEqual(['c', 'd', '> e']);
    expect(h.vt.cursor()).toEqual({ row: 2, col: 3 });
    h.screen.close();
  });
});

describe('resize', () => {
  const frameFor = (cols: number) => ({
    rows: ['-'.repeat(cols), 'body', '-'.repeat(cols), '> input'],
    cursor: { row: 3, col: 7 },
  });

  test('a shrink erases the re-wrapped rows; a listener re-renders at the new width', () => {
    const h = setup(80, 24);
    h.screen.print(['hello']);
    h.screen.render(frameFor(80));
    const sizes: { columns: number; rows: number }[] = [];
    h.screen.onResize((size) => {
      sizes.push(size);
      h.screen.render(frameFor(size.columns));
    });
    h.take();
    h.resizeTo(40, 24);
    expect(sizes).toEqual([{ columns: 40, rows: 24 }]);
    expect(h.take()).toContain(`\r${CSI}5A${CSI}J`);
    expect(visibleRows(h.vt)).toEqual(['hello', '-'.repeat(40), 'body', '-'.repeat(40), '> input']);
    expect(h.vt.cursor()).toEqual({ row: 4, col: 7 });
    expect(h.vt.scrollback()).toEqual([]);
    h.screen.close();
  });

  test('without a re-render the current frame is redrawn at the new width', () => {
    const h = setup(80, 24);
    h.screen.print(['hello']);
    h.screen.render(frameFor(80));
    h.resizeTo(40, 24);
    expect(visibleRows(h.vt)).toEqual(['hello', '-'.repeat(40), 'body', '-'.repeat(40), '> input']);
    expect(h.screen.size()).toEqual({ columns: 40, rows: 24 });
    h.screen.close();
  });

  test('a resize redraws through the full path even when the height is unchanged', () => {
    const h = setup(80, 24);
    h.screen.render(frameFor(80));
    h.take();
    h.resizeTo(60, 24);
    const out = h.take();
    expect(out).toContain(`${CSI}J`);
    expect(out).toContain('-'.repeat(60));
    h.screen.close();
  });

  test('a widen does not over-erase', () => {
    const h = setup(40, 24);
    h.screen.print(['above']);
    h.screen.render(frameFor(40));
    h.resizeTo(80, 24);
    expect(visibleRows(h.vt)).toEqual(['above', '-'.repeat(40), 'body', '-'.repeat(40), '> input']);
    h.screen.close();
  });

  test('a height shrink applies the clamp to the redraw', () => {
    const h = setup(20, 24);
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}`);
    h.screen.render({ rows, cursor: { row: 9, col: 0 } });
    h.resizeTo(20, 6);
    expect(visibleRows(h.vt)).toEqual(['r5', 'r6', 'r7', 'r8', 'r9']);
    h.screen.close();
  });

  test('a resize event with an unchanged size writes nothing', () => {
    const h = setup(80, 24);
    h.screen.render(frameFor(80));
    h.take();
    h.resize.fire(80, 24);
    expect(h.writes).toEqual([]);
    h.screen.close();
  });

  test('an unsubscribed listener is not called', () => {
    const h = setup(80, 24);
    let calls = 0;
    const off = h.screen.onResize(() => {
      calls++;
    });
    off();
    h.resizeTo(60, 24);
    expect(calls).toBe(0);
    h.screen.close();
  });

  test('resizeStream: false disables resize handling', () => {
    const writes: string[] = [];
    const screen = createScreen({
      write: (s) => {
        writes.push(s);
      },
      caps: capsOf(80, 24),
      resizeStream: false,
    });
    screen.onResize(() => {
      throw new Error('unexpected resize');
    });
    screen.render({ rows: ['a'] });
    expect(screen.size()).toEqual({ columns: 80, rows: 24 });
    expect(writes).toHaveLength(1);
    screen.close();
  });
});

describe('physicalCursorRowAfterRewrap', () => {
  test('counts wrapped physical rows above the cursor at the new width', () => {
    const prev = ['A'.repeat(80), 'short', '> input'];
    expect(physicalCursorRowAfterRewrap(prev, 2, 7, 40)).toBe(3);
  });

  test('adds the sub-row of the cursor within its own wrapped line', () => {
    const prev = ['B'.repeat(60), 'C'.repeat(70)];
    expect(physicalCursorRowAfterRewrap(prev, 1, 50, 40)).toBe(3);
  });

  test('equals cursorRow on a widen (no over-erase)', () => {
    const prev = ['x'.repeat(30), 'y'.repeat(20), '> in'];
    expect(physicalCursorRowAfterRewrap(prev, 2, 4, 80)).toBe(2);
  });

  test('counts wide glyphs by visual width, not code units', () => {
    expect(physicalCursorRowAfterRewrap(['漢'.repeat(30), '> in'], 1, 0, 40)).toBe(2);
  });

  test('a non-positive width falls back to cursorRow', () => {
    expect(physicalCursorRowAfterRewrap(['a', 'b'], 1, 0, 0)).toBe(1);
  });
});

describe('clearLive and clearScreen', () => {
  test('clearLive erases the region, shows the cursor and forgets the frame', () => {
    const h = setup();
    h.screen.print(['kept']);
    h.screen.render({ rows: ['modal', 'hint'] });
    h.screen.clearLive();
    expect(visibleRows(h.vt)).toEqual(['kept']);
    expect(h.vt.cursor()).toEqual({ row: 1, col: 0 });
    expect(h.vt.cursorVisible()).toBe(true);
    h.take();
    h.screen.print(['bye']);
    expect(h.writes).toEqual(['bye\n']);
    expect(visibleRows(h.vt)).toEqual(['kept', 'bye']);
    h.screen.close();
  });

  test('clearLive with nothing drawn writes nothing', () => {
    const h = setup();
    h.screen.clearLive();
    expect(h.writes).toEqual([]);
    h.screen.close();
  });

  test('clearScreen wipes the visible area and redraws the frame at the top', () => {
    const h = setup(20, 8);
    h.screen.print(['a', 'b', 'c']);
    h.screen.render({ rows: ['> x', 'footer'], cursor: { row: 0, col: 3 } });
    h.take();
    h.screen.clearScreen();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toContain(`${CSI}2J${CSI}H`);
    expect(visibleRows(h.vt)).toEqual(['> x', 'footer']);
    expect(h.vt.cursor()).toEqual({ row: 0, col: 3 });
    h.screen.render({ rows: ['> xy', 'footer'], cursor: { row: 0, col: 4 } });
    expect(visibleRows(h.vt)).toEqual(['> xy', 'footer']);
    h.screen.close();
  });
});

describe('close', () => {
  test('restores a hidden cursor and moves below the region without erasing it', () => {
    const h = setup();
    h.screen.render({ rows: ['a', 'b', 'c'], cursor: { row: 0, col: 1 } });
    h.screen.render({ rows: ['a', 'b', 'c'] });
    h.take();
    h.screen.close();
    const out = h.take();
    expect(out).toContain(SHOW);
    expect(out).not.toContain(`${CSI}J`);
    expect(visibleRows(h.vt)).toEqual(['a', 'b', 'c']);
    expect(h.vt.cursor()).toEqual({ row: 3, col: 0 });
    expect(h.vt.cursorVisible()).toBe(true);
  });

  test('is idempotent and turns every other method into a no-op', () => {
    const h = setup();
    h.screen.render({ rows: ['a'], cursor: { row: 0, col: 1 } });
    h.screen.close();
    h.take();
    h.screen.close();
    h.screen.render({ rows: ['b'] });
    h.screen.print(['c']);
    h.screen.clearLive();
    h.screen.clearScreen();
    expect(h.writes).toEqual([]);
  });

  test('stops listening for resizes', () => {
    const h = setup();
    let calls = 0;
    h.screen.onResize(() => {
      calls++;
    });
    expect(h.resize.listening()).toBe(true);
    h.screen.close();
    expect(h.resize.listening()).toBe(false);
    h.resize.fire(40, 10);
    expect(calls).toBe(0);
  });

  test('after clearLive, close writes nothing', () => {
    const h = setup();
    h.screen.render({ rows: ['a'], cursor: { row: 0, col: 1 } });
    h.screen.clearLive();
    h.take();
    h.screen.close();
    expect(h.writes).toEqual([]);
  });
});
