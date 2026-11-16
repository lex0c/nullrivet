// Pure key reducer for the input box: state in, state out, plus signals the caller acts on.
// It has no side effects and keeps nothing between calls, so a double Escape or a double
// Ctrl+C is detected by the caller, not here.

import { stripAnsi } from '../sanitize/ansi.ts';
import type { KeyEvent } from './keys.ts';

export interface InputState {
  // Multi-line text, lines separated by '\n'.
  value: string;
  // Offset in UTF-16 code units within `value`. Movement and deletion never leave it inside
  // a surrogate pair.
  cursor: number;
}

export interface ApplyKeyResult {
  next: InputState;
  // Enter on a non-empty buffer. `next` still holds the text; the caller clears it.
  submit?: { text: string };
  // Ctrl+C ('interrupt') or Ctrl+D ('eof') on an empty buffer. On a non-empty buffer Ctrl+C
  // clears it and Ctrl+D deletes forward, and neither is signalled.
  cancelInput?: 'interrupt' | 'eof';
  // Escape. The buffer is kept; the caller decides whether anything is running to interrupt.
  interruptSoft?: true;
}

export const emptyInput = (): InputState => ({ value: '', cursor: 0 });

const NOOP = (input: InputState): ApplyKeyResult => ({ next: input });

export const applyKey = (input: InputState, key: KeyEvent): ApplyKeyResult => {
  switch (key.kind) {
    case 'paste':
      return { next: insertText(input, key.text) };
    case 'char':
      if (key.ctrl) return applyCtrlChar(input, key.char);
      if (key.alt) return applyAltChar(input, key.char);
      return { next: insertText(input, key.char) };
    case 'key':
      return applyNamedKey(input, key);
  }
};

// ─── Insertion / deletion primitives ─────────────────────────────────────

// Inserted text reaches the live region verbatim, so escape sequences and control bytes
// (from a paste or an unusual key) are removed before they enter the buffer. Tabs and line
// breaks are content and are kept, with CR normalized to LF.
const sanitizeInsert = (text: string): string =>
  stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

// An input holding `text` with the cursor at its end, cleaned like inserted text: recalled text
// may come from outside the editor, such as a one-shot prompt kept in a session file.
export const inputWithText = (text: string): InputState => {
  const value = sanitizeInsert(text);
  return { value, cursor: value.length };
};

const insertText = (input: InputState, text: string): InputState => {
  const clean = sanitizeInsert(text);
  if (clean === '') return input;
  return {
    value: input.value.slice(0, input.cursor) + clean + input.value.slice(input.cursor),
    cursor: input.cursor + clean.length,
  };
};

const deleteRange = (input: InputState, start: number, end: number): InputState => {
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(input.value.length, Math.max(start, end));
  if (lo === hi) return input;
  return {
    value: input.value.slice(0, lo) + input.value.slice(hi),
    cursor: input.cursor <= lo ? input.cursor : input.cursor <= hi ? lo : input.cursor - (hi - lo),
  };
};

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

// One codepoint back from `cursor`. Removing or stepping over half of a surrogate pair would
// leave an orphan that corrupts the buffer and every encoding of it downstream.
const stepBack = (value: string, cursor: number): number => {
  if (cursor <= 0) return 0;
  if (isLowSurrogate(value.charCodeAt(cursor - 1)) && cursor >= 2) {
    if (isHighSurrogate(value.charCodeAt(cursor - 2))) return cursor - 2;
  }
  return cursor - 1;
};

const stepForward = (value: string, cursor: number): number => {
  if (cursor >= value.length) return value.length;
  if (isHighSurrogate(value.charCodeAt(cursor)) && cursor + 1 < value.length) {
    if (isLowSurrogate(value.charCodeAt(cursor + 1))) return cursor + 2;
  }
  return cursor + 1;
};

// ─── Ctrl+letter ──────────────────────────────────────────────────────────

const applyCtrlChar = (input: InputState, char: string): ApplyKeyResult => {
  switch (char) {
    case 'a':
      return { next: { ...input, cursor: lineStart(input) } };
    case 'e':
      return { next: { ...input, cursor: lineEnd(input) } };
    case 'u':
      return { next: deleteRange(input, lineStart(input), input.cursor) };
    case 'k':
      return { next: deleteRange(input, input.cursor, lineEnd(input)) };
    case 'w':
      return { next: deleteRange(input, prevWordBoundary(input), input.cursor) };
    case 'c':
      if (input.value === '') return { next: input, cancelInput: 'interrupt' };
      return { next: emptyInput() };
    case 'd':
      if (input.value === '') return { next: input, cancelInput: 'eof' };
      return { next: deleteRange(input, input.cursor, stepForward(input.value, input.cursor)) };
    case 'h':
      // The parser reports 0x08 as Backspace; this covers terminals that map Ctrl+H elsewhere.
      return { next: deleteRange(input, stepBack(input.value, input.cursor), input.cursor) };
    default:
      return NOOP(input);
  }
};

