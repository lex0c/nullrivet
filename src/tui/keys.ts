// Stdin parser for the inline TUI. Raw stdin in TTY mode delivers single ASCII bytes, UTF-8
// sequences for one codepoint, and escape sequences (CSI, SS3, ESC-prefixed) for arrows,
// function keys, paste markers and modified keys. The parser is stateful: `feed` accepts
// chunks and returns zero or more events, buffering an incomplete sequence until the next
// chunk completes it.

import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './term.ts';

export type KeyName =
  | 'enter'
  | 'tab'
  | 'backspace'
  | 'escape'
  | 'space'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'delete'
  | 'insert'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12';

export type KeyEvent =
  | { kind: 'key'; name: KeyName; ctrl: boolean; alt: boolean; shift: boolean; raw: string }
  // One printable codepoint. Shift is not reported: the typed casing already encodes it.
  | { kind: 'char'; char: string; ctrl: boolean; alt: boolean; raw: string }
  // Bracketed paste content as a single chunk, line endings normalized to LF.
  | { kind: 'paste'; text: string };

// Final byte of `ESC [ … <final>` mapped to a key. Sequences outside these tables are
// consumed and dropped.
const CSI_FINAL_TO_NAME: Record<string, KeyName> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  // ESC [ Z is Shift+Tab; surfaced as 'tab' with shift=true.
  Z: 'tab',
};

// `ESC [ <num> ~` codes (xterm).
const CSI_TILDE_TO_NAME: Record<string, KeyName> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
  '11': 'f1',
  '12': 'f2',
  '13': 'f3',
  '14': 'f4',
  '15': 'f5',
  '17': 'f6',
  '18': 'f7',
  '19': 'f8',
  '20': 'f9',
  '21': 'f10',
  '23': 'f11',
  '24': 'f12',
};

// `ESC O <letter>` (SS3), sent in application cursor mode and by some terminals for F1–F4.
const SS3_TO_NAME: Record<string, KeyName> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

// The modifier parameter is 1 + a bitfield: 1=shift, 2=alt, 4=ctrl. Higher bits (super,
// hyper, meta, lock keys) are ignored.
const decodeModifier = (param: number): { shift: boolean; alt: boolean; ctrl: boolean } => {
  const m = Math.max(0, param - 1);
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0 };
};

const NO_MODS = { shift: false, alt: false, ctrl: false };

// Keeps a codepoint split across two chunks intact: the decoder holds the leading bytes in
// `stream` mode until the rest arrives. String input is already decoded.
interface ChunkDecoder {
  decode: (input: Buffer | string) => string;
}
const createDecoder = (): ChunkDecoder => {
  const td = new TextDecoder('utf-8', { fatal: false });
  return {
    decode: (input) => (typeof input === 'string' ? input : td.decode(input, { stream: true })),
  };
};

export interface KeyParser {
  feed: (input: Buffer | string) => KeyEvent[];
  // Shutdown drain: a buffered lone ESC becomes an Escape key and any unterminated paste is
  // discarded rather than replayed as keystrokes.
  drain: () => KeyEvent[];
  // Idle-timeout helper for the lone-ESC ambiguity (Escape key, or the first byte of a
  // sequence whose remainder has not arrived). Emits Escape only when the buffer holds
  // exactly ESC and no paste is in progress; otherwise it changes nothing, so it is safe to
  // call on every idle tick without truncating a paste delivered in several chunks.
  tryResolveLoneEsc: () => KeyEvent[];
  bufferLength: () => number;
}

