import { SUMMARY_OPEN } from '../context/compaction.ts';
import { isProviderFamily } from '../providers/resolve.ts';
import type { ProviderContentBlock, ProviderMessage } from '../providers/types.ts';
import type { SummaryState } from './conversation.ts';

// The state of a conversation, enough to continue it: the history as the agent keeps it and what
// earlier compactions preserved. It is plain data, so it can be written out and read back.
export interface ConversationSnapshot {
  messages: ProviderMessage[];
  summary: SummaryState | null;
}

export type SnapshotResult =
  | { ok: true; snapshot: ConversationSnapshot }
  | { ok: false; error: string };

class InvalidSnapshot extends Error {}

const fail = (message: string): never => {
  throw new InvalidSnapshot(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const string = (value: unknown, where: string): string =>
  typeof value === 'string' ? value : fail(`${where} must be a string`);

const strings = (value: unknown, where: string): string[] =>
  Array.isArray(value)
    ? value.map((item, i) => string(item, `${where}[${i}]`))
    : fail(`${where} must be an array`);

// Blocks are rebuilt from their known fields only, so nothing that is not part of the history
// (a cache hint, a field from a newer version) reaches a provider.
const block = (value: unknown, where: string): ProviderContentBlock => {
  if (!isRecord(value)) return fail(`${where} must be an object`);
  switch (value.type) {
    case 'text':
      return { type: 'text', text: string(value.text, `${where}.text`) };
    case 'tool_use':
      if (!isRecord(value.input)) return fail(`${where}.input must be an object`);
      return {
        type: 'tool_use',
        id: string(value.id, `${where}.id`),
        name: string(value.name, `${where}.name`),
        input: value.input,
      };
    case 'tool_result': {
      const result: ProviderContentBlock = {
        type: 'tool_result',
        tool_use_id: string(value.tool_use_id, `${where}.tool_use_id`),
        content: string(value.content, `${where}.content`),
      };
      if (value.name !== undefined) result.name = string(value.name, `${where}.name`);
      if (value.is_error !== undefined) {
        if (typeof value.is_error !== 'boolean') fail(`${where}.is_error must be a boolean`);
        result.is_error = value.is_error === true;
      }
      return result;
    }
    case 'reasoning':
      if (typeof value.provider !== 'string' || !isProviderFamily(value.provider)) {
        return fail(`${where}.provider is not a known provider family`);
      }
      return { type: 'reasoning', provider: value.provider, data: value.data };
    default:
      return fail(`${where}.type is not a known block type`);
  }
};

const message = (value: unknown, where: string): ProviderMessage => {
  if (!isRecord(value)) return fail(`${where} must be an object`);
  if (value.role !== 'user' && value.role !== 'assistant') {
    return fail(`${where}.role must be user or assistant`);
  }
  if (typeof value.content === 'string') return { role: value.role, content: value.content };
  if (!Array.isArray(value.content) || value.content.length === 0) {
    return fail(`${where}.content must be a string or a non-empty array of blocks`);
  }
  return {
    role: value.role,
    content: value.content.map((item, i) => block(item, `${where}.content[${i}]`)),
  };
};

const blocksOf = (m: ProviderMessage): ProviderContentBlock[] =>
  typeof m.content === 'string' ? [] : m.content;

// The invariants the conversation keeps in memory: the history starts with the user, roles
// alternate, tool calls appear only in assistant messages and results only in user messages, and
// every call is answered by the next message, except calls of the last message (a turn that was
// interrupted), which the conversation answers before the next prompt.
const checkStructure = (messages: readonly ProviderMessage[], summary: SummaryState | null) => {
  if (messages.length === 0) {
    if (summary !== null) fail('a summary without messages');
    return;
  }
  if (messages[0]?.role !== 'user') fail('messages must start with a user message');
  for (const [i, m] of messages.entries()) {
    if (i > 0 && messages[i - 1]?.role === m.role)
      fail(`messages[${i}] repeats the role ${m.role}`);
    for (const b of blocksOf(m)) {
      if (b.type === 'tool_use' && m.role !== 'assistant') {
        fail(`messages[${i}] has a tool call outside an assistant message`);
      }
      if (b.type === 'tool_result' && m.role !== 'user') {
        fail(`messages[${i}] has a tool result outside a user message`);
      }
    }
  }
  for (const [i, m] of messages.entries()) {
    if (m.role !== 'user') continue;
    const previous = i > 0 ? messages[i - 1] : undefined;
    const calls = new Set(
      previous === undefined
        ? []
        : blocksOf(previous).flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])),
    );
    const answered = new Set<string>();
    for (const b of blocksOf(m)) {
      if (b.type !== 'tool_result') continue;
      if (!calls.has(b.tool_use_id)) {
        fail(`messages[${i}] answers a tool call the previous message did not make`);
      }
      answered.add(b.tool_use_id);
    }
    for (const id of calls) {
      if (!answered.has(id)) fail(`messages[${i}] does not answer tool call ${id}`);
    }
  }
  // A compacted history starts with the summary block, which compaction removes and rewrites.
  if (summary !== null) {
    const head = blocksOf(messages[0] as ProviderMessage)[0];
    if (head?.type !== 'text' || !head.text.startsWith(SUMMARY_OPEN)) {
      fail('a summary is present but the first message does not start with it');
    }
  }
};

const summaryState = (value: unknown): SummaryState | null => {
  if (value === null) return null;
  if (!isRecord(value)) return fail('summary must be an object or null');
  const omitted = value.omittedRequests;
  if (typeof omitted !== 'number' || !Number.isSafeInteger(omitted) || omitted < 0) {
    fail('summary.omittedRequests must be a non-negative integer');
  }
  return {
    llmSummary: string(value.llmSummary, 'summary.llmSummary'),
    userRequests: strings(value.userRequests, 'summary.userRequests'),
    omittedRequests: omitted as number,
    filesRead: strings(value.filesRead, 'summary.filesRead'),
    filesModified: strings(value.filesModified, 'summary.filesModified'),
  };
};

// Checks data read back from outside the process. Anything that breaks an invariant is refused
// rather than repaired: a history the agent did not produce is not continued.
export const parseConversationSnapshot = (value: unknown): SnapshotResult => {
  try {
    if (!isRecord(value)) return fail('the conversation must be an object');
    if (!Array.isArray(value.messages)) return fail('messages must be an array');
    const messages = value.messages.map((item, i) => message(item, `messages[${i}]`));
    const summary = summaryState(value.summary ?? null);
    checkStructure(messages, summary);
    return { ok: true, snapshot: { messages, summary } };
  } catch (error) {
    if (error instanceof InvalidSnapshot) return { ok: false, error: error.message };
    throw error;
  }
};
