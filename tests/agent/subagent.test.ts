import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { type Agent, createAgent } from '../../src/agent/agent.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import type { GenerateRequest, StreamEvent } from '../../src/providers/types.ts';
import { FENCE } from '../../src/sanitize/fence.ts';
import type { Tool, ToolEffect } from '../../src/tools/types.ts';
import { createMockProvider, textTurn, toolTurn } from '../helpers/mock-provider.ts';

const isChild = (req: GenerateRequest): boolean => req.system?.includes('# Subagent') === true;

const firstText = (req: GenerateRequest): string => {
  const content = req.messages[0]?.content;
  if (typeof content === 'string') return content;
  const block = content?.find((b) => b.type === 'text');
  return block?.type === 'text' ? block.text : '';
};

const toolNames = (req: GenerateRequest | undefined): string[] =>
  (req?.tools ?? []).map((t) => t.name).sort();

type Route = (
  req: GenerateRequest,
  signal: AbortSignal | undefined,
) => StreamEvent[] | Promise<StreamEvent[]>;

// Answers each request through `route`, so the parent and concurrent subagents can be scripted
// by what they ask rather than by the order of their requests.
const routedProvider = (route: Route) => {
  const provider = createMockProvider([]);
  provider.generate = async function* (req, signal) {
    provider.calls.push({ req, signal });
    for (const event of await route(req, signal)) yield event;
  };
  return provider;
};

const fakeTool = (name: string, effect: ToolEffect, onRun?: () => void): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  effect,
  async execute() {
    onRun?.();
    return { content: `${name} ok`, isError: false };
  },
});

const delegateCall = (id: string, args: Record<string, unknown>) => ({
  id,
  name: 'delegate',
  args: { title: id, objective: `objective ${id}`, ...args },
});

const harness = async (route: Route, tools: Tool[] = [fakeTool('read_file', 'read')]) => {
  const provider = routedProvider(route);
  const agent = await createAgent({
    provider,
    tools,
    mode: 'auto',
    cwd: '/tmp',
    instructions: null,
  });
  const events: AgentEvent[] = [];
  return { provider, agent, events, onEvent: (e: AgentEvent) => events.push(e) };
};

const toolResults = (req: GenerateRequest | undefined) => {
  const content = req?.messages.at(-1)?.content;
  return Array.isArray(content)
    ? content.flatMap((b) => (b.type === 'tool_result' ? [b] : []))
    : [];
};

// Tracks how many subagents run at once, from the events of the parent.
const concurrency = (events: AgentEvent[]): number => {
  let active = 0;
  let max = 0;
  for (const e of events) {
    if (e.type === 'subagent:start') max = Math.max(max, ++active);
    if (e.type === 'subagent:end') active--;
  }
  return max;
};

