import { describe, expect, test } from 'bun:test';
import { type DiffLine, lineDiff, readFileDiff } from '../../src/tools/line-diff.ts';

const types = (lines: DiffLine[]): string => lines.map((l) => l.type[0]).join('');
const texts = (lines: DiffLine[], type: DiffLine['type']): string[] =>
  lines.filter((l) => l.type === type).map((l) => l.text);
const positions = (lines: DiffLine[]) => lines.map((l) => [l.text, l.oldLine, l.newLine] as const);
const numbered = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe('lineDiff', () => {
  test('identical content has no changes and no snippet', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nb\nc\n')).toEqual({
      added: 0,
      removed: 0,
      snippet: [],
      hiddenChanges: 0,
    });
    expect(lineDiff('', '')).toEqual({ added: 0, removed: 0, snippet: [], hiddenChanges: 0 });
  });

  test('a final newline does not count as a line', () => {
    expect(lineDiff('a\nb\n', 'a\nb').added).toBe(0);
    expect(lineDiff('a\nb\n', 'a\nb').removed).toBe(0);
  });

  test('a replaced line is shown removed, then added, between its context', () => {
    const diff = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(positions(diff.snippet)).toEqual([
      ['a', 1, 1],
      ['b', 2, undefined],
      ['B', undefined, 2],
      ['c', 3, 3],
    ]);
    expect(diff.hiddenChanges).toBe(0);
  });

  test('inserted lines take the new positions and push the following lines down', () => {
    const diff = lineDiff('a\nb', 'a\nX\nY\nb');
    expect(diff).toMatchObject({ added: 2, removed: 0 });
    expect(positions(diff.snippet)).toEqual([
      ['a', 1, 1],
      ['X', undefined, 2],
      ['Y', undefined, 3],
      ['b', 2, 4],
    ]);
  });

  test('deleted lines keep their old positions', () => {
    const diff = lineDiff('a\nX\nY\nb', 'a\nb');
    expect(diff).toMatchObject({ added: 0, removed: 2 });
    expect(positions(diff.snippet)).toEqual([
      ['a', 1, 1],
      ['X', 2, undefined],
      ['Y', 3, undefined],
      ['b', 4, 2],
    ]);
  });

  test('a new file is all additions', () => {
    const diff = lineDiff('', 'x\ny\nz\n');
    expect(diff).toMatchObject({ added: 3, removed: 0, hiddenChanges: 0 });
    expect(types(diff.snippet)).toBe('aaa');
  });

  test('a small change in a large file shows only that region, with its absolute positions', () => {
    const before = numbered('line ', 500);
    const after = [...before];
    after[250] = 'CHANGED';
    const diff = lineDiff(before.join('\n'), after.join('\n'));
    expect(diff).toMatchObject({ added: 1, removed: 1, hiddenChanges: 0 });
    expect(types(diff.snippet)).toBe('ccdacc');
    expect(diff.snippet.find((l) => l.type === 'del')).toMatchObject({
      text: 'line 250',
      oldLine: 251,
    });
    expect(diff.snippet.find((l) => l.type === 'add')).toMatchObject({
      text: 'CHANGED',
      newLine: 251,
    });
  });

  test('the snippet is the first changed region; later regions are counted as hidden', () => {
    const before = numbered('line ', 40);
    const after = [...before];
    after[5] = 'first';
    after[30] = 'second';
    const diff = lineDiff(before.join('\n'), after.join('\n'));
    expect(diff).toMatchObject({ added: 2, removed: 2, hiddenChanges: 2 });
    expect(texts(diff.snippet, 'add')).toEqual(['first']);
    expect(types(diff.snippet)).toBe('ccdacc');
  });

  test('changes a few lines apart belong to the same region', () => {
    const diff = lineDiff('a\nb\nc\nd\ne', 'A\nb\nc\nD\ne');
    expect(diff).toMatchObject({ added: 2, removed: 2, hiddenChanges: 0 });
    expect(types(diff.snippet)).toBe('daccdac');
  });

  test('a long changed region is cut at ten lines, and the rest is counted as hidden', () => {
    const diff = lineDiff(numbered('old', 20).join('\n'), numbered('new', 20).join('\n'));
    expect(diff).toMatchObject({ added: 20, removed: 20 });
    expect(diff.snippet).toHaveLength(10);
    expect(diff.hiddenChanges).toBe(30);
  });

  test('a long line is cut in the snippet', () => {
    const diff = lineDiff('', 'x'.repeat(2_000));
    expect(diff.snippet[0]?.text).toBe('x'.repeat(500));
  });

  test('changes far apart in a large file are counted as the lines they changed', () => {
    const before = numbered('line ', 3_000);
    const after = [...before];
    after[10] = 'first';
    after[2_990] = 'last';
    const diff = lineDiff(before.join('\n'), after.join('\n'));
    expect(diff).toMatchObject({ added: 2, removed: 2, hiddenChanges: 2 });
    expect(texts(diff.snippet, 'del')).toEqual(['line 10']);
    expect(texts(diff.snippet, 'ctx')).toEqual(['line 8', 'line 9', 'line 11', 'line 12']);
  });

  test('many changes spread over a file are each counted', () => {
    const before = numbered('row ', 20_000);
    const after = before.map((line, i) => (i % 50 === 0 ? `${line}!` : line));
    expect(lineDiff(before.join('\n'), after.join('\n'))).toMatchObject({
      added: 400,
      removed: 400,
      hiddenChanges: 798,
    });
  });

  test('a line appended after a last line without a newline is the only change', () => {
    const diff = lineDiff('a\nb', 'a\nb\nc\n');
    expect(diff).toMatchObject({ added: 1, removed: 0 });
    expect(positions(diff.snippet)).toEqual([
      ['a', 1, 1],
      ['b', 2, 2],
      ['c', undefined, 3],
    ]);
  });

  test('empty lines are counted and numbered like any other', () => {
    expect(positions(lineDiff('\na', '\nb').snippet)).toEqual([
      ['', 1, 1],
      ['a', 2, undefined],
      ['b', undefined, 2],
    ]);
    expect(lineDiff('\n\n', '\n\n\n')).toMatchObject({ added: 1, removed: 0 });
  });

  test('emptying a file removes every line', () => {
    const diff = lineDiff('x\ny\n', '');
    expect(diff).toMatchObject({ added: 0, removed: 2, hiddenChanges: 0 });
    expect(positions(diff.snippet)).toEqual([
      ['x', 1, undefined],
      ['y', 2, undefined],
    ]);
  });

  test('a cut line does not end in half a character', () => {
    const line = `${'x'.repeat(499)}😀y`;
    const text = lineDiff('', line).snippet[0]?.text ?? '';
    expect(text).toBe('x'.repeat(499));
  });

  test('a change too costly to compare line by line is counted as replaced whole', () => {
    // Every line differs but one, which a full comparison would keep.
    const sides = (count: number): [string, string] => {
      const a = numbered('a', count);
      const b = numbered('b', count);
      a[count >> 1] = 'same';
      b[count >> 1] = 'same';
      return [a.join('\n'), b.join('\n')];
    };
    expect(lineDiff(...sides(5_001))).toMatchObject({
      added: 5_001,
      removed: 5_001,
      approximate: true,
    });
    expect(lineDiff(...sides(501))).toMatchObject({ added: 500, removed: 500 });
    expect(lineDiff(...sides(501)).approximate).toBeUndefined();
  });

  test('comparisons that share a budget take their steps from it, and stop once it is spent', () => {
    const a = numbered('a', 501);
    const b = numbered('b', 501);
    a[250] = 'same';
    b[250] = 'same';
    const sides: [string, string] = [a.join('\n'), b.join('\n')];
    const budget = { steps: 700_000 };
    expect(lineDiff(...sides, budget)).toMatchObject({ added: 500, removed: 500 });
    const left = budget.steps;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(700_000);
    // What is left does not cover a second comparison of the same size.
    expect(lineDiff(...sides, budget)).toMatchObject({
      added: 501,
      removed: 501,
      approximate: true,
    });
    expect(budget.steps).toBeLessThan(0);
    // Without a budget, the same comparison gets its own steps.
    expect(lineDiff(...sides)).toMatchObject({ added: 500, removed: 500 });
  });

  test('a region with too many lines to compare is counted as replaced whole', () => {
    const before = numbered('old', 150_000);
    const after = numbered('new', 150_000);
    before[75_000] = 'same';
    after[75_000] = 'same';
    const diff = lineDiff(before.join('\n'), after.join('\n'));
    expect(diff).toMatchObject({ added: 150_000, removed: 150_000, approximate: true });
    expect(types(diff.snippet)).toBe('dddddddddd');
    expect(positions(diff.snippet).slice(0, 2)).toEqual([
      ['old0', 1, undefined],
      ['old1', 2, undefined],
    ]);
  });

  test('counts match the fewest lines removed and added, and the snippet matches the files', () => {
    let seed = 1;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const text = (): string => {
      const count = Math.floor(random() * 12);
      const lines = Array.from(
        { length: count },
        () => ['a', 'b', 'c', ''][Math.floor(random() * 4)],
      );
      return lines.join('\n') + (random() < 0.5 && count > 0 ? '\n' : '');
    };
    const lines = (value: string): string[] =>
      value === '' ? [] : (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
    // Length of the longest common subsequence, by the textbook table.
    const common = (a: string[], b: string[]): number => {
      const table = Array.from({ length: a.length + 1 }, () =>
        new Array<number>(b.length + 1).fill(0),
      );
      for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
          const row = table[i] as number[];
          const next = table[i + 1] as number[];
          row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
        }
      }
      return table[0]?.[0] ?? 0;
    };
    for (let round = 0; round < 2_000; round++) {
      const before = text();
      const after = text();
      const a = lines(before);
      const b = lines(after);
      const diff = lineDiff(before, after);
      const shared = common(a, b);
      expect({ added: diff.added, removed: diff.removed }).toEqual({
        added: b.length - shared,
        removed: a.length - shared,
      });
      for (const line of diff.snippet) {
        if (line.type !== 'add') expect(a[(line.oldLine ?? 0) - 1]).toBe(line.text);
        if (line.type !== 'del') expect(b[(line.newLine ?? 0) - 1]).toBe(line.text);
      }
    }
  });
});

