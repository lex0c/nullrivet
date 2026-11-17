// Terminal primitives for the inline TUI: capability detection, ANSI/SGR helpers, the
// process-wide mode toggles (raw mode, bracketed paste), the resize watcher and the frame
// scheduler. Raw ANSI only; no framework.

import { EventEmitter } from 'node:events';

// Probed once at startup. `cols`/`rows` change on resize (see createResizeWatcher); the rest
// is fixed for the session because re-detecting mid-run only risks flicker.
export interface Capabilities {
  isTTY: boolean;
  cols: number;
  rows: number;
  // 'basic' is the 16-color palette. 256/truecolor are not tracked because the palette is
  // greyscale plus a few state colors.
  color: 'none' | 'basic';
  unicode: boolean;
}

export interface DetectOptions {
  stdout?: { isTTY?: boolean; columns?: number; rows?: number };
  env?: Record<string, string | undefined>;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const detectCapabilities = (opts: DetectOptions = {}): Capabilities => {
  const stdout = opts.stdout ?? process.stdout;
  const env = opts.env ?? process.env;
  const isTTY = stdout.isTTY === true;
  const cols = stdout.columns ?? DEFAULT_COLS;
  const rows = stdout.rows ?? DEFAULT_ROWS;
  // NO_COLOR disables color with any non-empty value (an empty value is treated as unset).
  // CLICOLOR_FORCE=1 enables color without a TTY, for captured CI logs.
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const force = env.CLICOLOR_FORCE === '1';
  const color: Capabilities['color'] = noColor ? 'none' : force || isTTY ? 'basic' : 'none';
  // Unicode glyphs only when the locale advertises UTF-8. Probing by writing a multibyte
  // character and reading the cursor back would block startup on slow terminals.
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? '';
  const unicode = /UTF-?8/i.test(locale);
  return { isTTY, cols, rows, color, unicode };
};

// ─── ANSI helpers ─────────────────────────────────────────────────────────

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

// Off-screen moves are clamped by the terminal itself.
export const cursorUp = (n: number): string => (n <= 0 ? '' : `${CSI}${n}A`);
export const cursorDown = (n: number): string => (n <= 0 ? '' : `${CSI}${n}B`);
export const cursorBack = (n: number): string => (n <= 0 ? '' : `${CSI}${n}D`);
export const cursorForward = (n: number): string => (n <= 0 ? '' : `${CSI}${n}C`);
// 1-indexed: row=1, col=1 is the top-left corner.
export const cursorTo = (row: number, col: number): string => `${CSI}${row};${col}H`;
export const cursorHide = `${CSI}?25l`;
export const cursorShow = `${CSI}?25h`;

export const clearLine = `${CSI}2K`;
export const clearDown = `${CSI}J`;
// Clears the visible area and homes the cursor; the scrollback above is kept.
export const clearScreen = `${CSI}2J${CSI}H`;

// Bracketed paste (DECSET 2004): the terminal wraps pasted text in ESC[200~ … ESC[201~ so
// the key parser can treat it as one event instead of a burst of keystrokes.
export const enableBracketedPaste = `${CSI}?2004h`;
export const disableBracketedPaste = `${CSI}?2004l`;

// Synchronized output (DECSET 2026). The terminal buffers everything between begin and end
// and presents it as one frame, so an erase followed by a redraw is never shown half done.
// Terminals without support ignore the private mode, so it is emitted unconditionally.
export const beginSyncOutput = `${CSI}?2026h`;
export const endSyncOutput = `${CSI}?2026l`;

// xterm modifyOtherKeys level 1. With it enabled, xterm reports modified keys that have no
// legacy encoding (Shift+Enter, Ctrl+Enter) as ESC[27;<mod>;<code>~ instead of a bare CR,
// which is what makes Shift+Enter distinguishable from Enter. Ctrl+letter keeps its control
// byte at level 1. The disable form restores the terminal's configured default. Terminals
// that do not implement the mode ignore both sequences.
export const enableModifyOtherKeys = `${CSI}>4;1m`;
export const disableModifyOtherKeys = `${CSI}>4m`;

export const BRACKETED_PASTE_START = `${CSI}200~`;
export const BRACKETED_PASTE_END = `${CSI}201~`;

export const SGR = {
  reset: `${CSI}0m`,
  // SGR 90 (bright black) is a grey that is visible everywhere; used for meta text that
  // must stand apart from content, where faint would disappear.
  secondary: `${CSI}90m`,
  // Bright blue, for structural anchors and inline code.
  accent: `${CSI}94m`,
  // Regular blue, quieter than `accent`, for interactive hints.
  accentDark: `${CSI}34m`,
  bold: `${CSI}1m`,
  italic: `${CSI}3m`,
  strikethrough: `${CSI}9m`,
  error: `${CSI}31m`,
  warn: `${CSI}33m`,
  success: `${CSI}32m`,
} as const;
export type SgrToken = keyof typeof SGR;

export const paint = (caps: Pick<Capabilities, 'color'>, token: SgrToken, text: string): string =>
  caps.color === 'none' ? text : `${SGR[token]}${text}${SGR.reset}`;

// Stacks several attributes under a single trailing reset. Nested `paint` calls would emit an
// inner reset that also cancels the outer attribute.
export const paintMulti = (
  caps: Pick<Capabilities, 'color'>,
  tokens: readonly SgrToken[],
  text: string,
): string => {
  if (caps.color === 'none' || tokens.length === 0) return text;
  return `${tokens.map((t) => SGR[t]).join('')}${text}${SGR.reset}`;
};

// Reverse video is an attribute, not a color, so it is emitted even when color is disabled:
// callers rely on the contrast in plain terminals too.
export const reverse = (text: string): string => `${CSI}7m${text}${SGR.reset}`;

// ─── Mode toggles ─────────────────────────────────────────────────────────
//
// Raw mode and bracketed paste are process-wide terminal state. Every exit path must restore
// them, so the flags live here and the toggles are idempotent: a crash handler can call the
// disable functions without knowing whether the modes were ever enabled.

// Only the part of stdin that is touched. Declared locally so strict optional-property rules
// do not conflict with the upstream `setRawMode` return type.
export interface RawModeStdin {
  setRawMode?: (mode: boolean) => unknown;
}

let rawModeActive = false;
let bracketedPasteActive = false;

export const enableRawMode = (stdin: RawModeStdin = process.stdin as RawModeStdin): boolean => {
  if (typeof stdin.setRawMode !== 'function') return false;
  if (!rawModeActive) {
    stdin.setRawMode(true);
    rawModeActive = true;
  }
  return true;
};

export const disableRawMode = (stdin: RawModeStdin = process.stdin as RawModeStdin): void => {
  if (typeof stdin.setRawMode !== 'function') return;
  if (rawModeActive) {
    stdin.setRawMode(false);
    rawModeActive = false;
  }
};

export const isRawModeActive = (): boolean => rawModeActive;

export const enableBracketedPasteOn = (write: (s: string) => void): void => {
  if (!bracketedPasteActive) {
    write(enableBracketedPaste);
    bracketedPasteActive = true;
  }
};

export const disableBracketedPasteOn = (write: (s: string) => void): void => {
  if (bracketedPasteActive) {
    write(disableBracketedPaste);
    bracketedPasteActive = false;
  }
};

export const isBracketedPasteActive = (): boolean => bracketedPasteActive;

// ─── Resize watcher ───────────────────────────────────────────────────────

export interface ResizeEvent {
  cols: number;
  rows: number;
}

export interface ResizeStream {
  columns?: number;
  rows?: number;
  on: (event: 'resize', listener: () => void) => unknown;
  off: (event: 'resize', listener: () => void) => unknown;
}

export interface ResizeWatcher {
  onResize: (handler: (e: ResizeEvent) => void) => () => void;
  close: () => void;
}

export const createResizeWatcher = (
  stdout: ResizeStream = process.stdout as unknown as ResizeStream,
): ResizeWatcher => {
  const emitter = new EventEmitter();
  const pump = (): void => {
    emitter.emit('resize', {
      cols: stdout.columns ?? DEFAULT_COLS,
      rows: stdout.rows ?? DEFAULT_ROWS,
    });
  };
  // The stream event is the reliable source on most terminals; SIGWINCH covers environments
  // where the stream does not emit it. Both can fire for one resize, so handlers must
  // tolerate repeated events with the same size.
  stdout.on('resize', pump);
  const sigwinch = (): void => pump();
  if (typeof process.on === 'function') process.on('SIGWINCH', sigwinch);
  return {
    onResize: (handler) => {
      emitter.on('resize', handler);
      return () => emitter.off('resize', handler);
    },
    close: () => {
      stdout.off('resize', pump);
      if (typeof process.off === 'function') process.off('SIGWINCH', sigwinch);
      emitter.removeAllListeners();
    },
  };
};

// ─── Frame scheduler ──────────────────────────────────────────────────────
//
// Coalesces redraw requests into at most one render per frame interval (30 fps by default):
// a single pending timer, no priorities. `flush()` renders immediately, for moments where
// latency matters more than batching.

export interface FrameSchedulerOptions {
  fps?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FrameScheduler {
  request: () => void;
  flush: () => void;
  close: () => void;
}

export const createFrameScheduler = (
  render: () => void,
  options: FrameSchedulerOptions = {},
): FrameScheduler => {
  const fps = options.fps ?? 30;
  const intervalMs = Math.max(1, Math.floor(1000 / fps));
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let closed = false;

  const fire = (): void => {
    timer = null;
    if (closed) return;
    render();
  };

  return {
    request: () => {
      if (closed || timer !== null) return;
      timer = setTimer(fire, intervalMs);
    },
    flush: () => {
      if (closed) return;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      render();
    },
    close: () => {
      closed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
};
