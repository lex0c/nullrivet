import { AGENT_NOTE_OPEN, type SummaryState } from '../agent/conversation.ts';
import { contentBlocks, type ProviderMessage, type ProviderTextBlock } from '../providers/types.ts';
import { estimateMessagesTokens } from './tokens.ts';

export const SUMMARY_OPEN = '[compacted_history]';
export const SUMMARY_CLOSE = '[/compacted_history]';

// Sections the summarizer must produce, most important first so a summary cut short by the
// output limit loses the least important ones.
export const SUMMARY_SECTIONS = [
  'GOAL',
  'CONSTRAINTS',
  'NEXT',
  'PROGRESS',
  'ERRORS',
  'DECISIONS',
  'ANCHORS',
  'REJECTED',
] as const;

const REQUEST_MAX_CHARS = 2_000;
const REQUESTS_TOTAL_CHARS = 8_000;
const MAX_LISTED_FILES = 100;
const TRANSCRIPT_RESULT_CHARS = 2_000;
const TRANSCRIPT_ERROR_CHARS = 4_000;
const TRANSCRIPT_ARG_CHARS = 400;
const TAIL_RESULT_CHARS = 2_000;

export const emptySummary = (): SummaryState => ({
  llmSummary: '',
  userRequests: [],
  omittedRequests: 0,
  filesRead: [],
  filesModified: [],
});

// Keeps the start and the end of long text, which usually carry the command and its outcome.
// The result, marker included, never exceeds `max` characters.
export const clipMiddle = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const marker = (omitted: number): string => `\n[... ${omitted} characters omitted ...]\n`;
  // Sized with the longest possible count so the final marker can only be shorter.
  const keep = Math.max(0, max - marker(text.length).length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}${marker(text.length - keep)}${tail > 0 ? text.slice(-tail) : ''}`;
};

const isPrompt = (message: ProviderMessage): boolean =>
  message.role === 'user' && contentBlocks(message.content).every((b) => b.type === 'text');

// Messages where the kept tail may start: never a message holding tool results, which would
// lose the tool calls they answer.
const isCutPoint = (message: ProviderMessage): boolean =>
  message.role === 'assistant' || isPrompt(message);

// The conversation without the summary block that heads it after an earlier compaction.
export const bodyOf = (
  history: readonly ProviderMessage[],
  compacted: boolean,
): ProviderMessage[] => {
  const [head, ...rest] = history;
  if (!compacted || head === undefined) return [...history];
  const blocks = contentBlocks(head.content).slice(1);
  return blocks.length > 0 ? [{ role: 'user', content: blocks }, ...rest] : rest;
};

// Index of the first message kept verbatim. The tail fits `tailBudget` when possible, starts at a
// prompt when one is available, and is never empty, so the latest exchange stays literal. Null
// when there is nothing before the last cut point to summarize.
export const chooseCut = (
  body: readonly ProviderMessage[],
  tailBudget: number,
  countReasoning: boolean,
): number | null => {
  let earliestFitting = body.length;
  let suffixTokens = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const message = body[i];
    if (message === undefined) break;
    suffixTokens += estimateMessagesTokens([message], { countReasoning });
    if (suffixTokens > tailBudget) break;
    earliestFitting = i;
  }
  const cuts: number[] = [];
  for (let i = 1; i < body.length; i++) {
    const message = body[i];
    if (message !== undefined && isCutPoint(message)) cuts.push(i);
  }
  if (cuts.length === 0) return null;
  const fitting = cuts.filter((i) => i >= earliestFitting);
  const promptCut = fitting.find((i) => {
    const message = body[i];
    return message !== undefined && isPrompt(message);
  });
  return promptCut ?? fitting[0] ?? cuts.at(-1) ?? null;
};

const textBlocks = (message: ProviderMessage): string[] =>
  contentBlocks(message.content)
    .filter((b): b is ProviderTextBlock => b.type === 'text')
    .map((b) => b.text);

const toolPaths = (span: readonly ProviderMessage[], names: readonly string[]): string[] => {
  const paths: string[] = [];
  for (const message of span) {
    if (message.role !== 'assistant') continue;
    for (const block of contentBlocks(message.content)) {
      if (block.type !== 'tool_use' || !names.includes(block.name)) continue;
      const path = block.input.path;
      if (typeof path === 'string' && path.length > 0) paths.push(path);
    }
  }
  return paths;
};

// Most recent first, without duplicates.
const mergeRecent = (previous: readonly string[], added: readonly string[]): string[] => {
  const merged: string[] = [];
  for (const item of [...[...added].reverse(), ...previous]) {
    if (!merged.includes(item)) merged.push(item);
  }
  return merged.slice(0, MAX_LISTED_FILES);
};

// Requests typed by the user stay verbatim because they are short and are the strongest signal
// of intent. Notes the agent added on its own are not requests.
export const userRequestsIn = (span: readonly ProviderMessage[]): string[] =>
  span
    .filter((m) => m.role === 'user')
    .flatMap(textBlocks)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !t.startsWith(AGENT_NOTE_OPEN))
    .map((t) => clipMiddle(t, REQUEST_MAX_CHARS));

// Updates the parts of the summary that are derived from the conversation by code, never by the
// model, so they cannot be lost or invented by a poor summary.
export const updateDeterministic = (
  previous: SummaryState,
  span: readonly ProviderMessage[],
): Omit<SummaryState, 'llmSummary'> => {
  const requests = [...previous.userRequests, ...userRequestsIn(span)];
  let omitted = previous.omittedRequests;
  while (requests.length > 1 && requests.join('').length > REQUESTS_TOTAL_CHARS) {
    requests.shift();
    omitted += 1;
  }
  return {
    userRequests: requests,
    omittedRequests: omitted,
    filesRead: mergeRecent(previous.filesRead, toolPaths(span, ['read_file'])),
    filesModified: mergeRecent(
      previous.filesModified,
      toolPaths(span, ['write_file', 'edit_file']),
    ),
  };
};

const argsForTranscript = (input: Record<string, unknown>): string => {
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    shown[key] =
      typeof value === 'string' && value.length > TRANSCRIPT_ARG_CHARS
        ? `[${value.length} characters]`
        : value;
  }
  return JSON.stringify(shown);
};

// Labels make the transcript read as material to summarize rather than a conversation to continue.
export const serializeMessage = (message: ProviderMessage): string => {
  const lines: string[] = [];
  for (const block of contentBlocks(message.content)) {
    if (block.type === 'text') {
      const label =
        message.role === 'assistant'
          ? '[Assistant]'
          : block.text.startsWith(AGENT_NOTE_OPEN)
            ? '[Note]'
            : '[User]';
      lines.push(`${label} ${block.text}`);
    } else if (block.type === 'tool_use') {
      lines.push(`[Tool call] ${block.name} ${argsForTranscript(block.input)}`);
    } else if (block.type === 'tool_result') {
      const limit = block.is_error === true ? TRANSCRIPT_ERROR_CHARS : TRANSCRIPT_RESULT_CHARS;
      const label = `[Tool result${block.name === undefined ? '' : ` ${block.name}`}${block.is_error === true ? ', error' : ''}]`;
      lines.push(`${label}\n${clipMiddle(block.content, limit)}`);
    }
  }
  return lines.join('\n');
};

// Groups the span into transcript chunks of at most `maxChars`, split at message boundaries, so a
// span too large for one summarizer request is summarized in sequence.
export const transcriptChunks = (span: readonly ProviderMessage[], maxChars: number): string[] => {
  const chunks: string[] = [];
  let current = '';
  for (const message of span) {
    const text = clipMiddle(serializeMessage(message), maxChars);
    if (text.length === 0) continue;
    if (current.length > 0 && current.length + text.length + 2 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current = current.length === 0 ? text : `${current}\n\n${text}`;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

// A summary without the expected sections is treated as a failure (a refusal, an answer to the
// transcript instead of a summary).
// Headings may carry Markdown decoration (`**GOAL:**`, `## GOAL`, `- GOAL`).
export const isUsableSummary = (text: string): boolean =>
  SUMMARY_SECTIONS.filter((section) => new RegExp(`^[\\s>#*_-]*${section}\\b`, 'm').test(text))
    .length >= 3;