describe('readFileDiff', () => {
  const valid = lineDiff('a\nb', 'a\nB');

  test('returns the diff in a tool result meta', () => {
    expect(readFileDiff({ path: '/x', diff: valid })).toEqual(valid);
  });

  test('returns null when there is no diff', () => {
    expect(readFileDiff(undefined)).toBeNull();
    expect(readFileDiff({ path: '/x' })).toBeNull();
    expect(readFileDiff({ diff: null })).toBeNull();
    expect(readFileDiff({ diff: 'a diff' })).toBeNull();
  });

  test('returns null for a diff that is not well formed', () => {
    const malformed: unknown[] = [
      { ...valid, added: -1 },
      { ...valid, removed: 1.5 },
      { ...valid, hiddenChanges: '0' },
      { ...valid, snippet: 'lines' },
      { ...valid, snippet: [{ type: 'change', text: 'x' }] },
      { ...valid, snippet: [{ type: 'add', text: 1 }] },
      { ...valid, snippet: [{ type: 'add', text: 'x', newLine: '2' }] },
      { ...valid, snippet: [{ type: 'del', text: 'x', oldLine: 0.5 }] },
      { ...valid, snippet: [null] },
      { ...valid, approximate: false },
      { ...valid, approximate: 'yes' },
    ];
    for (const diff of malformed) expect(readFileDiff({ diff })).toBeNull();
  });

  test('returns null for a diff larger than lineDiff produces', () => {
    const line = { type: 'add', text: 'x', newLine: 1 };
    expect(readFileDiff({ diff: { ...valid, snippet: Array(10).fill(line) } })).not.toBeNull();
    expect(readFileDiff({ diff: { ...valid, snippet: Array(11).fill(line) } })).toBeNull();
    const long = { ...line, text: 'x'.repeat(501) };
    expect(readFileDiff({ diff: { ...valid, snippet: [long] } })).toBeNull();
  });
});
