// Slash-command suggestions shown below the input while a `/command` is typed. At most
// MAX_VISIBLE rows, `/name  description` with names padded so descriptions align, starting at
// column 0 like the input. The selected row is `accent`, the others `secondary`. Without
// color both would look the same, and Enter runs the selected command, so in that mode the
// selected row is prefixed with `> ` (the others with two spaces to keep the alignment).

import { type Capabilities, paint, type SgrToken } from '../term.ts';

export interface SlashSuggestion {
  name: string;
  description: string;
}

export interface SlashSuggestions {
  items: readonly SlashSuggestion[];
  // Index into `items`; -1 when nothing is selected (no matches).
  selected: number;
}

const MAX_VISIBLE = 8;

// Number of rows `renderSlashPopover` returns, for layout code that needs the height without
// rendering. Must stay in step with the render below.
export const slashPopoverLineCount = (slash: SlashSuggestions): number => {
  if (slash.items.length === 0) return 1;
  const visibleCount = Math.min(MAX_VISIBLE, slash.items.length);
  return visibleCount + (slash.items.length > visibleCount ? 1 : 0);
};

export const renderSlashPopover = (slash: SlashSuggestions, caps: Capabilities): string[] => {
  if (slash.items.length === 0) {
    return [paint(caps, 'secondary', '(no matches — try /help)')];
  }
  const total = slash.items.length;
  const visibleCount = Math.min(MAX_VISIBLE, total);
  // The window slides so the selected row is always visible, as the last visible row once
  // the selection moves past the first page.
  const windowStart = slash.selected >= MAX_VISIBLE ? slash.selected - MAX_VISIBLE + 1 : 0;
  const visible = slash.items.slice(windowStart, windowStart + visibleCount);
  const longest = visible.reduce((max, s) => Math.max(max, s.name.length), 0);
  const useGlyph = caps.color === 'none';
  const lines = visible.map((s, i) => {
    const isSelected = windowStart + i === slash.selected;
    const prefix = useGlyph ? (isSelected ? '> ' : '  ') : '';
    const token: SgrToken = isSelected ? 'accent' : 'secondary';
    return paint(caps, token, `${prefix}/${s.name.padEnd(longest)}  ${s.description}`);
  });
  if (total > visibleCount) {
    lines.push(paint(caps, 'secondary', `(${total - visibleCount} more — scroll with ↑/↓)`));
  }
  return lines;
};
