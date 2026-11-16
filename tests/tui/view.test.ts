import { describe, expect, test } from 'bun:test';
import { formatTokens } from '../../src/format.ts';
import { stripAnsi } from '../../src/sanitize/ansi.ts';
import { formatPermanent } from '../../src/tui/permanent.ts';
import { createInitialState, type TuiState } from '../../src/tui/state.ts';
import type { Capabilities } from '../../src/tui/term.ts';
import { composeLive } from '../../src/tui/view.ts';

const caps = (cols: number): Capabilities => ({
  isTTY: true,
  cols,
  rows: 30,
  color: 'none',
  unicode: true,
});

const base = (): TuiState => {
  const state = createInitialState({
    model: 'openrouter/vendor/a-rather-long-model-name:free',
    mode: 'auto',
    effort: undefined,
    cwd: '/work/project',
    home: '/home/u',
    contextWindow: 100_000,
  });
  return {
    ...state,
    status: {
      ...state.status,
      contextTokens: 12_000,
      totals: { input: 12_000, output: 800, cacheRead: 0, cacheWrite: 0, requests: 3 },
    },
  };
};

const footer = (state: TuiState, cols: number): string => {
  const rows = composeLive(state, caps(cols), 0).rows;
  return rows[rows.length - 2] ?? '';
};

describe('composeLive', () => {
  test('the footer shows mode, model, context and tokens when there is room', () => {
    const row = footer(base(), 140);
    expect(row).toContain('auto mode on (shift+tab to change)');
    expect(row).toContain('openrouter/vendor/a-rather-long-model-name:free');
    expect(row).toContain('ctx 12%');
    expect(row).toContain('↑12k ↓800');
    expect(row.length).toBeLessThanOrEqual(140);
  });

  test('a narrow footer drops the least important parts first and never overflows', () => {
    for (const cols of [100, 80, 60, 40, 20]) {
      const row = footer(base(), cols);
      expect(row.length).toBeLessThanOrEqual(cols);
      expect(row).toStartWith('  auto');
    }
    const medium = footer(base(), 90);
    expect(medium).toContain('openrouter/vendor');
    expect(medium).not.toContain('↑12k');
  });

  test('the footer names the mode and, while a task runs, how to interrupt it', () => {
    const readonly = { ...base(), status: { ...base().status, mode: 'readonly' as const } };
    expect(footer(readonly, 140)).toContain('readonly mode on (shift+tab to change)');
    const running: TuiState = {
      ...readonly,
      turn: {
        startedAt: 0,
        pendingText: '',
        thinkingSince: null,
        outputChars: 0,
        interrupting: false,
        tools: [],
      },
    };
    const row = footer(running, 40);
    expect(row).toContain('readonly mode on · esc to interrupt');
    expect(row).not.toContain('shift+tab');
  });

  test('popover rows carry the frame margin', () => {
    const state = {
      ...base(),
      slash: { items: [{ name: 'help', description: 'List' }], selected: 0 },
    };
    const rows = composeLive(state, caps(80), 0).rows;
    expect(rows).toContain('  > /help  List');
  });

  test('the cursor sits after the typed text in the input row', () => {
    const state = { ...base(), input: { value: 'hello', cursor: 5 } };
    const frame = composeLive(state, caps(80), 0);
    const row = frame.rows[frame.cursor?.row ?? -1] ?? '';
    expect(row).toBe('> hello');
    expect(frame.cursor?.col).toBe(7);
  });
});

describe('formatPermanent', () => {
  test('a long prompt is wrapped so every row keeps the highlighted bar', () => {
    const text = 'x'.repeat(30);
    const lines = formatPermanent({ kind: 'user', text }, caps(20));
    const rows = lines.filter((l) => l.length > 0);
    expect(rows.length).toBe(2);
    for (const row of rows) expect(stripAnsi(row)).toHaveLength(20);
  });

  test('a failed tool shows its error under the head', () => {
    const lines = formatPermanent(
      {
        kind: 'tool',
        name: 'bash',
        args: { command: 'make' },
        isError: true,
        content: 'error [bash.spawn_failed]: could not start bash',
        meta: undefined,
        durationMs: 12,
      },
      caps(80),
    );
    expect(lines.join('\n')).toContain('● Ran make');
    expect(lines.join('\n')).toContain('└─ could not start bash');
  });
});

describe('scrollback width', () => {
  test('long notices wrap inside the frame margin', () => {
    const text = `Unknown command /tmp. ${'word '.repeat(30)}`;
    const lines = formatPermanent({ kind: 'notice', level: 'error', text }, caps(40)).filter(
      (l) => l.length > 0,
    );
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
      expect(line).toStartWith('  ');
    }
  });

  test('a finished tool row fits the terminal width', () => {
    const lines = formatPermanent(
      {
        kind: 'tool',
        name: 'bash',
        args: { command: `echo ${'x'.repeat(200)}` },
        isError: false,
        content: '',
        meta: undefined,
        durationMs: 5,
      },
      caps(60),
    );
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(60);
  });

  test('provider failures are not repeated in the end-of-turn line', () => {
    const lines = formatPermanent(
      {
        kind: 'turn-end',
        reason: 'error',
        message: 'provider request failed: 500',
        durationMs: 2_000,
      },
      caps(80),
    );
    expect(lines.join('\n')).not.toContain('provider request failed');
  });

  test('escape sequences in notices are not written to the terminal', () => {
    const lines = formatPermanent(
      { kind: 'notice', level: 'error', text: 'bad \x1b]0;title\x07\x1b[2Jbody' },
      caps(80),
    );
    expect(lines.join('')).not.toContain('\x1b]');
    expect(lines.join('')).not.toContain('\x1b[2J');
  });
});

describe('formatTokens', () => {
  test('uses k and M suffixes', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_234)).toBe('1.2k');
    expect(formatTokens(56_789)).toBe('57k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('subagent progress', () => {
  test('a running delegate call shows what its subagent is doing', () => {
    const state: TuiState = {
      ...base(),
      turn: {
        startedAt: 0,
        pendingText: '',
        thinkingSince: null,
        outputChars: 0,
        interrupting: false,
        tools: [
          {
            id: 'd1',
            name: 'delegate',
            args: { title: 'scan the parser' },
            startedAt: 0,
            subagent: { step: 3, tool: { name: 'grep', args: { pattern: 'TODO', path: 'src' } } },
          },
        ],
      },
    };
    const rows = composeLive(state, caps(100), 1_000).rows.map(stripAnsi);
    const card = rows.findIndex((r) => r.includes('Delegating scan the parser'));
    expect(card).toBeGreaterThanOrEqual(0);
    expect(rows[card + 1]).toContain('step 3 · Searching TODO in src');
  });
});
