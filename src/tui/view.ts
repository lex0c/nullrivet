import { stripAnsi } from '../sanitize/ansi.ts';
import { shortenCwd } from './render/cwd.ts';
import { formatChipDuration } from './render/duration.ts';
import { padFrame } from './render/frame.ts';
import { inputCursor, renderInput } from './render/input.ts';
import { renderMarkdown } from './render/markdown.ts';
import { renderShimmer } from './render/shimmer.ts';
import { renderSlashPopover } from './render/slash-popover.ts';
import { truncateToWidth, visualWidth } from './render/width.ts';
import type { ScreenFrame } from './screen.ts';
import type { TuiState, TurnState } from './state.ts';
import { type Capabilities, paint } from './term.ts';
import { subjectWidth, toolSubject, toolVerb } from './tool-labels.ts';

const FOOTER_MARGIN = 2;
const MIN_FOOTER_GAP = 2;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_SPINNER_FRAMES = ['|', '/', '-', '\\'];
const SPINNER_FRAME_MS = 80;

export const spinner = (caps: Capabilities, now: number): string => {
  const frames = caps.unicode ? SPINNER_FRAMES : ASCII_SPINNER_FRAMES;
  return frames[Math.floor(now / SPINNER_FRAME_MS) % frames.length] ?? '*';
};

