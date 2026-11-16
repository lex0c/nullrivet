import { describe, expect, test } from 'bun:test';
import { executeToolCall } from '../../src/agent/tool-executor.ts';
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

const run = (name: string, mode: ExecutionMode, tools: Tool[]) =>
  executeToolCall(
    { id: 'c1', name, input: {} },
    {
      tools: new Map(tools.map((t) => [t.name, t])),
      mode,
      cwd: '/tmp',
      signal: new AbortController().signal,
    },
  );

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
