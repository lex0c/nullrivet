import wrapAnsi from 'wrap-ansi';
import { stripAnsi } from '../sanitize/ansi.ts';
import { shortenCwd } from './render/cwd.ts';
import { formatChipDuration, formatCoarseDuration } from './render/duration.ts';
import { frameWidth, padFrame } from './render/frame.ts';
import { subContentConnector } from './render/glyphs.ts';
import { displayText } from './render/input.ts';
import { renderMarkdown } from './render/markdown.ts';
import { visualWidth } from './render/width.ts';
import { wrapInputLine } from './render/wrap.ts';
import type { PermanentItem } from './state.ts';
import { type Capabilities, paint, reverse } from './term.ts';
import { errorSummary, subjectWidth, toolSubject, toolVerb } from './tool-labels.ts';

const TOOL_DONE_GLYPH = '●';

// Messages from providers, commands and paths can contain escape sequences; printed as they are,
// the terminal would execute them. Carriage returns would overwrite the start of the row.
const clean = (text: string): string => stripAnsi(text).replace(/\r/g, '');
const PROMPT_WIDTH = 2;

const turnEndLine = (
  item: Extract<PermanentItem, { kind: 'turn-end' }>,
  caps: Capabilities,
): string => {
  const elapsed = formatCoarseDuration(item.durationMs);
  const detail = item.message === undefined ? '' : `: ${clean(item.message)}`;
  switch (item.reason) {
    case 'done':
      return paint(caps, 'secondary', `Worked for ${elapsed}`);
    case 'aborted':
      return paint(caps, 'warn', `Interrupted after ${elapsed}`);
    case 'budget':
      return paint(caps, 'warn', `Stopped after ${elapsed}${detail}`);
    // The failure itself was already shown by the error event that precedes the end of the turn.
    case 'error':
      return paint(caps, 'error', `Failed after ${elapsed}`);
  }
};

const toolLines = (
  item: Extract<PermanentItem, { kind: 'tool' }>,
  caps: Capabilities,
): string[] => {
  const subject = toolSubject(item.name, item.args, subjectWidth(caps));
  const head = `${TOOL_DONE_GLYPH} ${toolVerb(item.name, 'done')}${subject === '' ? '' : ` ${subject}`}`;
  const exitCode = item.meta?.exitCode;
  const exit =
    typeof exitCode === 'number' && exitCode !== 0 ? paint(caps, 'warn', `  exit ${exitCode}`) : '';
  const metric = paint(caps, 'secondary', `  [${formatChipDuration(item.durationMs)}]`);
  const lines = ['', `${paint(caps, item.isError ? 'error' : 'dim', head)}${exit}${metric}`];
  if (item.isError) {
    lines.push(
      padFrame(
        paint(
          caps,
          'error',
          `${subContentConnector(caps)}${errorSummary(item.content, frameWidth(caps) - 3)}`,
        ),
      ),
    );
  }
  return lines;
};

const noticeLines = (
  item: Extract<PermanentItem, { kind: 'notice' }>,
  caps: Capabilities,
): string[] => {
  const label = item.level === 'info' ? '' : item.level === 'warning' ? 'warning: ' : 'error: ';
  const tone = item.level === 'info' ? 'secondary' : item.level === 'warning' ? 'warn' : 'error';
  // Wrapped here so continuation rows keep the margin instead of starting at column 0.
  const width = Math.max(10, frameWidth(caps) - label.length);
  const lines = clean(item.text)
    .split('\n')
    .flatMap((line) => wrapAnsi(line, width, { hard: true, trim: false }).split('\n'));
  return [
    '',
    ...lines.map((line, i) =>
      padFrame(paint(caps, tone, `${i === 0 ? label : ' '.repeat(label.length)}${line}`)),
    ),
  ];
};

// Lines written to the scrollback for an item. Content rows carry the frame margin; tool heads
// start at the margin column so their glyph hangs in the gutter.
export const formatPermanent = (item: PermanentItem, caps: Capabilities): string[] => {
  switch (item.kind) {
    case 'banner': {
      const identity = [
        clean(item.model),
        item.mode,
        ...(item.effort === undefined ? [] : [`effort ${item.effort}`]),
      ].join(' · ');
      const lines = [
        `${paint(caps, 'bold', 'nullrivet')} ${paint(caps, 'secondary', `v${item.version}`)}`,
        paint(caps, 'secondary', identity),
        paint(caps, 'secondary', clean(shortenCwd(item.cwd, item.home, caps))),
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
      const rows = displayText(item.text)
        .split('\n')
        .flatMap((line, i) => {
          const chunks =
            line.length === 0 ? [{ start: 0, end: 0 }] : wrapInputLine(line, innerWidth);
          return chunks.map(
            (chunk, c) =>
              `${i === 0 && c === 0 ? '> ' : '  '}${line.slice(chunk.start, chunk.end)}`,
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
