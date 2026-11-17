import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from '../../src/agent/system-prompt.ts';

const prompt = (mode: 'auto' | 'readonly', role: 'main' | 'subagent' = 'main'): string =>
  buildSystemPrompt({
    cwd: '/work',
    mode,
    platform: 'linux',
    date: '2026-01-02',
    isGitRepo: true,
    role,
    ...(role === 'main' ? { delegation: { maxRunning: 4 } } : {}),
  });

describe('buildSystemPrompt', () => {
  test('asks for replies in the language of the user in every mode and role', () => {
    for (const text of [prompt('auto'), prompt('readonly'), prompt('auto', 'subagent')]) {
      expect(text).toContain("Write your replies in the language of the user's messages.");
    }
  });

  test('a readonly prompt names no tool it does not offer', () => {
    const readonly = prompt('readonly');
    for (const name of ['edit_file', 'write_file', 'bash']) expect(readonly).not.toContain(name);
    expect(readonly).toContain('Use read_file, glob and grep');
    const auto = prompt('auto');
    for (const name of ['edit_file', 'bash']) expect(auto).toContain(name);
  });

  test('the delegation section states how many subagents run at once, and only for the main agent', () => {
    expect(prompt('auto')).toContain('up to 4 run at once and the others wait');
    // Models were seen sleeping in a loop to wait for a report.
    expect(prompt('auto')).toContain('until a report arrives, end your turn');
    expect(prompt('auto', 'subagent')).not.toContain('# Delegation');
  });

  test('the text before the mode section is the same in both modes', () => {
    const before = (text: string): string => text.slice(0, text.indexOf('# Execution mode'));
    expect(before(prompt('readonly'))).toBe(before(prompt('auto')));
    expect(before(prompt('auto')).length).toBeGreaterThan(1_000);
  });
});
