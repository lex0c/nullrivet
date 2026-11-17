// Input box rows. Each buffer line becomes one or more rows: the first row carries the `> `
// prompt, every continuation row (an explicit '\n' or a soft wrap) a two-space indent aligned
// under it. Lines wrap by column, not by word: the input holds commands, code and pasted text,
// where a predictable column wrap is preferable and word wrapping would fight wide glyphs.
//
// `renderInput` and `inputCursor` walk the same chunk list (`wrapInputLine`), so the cursor
// always lands on the row and column that were drawn.

import type { InputState } from '../input-editor.ts';
import { type Capabilities, paint } from '../term.ts';
import { visualWidth } from './width.ts';
import { wrapInputLine } from './wrap.ts';

const PROMPT_PREFIX = '> ';
const CONT_PREFIX = '  ';
const PREFIX_WIDTH = 2;

// A tab is shown as one space. The width library counts a tab as zero columns while the
// terminal jumps to the next tab stop, so a raw tab would desynchronize the wrap and the
// cursor. The substitution is one code unit for one, so buffer offsets stay valid.
// Tabs are shown as one space so wrapping and the cursor column stay exact; the buffer keeps them.
export const displayText = (value: string): string => value.replace(/\t/g, ' ');

export interface RenderInputOptions {
  // Dim hint shown after the prompt while the buffer is empty.
  placeholder?: string;
  // Dim argument hint (e.g. ` [low|medium|high]`) appended after a single-line `/command`.
  // Shown only with the cursor at the end of the buffer, where it cannot trail past the
  // caret, and only when it fits the row: it is never wrapped.
  commandGhost?: string;
}

export const renderInput = (
  input: InputState,
  caps: Capabilities,
  options: RenderInputOptions = {},
): string[] => {
  const innerWidth = Math.max(1, caps.cols - PREFIX_WIDTH);
  const shown = displayText(input.value);
  if (shown === '' && options.placeholder !== undefined && options.placeholder !== '') {
    return [PROMPT_PREFIX + paint(caps, 'secondary', options.placeholder)];
  }
  const isSlashLine = shown.startsWith('/') && !shown.includes('\n');
  // The command token (slash and name, up to the first whitespace) is painted `accent` so the
  // operator sees the line will run a command rather than send a message.
  const slashTokenEnd = isSlashLine
    ? (() => {
        const ws = shown.search(/\s/);
        return ws === -1 ? shown.length : ws;
      })()
    : -1;
  const lines = shown === '' ? [''] : shown.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const linePrefix = i === 0 ? PROMPT_PREFIX : CONT_PREFIX;
    if (line.length === 0) {
      out.push(linePrefix);
      continue;
    }
    const chunks = wrapInputLine(line, innerWidth);
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      if (chunk === undefined) continue;
      const prefix = c === 0 ? linePrefix : CONT_PREFIX;
      // A long command token can wrap, so only the part inside this chunk is painted.
      if (i === 0 && slashTokenEnd > chunk.start) {
        const cut = Math.min(slashTokenEnd, chunk.end);
        const head = paint(caps, 'accent', line.slice(chunk.start, cut));
        out.push(prefix + head + line.slice(cut, chunk.end));
        continue;
      }
      out.push(prefix + line.slice(chunk.start, chunk.end));
    }
  }
  const ghost = options.commandGhost;
  if (
    ghost !== undefined &&
    ghost !== '' &&
    isSlashLine &&
    input.cursor === input.value.length &&
    out.length > 0 &&
    PREFIX_WIDTH + visualWidth(shown) + visualWidth(ghost) <= caps.cols
  ) {
    out[out.length - 1] = `${out[out.length - 1]}${paint(caps, 'secondary', ghost)}`;
  }
  return out;
};

export interface InputCursor {
  row: number;
  col: number;
}

// Cursor position relative to the first row returned by `renderInput` for the same input and
// width: `row` is a 0-based offset into those rows, `col` a visual column. A cursor right at
// the end of a row that fills the width stays on that row, on the last column, because no
// further row is drawn for it.
export const inputCursor = (input: InputState, caps: Capabilities): InputCursor => {
  const innerWidth = Math.max(1, caps.cols - PREFIX_WIDTH);
  const maxCol = Math.max(0, caps.cols - 1);
  const value = displayText(input.value);
  const cursor = Math.max(0, Math.min(input.cursor, value.length));
  const lines = value === '' ? [''] : value.split('\n');
  let row = 0;
  let charsBefore = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const chunks = wrapInputLine(line, innerWidth);
    if (cursor <= charsBefore + line.length) {
      const offset = cursor - charsBefore;
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        if (chunk === undefined) continue;
        if (offset < chunk.end || c === chunks.length - 1) {
          const col = PREFIX_WIDTH + visualWidth(line.slice(chunk.start, offset));
          return { row: row + c, col: Math.min(col, maxCol) };
        }
      }
      return { row, col: Math.min(PREFIX_WIDTH, maxCol) };
    }
    row += Math.max(1, chunks.length);
    charsBefore += line.length + 1;
  }
  return { row: Math.max(0, row - 1), col: Math.min(PREFIX_WIDTH, maxCol) };
};
