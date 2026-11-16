import { shortenCwd } from './render/cwd.ts';
import { formatChipDuration, formatCoarseDuration } from './render/duration.ts';
import { padFrame } from './render/frame.ts';
import { subContentConnector } from './render/glyphs.ts';
import { renderMarkdown } from './render/markdown.ts';
import { visualWidth } from './render/width.ts';
import { wrapInputLine } from './render/wrap.ts';
import type { PermanentItem } from './state.ts';
import { type Capabilities, paint, reverse } from './term.ts';
import { errorSummary, toolSubject, toolVerb } from './tool-labels.ts';

const TOOL_DONE_GLYPH = '●';
const PROMPT_WIDTH = 2;

const turnEndLine = (
  item: Extract<PermanentItem, { kind: 'turn-end' }>,
  caps: Capabilities,
): string => {
  const elapsed = formatCoarseDuration(item.durationMs);
  const detail = item.message === undefined ? '' : `: ${item.message}`;
  switch (item.reason) {
    case 'done':
      return paint(caps, 'secondary', `Worked for ${elapsed}`);
    case 'aborted':
      return paint(caps, 'warn', `Interrupted after ${elapsed}`);
    case 'budget':
      return paint(caps, 'warn', `Stopped after ${elapsed}${detail}`);
    case 'error':
      return paint(caps, 'error', `Failed after ${elapsed}${detail}`);
  }
};

const toolLines = (
  item: Extract<PermanentItem, { kind: 'tool' }>,
  caps: Capabilities,
): string[] => {
  const subject = toolSubject(item.name, item.args);
  const head = `${TOOL_DONE_GLYPH} ${toolVerb(item.name, 'done')}${subject === '' ? '' : ` ${subject}`}`;
  const exitCode = item.meta?.exitCode;
  const exit =
    typeof exitCode === 'number' && exitCode !== 0 ? paint(caps, 'warn', `  exit ${exitCode}`) : '';
  const metric = paint(caps, 'secondary', `  [${formatChipDuration(item.durationMs)}]`);
  const lines = ['', `${paint(caps, item.isError ? 'error' : 'dim', head)}${exit}${metric}`];
  if (item.isError) {
    lines.push(
      padFrame(paint(caps, 'error', `${subContentConnector(caps)}${errorSummary(item.content)}`)),
    );
  }
  return lines;
};

const noticeLines = (
  item: Extract<PermanentItem, { kind: 'notice' }>,
  caps: Capabilities,
): string[] => {
  const lines = item.text.split('\n');
  if (item.level === 'info')
    return ['', ...lines.map((l) => padFrame(paint(caps, 'secondary', l)))];
  const label = item.level === 'warning' ? 'warning: ' : 'error: ';
  const tone = item.level === 'warning' ? 'warn' : 'error';
  return [
    '',
    ...lines.map((l, i) =>
      padFrame(paint(caps, tone, i === 0 ? `${label}${l}` : `${' '.repeat(label.length)}${l}`)),
    ),
  ];
};

// Lines written to the scrollback for an item. Content rows carry the frame margin; tool heads
// start at the margin column so their glyph hangs in the gutter.
export const formatPermanent = (item: PermanentItem, caps: Capabilities): string[] => {
  switch (item.kind) {
    case 'banner': {
      const identity = [
        item.model,
        item.mode,
        ...(item.effort === undefined ? [] : [`effort ${item.effort}`]),
      ].join(' · ');
      const lines = [
        `${paint(caps, 'bold', 'nullrivet')} ${paint(caps, 'secondary', `v${item.version}`)}`,
        paint(caps, 'secondary', identity),
        paint(caps, 'secondary', shortenCwd(item.cwd, item.home, caps)),
      ];
      if (item.instructions > 0) {
        const files = item.instructions === 1 ? 'file' : 'files';
        lines.push(paint(caps, 'secondary', `AGENTS.md: ${item.instructions} ${files} loaded`));
      }
      lines.push(paint(caps, 'secondary', 'Type /help for commands.'));
      return lines.map(padFrame);
    }
    case 'user': {
      // Wrapped like the input box, so every physical row carries the highlighted bar.
      const innerWidth = Math.max(1, caps.cols - PROMPT_WIDTH);
      const rows = item.text.split('\n').flatMap((line, i) => {
        const chunks = line.length === 0 ? [{ start: 0, end: 0 }] : wrapInputLine(line, innerWidth);
        return chunks.map(
          (chunk, c) => `${i === 0 && c === 0 ? '> ' : '  '}${line.slice(chunk.start, chunk.end)}`,
        );
      });
      return [
        '',
        ...rows.map((row) => reverse(row + ' '.repeat(Math.max(0, caps.cols - visualWidth(row))))),
      ];
    }
    case 'assistant':
      return ['', ...renderMarkdown(item.markdown, caps).map(padFrame)];
    case 'tool':
      return toolLines(item, caps);
    case 'turn-end':
      return ['', padFrame(turnEndLine(item, caps))];
    case 'notice':
      return noticeLines(item, caps);
  }
};