export const createKeyParser = (): KeyParser => {
  let buf = '';
  let pasteActive = false;
  let pasteBuf = '';
  const decoder = createDecoder();

  // Terminals send CR for line breaks inside pasted text and Windows sources send CRLF; both
  // become LF. CRLF is replaced first so it does not turn into two line breaks.
  const takePaste = (): KeyEvent => {
    const text = pasteBuf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    pasteBuf = '';
    pasteActive = false;
    return { kind: 'paste', text };
  };

  // Consumes at most one event from the head of `buf`. `advance: 0` means the buffer holds
  // an incomplete sequence and must wait for the next feed.
  const consume = (): { event: KeyEvent | null; advance: number } => {
    if (pasteActive) {
      const endIdx = buf.indexOf(BRACKETED_PASTE_END);
      if (endIdx === -1) {
        // Hold back enough bytes to contain a partial end marker split across chunks.
        const safeEnd = Math.max(0, buf.length - BRACKETED_PASTE_END.length + 1);
        if (safeEnd === 0) return { event: null, advance: 0 };
        pasteBuf += buf.slice(0, safeEnd);
        return { event: null, advance: safeEnd };
      }
      pasteBuf += buf.slice(0, endIdx);
      return { event: takePaste(), advance: endIdx + BRACKETED_PASTE_END.length };
    }

    if (buf.startsWith(BRACKETED_PASTE_START)) {
      pasteActive = true;
      return { event: null, advance: BRACKETED_PASTE_START.length };
    }

    const c0 = buf.charCodeAt(0);

    if (c0 === 0x1b) {
      // A lone ESC is ambiguous until more bytes arrive or the idle timer resolves it.
      if (buf.length === 1) return { event: null, advance: 0 };

      const c1 = buf.charCodeAt(1);

      if (c1 === 0x5b /* '[' */) {
        let i = 2;
        while (i < buf.length) {
          const c = buf.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) break;
          i++;
        }
        const final = buf[i];
        if (final === undefined) return { event: null, advance: 0 };
        const total = i + 1;
        return { event: decodeCsi(final, buf.slice(2, i), buf.slice(0, total)), advance: total };
      }

      if (c1 === 0x4f /* 'O' */) {
        const letter = buf[2];
        if (letter === undefined) return { event: null, advance: 0 };
        const raw = buf.slice(0, 3);
        // Konsole's default keymap sends ESC O M for Shift+Enter. The same bytes are keypad
        // Enter in application keypad mode, which this program never enables.
        if (letter === 'M') {
          return {
            event: { kind: 'key', name: 'enter', ...NO_MODS, shift: true, raw },
            advance: 3,
          };
        }
        const name = SS3_TO_NAME[letter];
        if (name === undefined) return { event: null, advance: 3 };
        return { event: { kind: 'key', name, ...NO_MODS, raw }, advance: 3 };
      }

      const ch = buf[1] ?? '';
      // ESC ESC: emit one Escape and leave the second ESC for the next consume, so a double
      // tap reaches the caller as two Escape events.
      if (c1 === 0x1b) {
        return { event: { kind: 'key', name: 'escape', ...NO_MODS, raw: '\x1b' }, advance: 1 };
      }
      // ESC CR is Alt+Enter in every terminal that sends Meta as an ESC prefix.
      if (c1 === 0x0d) {
        return {
          event: { kind: 'key', name: 'enter', ...NO_MODS, alt: true, raw: buf.slice(0, 2) },
          advance: 2,
        };
      }
      if (c1 >= 0x20 && c1 !== 0x7f) {
        return {
          event: { kind: 'char', char: ch, ctrl: false, alt: true, raw: buf.slice(0, 2) },
          advance: 2,
        };
      }
      // ESC followed by another control byte: drop the ESC and parse the byte on its own.
      return { event: null, advance: 1 };
    }

    // Enter, Tab and Backspace share bytes with Ctrl+M/J, Ctrl+I and Ctrl+H. They are
    // reported as the named keys, so those Ctrl combinations cannot be bound separately.
    if (c0 === 0x0d || c0 === 0x0a) {
      return { event: { kind: 'key', name: 'enter', ...NO_MODS, raw: buf[0] ?? '' }, advance: 1 };
    }
    if (c0 === 0x09) {
      return { event: { kind: 'key', name: 'tab', ...NO_MODS, raw: '\t' }, advance: 1 };
    }
    if (c0 === 0x7f || c0 === 0x08) {
      return {
        event: { kind: 'key', name: 'backspace', ...NO_MODS, raw: buf[0] ?? '' },
        advance: 1,
      };
    }
    if (c0 === 0x20) {
      return { event: { kind: 'key', name: 'space', ...NO_MODS, raw: ' ' }, advance: 1 };
    }
    if (c0 >= 0x01 && c0 <= 0x1a) {
      const letter = String.fromCharCode(0x60 + c0);
      return {
        event: { kind: 'char', char: letter, ctrl: true, alt: false, raw: buf[0] ?? '' },
        advance: 1,
      };
    }
    // NUL (Ctrl+Space / Ctrl+@) and 0x1c–0x1f (Ctrl+\ ] ^ _) are reported as Ctrl+symbol so
    // the raw control byte never reaches the input buffer.
    if (c0 === 0x00 || (c0 >= 0x1c && c0 <= 0x1f)) {
      return {
        event: {
          kind: 'char',
          char: String.fromCharCode(0x40 + c0),
          ctrl: true,
          alt: false,
          raw: buf[0] ?? '',
        },
        advance: 1,
      };
    }

    if (c0 < 0x80) {
      return {
        event: { kind: 'char', char: buf[0] ?? '', ctrl: false, alt: false, raw: buf[0] ?? '' },
        advance: 1,
      };
    }
    // After decoding, a non-BMP codepoint occupies two UTF-16 code units.
    const cp = buf.codePointAt(0);
    if (cp === undefined) return { event: null, advance: 1 };
    const len = cp > 0xffff ? 2 : 1;
    const char = buf.slice(0, len);
    return { event: { kind: 'char', char, ctrl: false, alt: false, raw: char }, advance: len };
  };

  return {
    feed: (input) => {
      buf += decoder.decode(input);
      const events: KeyEvent[] = [];
      while (buf.length > 0) {
        const r = consume();
        if (r.advance === 0) break;
        if (r.event !== null) events.push(r.event);
        buf = buf.slice(r.advance);
      }
      return events;
    },
    drain: () => {
      const events: KeyEvent[] = [];
      if (buf.length === 1 && buf.charCodeAt(0) === 0x1b) {
        events.push({ kind: 'key', name: 'escape', ...NO_MODS, raw: '\x1b' });
        buf = '';
      }
      pasteActive = false;
      pasteBuf = '';
      return events;
    },
    tryResolveLoneEsc: () => {
      if (pasteActive) return [];
      if (buf.length !== 1 || buf.charCodeAt(0) !== 0x1b) return [];
      buf = '';
      return [{ kind: 'key', name: 'escape', ...NO_MODS, raw: '\x1b' }];
    },
    bufferLength: () => buf.length,
  };
};