// ─── Alt+letter ───────────────────────────────────────────────────────────

const applyAltChar = (input: InputState, char: string): ApplyKeyResult => {
  switch (char) {
    case 'b':
      return { next: { ...input, cursor: prevWordBoundary(input) } };
    case 'f':
      return { next: { ...input, cursor: nextWordBoundary(input) } };
    case 'd':
      return { next: deleteRange(input, input.cursor, nextWordBoundary(input)) };
    default:
      return NOOP(input);
  }
};

// ─── Named keys ───────────────────────────────────────────────────────────

const applyNamedKey = (
  input: InputState,
  key: Extract<KeyEvent, { kind: 'key' }>,
): ApplyKeyResult => {
  switch (key.name) {
    case 'enter': {
      // Shift+Enter and Alt+Enter insert a newline; plain Enter submits. Enter on an empty
      // buffer does nothing.
      if (key.shift || key.alt) return { next: insertText(input, '\n') };
      if (input.value === '') return NOOP(input);
      // A backslash right before the cursor turns Enter into a newline that replaces the
      // backslash, for terminals where Shift+Enter is indistinguishable from Enter.
      const beforeCursor = input.value.slice(0, input.cursor);
      if (beforeCursor.endsWith('\\')) {
        const value = `${beforeCursor.slice(0, -1)}\n${input.value.slice(input.cursor)}`;
        return { next: { value, cursor: input.cursor } };
      }
      return { next: input, submit: { text: input.value } };
    }

    case 'backspace':
      return { next: deleteRange(input, stepBack(input.value, input.cursor), input.cursor) };

    case 'delete':
      return { next: deleteRange(input, input.cursor, stepForward(input.value, input.cursor)) };

    case 'left':
      if (key.ctrl || key.alt) return { next: { ...input, cursor: prevWordBoundary(input) } };
      return { next: { ...input, cursor: stepBack(input.value, input.cursor) } };

    case 'right':
      if (key.ctrl || key.alt) return { next: { ...input, cursor: nextWordBoundary(input) } };
      return { next: { ...input, cursor: stepForward(input.value, input.cursor) } };

    case 'home':
      return { next: { ...input, cursor: lineStart(input) } };

    case 'end':
      return { next: { ...input, cursor: lineEnd(input) } };

    case 'up':
      return { next: moveCursorVertical(input, -1) };

    case 'down':
      return { next: moveCursorVertical(input, +1) };

    case 'escape':
      return { next: input, interruptSoft: true };

    case 'space':
      return { next: insertText(input, ' ') };

    default:
      // Tab is left to the caller (slash-command completion); function keys do nothing.
      return NOOP(input);
  }
};

// ─── Cursor / word helpers ────────────────────────────────────────────────

const lineStart = (input: InputState): number => {
  const nl = input.value.slice(0, input.cursor).lastIndexOf('\n');
  return nl === -1 ? 0 : nl + 1;
};

const lineEnd = (input: InputState): number => {
  const idx = input.value.indexOf('\n', input.cursor);
  return idx === -1 ? input.value.length : idx;
};

const isWordChar = (c: string): boolean => c !== ' ' && c !== '\t' && c !== '\n';

const prevWordBoundary = (input: InputState): number => {
  let i = input.cursor;
  while (i > 0 && !isWordChar(input.value[i - 1] ?? '')) i--;
  while (i > 0 && isWordChar(input.value[i - 1] ?? '')) i--;
  return i;
};

const nextWordBoundary = (input: InputState): number => {
  let i = input.cursor;
  while (i < input.value.length && !isWordChar(input.value[i] ?? '')) i++;
  while (i < input.value.length && isWordChar(input.value[i] ?? '')) i++;
  return i;
};

// Moves one buffer line up or down, keeping the column when the target line is long enough.
// Past the first line the cursor goes to the start of the buffer, past the last to its end,
// as in readline.
const moveCursorVertical = (input: InputState, direction: -1 | 1): InputState => {
  const lines = input.value.split('\n');
  const before = input.value.slice(0, input.cursor).split('\n');
  const line = before.length - 1;
  const col = before[line]?.length ?? 0;
  const targetLine = line + direction;
  if (targetLine < 0) return { ...input, cursor: 0 };
  if (targetLine >= lines.length) return { ...input, cursor: input.value.length };
  let offset = 0;
  for (let i = 0; i < targetLine; i++) offset += (lines[i] ?? '').length + 1;
  const target = lines[targetLine] ?? '';
  let cursor = offset + Math.min(col, target.length);
  // Keeping the column can land between the halves of a surrogate pair on the target line.
  if (isLowSurrogate(input.value.charCodeAt(cursor)) && cursor > offset) {
    if (isHighSurrogate(input.value.charCodeAt(cursor - 1))) cursor -= 1;
  }
  return { ...input, cursor };
};
