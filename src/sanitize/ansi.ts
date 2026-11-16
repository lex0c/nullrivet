// Matches terminal escape sequences and the control bytes that can change terminal state.
// TAB, LF and CR are kept because they carry layout in ordinary text. A stray ESC is removed
// as well: left in place, concatenation with later text could re-form a live sequence.
const ANSI_PATTERN = new RegExp(
  [
    // CSI, including private-mode parameters such as `\x1b[<0;1;1M`.
    '\\x1b\\[[0-9;:<=>?]*[ -/]*[@-~]',
    // OSC, DCS, APC, PM and SOS strings, terminated by BEL or ST. The string cannot contain ESC,
    // which starts the terminator, so each match attempt stops at the next ESC and the scan stays
    // linear; an unterminated string is left to the rules below, which remove its ESC.
    '\\x1b[\\]PX^_][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
    // Single-character escapes, including RIS (terminal reset).
    '\\x1b[@-~]',
    // C1 control characters.
    '[\\x80-\\x9f]',
    '\\x1b',
    // C0 controls other than TAB, LF and CR, plus DEL.
    '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1a\\x1c-\\x1f\\x7f]',
  ].join('|'),
  'g',
);

export const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, '');
