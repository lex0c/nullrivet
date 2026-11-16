// Visual width in terminal columns. `.length` counts UTF-16 code units, which undercounts
// CJK and emoji (two columns each); the live-region erase depends on exact row widths, and
// a miscount leaves stale rows on screen.

import stringWidth from 'string-width';

// CJK and emoji presentation count as 2, control characters and ANSI escapes as 0.
export const visualWidth = (s: string): number => stringWidth(s);

const ESC = '\x1b';
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

// Index just past the CSI sequence that starts at `i` (ESC '[' params final-byte).
const skipCsi = (s: string, i: number): number => {
  let end = i + 2;
  while (end < s.length) {
    const c = s.charCodeAt(end);
    end++;
    if (c >= CSI_FINAL_MIN && c <= CSI_FINAL_MAX) break;
  }
  return end;
};

// Cuts `s` to at most `maxCols` visible columns, without an ellipsis. CSI sequences are kept
// whole and cost no width; the ones after the cut point are still appended so a trailing SGR
// reset survives and the terminal is not left in a colored state. Only CSI is recognized,
// since that is the only escape the renderers emit.
export const truncateToWidth = (s: string, maxCols: number): string => {
  if (maxCols <= 0) return '';
  if (visualWidth(s) <= maxCols) return s;
  let acc = '';
  let width = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC && s[i + 1] === '[') {
      const end = skipCsi(s, i);
      acc += s.slice(i, end);
      i = end;
      continue;
    }
    const cp = s.codePointAt(i);
    if (cp === undefined) {
      i++;
      continue;
    }
    const cpStr = s.slice(i, i + (cp > 0xffff ? 2 : 1));
    const w = visualWidth(cpStr);
    if (width + w > maxCols) break;
    acc += cpStr;
    width += w;
    i += cpStr.length;
  }
  let j = i;
  while (j < s.length) {
    if (s[j] === ESC && s[j + 1] === '[') {
      const end = skipCsi(s, j);
      acc += s.slice(j, end);
      j = end;
    } else {
      j++;
    }
  }
  return acc;
};
