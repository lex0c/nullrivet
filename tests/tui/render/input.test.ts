import { describe, expect, test } from 'bun:test';
import { inputCursor, renderInput } from '../../../src/tui/render/input.ts';
import { type Capabilities, CSI } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const colored: Capabilities = { ...caps, color: 'basic' };
// innerWidth = cols - prefix(2) = 8.
const narrow: Capabilities = { ...caps, cols: 10 };

describe('renderInput', () => {
  test('empty input shows just the prompt prefix', () => {
    expect(renderInput({ value: '', cursor: 0 }, caps)).toEqual(['> ']);
  });

  test('placeholder shows after the prompt on an empty buffer', () => {
    expect(renderInput({ value: '', cursor: 0 }, caps, { placeholder: 'Type a message' })).toEqual([
      '> Type a message',
    ]);
  });

  test('placeholder is suppressed once the buffer is non-empty', () => {
    expect(renderInput({ value: 'hi', cursor: 2 }, caps, { placeholder: 'hint' })).toEqual([
      '> hi',
    ]);
  });

  test('placeholder is painted dim', () => {
    const out = renderInput({ value: '', cursor: 0 }, colored, { placeholder: 'hint' });
    expect(out).toEqual([`> ${CSI}2mhint${CSI}0m`]);
  });

  test('slash command token is painted accent; args keep the normal tone', () => {
    const out = renderInput({ value: '/effort high', cursor: 12 }, colored);
    expect(out).toEqual([`> ${CSI}94m/effort${CSI}0m high`]);
  });

  test('a bare slash turns blue immediately', () => {
    expect(renderInput({ value: '/', cursor: 1 }, colored)).toEqual([`> ${CSI}94m/${CSI}0m`]);
  });

  test('non-slash input is not colored', () => {
    expect(renderInput({ value: 'hello world', cursor: 11 }, colored)).toEqual(['> hello world']);
  });

  test('a multi-line buffer starting with `/` is not treated as a command', () => {
    expect(renderInput({ value: '/x\ny', cursor: 4 }, colored)).toEqual(['> /x', '  y']);
  });

  test('slash highlight no-ops under color=none', () => {
    expect(renderInput({ value: '/effort high', cursor: 12 }, caps)).toEqual(['> /effort high']);
  });

  test('single line gets prompt prefix', () => {
    expect(renderInput({ value: 'hello', cursor: 5 }, caps)).toEqual(['> hello']);
  });

  test('multi-line indents continuation rows by 2 spaces', () => {
    expect(renderInput({ value: 'first\nsecond\nthird', cursor: 0 }, caps)).toEqual([
      '> first',
      '  second',
      '  third',
    ]);
  });

  test('preserves a trailing empty line', () => {
    // After Shift+Enter at the end the cursor needs a visible row to sit on.
    expect(renderInput({ value: 'abc\n', cursor: 4 }, caps)).toEqual(['> abc', '  ']);
  });

  test('long lines soft-wrap by column with the continuation indent', () => {
    expect(renderInput({ value: 'a'.repeat(20), cursor: 0 }, narrow)).toEqual([
      `> ${'a'.repeat(8)}`,
      `  ${'a'.repeat(8)}`,
      `  ${'a'.repeat(4)}`,
    ]);
  });

  test('soft-wrap does not split a surrogate pair across rows', () => {
    const line = `${'a'.repeat(7)}😀b`;
    const out = renderInput({ value: line, cursor: 0 }, narrow);
    expect(out[0]).toBe('> aaaaaaa');
    expect(out[1]).toBe('  😀b');
  });

  test('tabs are displayed as one space so widths stay exact', () => {
    expect(renderInput({ value: 'a\tb', cursor: 3 }, caps)).toEqual(['> a b']);
  });

  test('no SGR is emitted for plain input even with color enabled', () => {
    expect(renderInput({ value: 'x', cursor: 1 }, colored)).toEqual(['> x']);
  });

  test('commandGhost trails a fully-typed slash command (cursor at end)', () => {
    const out = renderInput({ value: '/effort', cursor: 7 }, caps, {
      commandGhost: ' [low|medium|high]',
    });
    expect(out).toEqual(['> /effort [low|medium|high]']);
  });

  test('commandGhost is painted secondary; the token keeps its accent', () => {
    const out = renderInput({ value: '/effort', cursor: 7 }, colored, {
      commandGhost: ' [low|medium|high]',
    });
    expect(out).toEqual([`> ${CSI}94m/effort${CSI}0m${CSI}90m [low|medium|high]${CSI}0m`]);
  });

  test('commandGhost works after a trailing space', () => {
    const out = renderInput({ value: '/effort ', cursor: 8 }, caps, {
      commandGhost: '[low|medium|high]',
    });
    expect(out).toEqual(['> /effort [low|medium|high]']);
  });

  test('commandGhost is hidden when the cursor is not at the end', () => {
    const out = renderInput({ value: '/effort', cursor: 3 }, caps, {
      commandGhost: ' [low|medium|high]',
    });
    expect(out).toEqual(['> /effort']);
  });

  test('commandGhost is dropped rather than wrapped when it overflows the row', () => {
    const out = renderInput({ value: '/effort', cursor: 7 }, narrow, {
      commandGhost: ' [low|medium|high]',
    });
    expect(out).toEqual(['> /effort']);
  });

  test('commandGhost is ignored for a non-slash buffer', () => {
    expect(renderInput({ value: 'hello', cursor: 5 }, caps, { commandGhost: ' x' })).toEqual([
      '> hello',
    ]);
  });
});

