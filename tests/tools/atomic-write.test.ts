import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, truncateUtf8, writeAll } from '../../src/tools/atomic-write.ts';
import { TempDirs } from './fixtures.ts';

const temp = new TempDirs();

afterEach(() => {
  temp.cleanup();
});

describe('atomicWrite', () => {
  test('replaces the content and returns the byte count', () => {
    const dir = temp.create('atomic');
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'old');
    expect(atomicWrite(path, 'café')).toBe(5);
    expect(readFileSync(path, 'utf-8')).toBe('café');
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  test('keeps the temp name within NAME_MAX for a long non-ASCII file name', () => {
    const dir = temp.create('atomic');
    // 80 three-byte characters: 240 bytes, valid on its own; the temp name must not exceed 255.
    const path = join(dir, '中'.repeat(80));
    expect(atomicWrite(path, 'x')).toBe(1);
    expect(readFileSync(path, 'utf-8')).toBe('x');
  });
});

// A local filesystem does not short-write small buffers, so the loop is exercised with a fake
// writer that returns chosen byte counts.
describe('writeAll', () => {
  test('makes one call when the writer accepts everything', () => {
    const offsets: number[] = [];
    writeAll(
      (off) => {
        offsets.push(off);
        return 10 - off;
      },
      10,
      'x',
    );
    expect(offsets).toEqual([0]);
  });

  test('continues after short writes until every byte is written', () => {
    const offsets: number[] = [];
    writeAll(
      (off) => {
        offsets.push(off);
        return 3;
      },
      10,
      'x',
    );
    expect(offsets).toEqual([0, 3, 6, 9]);
  });

  test('throws instead of looping when the writer makes no progress', () => {
    let calls = 0;
    expect(() =>
      writeAll(
        () => {
          calls += 1;
          return 0;
        },
        10,
        'g.txt',
      ),
    ).toThrow(/short write: only 0 of 10 bytes written to g\.txt/);
    expect(calls).toBe(1);
  });

  test('makes no call for empty content', () => {
    let called = false;
    writeAll(
      () => {
        called = true;
        return 0;
      },
      0,
      'empty',
    );
    expect(called).toBe(false);
  });
});

describe('truncateUtf8', () => {
  test('returns the string unchanged when it fits', () => {
    expect(truncateUtf8('hello', 10)).toBe('hello');
    expect(truncateUtf8('hello', 5)).toBe('hello');
  });

  test('truncates ASCII to the byte budget', () => {
    expect(truncateUtf8('abcdefghij', 4)).toBe('abcd');
  });

  test('never splits a multi-byte character', () => {
    expect(truncateUtf8('中中中', 4)).toBe('中');
    expect(truncateUtf8('🚀x', 3)).toBe('');
    expect(truncateUtf8('🚀x', 4)).toBe('🚀');
  });

  test('bounds a long non-ASCII name in bytes, not UTF-16 units', () => {
    const slice = truncateUtf8('中'.repeat(200), 80);
    expect(Buffer.byteLength(slice, 'utf8')).toBeLessThanOrEqual(80);
    expect(slice).toBe('中'.repeat(26));
  });
});
