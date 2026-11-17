import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Agent, createAgent } from '../../src/agent/agent.ts';
import { Conversation } from '../../src/agent/conversation.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import { InstructionsLoader } from '../../src/instructions/agents-loader.ts';
import type { GenerateRequest } from '../../src/providers/types.ts';
import { FENCE } from '../../src/sanitize/fence.ts';
import { removeOutputFiles } from '../../src/tools/output-files.ts';
import {
  createMockProvider,
  type MockProvider,
  textTurn,
  toolTurn,
} from '../helpers/mock-provider.ts';

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
    expect(result.limit).toBe('time');
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

describe('mode switch', () => {
  const lastMessage = (provider: MockProvider, call: number): string =>
    JSON.stringify(provider.calls[call]?.req.messages.at(-1));
  const notes = (provider: MockProvider): number[] =>
    provider.calls.map(
      (c) =>
        JSON.stringify(c.req.messages).split('The user switched the execution mode').length - 1,
    );

  test('a switch between prompts is announced once, with the next prompt', async () => {
    const provider = createMockProvider([textTurn('one'), textTurn('two'), textTurn('three')]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'readonly',
      cwd: '/tmp',
      instructions: null,
    });
    await agent.run('first');
    agent.mode = 'auto';
    await agent.run('second');
    await agent.run('third');
    expect(notes(provider)).toEqual([0, 1, 1]);
    expect(lastMessage(provider, 1)).toContain('second');
    expect(lastMessage(provider, 1)).toContain('from readonly to auto');
  });

  test('a switch during a task is announced with the next tool results', async () => {
    const provider = createMockProvider([
      toolTurn([{ id: 't1', name: 'echo', args: {} }]),
      textTurn('done'),
    ]);
    let agent: Agent | undefined;
    agent = await createAgent({
      provider,
      tools: [
        {
          name: 'echo',
          description: 'echo',
          inputSchema: { type: 'object' },
          effect: 'read',
          execute: async () => {
            if (agent !== undefined) agent.mode = 'readonly';
            return { content: 'ok', isError: false };
          },
        },
      ],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
    });
    await agent.run('go');
    expect(notes(provider)).toEqual([0, 1]);
    expect(lastMessage(provider, 1)).toContain('tool_result');
    expect(lastMessage(provider, 1)).toContain('from auto to readonly');
  });

  test('a cleared conversation starts without a note', async () => {
    const provider = createMockProvider([textTurn('one'), textTurn('two')]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'readonly',
      cwd: '/tmp',
      instructions: null,
    });
    await agent.run('first');
    agent.clear();
    agent.mode = 'auto';
    await agent.run('second');
    expect(notes(provider)).toEqual([0, 0]);
  });

  test('a restored conversation produced in another mode is announced', async () => {
    const earlier = new Conversation();
    earlier.appendUser('create a file');
    earlier.appendAssistant([{ type: 'text', text: 'I am in readonly mode and cannot.' }]);
    earlier.setRequestMode('readonly');
    const provider = createMockProvider([textTurn('done')]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
    });
    agent.conversation.restore(earlier.snapshot());
    await agent.run('try again');
    expect(lastMessage(provider, 0)).toContain('from readonly to auto');
  });
});

