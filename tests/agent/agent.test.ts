import { describe, expect, test } from 'bun:test';
import { createAgent } from '../../src/agent/agent.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import { createMockProvider, textTurn } from '../helpers/mock-provider.ts';

// A provider whose stream stays open until the request is cancelled.
const silentProvider = () => {
  const provider = createMockProvider([]);
  provider.generate = async function* (_req, signal) {
    yield { kind: 'start', message_id: 'm' };
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
  };
  return provider;
};

describe('time limit', () => {
  test('a task that runs past its time limit ends at a limit, not as an interrupt', async () => {
    const agent = await createAgent({
      provider: silentProvider(),
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      timeLimitMs: 30,
    });
    const events: AgentEvent[] = [];
    const result = await agent.run('go', { onEvent: (e) => events.push(e) });
    expect(result.reason).toBe('budget');
    expect(result.message).toBe('time limit of 1s reached');
    expect(events.at(-1)).toEqual({
      type: 'agent:end',
      reason: 'budget',
      message: 'time limit of 1s reached',
    });
  });

  test('an interrupt before the limit is still an interrupt', async () => {
    const agent = await createAgent({
      provider: silentProvider(),
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      timeLimitMs: 60_000,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await agent.run('go', { signal: controller.signal });
    expect(result.reason).toBe('aborted');
  });

  test('a limit too large for a timer does not stop the task at once', async () => {
    const agent = await createAgent({
      provider: createMockProvider([textTurn('one')]),
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      timeLimitMs: 3_000_000_000,
    });
    expect((await agent.run('first')).reason).toBe('done');
  });

  test('the limit applies to each task separately', async () => {
    const agent = await createAgent({
      provider: createMockProvider([textTurn('one'), textTurn('two')]),
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      timeLimitMs: 200,
    });
    expect((await agent.run('first')).reason).toBe('done');
    await Bun.sleep(250);
    expect((await agent.run('second')).reason).toBe('done');
  });
});
