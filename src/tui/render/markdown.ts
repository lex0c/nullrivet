// GitHub-flavored Markdown to terminal lines (ANSI, no frame margin; the caller pads). The
// input must be a complete chunk: a block cut mid-way (an open code fence, half a table)
// renders as whatever that partial text parses to.

import type { List, ListItem, PhrasingContent, RootContent, Table, TableRow } from 'mdast';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import wrapAnsi from 'wrap-ansi';
import { stripAnsi } from '../../sanitize/ansi.ts';
import { type Capabilities, paint, paintMulti, type SgrToken } from '../term.ts';
import { frameWidth } from './frame.ts';
import { visualWidth } from './width.ts';

const parser = remark().use(remarkGfm);

// The attribute stack is threaded down the walk and applied once per text run. Nesting
// `paint` calls would emit an inner reset that also cancels the outer attribute (bold lost
// after an inline-code span inside `**…**`).
const styled = (text: string, caps: Capabilities, active: readonly SgrToken[]): string =>
  active.length > 0 ? paintMulti(caps, active, text) : text;

const renderInline = (
  nodes: readonly PhrasingContent[],
  caps: Capabilities,
  active: readonly SgrToken[] = [],
): string => {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += styled(node.value, caps, active);
        break;
      case 'strong':
        out += renderInline(node.children, caps, [...active, 'bold']);
        break;
      case 'emphasis':
        out += renderInline(node.children, caps, [...active, 'italic']);
        break;
      case 'delete':
        out += renderInline(node.children, caps, [...active, 'strikethrough']);
        break;
      case 'inlineCode':
        out += styled(node.value, caps, [...active, 'accent']);
        break;
      case 'break':
        out += '\n';
        break;
      case 'image':
        out += styled(node.alt ?? '', caps, active);
        break;
      case 'link': {
        // The URL follows the label, dimmed, unless it repeats the label (an autolink). The
        // comparison uses the unstyled label: surrounding formatting adds SGR codes that
        // would make an identical URL compare unequal.
        const label = renderInline(node.children, caps, active);
        const rawLabel = renderInline(node.children, { ...caps, color: 'none' }, []);
        out +=
          node.url !== '' && node.url !== rawLabel
            ? `${label} ${styled(`(${node.url})`, caps, [...active, 'dim'])}`
            : label;
        break;
      }
      default: {
        // linkReference, footnoteReference, inline html: children if any, else the raw value.
        const other = node as { children?: PhrasingContent[]; value?: string };
        if (other.children !== undefined) out += renderInline(other.children, caps, active);
        else if (typeof other.value === 'string') out += styled(other.value, caps, active);
        break;
      }
    }
  }
  return out;
};

// Word-wraps to `width`, keeping hard breaks. A width ≤ 0 (deep nesting in a narrow terminal)
// only splits on the existing newlines.
const wrapText = (text: string, width: number): string[] =>
  width > 0 ? wrapAnsi(text, width).split('\n') : text.split('\n');

const listMarker = (node: List, item: ListItem, n: number, caps: Capabilities): string => {
  if (item.checked === true) return '[x] ';
  if (item.checked === false) return '[ ] ';
  if (node.ordered === true) return `${n}. `;
  return caps.unicode ? '• ' : '- ';
};

