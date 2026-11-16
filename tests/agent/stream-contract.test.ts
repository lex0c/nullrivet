import { describe, expect, test } from 'bun:test';
import { abortableIterable, stallWatchdog } from '../../src/agent/abortable.ts';
import { buildAssistantContent } from '../../src/agent/assistant-content.ts';
import { collectStep } from '../../src/agent/collect.ts';
import { generateWithRetry } from '../../src/agent/retry.ts';
import { createMockProvider, textTurn, toolTurn } from '../helpers/mock-provider.ts';

const req = {
  model: 'mock/model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  max_tokens: 100,
};

// The composition the agent loop uses for every provider step.
const runStep = (provider: ReturnType<typeof createMockProvider>, signal: AbortSignal) =>
  collectStep(
    abortableIterable(stallWatchdog(generateWithRetry(provider, req, signal), 1_000), signal),
  );

describe('provider step pipeline', () => {
  test('collects a text turn into one assistant text block', async () => {
    const provider = createMockProvider([textTurn('hello')]);
    const step = await runStep(provider, new AbortController().signal);
    expect(step.stop_reason).toBe('end_turn');
    expect(step.usageSeen).toBe(true);
    expect(buildAssistantContent(step)).toEqual([{ type: 'text', text: 'hello' }]);
  });

  test('collects parallel tool calls in emission order', async () => {
    const provider = createMockProvider([
      toolTurn([
        { id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
        { id: 'c2', name: 'git', args: { subcommand: 'status' } },
      ]),
    ]);
    const step = await runStep(provider, new AbortController().signal);
    expect(step.stop_reason).toBe('tool_use');
    expect(step.tool_uses.map((t) => t.id)).toEqual(['c1', 'c2']);
    expect(buildAssistantContent(step).map((b) => b.type)).toEqual(['tool_use', 'tool_use']);
  });

  test('retries a rate-limited first attempt without duplicating output', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after-ms': '1' },
    });
    const provider = createMockProvider([rateLimited, textTurn('ok')]);
    const step = await runStep(provider, new AbortController().signal);
    expect(provider.calls).toHaveLength(2);
    expect(step.text).toBe('ok');
  });

  test('forwards the abort signal to the provider', async () => {
    const provider = createMockProvider([textTurn('ok')]);
    const ac = new AbortController();
    await runStep(provider, ac.signal);
    expect(provider.calls[0]?.signal).toBe(ac.signal);
  });
});