export const formatTokens = (n: number): string => {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

const rule = (caps: Capabilities): string =>
  paint(caps, 'dim', (caps.unicode ? '─' : '-').repeat(Math.max(0, caps.cols)));

// The pending block is redrawn on every animation frame while its text changes far less often,
// so the last rendering is reused until the text or the terminal changes.
let pendingCache: { text: string; cols: number; color: string; lines: string[] } | null = null;

const renderPending = (text: string, caps: Capabilities): string[] => {
  const cached = pendingCache;
  if (
    cached !== null &&
    cached.text === text &&
    cached.cols === caps.cols &&
    cached.color === caps.color
  ) {
    return cached.lines;
  }
  const lines = renderMarkdown(text, caps).map(padFrame);
  pendingCache = { text, cols: caps.cols, color: caps.color, lines };
  return lines;
};

const compactingChip = (since: number, caps: Capabilities, now: number): string =>
  `${paint(caps, 'accent', spinner(caps, now))} ${renderShimmer('Compacting context…', caps, now, 'secondary')} ${paint(caps, 'dim', `(${formatChipDuration(now - since)})`)}`;

const phaseChip = (state: TuiState, turn: TurnState, caps: Capabilities, now: number): string => {
  if (state.compacting !== null) return compactingChip(state.compacting.since, caps, now);
  const elapsed = formatChipDuration(now - turn.startedAt);
  let label: string;
  if (turn.interrupting) label = 'Interrupting…';
  else if (turn.tools.length > 0) label = 'Working…';
  else if (turn.thinkingSince !== null) label = 'Thinking…';
  else if (turn.pendingText.length > 0 || turn.outputChars > 0) label = 'Writing…';
  else label = 'Waiting for the model…';
  const details = [elapsed];
  if (turn.interrupting) details.push('ctrl+c to exit');
  if (turn.outputChars > 0)
    details.push(`↓ ~${formatTokens(Math.ceil(turn.outputChars / 4))} tokens`);
  return `${paint(caps, 'accent', spinner(caps, now))} ${renderShimmer(label, caps, now, 'secondary')} ${paint(caps, 'dim', `(${details.join(' · ')})`)}`;
};

const turnRows = (state: TuiState, turn: TurnState, caps: Capabilities, now: number): string[] => {
  const rows: string[] = [];
  if (turn.pendingText.trim().length > 0) {
    rows.push('', ...renderPending(turn.pendingText, caps));
  }
  for (const tool of turn.tools) {
    const subject = toolSubject(tool.name, tool.args, subjectWidth(caps));
    const elapsed = paint(caps, 'secondary', `  [${formatChipDuration(now - tool.startedAt)}]`);
    rows.push(
      '',
      `${paint(caps, 'accent', spinner(caps, now))} ${toolVerb(tool.name, 'running')} ${subject}${elapsed}`,
    );
  }
  rows.push('', padFrame(phaseChip(state, turn, caps, now)));
  return rows;
};

const contextLabel = (state: TuiState, caps: Capabilities): string | null => {
  const { contextTokens, contextWindow } = state.status;
  if (contextTokens === null || contextWindow <= 0) return null;
  const percent = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
  const tone = percent >= 95 ? 'error' : percent >= 80 ? 'warn' : 'secondary';
  return paint(caps, tone, `ctx ${percent}%`);
};

const footerRow = (state: TuiState, caps: Capabilities): string => {
  const sep = paint(caps, 'dim', ' · ');
  let left: string;
  if (state.exitArmedAt !== null) {
    left = paint(caps, 'warn', 'Press Ctrl+C again to exit');
  } else {
    const mode =
      state.status.mode === 'auto'
        ? paint(caps, 'warn', 'auto')
        : paint(caps, 'accent', 'readonly');
    const hint = state.turn !== null ? 'esc to interrupt' : '/help for commands';
    left = `${mode}${sep}${paint(caps, 'dim', hint)}`;
  }
  // Right-side parts in order of importance; the least important are dropped first when the
  // row is too narrow, and the model name is shortened last.
  const totals = state.status.totals;
  const parts = [
    stripAnsi(state.status.model),
    ...(state.status.effort === undefined ? [] : [`effort ${state.status.effort}`]),
  ].map((text) => paint(caps, 'secondary', text));
  const context = contextLabel(state, caps);
  if (context !== null) parts.push(context);
  if (totals.requests > 0) {
    const inputTokens = totals.input + totals.cacheRead + totals.cacheWrite;
    parts.push(
      paint(caps, 'secondary', `↑${formatTokens(inputTokens)} ↓${formatTokens(totals.output)}`),
    );
  }
  const available = caps.cols - FOOTER_MARGIN - visualWidth(left) - MIN_FOOTER_GAP;
  while (parts.length > 1 && visualWidth(parts.join(sep)) > available) parts.pop();
  let right = parts.join(sep);
  if (visualWidth(right) > available) {
    right = available > 1 ? `${truncateToWidth(right, available - 1)}…` : '';
  }
  const gap = caps.cols - FOOTER_MARGIN - visualWidth(left) - visualWidth(right);
  if (right.length === 0 || gap < MIN_FOOTER_GAP) {
    return padFrame(truncateToWidth(left, caps.cols - FOOTER_MARGIN));
  }
  return padFrame(`${left}${' '.repeat(gap)}${right}`);
};

// The live region: the turn in progress, the input box and the status rows. It is redrawn on
// every change, while finished content is written to the scrollback by the caller.
export const composeLive = (state: TuiState, caps: Capabilities, now: number): ScreenFrame => {
  const rows: string[] =
    state.turn !== null
      ? turnRows(state, state.turn, caps, now)
      : state.compacting !== null
        ? ['', padFrame(compactingChip(state.compacting.since, caps, now))]
        : [];
  rows.push('', rule(caps));
  const inputTop = rows.length;
  rows.push(
    ...renderInput(
      state.input,
      caps,
      state.slash?.hint === undefined ? {} : { commandGhost: state.slash.hint },
    ),
  );
  rows.push(rule(caps));
  if (state.slash !== null && state.slash.items.length > 0) {
    rows.push(...renderSlashPopover(state.slash, caps).map(padFrame));
  }
  rows.push(footerRow(state, caps));
  const cwd = stripAnsi(shortenCwd(state.status.cwd, state.status.home, caps));
  rows.push(padFrame(paint(caps, 'dim', cwd)));
  const cursor = inputCursor(state.input, caps);
  return { rows, cursor: { row: inputTop + cursor.row, col: cursor.col } };
};
