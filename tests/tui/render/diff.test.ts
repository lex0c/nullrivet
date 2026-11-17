import { describe, expect, test } from 'bun:test';
import { stripAnsi } from '../../../src/sanitize/ansi.ts';
import { type FileDiff, lineDiff } from '../../../src/tools/line-diff.ts';
import { formatPermanent } from '../../../src/tui/permanent.ts';
import { diffCounts, diffRows } from '../../../src/tui/render/diff.ts';
import { visualWidth } from '../../../src/tui/render/width.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps = (cols = 80): Capabilities => ({
  isTTY: true,
  cols,
  rows: 24,
  color: 'none',
  unicode: true,
});
const colored: Capabilities = { ...caps(), color: 'basic' };

const numbered = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`);

describe('diffCounts', () => {
  test('shows the added and removed lines in green and red', () => {
    const diff = lineDiff('a\nb', 'a\nB\nC');
    expect(diffCounts(diff, caps())).toBe('  +2 -1');
    const painted = diffCounts(diff, colored);
    expect(painted).toContain('\x1b[32m+2');
    expect(painted).toContain('\x1b[31m-1');
  });

  test('is empty when the content did not change', () => {
    expect(diffCounts(lineDiff('a', 'a'), caps())).toBe('');
  });
});

describe('diffRows', () => {
  test('one row per snippet line, with the line number, a rail and the mark', () => {
    const before = numbered(120);
    const after = [...before];
    after[98] = 'changed';
    expect(diffRows(lineDiff(before.join('\n'), after.join('\n')), caps())).toEqual([
      '     97 │   line 97',
      '     98 │   line 98',
      '     99 │ - line 99',
      '     99 │ + changed',
      '    100 │   line 100',
      '    101 │   line 101',
    ]);
  });

  test('numbers are right-aligned to the widest one', () => {
    const before = numbered(10);
    const after = [...before];
    after[8] = 'nine';
    const rows = diffRows(lineDiff(before.join('\n'), after.join('\n')), caps());
    expect(rows[0]).toBe('     7 │   line 7');
    expect(rows.at(-1)).toBe('    10 │   line 10');
  });

  test('lines are colored by change, and the rail is grey', () => {
    const rows = diffRows(lineDiff('a\nb', 'a\nB'), colored);
    expect(rows[1]).toContain('\x1b[31m- b');
    expect(rows[2]).toContain('\x1b[32m+ B');
    expect(rows[0]).toContain('\x1b[90m │ ');
  });

  test('without Unicode the rail is ASCII', () => {
    const rows = diffRows(lineDiff('', 'x'), { ...caps(), unicode: false });
    expect(rows).toEqual(['    1 | + x']);
  });

  test('escape sequences and carriage returns in the file are not written to the terminal', () => {
    const rows = diffRows(lineDiff('', 'a\x1b]0;title\x07\x1b[2Jb\r\tc'), colored);
    const text = rows.join('');
    expect(text).not.toContain('\x1b]');
    expect(text).not.toContain('\x1b[2J');
    expect(text).not.toContain('\r');
    expect(stripAnsi(rows[0] ?? '')).toBe('    1 │ + ab  c');
  });

  test('bidirectional controls in the file do not reorder the row', () => {
    const rows = diffRows(
      lineDiff('', 'access = "user\u202e \u2066// admin\u2069 \u2066"'),
      caps(),
    );
    expect(rows).toEqual(['    1 │ + access = "user // admin "']);
  });

  test('a line wider than the terminal is cut with an ellipsis', () => {
    const rows = diffRows(lineDiff('', `${'x'.repeat(200)}\n${'界'.repeat(100)}`), caps(40));
    for (const row of rows) {
      expect(visualWidth(row)).toBeLessThanOrEqual(40);
      expect(row).toEndWith('…');
    }
  });

  test('changes outside the snippet are counted in a last row', () => {
    const many = lineDiff('', numbered(14).join('\n'));
    expect(diffRows(many, caps()).at(-1)).toBe('    … +4 more changed lines');
    const one: FileDiff = { ...lineDiff('a', 'b'), hiddenChanges: 1 };
    expect(diffRows(one, caps()).at(-1)).toBe('    … +1 more changed line');
  });
});

describe('tool card', () => {
  const card = (
    meta: Record<string, unknown> | undefined,
    options: { isError?: boolean; path?: string; cols?: number } = {},
  ): string[] =>
    formatPermanent(
      {
        kind: 'tool',
        name: 'edit_file',
        args: { path: options.path ?? 'src/a.ts' },
        isError: options.isError ?? false,
        content: options.isError === true ? 'error [edit.no_match]: no match' : 'ok',
        meta,
        durationMs: 12,
      },
      caps(options.cols),
    );

  test('an edit shows the counts in its head and the changed region under it', () => {
    const lines = card({ diff: lineDiff('a\nb', 'a\nB') });
    expect(lines).toEqual([
      '',
      '● Edited src/a.ts  +1 -1  [12ms]',
      '    1 │   a',
      '    2 │ - b',
      '    2 │ + B',
    ]);
  });

  test('a failed edit and a result without a well-formed diff show no diff', () => {
    expect(card({ diff: lineDiff('a', 'b') }, { isError: true }).join('\n')).not.toContain('│');
    expect(card({ diff: { added: 1 } })).toEqual(['', '● Edited src/a.ts  [12ms]']);
    expect(card(undefined)).toEqual(['', '● Edited src/a.ts  [12ms]']);
  });

  test('the head keeps to one row with a long path and large counts', () => {
    const before = numbered(30_000).join('\n');
    const after = numbered(30_000)
      .map((line) => `${line}!`)
      .join('\n');
    const lines = card({ diff: lineDiff(before, after) }, { path: 'p/'.repeat(100), cols: 60 });
    expect(lines[1]).toContain('+30000 -30000');
    for (const line of lines) expect(visualWidth(line)).toBeLessThanOrEqual(60);
  });
});