describe('inputCursor', () => {
  test('empty input: row 0, col 2 (after the prompt)', () => {
    expect(inputCursor({ value: '', cursor: 0 }, caps)).toEqual({ row: 0, col: 2 });
  });

  test('single line: col reflects the offset', () => {
    expect(inputCursor({ value: 'hello world', cursor: 5 }, caps)).toEqual({ row: 0, col: 7 });
    expect(inputCursor({ value: 'abc', cursor: 3 }, caps)).toEqual({ row: 0, col: 5 });
    expect(inputCursor({ value: 'hello', cursor: 0 }, caps)).toEqual({ row: 0, col: 2 });
  });

  test('col counts the visual width of wide glyphs before the cursor', () => {
    expect(inputCursor({ value: '中x', cursor: 2 }, caps)).toEqual({ row: 0, col: 5 });
    expect(inputCursor({ value: '中x', cursor: 1 }, caps)).toEqual({ row: 0, col: 4 });
  });

  test('multi-line: cursor on the line that contains the offset', () => {
    expect(inputCursor({ value: 'first\nsecond\nthird', cursor: 9 }, caps)).toEqual({
      row: 1,
      col: 5,
    });
  });

  test('start of a continuation line maps to col 2 of that row', () => {
    expect(inputCursor({ value: 'a\nb', cursor: 2 }, caps)).toEqual({ row: 1, col: 2 });
  });

  test('cursor on a trailing empty line', () => {
    expect(inputCursor({ value: 'abc\n', cursor: 4 }, caps)).toEqual({ row: 1, col: 2 });
  });

  test('soft-wrap: the cursor lands on the right sub-row', () => {
    // 50 chars at innerWidth 8: offset 50 is on sub-row 6, col 2 + 50 % 8.
    expect(inputCursor({ value: 'a'.repeat(50), cursor: 50 }, narrow)).toEqual({
      row: 6,
      col: 4,
    });
  });

  test('soft-wrap: a cursor on a wrap boundary goes to the start of the next sub-row', () => {
    expect(inputCursor({ value: 'a'.repeat(20), cursor: 8 }, narrow)).toEqual({
      row: 1,
      col: 2,
    });
  });

  test('a cursor at the end of a line that fills the row clamps to the last column', () => {
    // renderInput draws one row for an 8-char line, so the cursor cannot move to a second.
    expect(inputCursor({ value: 'a'.repeat(8), cursor: 8 }, narrow)).toEqual({ row: 0, col: 9 });
  });

  test('one char past the boundary lands on the next sub-row', () => {
    expect(inputCursor({ value: 'a'.repeat(9), cursor: 9 }, narrow)).toEqual({ row: 1, col: 3 });
  });

  test('wrapped lines above shift the rows of later lines', () => {
    expect(inputCursor({ value: `${'a'.repeat(20)}\nbc`, cursor: 23 }, narrow)).toEqual({
      row: 3,
      col: 4,
    });
  });

  test('surrogate pair at the wrap boundary keeps the cursor aligned with the drawn chunks', () => {
    const value = `${'a'.repeat(7)}😀b`;
    expect(inputCursor({ value, cursor: 7 }, narrow)).toEqual({ row: 1, col: 2 });
    expect(inputCursor({ value, cursor: 4 }, narrow)).toEqual({ row: 0, col: 6 });
  });

  test('a tab before the cursor counts as one column, as drawn', () => {
    expect(inputCursor({ value: 'a\tb', cursor: 2 }, caps)).toEqual({ row: 0, col: 4 });
  });

  test('every row index it returns exists in renderInput output', () => {
    const value = `${'x'.repeat(17)}\n\n${'y'.repeat(9)}`;
    const rows = renderInput({ value, cursor: 0 }, narrow).length;
    for (let cursor = 0; cursor <= value.length; cursor++) {
      const pos = inputCursor({ value, cursor }, narrow);
      expect(pos.row).toBeLessThan(rows);
      expect(pos.col).toBeLessThan(narrow.cols);
    }
  });
});