// A table renders as an aligned grid (bold header, rule, padded rows) when it fits the width;
// otherwise as a stack of `header: value` lines per row, which fits any width.
const renderTable = (node: Table, caps: Capabilities, width: number, indent: number): string[] => {
  const pad = ' '.repeat(indent);
  const avail = Math.max(1, width - indent);
  const headerNode = node.children[0];
  if (headerNode === undefined) return [];
  const bodyNodes = node.children.slice(1);

  const cellsOf = (row: TableRow, active: readonly SgrToken[]): string[] =>
    row.children.map((cell) => renderInline(cell.children, caps, active));

  const header = cellsOf(headerNode, []);
  const body = bodyNodes.map((row) => cellsOf(row, []));
  const cols = header.length;

  const colWidth = Array.from({ length: cols }, (_, c) =>
    Math.max(visualWidth(header[c] ?? ''), ...body.map((row) => visualWidth(row[c] ?? ''))),
  );
  const SEP = '  ';
  const gridWidth = colWidth.reduce((a, b) => a + b, 0) + SEP.length * Math.max(0, cols - 1);

  const padTo = (text: string, w: number): string =>
    text + ' '.repeat(Math.max(0, w - visualWidth(text)));
  // The last column is not padded, so rows carry no trailing spaces.
  const gridRow = (cells: string[]): string =>
    pad + cells.map((cell, c) => (c === cols - 1 ? cell : padTo(cell, colWidth[c] ?? 0))).join(SEP);

  if (gridWidth <= avail) {
    const out = [gridRow(cellsOf(headerNode, ['bold']))];
    const ruleGlyph = caps.unicode ? '─' : '-';
    out.push(pad + paint(caps, 'dim', ruleGlyph.repeat(Math.min(gridWidth, avail))));
    for (const row of body) out.push(gridRow(row));
    return out;
  }

  // A header-only table lists its headers one per line.
  const labels = cellsOf(headerNode, ['secondary']);
  const colon = paint(caps, 'secondary', ':');
  const out: string[] = [];
  if (body.length === 0) {
    for (const label of labels) {
      for (const line of wrapText(label, avail)) out.push(pad + line);
    }
    return out;
  }
  body.forEach((row, i) => {
    if (i > 0) out.push('');
    labels.forEach((label, c) => {
      for (const line of wrapText(`${label}${colon} ${row[c] ?? ''}`, avail)) out.push(pad + line);
    });
  });
  return out;
};

// Item content renders at `indent + marker.length`; the first line swaps that indent for the
// marker so continuation lines align under the text. Blocks inside an item have no blank line
// between them: list items read tight.
const renderList = (node: List, caps: Capabilities, width: number, indent: number): string[] => {
  const out: string[] = [];
  let n = node.start ?? 1;
  for (const item of node.children) {
    const marker = listMarker(node, item, n, caps);
    n += 1;
    const childIndent = indent + marker.length;
    const inner: string[] = [];
    for (const child of item.children) {
      inner.push(...renderBlock(child, caps, width, childIndent));
    }
    if (inner.length === 0) {
      out.push(' '.repeat(indent) + marker);
      continue;
    }
    inner.forEach((line, j) => {
      out.push(j === 0 ? ' '.repeat(indent) + marker + line.slice(childIndent) : line);
    });
  }
  return out;
};

// Every returned line starts with `indent` spaces; `renderList` relies on it to place markers.
const renderBlock = (
  node: RootContent,
  caps: Capabilities,
  width: number,
  indent: number,
): string[] => {
  const pad = ' '.repeat(indent);
  switch (node.type) {
    case 'paragraph':
      return wrapText(renderInline(node.children, caps), width - indent).map((l) => pad + l);
    case 'heading':
      return wrapText(renderInline(node.children, caps, ['bold']), width - indent).map(
        (l) => pad + l,
      );
    case 'code':
      // Indented two columns and dimmed; no syntax highlighting.
      return node.value.split('\n').map((l) => `${pad}  ${paint(caps, 'dim', l)}`);
    case 'blockquote': {
      const bar = paint(caps, 'secondary', caps.unicode ? '│ ' : '| ');
      return renderFlow(node.children, caps, Math.max(1, width - indent - 2), 0).map(
        (l) => pad + bar + l,
      );
    }
    case 'thematicBreak':
      return [
        pad + paint(caps, 'dim', (caps.unicode ? '─' : '-').repeat(Math.max(0, width - indent))),
      ];
    case 'list':
      return renderList(node, caps, width, indent);
    case 'table':
      return renderTable(node, caps, width, indent);
    default:
      // html, definition, footnoteDefinition: the raw value when present, otherwise nothing.
      if ('value' in node && typeof node.value === 'string') {
        return node.value.split('\n').map((l) => pad + l);
      }
      return [];
  }
};

// Blocks separated by one blank line.
const renderFlow = (
  nodes: readonly RootContent[],
  caps: Capabilities,
  width: number,
  indent: number,
): string[] => {
  const out: string[] = [];
  for (const node of nodes) {
    const block = renderBlock(node, caps, width, indent);
    if (block.length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(...block);
  }
  return out;
};

// The source is model output: escape sequences and control bytes are stripped before parsing
// so the text cannot drive the terminal. Empty input yields no lines.
export const renderMarkdown = (src: string, caps: Capabilities): string[] => {
  const tree = parser.parse(stripAnsi(src));
  return renderFlow(tree.children, caps, frameWidth(caps), 0);
};
