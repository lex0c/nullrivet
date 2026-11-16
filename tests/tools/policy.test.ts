import { describe, expect, test } from 'bun:test';
import { isExecutionMode, isToolAllowed, toolsForMode } from '../../src/tools/policy.ts';
import type { Tool, ToolEffect } from '../../src/tools/types.ts';

const tool = (name: string, effect: ToolEffect): Pick<Tool, 'name' | 'effect'> => ({
  name,
  effect,
});

const read = tool('read_file', 'read');
const git = tool('git', 'read');
const write = tool('write_file', 'write');
const bash = tool('bash', 'exec');

describe('isToolAllowed', () => {
  test('auto allows every effect', () => {
    for (const t of [read, git, write, bash]) expect(isToolAllowed('auto', t)).toBe(true);
  });

  test('readonly allows only read tools', () => {
    expect(isToolAllowed('readonly', read)).toBe(true);
    expect(isToolAllowed('readonly', git)).toBe(true);
    expect(isToolAllowed('readonly', write)).toBe(false);
    expect(isToolAllowed('readonly', bash)).toBe(false);
  });
});

describe('toolsForMode', () => {
  test('keeps the original order and drops tools with side effects in readonly', () => {
    const tools = [bash, read, write, git];
    expect(toolsForMode('auto', tools).map((t) => t.name)).toEqual([
      'bash',
      'read_file',
      'write_file',
      'git',
    ]);
    expect(toolsForMode('readonly', tools).map((t) => t.name)).toEqual(['read_file', 'git']);
  });
});

describe('isExecutionMode', () => {
  test('accepts only the two modes', () => {
    expect(isExecutionMode('auto')).toBe(true);
    expect(isExecutionMode('readonly')).toBe(true);
    expect(isExecutionMode('supervised')).toBe(false);
    expect(isExecutionMode('')).toBe(false);
  });
});
