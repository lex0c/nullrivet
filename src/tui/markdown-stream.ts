export interface MarkdownSplit {
  // Complete blocks: text that will render the same no matter what arrives later.
  settled: string;
  // The block still being written.
  pending: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;

// Streamed markdown is rendered block by block: settled blocks go to the scrollback once and the
// pending block is redrawn in the live region. A block is settled when a blank line outside a
// fenced code block is followed by a line that starts a new block. An indented line after the
// blank line may continue the previous block (a list item paragraph), so it does not settle it.
export const splitSettledMarkdown = (text: string): MarkdownSplit => {
  const lines = text.split('\n');
  let openFence: string | null = null;
  let boundary = -1;
  // The last line may be incomplete, so it never decides anything.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] ?? '';
    if (openFence === null) {
      const fence = FENCE.exec(line);
      if (fence?.[1] !== undefined) {
        openFence = fence[1];
        continue;
      }
      const next = lines[i + 1] ?? '';
      if (line.trim() === '' && next.length > 0 && !/^\s/.test(next)) boundary = i;
      continue;
    }
    const closing = CLOSING_FENCE.exec(line);
    if (
      closing?.[1] !== undefined &&
      closing[1][0] === openFence[0] &&
      closing[1].length >= openFence.length
    ) {
      openFence = null;
    }
  }
  if (boundary < 0) return { settled: '', pending: text };
  return {
    settled: lines.slice(0, boundary).join('\n').replace(/\n+$/, ''),
    pending: lines.slice(boundary + 1).join('\n'),
  };
};
