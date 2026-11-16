import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../../src/agent/agent.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import { InstructionsLoader } from '../../src/instructions/agents-loader.ts';
import { FENCE } from '../../src/sanitize/fence.ts';
import { createMockProvider, textTurn, toolTurn } from '../helpers/mock-provider.ts';

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

describe('piped input', () => {
  test('is sent as a fenced block after the prompt', async () => {
    const provider = createMockProvider([textTurn('ok')]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
    });
    await agent.run('review this', { input: 'the diff' });
    expect(provider.calls[0]?.req.messages[0]?.content).toEqual([
      { type: 'text', text: 'review this' },
      { type: 'text', text: `<input fence="${FENCE}">\nthe diff\n</input fence="${FENCE}">` },
    ]);
  });
});

describe('project instructions of the working directory', () => {
  test('are sent in the user turn, fenced, and not in the system prompt', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'nullrivet-agent-')));
    try {
      const project = join(root, 'project');
      await mkdir(join(project, '.git'), { recursive: true });
      await writeFile(join(project, 'AGENTS.md'), 'use tabs');
      const provider = createMockProvider([textTurn('ok')]);
      const agent = await createAgent({
        provider,
        tools: [],
        mode: 'auto',
        cwd: project,
        instructions: new InstructionsLoader({ home: root }),
      });
      await agent.run('go');
      const request = provider.calls[0]?.req;
      expect(request?.system).not.toContain('use tabs');
      const first = request?.messages[0]?.content;
      const context = Array.isArray(first) && first[0]?.type === 'text' ? first[0].text : '';
      expect(context).toContain(
        `fence="${FENCE}">\nuse tabs\n</project_instructions fence="${FENCE}">`,
      );
      expect(Array.isArray(first) && first[1]?.type === 'text' ? first[1].text : '').toBe('go');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('checkpoint', () => {
  test('is called after each step with tool results and when a turn ends', async () => {
    const provider = createMockProvider([
      toolTurn([{ id: 't1', name: 'echo', args: {} }]),
      textTurn('done'),
    ]);
    const agent = await createAgent({
      provider,
      tools: [
        {
          name: 'echo',
          description: 'echo',
          inputSchema: { type: 'object' },
          effect: 'read',
          execute: async () => ({ content: 'ok', isError: false }),
        },
      ],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
    });
    const seen: number[] = [];
    agent.checkpoint = async () => {
      seen.push(agent.conversation.messages().length);
    };
    await agent.run('go');
    // After the tool step (prompt, call, results), then at the end with the final answer.
    expect(seen).toEqual([3, 4]);
  });

  test('is called after a manual compaction', async () => {
    const agent = await createAgent({
      provider: createMockProvider([]),
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
    });
    let calls = 0;
    agent.checkpoint = async () => {
      calls++;
    };
    await agent.compact();
    expect(calls).toBe(1);
  });

  test('is called when a turn is interrupted, with the conversation still consistent', async () => {
    const agent = await createAgent({
      provider: silentProvider(),
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
    });
    let calls = 0;
    agent.checkpoint = async () => {
      calls++;
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await agent.run('go', { signal: controller.signal });
    expect(calls).toBe(1);
  });
});