describe('background jobs', () => {
  afterAll(() => removeOutputFiles());

  const JOB_TOOLS = ['bash_background', 'bash_jobs', 'bash_kill'];
  const offered = (req: GenerateRequest | undefined): string[] =>
    (req?.tools ?? []).map((t) => t.name);

  // That subagents never get them is checked with the subagent tests.
  test('the job tools are offered in auto mode only', async () => {
    const provider = createMockProvider([textTurn('done'), textTurn('fine')]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      backgroundJobs: 'interactive',
    });
    await agent.run('go');
    for (const name of JOB_TOOLS) expect(offered(provider.calls[0]?.req)).toContain(name);

    agent.mode = 'readonly';
    await agent.run('again');
    for (const name of JOB_TOOLS) expect(offered(provider.calls.at(-1)?.req)).not.toContain(name);
  });

  test('a job that ends after a switch to readonly is still reported', async () => {
    const provider = createMockProvider([
      toolTurn([{ id: 't1', name: 'bash_background', args: { command: 'echo hi' } }]),
      textTurn('started'),
      ...Array.from({ length: 50 }, () => textTurn('noted')),
    ]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      backgroundJobs: 'interactive',
    });
    await agent.run('start it');
    agent.mode = 'readonly';
    // Asks again until the job has ended, rather than guessing how long that takes.
    const note = /<agent-note>Background job [0-9a-f]{16}-1 completed with exit code 0/;
    let last = '';
    for (let attempt = 0; attempt < 50 && !note.test(last); attempt++) {
      if (attempt > 0) await Bun.sleep(100);
      await agent.run('anything new?');
      last = JSON.stringify(provider.calls.at(-1)?.req.messages);
    }
    expect(last).toMatch(note);
    expect(offered(provider.calls.at(-1)?.req)).not.toContain('bash_jobs');
  });

  test('a turn on job events starts nothing when none are pending', async () => {
    const provider = createMockProvider([]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      backgroundJobs: 'interactive',
    });
    expect(agent.hasBackgroundEvents()).toBe(false);
    expect(await agent.runOnBackgroundEvents()).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  test('a job that ends is announced, and a turn without a prompt reports it', async () => {
    const provider = createMockProvider([
      toolTurn([{ id: 't1', name: 'bash_background', args: { command: 'echo hi' } }]),
      textTurn('started'),
      textTurn('noted'),
    ]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      backgroundJobs: 'interactive',
    });
    let announced = 0;
    agent.onBackgroundEvent(() => {
      announced += 1;
    });
    await agent.run('start it');
    const deadline = Date.now() + 5_000;
    while (!agent.hasBackgroundEvents() && Date.now() < deadline) await Bun.sleep(20);
    await Promise.resolve();
    expect(announced).toBe(1);
    expect((await agent.runOnBackgroundEvents())?.reason).toBe('done');
    expect(provider.calls.at(-1)?.req.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(String(provider.calls.at(-1)?.req.messages.at(-1)?.content)).toMatch(
      /^<agent-note>Background job [0-9a-f]{16}-1 completed with exit code 0 after \S+\.[^<]*<\/agent-note>$/,
    );
    expect(agent.hasBackgroundEvents()).toBe(false);
  });

  test('after clear, the events of jobs started before are not reported', async () => {
    const provider = createMockProvider([
      toolTurn([{ id: 't1', name: 'bash_background', args: { command: 'sleep 0.3' } }]),
      textTurn('started'),
    ]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      backgroundJobs: 'interactive',
    });
    let announced = 0;
    agent.onBackgroundEvent(() => {
      announced += 1;
    });
    await agent.run('start it');
    expect(agent.backgroundWork()).toEqual({ jobs: 1, subagents: 0, queuedSubagents: 0 });
    agent.clear();
    // The job keeps running after clear, and the interface still counts it.
    expect(agent.backgroundWork().jobs).toBe(1);
    const deadline = Date.now() + 5_000;
    while (announced === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(announced).toBe(1);
    // The announcement comes once the job's end is recorded, so a count read then is current.
    expect(agent.backgroundWork().jobs).toBe(0);
    expect(agent.hasBackgroundEvents()).toBe(false);
    expect(await agent.runOnBackgroundEvents()).toBeNull();
    expect(provider.calls).toHaveLength(2);
  });

  // Models were seen setting ready_pattern for short commands, which added a note with nothing to
  // wait for.
  const readyPatternDescription = async (): Promise<string> => {
    const provider = createMockProvider([textTurn('ok')]);
    const agent = await createAgent({
      provider,
      tools: [],
      mode: 'auto',
      cwd: '/tmp',
      instructions: null,
      backgroundJobs: 'interactive',
    });
    await agent.run('go');
    const tool = provider.calls[0]?.req.tools?.find((t) => t.name === 'bash_background');
    const schema = tool?.input_schema as {
      properties?: { ready_pattern?: { description?: string } };
    };
    return schema.properties?.ready_pattern?.description ?? '';
  };

  test('the job tools tell the model what happens once it finishes', async () => {
    const description = async (session: 'interactive' | 'one-shot'): Promise<string> => {
      const provider = createMockProvider([textTurn('ok')]);
      const agent = await createAgent({
        provider,
        tools: [],
        mode: 'auto',
        cwd: '/tmp',
        instructions: null,
        backgroundJobs: session,
      });
      await agent.run('go');
      const tools = provider.calls[0]?.req.tools ?? [];
      return tools.find((t) => t.name === 'bash_background')?.description ?? '';
    };
    const interactive = await description('interactive');
    expect(interactive).toContain(
      "usually by a new turn of your own; the session can hold that turn back until the user's next message",
    );
    expect(interactive).toContain(
      'end your turn instead, and use bash_jobs with wait_ms only when your next step needs its result',
    );
    expect(await readyPatternDescription()).toStartWith(
      'Only for a job that keeps running once it is up, such as a server or a watcher',
    );
    const oneShot = await description('one-shot');
    expect(oneShot).toContain('nullrivet exits when you finish, which stops running jobs');
    expect(oneShot).not.toContain('end your turn');
  });
});
