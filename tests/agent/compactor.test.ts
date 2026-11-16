import { describe, expect, test } from 'bun:test';
import { compactConversation } from '../../src/agent/compactor.ts';
import { Conversation, type PromptShape } from '../../src/agent/conversation.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import { SUMMARY_OPEN } from '../../src/context/compaction.ts';
import type { ProviderMessage } from '../../src/providers/types.ts';
import { createMockProvider, type ScriptedTurn, textTurn } from '../helpers/mock-provider.ts';

const shape: PromptShape = {
  key: 'k',
  system: 'system',
  context: '',
  tools: [],
  countReasoning: false,
};

const SUMMARY = 'GOAL:\nfix the parser\nNEXT:\nadd tests\nERRORS:\n(none)\nDECISIONS:\nkeep API';
// The span may be summarized in several requests, one per transcript chunk.
const summaries = (text = SUMMARY): ScriptedTurn[] => [
  textTurn(text),
  textTurn(text),
  textTurn(text),
];

const filled = (): Conversation => {
  const c = new Conversation();
  for (let i = 0; i < 6; i++) {
    c.appendUser(`request ${i} ${'p'.repeat(500)}`);
    c.appendAssistant([
      { type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `f${i}.ts` } },
    ]);
    c.appendToolResults([
      { type: 'tool_result', tool_use_id: `t${i}`, content: 'r'.repeat(8_000) },
    ]);
    c.appendAssistant([{ type: 'text', text: `answer ${i}` }]);
  }
  return c;
};

const run = async (
  conversation: Conversation,
  turns: ScriptedTurn[],
  options: { signal?: AbortSignal; instructions?: string } = {},
) => {
  const provider = createMockProvider(turns, { context_window: 16_000, output_max_tokens: 4_000 });
  const events: AgentEvent[] = [];
  const outcome = await compactConversation({
    provider,
    conversation,
    shape,
    reason: 'manual',
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    emit: (e) => events.push(e),
    signal: options.signal ?? new AbortController().signal,
  });
  return { provider, events, outcome };
};

const firstText = (m: ProviderMessage | undefined): string =>
  Array.isArray(m?.content) && m.content[0]?.type === 'text' ? m.content[0].text : '';

describe('compactConversation', () => {
  test('replaces the older part with a summary and keeps the latest exchange', async () => {
    const conversation = filled();
    const before = conversation.messages().length;
    const { outcome, events } = await run(conversation, summaries());
    expect(outcome?.strategy).toBe('llm');
    expect(outcome?.after).toBeLessThan(outcome?.before ?? 0);
    const history = conversation.messages();
    expect(history.length).toBeLessThan(before);
    const head = firstText(history[0]);
    expect(head).toStartWith(SUMMARY_OPEN);
    expect(head).toContain('fix the parser');
    expect(head).toContain('- request 0');
    expect(head).toContain('FILES_READ: f');
    expect(history.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer 5' }],
    });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('context:compact:start');
    expect(types.at(-1)).toBe('context:compact');
    expect(types.filter((t) => t === 'usage').length).toBeGreaterThan(0);
  });

  test('a second compaction updates the previous summary instead of discarding it', async () => {
    const conversation = filled();
    await run(conversation, summaries());
    for (let i = 6; i < 10; i++) {
      conversation.appendUser(`request ${i} ${'p'.repeat(500)}`);
      conversation.appendAssistant([{ type: 'text', text: `answer ${i} ${'a'.repeat(8_000)}` }]);
    }
    const { provider } = await run(conversation, summaries(`${SUMMARY}\nPROGRESS:\nmore`));
    const request = provider.calls[0]?.req.messages[0]?.content;
    const input = JSON.parse(typeof request === 'string' ? request : '{}') as {
      previous_summary?: string;
    };
    expect(input.previous_summary).toStartWith('GOAL:\nfix the parser');
    const head = firstText(conversation.messages()[0]);
    expect(head).toContain('- request 0');
    expect(head).toContain('- request 6');
    expect(head.match(/\[compacted_history\]/g)).toHaveLength(1);
  });

  test('a section the second summary omits keeps what the first one recorded', async () => {
    const conversation = filled();
    await run(conversation, summaries());
    for (let i = 6; i < 10; i++) {
      conversation.appendUser(`request ${i} ${'p'.repeat(500)}`);
      conversation.appendAssistant([{ type: 'text', text: `answer ${i} ${'a'.repeat(8_000)}` }]);
    }
    await run(conversation, summaries('GOAL:\nfix the parser\nNEXT:\nmore tests\nERRORS:\n(none)'));
    expect(conversation.summary()?.llmSummary).toContain(
      'DECISIONS (from the previous summary):\nkeep API',
    );
  });

  test('passes the focus requested with /compact', async () => {
    const { provider } = await run(filled(), summaries(), { instructions: 'the parser' });
    const request = provider.calls[0]?.req.messages[0]?.content;
    const input = JSON.parse(typeof request === 'string' ? request : '{}') as {
      focus?: string;
      transcript?: { role: string }[];
    };
    expect(input.focus).toBe('the parser');
    expect(input.transcript?.[0]?.role).toBe('user');
  });

  test('falls back to the deterministic sections when the summary is unusable', async () => {
    const conversation = filled();
    const { outcome } = await run(conversation, summaries('I cannot help with that.'));
    expect(outcome?.strategy).toBe('fallback');
    const head = firstText(conversation.messages()[0]);
    expect(head).toContain('could not be summarized');
    expect(head).toContain('- request 0');
  });

  test('a provider failure also falls back', async () => {
    const conversation = filled();
    const failure = Object.assign(new Error('bad request'), { status: 400 });
    const { outcome, events } = await run(conversation, [failure]);
    expect(outcome?.strategy).toBe('fallback');
    expect(events.some((e) => e.type === 'warning')).toBe(true);
  });

  test('an abort leaves the conversation unchanged', async () => {
    const conversation = filled();
    const snapshot = [...conversation.messages()];
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(conversation, [textTurn(SUMMARY)], { signal: controller.signal }),
    ).rejects.toThrow();
    expect(conversation.messages()).toEqual(snapshot);
    expect(conversation.summary()).toBeNull();
  });

  test('returns null when there is nothing to compact', async () => {
    const conversation = new Conversation();
    conversation.appendUser('hello');
    const { outcome, provider } = await run(conversation, []);
    expect(outcome).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  test('the summary request has no tools and a bounded output', async () => {
    const { provider } = await run(filled(), summaries());
    const req = provider.calls[0]?.req;
    expect(req?.tools).toBeUndefined();
    expect(req?.max_tokens).toBe(4_000);
    expect(req?.system).toContain('GOAL:');
  });
});