// Parameters may carry colon-separated sub-fields (alternate keys, event type); only the
// first sub-field is used.
const firstSubParam = (param: string | undefined): number =>
  param === undefined || param === '' ? Number.NaN : Number.parseInt(param.split(':')[0] ?? '', 10);

const modifiersOf = (param: string | undefined): typeof NO_MODS => {
  const value = firstSubParam(param);
  return Number.isFinite(value) ? decodeModifier(value) : NO_MODS;
};

// A key reported by its Unicode codepoint, as in CSI-u (`ESC [ <code> ; <mod> u`) and xterm
// modifyOtherKeys (`ESC [ 27 ; <mod> ; <code> ~`). This is how terminals report
// Shift+Enter distinctly from Enter.
const decodeKeyCode = (code: number, mods: typeof NO_MODS, raw: string): KeyEvent | null => {
  switch (code) {
    case 13:
      return { kind: 'key', name: 'enter', ...mods, raw };
    case 9:
      return { kind: 'key', name: 'tab', ...mods, raw };
    case 27:
      return { kind: 'key', name: 'escape', ...mods, raw };
    case 8:
    case 127:
      return { kind: 'key', name: 'backspace', ...mods, raw };
    case 32:
      return { kind: 'key', name: 'space', ...mods, raw };
  }
  // Printable codepoints only: C0/C1 controls, surrogates and the private-use range (where
  // some terminals encode functional keys) are dropped.
  const printable =
    Number.isInteger(code) &&
    code > 0x20 &&
    code <= 0x10ffff &&
    !(code >= 0x7f && code <= 0x9f) &&
    !(code >= 0xd800 && code <= 0xdfff) &&
    !(code >= 0xe000 && code <= 0xf8ff);
  if (!printable) return null;
  // With Ctrl an ASCII letter is reported lowercase whatever the shift state, matching the
  // legacy control byte (Ctrl+Shift+A sends 0x01 like Ctrl+A). Otherwise Shift on a lowercase
  // ASCII letter uppercases it; other keys are left alone because their shifted symbol
  // depends on the keyboard layout.
  const isLowerAscii = code >= 0x61 && code <= 0x7a;
  const isUpperAscii = code >= 0x41 && code <= 0x5a;
  let cp = code;
  if (mods.ctrl && isUpperAscii) cp = code + 0x20;
  else if (!mods.ctrl && mods.shift && isLowerAscii) cp = code - 0x20;
  return { kind: 'char', char: String.fromCodePoint(cp), ctrl: mods.ctrl, alt: mods.alt, raw };
};

// Returns null for sequences that are not recognized; the caller drops them.
const decodeCsi = (final: string, paramStr: string, raw: string): KeyEvent | null => {
  const parts = paramStr.split(';');
  if (final === 'u') {
    return decodeKeyCode(firstSubParam(parts[0]), modifiersOf(parts[1]), raw);
  }
  if (final === '~') {
    if (parts[0] === '27' && parts.length >= 3) {
      return decodeKeyCode(firstSubParam(parts[2]), modifiersOf(parts[1]), raw);
    }
    const name = CSI_TILDE_TO_NAME[parts[0] ?? ''];
    if (name === undefined) return null;
    return { kind: 'key', name, ...modifiersOf(parts[1]), raw };
  }
  const name = CSI_FINAL_TO_NAME[final];
  if (name === undefined) return null;
  // xterm sends `1;5C` for Ctrl+Right: the leading 1 is a placeholder parameter.
  const mods = parts.length >= 2 ? modifiersOf(parts[1]) : NO_MODS;
  if (final === 'Z') return { kind: 'key', name: 'tab', ...mods, shift: true, raw };
  return { kind: 'key', name, ...mods, raw };
};
