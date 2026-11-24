import { describe, expect, test } from 'bun:test';
import {
  BackendLostError,
  executeToolCall,
  IN_PROCESS_BACKEND,
  type ToolBackend,
  type ToolExecutionContext,
} from '../../src/agent/tool-broker.ts';
import { InvalidArgumentError } from '../../src/tools/args.ts';
import type { ExecutionMode } from '../../src/tools/policy.ts';
import type { Tool, ToolEffect, ToolResult } from '../../src/tools/types.ts';

const makeTool = (
  name: string,
  effect: ToolEffect,
  run: (input: Record<string, unknown>) => Promise<ToolResult>,
): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  effect,
  execute: run,
});

const calls: string[] = [];
const ok = (name: string, effect: ToolEffect): Tool =>
  makeTool(name, effect, async () => {
    calls.push(name);
    return { content: `${name} ran`, isError: false };
  });

const context = (
  tools: Tool[],
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext => ({
  tools: new Map(tools.map((t) => [t.name, t])),
  mode: 'auto',
  cwd: '/work',
  signal: new AbortController().signal,
  backend: IN_PROCESS_BACKEND,
  ...overrides,
});

const run = (name: string, mode: ExecutionMode, tools: Tool[]) =>
  executeToolCall({ id: 'c1', name, input: {} }, context(tools, { mode }));

describe('executeToolCall', () => {
  test('runs an allowed tool', async () => {
    const result = await run('read_file', 'readonly', [ok('read_file', 'read')]);
    expect(result).toEqual({ content: 'read_file ran', isError: false });
  });

  test('refuses tools with side effects in readonly mode without running them', async () => {
    calls.length = 0;
    const tools = [ok('bash', 'exec'), ok('write_file', 'write')];
    for (const name of ['bash', 'write_file']) {
      const result = await run(name, 'readonly', tools);
      expect(result.isError).toBe(true);
      expect(result.meta?.errorCode).toBe('policy.denied');
    }
    expect(calls).toEqual([]);
  });

  test('reports unknown tools with the available names', async () => {
    const result = await run('rm_rf', 'auto', [ok('bash', 'exec')]);
    expect(result.meta?.errorCode).toBe('tool.unknown');
    expect(result.content).toContain('available tools: bash');
  });

  test('turns invalid arguments and crashes into tool errors', async () => {
    const invalid = makeTool('a', 'read', async () => {
      throw new InvalidArgumentError("'path' must be a string");
    });
    const crash = makeTool('b', 'read', async () => {
      throw new Error('boom');
    });
    expect((await run('a', 'auto', [invalid])).meta?.errorCode).toBe('input.invalid');
    const crashed = await run('b', 'auto', [crash]);
    expect(crashed.meta?.errorCode).toBe('tool.crashed');
    expect(crashed.content).toContain('boom');
  });

  test('strips terminal escape sequences from tool output', async () => {
    const colored = makeTool('c', 'read', async () => ({
      content: '\x1b[31mred\x1b[0m\x07 text',
      isError: false,
    }));
    expect((await run('c', 'auto', [colored])).content).toBe('red text');
  });
});

describe('dispatch to the backend', () => {
  const recordingBackend = () => {
    const received: {
      tool: string;
      input: Record<string, unknown>;
      cwd: string;
      signal: AbortSignal;
    }[] = [];
    const backend: ToolBackend = {
      execute: async (tool, input, context) => {
        received.push({ tool: tool.name, input, cwd: context.cwd, signal: context.signal });
        return { content: '\x1b[1mfrom backend\x1b[0m', isError: false };
      },
    };
    return { backend, received };
  };

  test('hands an authorized call to the backend, and sanitizes what it returns', async () => {
    calls.length = 0;
    const { backend, received } = recordingBackend();
    const signal = new AbortController().signal;
    const result = await executeToolCall(
      { id: 'c1', name: 'bash', input: { command: 'ls' } },
      context([ok('bash', 'exec')], { signal, backend }),
    );
    expect(received).toEqual([{ tool: 'bash', input: { command: 'ls' }, cwd: '/work', signal }]);
    expect(received[0]?.signal).toBe(signal);
    expect(result).toEqual({ content: 'from backend', isError: false });
    // The backend runs the call; the tool is not also run in process.
    expect(calls).toEqual([]);
  });

  test('never reaches the backend with a call it refuses', async () => {
    const { backend, received } = recordingBackend();
    const writer: Tool = { ...ok('write_file', 'write'), targetPaths: () => ['/work/a.txt'] };
    const refusals = [
      await executeToolCall(
        { id: 'c1', name: 'missing', input: {} },
        context([writer], { backend }),
      ),
      await executeToolCall(
        { id: 'c2', name: 'write_file', input: {} },
        context([writer], { backend, mode: 'readonly' }),
      ),
      await executeToolCall(
        { id: 'c3', name: 'write_file', input: {} },
        context([writer], { backend, newInstructions: async () => 'AGENTS.md text' }),
      ),
    ];
    expect(refusals.map((r) => r.meta?.errorCode)).toEqual([
      'tool.unknown',
      'policy.denied',
      'instructions.new',
    ]);
    expect(received).toEqual([]);
  });

  test('reports target paths that cannot be computed as invalid input, without the backend', async () => {
    const { backend, received } = recordingBackend();
    const writer: Tool = {
      ...ok('write_file', 'write'),
      targetPaths: () => {
        throw new InvalidArgumentError("'path' must be a string");
      },
    };
    const result = await executeToolCall(
      { id: 'c1', name: 'write_file', input: { path: 1 } },
      context([writer], { backend, newInstructions: async () => null }),
    );
    expect(result.meta?.errorCode).toBe('input.invalid');
    expect(received).toEqual([]);
  });

  test('reports a backend that throws as a crash of the tool', async () => {
    const failing: ToolBackend = {
      execute: async () => {
        throw new Error('worker exited');
      },
    };
    const result = await executeToolCall(
      { id: 'c1', name: 'bash', input: {} },
      context([ok('bash', 'exec')], { backend: failing }),
    );
    expect(result.meta?.errorCode).toBe('tool.crashed');
    expect(result.content).toContain('bash failed unexpectedly: worker exited');
  });
});

describe('routing and a lost backend', () => {
  const recording = (failure: () => string | null = () => null) => {
    const received: string[] = [];
    const backend: ToolBackend = {
      execute: async (tool) => {
        received.push(tool.name);
        return { content: 'from backend', isError: false };
      },
      failure,
    };
    return { backend, received };
  };

  test('runs a tool that acts on the host in process, and every other on the backend', async () => {
    calls.length = 0;
    const { backend, received } = recording();
    const tools = [{ ...ok('delegate', 'read'), runsOnHost: true }, ok('read_file', 'read')];
    const host = await executeToolCall(
      { id: 'c1', name: 'delegate', input: {} },
      context(tools, { backend }),
    );
    const sandboxed = await executeToolCall(
      { id: 'c2', name: 'read_file', input: {} },
      context(tools, { backend }),
    );
    expect(host.content).toBe('delegate ran');
    expect(sandboxed.content).toBe('from backend');
    expect(calls).toEqual(['delegate']);
    expect(received).toEqual(['read_file']);
  });

  test('refuses every call once the backend is lost, host tools included', async () => {
    calls.length = 0;
    const { backend, received } = recording(() => 'the worker exited');
    const tools = [{ ...ok('delegate', 'read'), runsOnHost: true }, ok('read_file', 'read')];
    for (const name of ['read_file', 'delegate']) {
      const result = await executeToolCall(
        { id: 'c1', name, input: {} },
        context(tools, { backend }),
      );
      expect(result.meta?.errorCode).toBe('sandbox.lost');
      expect(result.content).toContain(
        `${name} was not executed: the tool sandbox stopped (the worker exited)`,
      );
    }
    expect(received).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('reports a call the backend lost while it ran as such, not as a crash', async () => {
    const backend: ToolBackend = {
      execute: async () => {
        throw new BackendLostError('the worker exited');
      },
    };
    const result = await executeToolCall(
      { id: 'c1', name: 'bash', input: {} },
      context([ok('bash', 'exec')], { backend }),
    );
    expect(result.meta?.errorCode).toBe('sandbox.lost');
    expect(result.content).toContain(
      'bash did not complete: the tool sandbox stopped (the worker exited)',
    );
  });
});
