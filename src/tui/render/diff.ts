// The change an edit_file or write_file call made, under its card: counts of added and removed
// lines, then the first changed region with line numbers. The lines are file content, which is
// untrusted: they are cleaned for the terminal and cut to one row.

import { terminalText } from '../../sanitize/display.ts';
import type { DiffLine, FileDiff } from '../../tools/line-diff.ts';
import { type Capabilities, paint } from '../term.ts';
import { frameWidth, padFrame } from './frame.ts';
import { ellipsisGlyph } from './glyphs.ts';
import { truncateToWidth, visualWidth } from './width.ts';

// After the frame margin, which already aligns a row with the verb of the card head, the diff
// rows are indented further so they read as the content of the card.
const INDENT = '  ';

const TONE = { add: 'success', del: 'error', ctx: 'secondary' } as const;
const MARK = { add: '+', del: '-', ctx: ' ' } as const;

// The number shown for a line: its position after the change, or before it for a removed line.
const lineNumber = (line: DiffLine): number | undefined => line.newLine ?? line.oldLine;

// A line of the file as one row: cleaned for the terminal, tabs shown as two spaces (a terminal
// would give them a width of its own), cut to `width` columns.
const displayLine = (text: string, width: number, caps: Capabilities): string => {
  const flat = terminalText(text).replace(/\t/g, '  ');
  if (visualWidth(flat) <= width) return flat;
  const ellipsis = ellipsisGlyph(caps);
  return `${truncateToWidth(flat, Math.max(0, width - visualWidth(ellipsis)))}${ellipsis}`;
};

// `  +3 -1` after the head of the card; empty when the content did not change.
export const diffCounts = (diff: FileDiff, caps: Capabilities): string =>
  diff.added + diff.removed === 0
    ? ''
    : `  ${paint(caps, 'success', `+${diff.added}`)} ${paint(caps, 'error', `-${diff.removed}`)}`;

export const diffRows = (diff: FileDiff, caps: Capabilities): string[] => {
  const digits = diff.snippet.reduce(
    (width, line) => Math.max(width, String(lineNumber(line) ?? '').length),
    0,
  );
  const rail = caps.unicode ? ' │ ' : ' | ';
  // Room left for the text after the indent, the line number, the rail and the mark.
  const textWidth = Math.max(0, frameWidth(caps) - INDENT.length - digits - rail.length - 2);
  const rows = diff.snippet.map((line) => {
    const tone = TONE[line.type];
    const number = paint(caps, tone, String(lineNumber(line) ?? '').padStart(digits));
    const text = paint(caps, tone, `${MARK[line.type]} ${displayLine(line.text, textWidth, caps)}`);
    return padFrame(`${INDENT}${number}${paint(caps, 'secondary', rail)}${text}`);
  });
  if (diff.hiddenChanges > 0) {
    const more = `${ellipsisGlyph(caps)} +${diff.hiddenChanges} more changed ${diff.hiddenChanges === 1 ? 'line' : 'lines'}`;
    rows.push(padFrame(paint(caps, 'secondary', `${INDENT}${more}`)));
  }
  return rows;
};