describe('delegate', () => {
  test('the subagent starts from the objective alone and returns only its report', async () => {
    let parentCalls = 0;
    let childCalls = 0;
    const h = await harness((req) => {
      if (isChild(req)) {
        childCalls++;
        return childCalls === 1
          ? toolTurn([{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }])
          : textTurn('Result: found it in a.ts:3');
      }
      parentCalls++;
      return parentCalls === 1
        ? toolTurn([delegateCall('d1', { context: 'look in src' })])
        : textTurn('done');
    });
    await h.agent.run('secret parent prompt', { onEvent: h.onEvent });

    const child = h.provider.calls.find((c) => isChild(c.req))?.req;
    expect(child?.messages).toHaveLength(1);
    expect(child?.messages[0]?.content).toEqual([
      { type: 'text', text: 'objective d1' },
      { type: 'text', text: `<input fence="${FENCE}">\nlook in src\n</input fence="${FENCE}">` },
    ]);
    expect(JSON.stringify(child?.messages)).not.toContain('secret parent prompt');
    expect(toolNames(child)).toEqual(['read_file']);

    const parentAfter = h.provider.calls.at(-1)?.req;
    const [result] = toolResults(parentAfter);
    expect(result?.content).toStartWith('[subagent completed, 2 steps, ');
    expect(result?.content).toEndWith('Result: found it in a.ts:3');
    expect(JSON.stringify(parentAfter?.messages)).not.toContain('read_file ok');

    const types = h.events.map((e) => e.type);
    expect(types).toContain('subagent:start');
    expect(types).toContain('subagent:end');
    const progress = h.events.find((e) => e.type === 'subagent:progress');
    expect(progress).toMatchObject({ id: 'd1', step: 1, tool: { name: 'read_file' } });
    const childUsage = h.events.filter((e) => e.type === 'usage' && e.subagent === 'd1');
    expect(childUsage).toHaveLength(2);
  });

  test('the subagent mode never exceeds the session mode, even when it changes mid-run', async () => {
    let agent: Agent | undefined;
    const tools = [
      fakeTool('read_file', 'read', () => {
        if (agent !== undefined) agent.mode = 'readonly';
      }),
      fakeTool('write_file', 'write'),
      fakeTool('bash', 'exec'),
    ];
    let childCalls = 0;
    let parentCalls = 0;
    const h = await harness((req) => {
      if (isChild(req)) {
        childCalls++;
        return childCalls === 1
          ? toolTurn([{ id: 'c1', name: 'read_file', args: {} }])
          : textTurn('report');
      }
      parentCalls++;
      return parentCalls === 1
        ? toolTurn([delegateCall('d1', { mode: 'auto' })])
        : textTurn('done');
    }, tools);
    agent = h.agent;
    await h.agent.run('go', { onEvent: h.onEvent });
    const childRequests = h.provider.calls.filter((c) => isChild(c.req)).map((c) => c.req);
    expect(toolNames(childRequests[0])).toEqual(['bash', 'read_file', 'write_file']);
    expect(toolNames(childRequests[1])).toEqual(['read_file']);
  });

  test('readonly subagents of one response run at the same time, at most three', async () => {
    let started = 0;
    let release: () => void = () => undefined;
    const threeStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parentCalls = 0;
    const h = await harness(async (req) => {
      if (isChild(req)) {
        if (++started === 3) release();
        await Promise.race([threeStarted, Bun.sleep(2_000)]);
        return textTurn(`report ${firstText(req)}`);
      }
      parentCalls++;
      return parentCalls === 1
        ? toolTurn(['d1', 'd2', 'd3', 'd4'].map((id) => delegateCall(id, {})))
        : textTurn('done');
    });
    const startedAt = performance.now();
    await h.agent.run('go', { onEvent: h.onEvent });
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(concurrency(h.events)).toBe(3);
    const results = toolResults(h.provider.calls.at(-1)?.req);
    expect(results.map((r) => r.tool_use_id)).toEqual(['d1', 'd2', 'd3', 'd4']);
    expect(results.map((r) => r.content.split('\n').at(-1))).toEqual([
      'report objective d1',
      'report objective d2',
      'report objective d3',
      'report objective d4',
    ]);
  });

  test('auto subagents run one after another', async () => {
    let parentCalls = 0;
    const h = await harness(
      async (req) => {
        if (isChild(req)) {
          await Bun.sleep(20);
          return textTurn('report');
        }
        parentCalls++;
        return parentCalls === 1
          ? toolTurn(['d1', 'd2'].map((id) => delegateCall(id, { mode: 'auto' })))
          : textTurn('done');
      },
      [fakeTool('read_file', 'read'), fakeTool('write_file', 'write')],
    );
    await h.agent.run('go', { onEvent: h.onEvent });
    expect(concurrency(h.events)).toBe(1);
  });

  test('interrupting the session cancels its subagents', async () => {
    const controller = new AbortController();
    const h = await harness(async (req, signal) => {
      if (isChild(req)) {
        controller.abort();
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
        return textTurn('late');
      }
      return toolTurn([delegateCall('d1', {})]);
    });
    const result = await h.agent.run('go', { onEvent: h.onEvent, signal: controller.signal });
    expect(result.reason).toBe('aborted');
    expect(h.events.find((e) => e.type === 'subagent:end')).toMatchObject({
      id: 'd1',
      status: 'cancelled',
    });
  });

  test('a subagent cannot delegate, and a long report is cut', async () => {
    let parentCalls = 0;
    const h = await harness((req) => {
      if (isChild(req)) return textTurn(`start\n${'line\n'.repeat(10_000)}end`);
      parentCalls++;
      return parentCalls === 1 ? toolTurn([delegateCall('d1', {})]) : textTurn('done');
    });
    await h.agent.run('go', { onEvent: h.onEvent });
    const child = h.provider.calls.find((c) => isChild(c.req))?.req;
    expect(toolNames(child)).not.toContain('delegate');
    const [result] = toolResults(h.provider.calls.at(-1)?.req);
    expect(Buffer.byteLength(result?.content ?? '', 'utf8')).toBeLessThan(17 * 1024);
    expect(result?.content).toContain('start');
    expect(result?.content).toEndWith('end');
  });

  test('a subagent at its step limit is asked for its report on the last step', async () => {
    let parentCalls = 0;
    const h = await harness((req) => {
      if (isChild(req)) {
        const last = JSON.stringify(req.messages.at(-1));
        return last.includes('This is your last step')
          ? textTurn('Result: partial findings')
          : toolTurn([{ id: `c${req.messages.length}`, name: 'read_file', args: {} }]);
      }
      parentCalls++;
      return parentCalls === 1 ? toolTurn([delegateCall('d1', {})]) : textTurn('done');
    });
    await h.agent.run('go', { onEvent: h.onEvent });
    const [result] = toolResults(h.provider.calls.at(-1)?.req);
    expect(result?.content).toStartWith('[subagent completed, 40 steps');
    expect(result?.content).toEndWith('Result: partial findings');
    const steps = h.events.flatMap((e) => (e.type === 'subagent:progress' ? [e.step] : []));
    expect(steps.slice(0, 3)).toEqual([1, 2, 3]);
  });

  test('the reason a subagent failed reaches the summary shown to the user', async () => {
    let parentCalls = 0;
    const h = await harness((req) => {
      if (isChild(req)) throw Object.assign(new Error('invalid api key'), { status: 401 });
      parentCalls++;
      return parentCalls === 1 ? toolTurn([delegateCall('d1', {})]) : textTurn('done');
    });
    await h.agent.run('go', { onEvent: h.onEvent });
    const end = h.events.find((e) => e.type === 'tool:end' && e.name === 'delegate');
    expect(end?.type === 'tool:end' && end.isError).toBe(true);
    const summary = end?.type === 'tool:end' ? String(end.meta?.summary) : '';
    expect(summary).toStartWith('subagent failed');
    expect(summary).toContain('invalid api key');
  });

  test('files changed by a subagent are reported relative to the session directory', async () => {
    const tools = [fakeTool('read_file', 'read'), fakeTool('write_file', 'write')];
    let childCalls = 0;
    let parentCalls = 0;
    const h = await harness((req) => {
      if (isChild(req)) {
        childCalls++;
        return childCalls === 1
          ? toolTurn([{ id: 'c1', name: 'write_file', args: { path: 'src/index.ts' } }])
          : textTurn('done');
      }
      parentCalls++;
      return parentCalls === 1
        ? toolTurn([delegateCall('d1', { mode: 'auto', cwd: '/tmp/../tmp/pkg-api' })])
        : textTurn('done');
    }, tools);
    await mkdir('/tmp/pkg-api', { recursive: true });
    await h.agent.run('go', { onEvent: h.onEvent });
    const [result] = toolResults(h.provider.calls.at(-1)?.req);
    expect(result?.content).toContain('modified: pkg-api/src/index.ts');
  });

  test('a delegate cwd that cannot be used is reported with its real cause', async () => {
    let parentCalls = 0;
    const h = await harness((req) => {
      if (isChild(req)) return textTurn('never');
      parentCalls++;
      return parentCalls === 1
        ? toolTurn([
            delegateCall('d1', { cwd: '/proc/self/status' }),
            delegateCall('d2', { cwd: '/nope/x' }),
          ])
        : textTurn('done');
    });
    await h.agent.run('go', { onEvent: h.onEvent });
    const results = toolResults(h.provider.calls.at(-1)?.req);
    expect(results[0]?.content).toContain('[fs.not_directory]');
    expect(results[1]?.content).toContain('[fs.not_found]');
  });
});

describe('the main system prompt', () => {
  test('explains delegation only when the tool is offered', async () => {
    const run = async (delegation: boolean) => {
      const provider = createMockProvider([textTurn('ok')]);
      const agent = await createAgent({
        provider,
        tools: [],
        mode: 'auto',
        cwd: '/tmp',
        instructions: null,
        delegation,
      });
      await agent.run('go');
      return provider.calls[0]?.req;
    };
    const on = await run(true);
    const off = await run(false);
    expect(on?.system).toContain('# Delegation');
    expect(toolNames(on)).toEqual(['delegate']);
    expect(off?.system).not.toContain('# Delegation');
    expect(toolNames(off)).toEqual([]);
  });
});
