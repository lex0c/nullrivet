import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversation } from '../../src/agent/conversation.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import { runTurn, type TurnDependencies } from '../../src/agent/loop.ts';
import { InstructionsLoader } from '../../src/instructions/agents-loader.ts';
import type { ProviderMessage, StreamEvent } from '../../src/providers/types.ts';
import type { ExecutionMode } from '../../src/tools/policy.ts';
import type { Tool, ToolEffect, ToolResult } from '../../src/tools/types.ts';
import {
  createMockProvider,
  type ScriptedTurn,
  textTurn,
  toolTurn,
} from '../helpers/mock-provider.ts';

const fakeTool = (
  name: string,
  effect: ToolEffect,
  run: (input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult> = async () => ({
    content: `${name} ok`,
    isError: false,
  }),
): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object' },
  effect,
  execute: (input, ctx) => run(input, ctx.signal),
});

interface Harness {
  deps: TurnDependencies;
  events: AgentEvent[];
  provider: ReturnType<typeof createMockProvider>;
  setMode: (mode: ExecutionMode) => void;
}

const harness = (
  turns: ScriptedTurn[],
  options: {
    tools?: Tool[];
    mode?: ExecutionMode;
    maxSteps?: number;
    signal?: AbortSignal;
    instructions?: InstructionsLoader;
    cwd?: string;
  } = {},
): Harness => {
  const provider = createMockProvider(turns);
  const events: AgentEvent[] = [];
  let mode = options.mode ?? 'auto';
  const tools = options.tools ?? [fakeTool('read_file', 'read'), fakeTool('bash', 'exec')];
  return {
    provider,
    events,
    setMode: (m) => {
      mode = m;
    },
    deps: {
      provider,
      conversation: new Conversation(),
      tools: new Map(tools.map((t) => [t.name, t])),
      mode: () => mode,
      cwd: options.cwd ?? '/tmp',
      systemPrompt: () => `system for ${mode}`,
      instructions: options.instructions ?? null,
      limits: {
        maxSteps: options.maxSteps ?? 10,
        maxOutputTokens: 1_000,
        stallMs: 5_000,
        streamRetryDelayMs: 1,
      },
      emit: (e) => events.push(e),
      signal: options.signal ?? new AbortController().signal,
    },
  };
};

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);

const toolResults = (message: ProviderMessage | undefined) =>
  Array.isArray(message?.content) ? message.content.filter((b) => b.type === 'tool_result') : [];

