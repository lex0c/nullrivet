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

  test('the footer hints are grey, not faint', () => {
    const colored = { ...caps(140), color: 'basic' as const };
    const row = (state: TuiState): string => {
      const rows = composeLive(state, colored, 0).rows;
      return rows[rows.length - 2] ?? '';
    };
    const idle = row(base());
    expect(idle).toContain('\x1b[90m (shift+tab to change)');
    const running = row({
      ...base(),
      turn: {
        startedAt: 0,
        pendingText: '',
        thinkingSince: null,
        outputChars: 0,
        interrupting: false,
        tools: [],
      },
    });
    expect(running).toContain('\x1b[90m · \x1b[0m\x1b[90mesc to interrupt');
    expect(`${idle}${running}`).not.toContain('\x1b[2m');
  });

  test('background work leads the right side in green, and is the last part dropped', () => {
    const working = (background: TuiState['status']['background']): TuiState => ({
      ...base(),
      status: { ...base().status, background },
    });
    const busy = working({ jobs: 2, subagents: 4, queuedSubagents: 1 });
    const wide = footer(busy, 160);
    expect(wide).toContain('2 jobs · 4+1 subagents · openrouter/vendor');
    const colored = composeLive(busy, { ...caps(160), color: 'basic' }, 0).rows;
    expect(colored[colored.length - 2]).toContain('\x1b[32m2 jobs');
    const narrow = footer(busy, 70);
    expect(narrow).toContain('2 jobs');
    expect(narrow).not.toContain('openrouter');
    expect(narrow.length).toBeLessThanOrEqual(70);
    expect(footer(working({ jobs: 1, subagents: 1, queuedSubagents: 0 }), 160)).toContain(
      '1 job · 1 subagent · ',
    );
    expect(footer(base(), 160)).not.toMatch(/job|subagent/);
  });

  test('with subagents and no task running, the footer says Esc cancels them', () => {
    const idle: TuiState = {
      ...base(),
      status: { ...base().status, background: { jobs: 0, subagents: 0, queuedSubagents: 2 } },
    };
    expect(footer(idle, 160)).toContain('auto mode on · esc to cancel subagents');
    expect(footer(idle, 160)).not.toContain('shift+tab');
    const running: TuiState = {
      ...idle,
      turn: {
        startedAt: 0,
        pendingText: '',
        thinkingSince: null,
        outputChars: 0,
        interrupting: false,
        tools: [],
      },
    };
    expect(footer(running, 160)).toContain('esc to interrupt');
    expect(footer(running, 160)).not.toContain('esc to cancel subagents');
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
  test('a background subagent shows what it is doing, with no turn running', () => {
    const state: TuiState = {
      ...base(),
      subagents: [
        {
          id: 's1',
          title: 'scan the parser',
          startedAt: 0,
          progress: { step: 3, tool: { name: 'grep', args: { pattern: 'TODO', path: 'src' } } },
        },
      ],
    };
    const rows = composeLive(state, caps(100), 1_000).rows.map(stripAnsi);
    const card = rows.findIndex((r) => r.includes('Subagent scan the parser'));
    expect(card).toBeGreaterThanOrEqual(0);
    expect(rows[card]).toContain('[1.0s]');
    expect(rows[card + 1]).toContain('step 3 · Searching TODO in src');
  });
});