const list = (items: readonly string[]): string =>
  items.length === 0 ? '(none)' : items.join(', ');

export const renderSummary = (state: SummaryState): string => {
  const requests = state.userRequests.map((r) => `- ${r.replace(/\n/g, '\n  ')}`);
  if (state.omittedRequests > 0) {
    requests.unshift(
      `(${state.omittedRequests} earlier ${state.omittedRequests === 1 ? 'request' : 'requests'} omitted)`,
    );
  }
  return [
    SUMMARY_OPEN,
    'Earlier parts of this conversation were compacted. This is what they contained.',
    '',
    state.llmSummary.replaceAll(SUMMARY_CLOSE, '').trim() || '(no summary available)',
    '',
    'USER_REQUESTS (verbatim, oldest first):',
    ...(requests.length === 0 ? ['(none)'] : requests),
    `FILES_READ: ${list(state.filesRead)}`,
    `FILES_MODIFIED: ${list(state.filesModified)}`,
    SUMMARY_CLOSE,
  ].join('\n');
};

// The summary heads the history as the first block of a user message. When the tail starts with
// a prompt, the prompt joins that message so roles keep alternating.
export const assembleHistory = (
  state: SummaryState,
  tail: readonly ProviderMessage[],
): ProviderMessage[] => {
  const head: ProviderTextBlock = { type: 'text', text: renderSummary(state) };
  const [first, ...rest] = tail;
  if (first !== undefined && first.role === 'user') {
    return [{ role: 'user', content: [head, ...contentBlocks(first.content)] }, ...rest];
  }
  return [{ role: 'user', content: [head] }, ...tail];
};

// Shortens tool results in the kept tail when the compacted conversation is still above its
// target. Errors and the latest results stay intact because they drive the next step, unless
// `keepLatest` is off: the last resort when the latest exchange alone is too large.
export const reduceTail = (
  tail: readonly ProviderMessage[],
  options: { keepLatest?: boolean } = {},
): ProviderMessage[] => {
  const keepLatest = options.keepLatest ?? true;
  let lastResults = -1;
  tail.forEach((m, i) => {
    if (m.role === 'user' && contentBlocks(m.content).some((b) => b.type === 'tool_result'))
      lastResults = i;
  });
  return tail.map((message, i) => {
    if (
      (keepLatest && i === lastResults) ||
      message.role !== 'user' ||
      typeof message.content === 'string'
    ) {
      return message;
    }
    return {
      role: 'user',
      content: message.content.map((block) =>
        block.type === 'tool_result' && block.is_error !== true
          ? { ...block, content: clipMiddle(block.content, TAIL_RESULT_CHARS) }
          : block,
      ),
    };
  });
};