describe('summary request on reasoning models', () => {
  test('asks for the lowest effort and leaves room beyond the summary text', async () => {
    const provider = createMockProvider(
      Array.from({ length: 10 }, () => textTurn(SUMMARY)),
      {
        context_window: 200_000,
        output_max_tokens: 32_768,
        supports_reasoning_effort: true,
        supports_sampling: false,
      },
    );
    await compactConversation({
      provider,
      conversation: filled(),
      shape,
      reason: 'manual',
      emit: () => undefined,
      signal: new AbortController().signal,
    });
    const req = provider.calls[0]?.req;
    expect(req?.effort).toBe('low');
    expect(req?.max_tokens).toBe(8_192);
    expect(req?.temperature).toBeUndefined();
  });

  test('a summary stream that goes silent falls back instead of hanging', async () => {
    const provider = createMockProvider([], { context_window: 16_000, output_max_tokens: 4_000 });
    let cancelled = false;
    provider.generate = async function* (_req, signal) {
      yield { kind: 'start', message_id: 'm' };
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => {
          cancelled = true;
          resolve();
        }),
      );
    };
    const conversation = filled();
    const outcome = await compactConversation({
      provider,
      conversation,
      shape,
      reason: 'auto',
      stallMs: 30,
      emit: () => undefined,
      signal: new AbortController().signal,
    });
    expect(outcome?.strategy).toBe('fallback');
    expect(cancelled).toBe(true);
  });
});

describe('Conversation measurement', () => {
  test('starts from the reported prompt size and estimates only what came after it', () => {
    const c = new Conversation();
    c.appendUser('x'.repeat(40_000));
    c.recordPromptUsage(9_000, shape);
    expect(c.estimateTokens(shape)).toBe(9_000);
    c.appendAssistant([{ type: 'text', text: 'y'.repeat(400) }]);
    expect(c.estimateTokens(shape)).toBe(9_100);
    expect(c.estimateTokens({ ...shape, key: 'other' })).toBeGreaterThan(10_000);
  });

  test('a report far below the estimate is treated as incomplete', () => {
    const c = new Conversation();
    c.appendUser('x'.repeat(40_000));
    // A server that reports only the tokens it did not reuse from its cache.
    c.recordPromptUsage(600, shape);
    expect(c.estimateTokens(shape)).toBeGreaterThan(10_000);
  });
});