describe('runTurn', () => {
  test('a text answer ends the turn', async () => {
    const h = harness([textTurn('hello')]);
    const result = await runTurn('hi', h.deps);
    expect(result.reason).toBe('done');
    expect(types(h.events)).toEqual(['agent:start', 'text:delta', 'usage', 'agent:end']);
    expect(h.deps.conversation.messages()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(h.provider.calls[0]?.req.system).toBe('system for auto');
    expect(h.provider.calls[0]?.req.max_tokens).toBe(1_000);
  });

  test('tool results are fed back and the loop continues until a text answer', async () => {
    const h = harness([
      toolTurn([{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }]),
      textTurn('done reading'),
    ]);
    const result = await runTurn('read it', h.deps);
    expect(result.reason).toBe('done');
    expect(result.steps).toBe(2);
    expect(result.usage.input).toBe(20);
    const second = h.provider.calls[1]?.req.messages ?? [];
    expect(toolResults(second.at(-1))).toEqual([
      { type: 'tool_result', tool_use_id: 't1', name: 'read_file', content: 'read_file ok' },
    ]);
    const toolEnd = h.events.find((e) => e.type === 'tool:end');
    expect(toolEnd).toMatchObject({ id: 't1', name: 'read_file', isError: false });
  });

  test('readonly offers only read tools and refuses other calls without running them', async () => {
    let bashRuns = 0;
    const h = harness(
      [toolTurn([{ id: 't1', name: 'bash', args: { command: 'rm -rf /' } }]), textTurn('ok')],
      {
        mode: 'readonly',
        tools: [
          fakeTool('read_file', 'read'),
          fakeTool('bash', 'exec', async () => {
            bashRuns += 1;
            return { content: 'ran', isError: false };
          }),
        ],
      },
    );
    await runTurn('clean up', h.deps);
    expect(h.provider.calls[0]?.req.tools?.map((t) => t.name)).toEqual(['read_file']);
    expect(bashRuns).toBe(0);
    const results = toolResults(h.provider.calls[1]?.req.messages.at(-1));
    expect(results[0]).toMatchObject({ is_error: true });
    expect((results[0] as { content: string }).content).toContain('policy.denied');
  });

  test('a mode change during the turn applies to the next tool call', async () => {
    let h: Harness;
    const tools = [
      fakeTool('read_file', 'read', async () => {
        h.setMode('readonly');
        return { content: 'read', isError: false };
      }),
      fakeTool('bash', 'exec'),
    ];
    h = harness(
      [
        toolTurn([
          { id: 't1', name: 'read_file', args: {} },
          { id: 't2', name: 'bash', args: {} },
        ]),
        textTurn('ok'),
      ],
      { tools },
    );
    await runTurn('go', h.deps);
    const results = toolResults(h.provider.calls[1]?.req.messages.at(-1));
    expect(results.map((r) => (r as { is_error?: boolean }).is_error === true)).toEqual([
      false,
      true,
    ]);
    expect(h.provider.calls[1]?.req.system).toBe('system for readonly');
  });

  test('stops at the step limit', async () => {
    const turns = Array.from({ length: 3 }, (_, i) =>
      toolTurn([{ id: `t${i}`, name: 'read_file', args: {} }]),
    );
    const h = harness(turns, { maxSteps: 3 });
    const result = await runTurn('loop forever', h.deps);
    expect(result.reason).toBe('budget');
    expect(result.message).toContain('3 steps');
  });

  test('a provider error ends the turn and leaves a valid history', async () => {
    const badRequest = Object.assign(new Error('invalid request'), { status: 400 });
    const h = harness([badRequest, textTurn('recovered')]);
    const first = await runTurn('one', h.deps);
    expect(first.reason).toBe('error');
    expect(first.message).toContain('invalid request');
    expect(h.events.some((e) => e.type === 'error')).toBe(true);
    const second = await runTurn('two', h.deps);
    expect(second.reason).toBe('done');
    expect(h.provider.calls[1]?.req.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    });
  });

  test('an abort during tool execution answers every pending tool call', async () => {
    const controller = new AbortController();
    const h = harness(
      [
        toolTurn([
          { id: 't1', name: 'bash', args: {} },
          { id: 't2', name: 'read_file', args: {} },
        ]),
      ],
      {
        signal: controller.signal,
        tools: [
          fakeTool('bash', 'exec', async () => {
            controller.abort();
            return { content: '[aborted]', isError: true };
          }),
          fakeTool('read_file', 'read'),
        ],
      },
    );
    const result = await runTurn('go', h.deps);
    expect(result.reason).toBe('aborted');
    const results = toolResults(h.deps.conversation.messages().at(-1));
    expect(results.map((r) => (r as { tool_use_id: string }).tool_use_id)).toEqual(['t1', 't2']);
    expect((results[1] as { content: string }).content).toContain('interrupted');
  });

  test('an abort during the stream keeps the text already shown', async () => {
    const controller = new AbortController();
    const stream: StreamEvent[] = [
      { kind: 'start', message_id: 'm' },
      { kind: 'text_delta', text: 'partial' },
      { kind: 'text_delta', text: ' answer' },
      { kind: 'stop', reason: 'end_turn' },
    ];
    const h = harness([stream], { signal: controller.signal });
    const emit = h.deps.emit;
    h.deps.emit = (event) => {
      emit(event);
      if (event.type === 'text:delta') controller.abort();
    };
    const result = await runTurn('go', h.deps);
    expect(result.reason).toBe('aborted');
    expect(h.deps.conversation.messages().at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
    });
  });

  test('a transient stream error before any output repeats the step', async () => {
    const failed: StreamEvent[] = [
      { kind: 'start', message_id: 'm' },
      { kind: 'thinking_delta', text: 'hmm' },
      { kind: 'error', code: 'openrouter.stream_error', message: 'upstream', retryable: true },
    ];
    const h = harness([failed, textTurn('recovered')]);
    const result = await runTurn('go', h.deps);
    expect(result.reason).toBe('done');
    expect(result.steps).toBe(1);
    expect(h.provider.calls).toHaveLength(2);
    expect(h.events.some((e) => e.type === 'warning')).toBe(true);
    expect(h.deps.conversation.messages()).toHaveLength(2);
  });

  test('a stream error after visible text ends the turn instead of repeating it', async () => {
    const failed: StreamEvent[] = [
      { kind: 'start', message_id: 'm' },
      { kind: 'text_delta', text: 'half an answer' },
      { kind: 'error', code: 'openrouter.stream_error', message: 'upstream', retryable: true },
    ];
    const h = harness([failed, textTurn('never requested')]);
    const result = await runTurn('go', h.deps);
    expect(result.reason).toBe('error');
    expect(h.provider.calls).toHaveLength(1);
  });

  test('repeated transient errors stop after the retry limit', async () => {
    const failed: StreamEvent[] = [
      { kind: 'start', message_id: 'm' },
      { kind: 'error', code: 'openrouter.stream_error', message: 'upstream', retryable: true },
    ];
    const h = harness([failed, failed, failed]);
    const result = await runTurn('go', h.deps);
    expect(result.reason).toBe('error');
    expect(h.provider.calls).toHaveLength(3);
  });

  test('an invalid tool call is reported back to the model instead of ending the turn', async () => {
    const broken: StreamEvent[] = [
      { kind: 'start', message_id: 'm' },
      { kind: 'tool_use_start', id: 't1', name: 'read_file' },
      { kind: 'tool_use_stop', id: 't1', final_args: { path: 'a.ts' } },
      {
        kind: 'error',
        code: 'tool_call.invalid',
        message: 'failed to parse arguments of call t2',
        retryable: false,
      },
      { kind: 'stop', reason: 'tool_use' },
    ];
    const h = harness([broken, textTurn('fixed')]);
    const result = await runTurn('go', h.deps);
    expect(result.reason).toBe('done');
    const sent = h.provider.calls[1]?.req.messages.at(-1);
    expect(toolResults(sent)).toHaveLength(1);
    const text = Array.isArray(sent?.content)
      ? sent.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
      : [];
    expect(text.join('')).toContain('failed to parse arguments of call t2');
    expect(h.events.some((e) => e.type === 'warning')).toBe(true);
  });

  test('transient failures in different steps each get their own retries', async () => {
    const failed: StreamEvent[] = [
      { kind: 'start', message_id: 'm' },
      { kind: 'error', code: 'openrouter.stream_error', message: 'upstream', retryable: true },
    ];
    const h = harness([
      failed,
      toolTurn([{ id: 't1', name: 'read_file', args: {} }]),
      failed,
      failed,
      textTurn('done'),
    ]);
    const result = await runTurn('go', h.deps);
    expect(result.reason).toBe('done');
    expect(h.provider.calls).toHaveLength(5);
  });

  test('the output limit shrinks to fit the remaining context window', async () => {
    const h = harness([textTurn('ok')]);
    h.deps.provider.capabilities.context_window = 6_000;
    h.deps.limits.maxOutputTokens = 4_000;
    const prompt = 'x'.repeat(4 * 2_000);
    await runTurn(prompt, h.deps);
    const sent = h.provider.calls[0]?.req.max_tokens ?? 0;
    expect(sent).toBeLessThan(4_000);
    expect(sent).toBeGreaterThanOrEqual(1_024);
  });

  test('a conversation that no longer fits the window ends with a budget reason', async () => {
    const h = harness([textTurn('never sent')]);
    h.deps.provider.capabilities.context_window = 4_000;
    const result = await runTurn('x'.repeat(4 * 4_000), h.deps);
    expect(result.reason).toBe('budget');
    expect(result.message).toContain('context window');
    expect(h.provider.calls).toHaveLength(0);
  });

  test('a stalled stream cancels the provider request', async () => {
    let received: AbortSignal | undefined;
    const h = harness([]);
    h.deps.limits.stallMs = 30;
    h.deps.provider = {
      ...h.deps.provider,
      async *generate(_req, signal) {
        received = signal;
        yield { kind: 'start', message_id: 'm' };
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      },
    };
    const result = await runTurn('go', h.deps);
    expect(result.reason).toBe('error');
    expect(result.message).toContain('stopped responding');
    expect(received?.aborted).toBe(true);
  });

  test('a truncated answer ends with a budget reason', async () => {
    const h = harness([
      [
        { kind: 'start', message_id: 'm' },
        { kind: 'text_delta', text: 'cut' },
        { kind: 'stop', reason: 'max_tokens' },
      ],
    ]);
    const result = await runTurn('write a lot', h.deps);
    expect(result.reason).toBe('budget');
    expect(result.message).toContain('output token limit');
  });

  describe('project instructions', () => {
    let root: string;

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'nullrivet-loop-')));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test('AGENTS.md files of a touched path are attached once to the tool result', async () => {
      const other = join(root, 'other');
      await mkdir(join(other, '.git'), { recursive: true });
      await writeFile(join(other, 'AGENTS.md'), 'use tabs');
      const reader = fakeTool('read_file', 'read', async (input) => ({
        content: 'file text',
        isError: false,
        touchedPaths: [join(other, String(input.path))],
      }));
      const h = harness(
        [
          toolTurn([{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }]),
          toolTurn([{ id: 't2', name: 'read_file', args: { path: 'b.ts' } }]),
          textTurn('ok'),
        ],
        { tools: [reader], instructions: new InstructionsLoader({ home: root }) },
      );
      await runTurn('go', h.deps);
      const first = toolResults(h.provider.calls[1]?.req.messages.at(-1))[0] as { content: string };
      const second = toolResults(h.provider.calls[2]?.req.messages.at(-1))[0] as {
        content: string;
      };
      expect(first.content).toContain('file text');
      expect(first.content).toContain('use tabs');
      expect(first.content).toContain(`source="${join(other, 'AGENTS.md')}"`);
      expect(second.content).toBe('file text');
    });
  });
});
