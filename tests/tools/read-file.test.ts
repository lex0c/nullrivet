import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { InvalidArgumentError } from '../../src/tools/args.ts';
import { readFileTool } from '../../src/tools/read-file.ts';
import { abortedContext, errorCode, isRoot, TempDirs, toolContext } from './fixtures.ts';

const temp = new TempDirs();
let dir: string;

beforeEach(() => {
  dir = temp.create('read');
});

afterEach(() => {
  temp.cleanup();
});

const read = (input: Record<string, unknown>, cwd = dir) =>
  readFileTool.execute(input, toolContext(cwd));

describe('readFileTool', () => {
  test('is a read tool with an object schema', () => {
    expect(readFileTool.effect).toBe('read');
    expect(readFileTool.inputSchema.type).toBe('object');
    expect(readFileTool.inputSchema.required).toEqual(['path']);
  });

  test('returns the file content verbatim without line-number prefixes', async () => {
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'line1\nline2\nline3');
    const out = await read({ path });
    expect(out.isError).toBe(false);
    expect(out.content).toBe('line1\nline2\nline3');
    expect(out.meta).toMatchObject({
      path,
      totalLines: 3,
      offset: 0,
      linesReturned: 3,
      truncated: false,
    });
    expect(out.touchedPaths).toEqual([path]);
  });

  test('resolves a relative path against ctx.cwd', async () => {
    writeFileSync(join(dir, 'rel.txt'), 'hello');
    const out = await read({ path: 'rel.txt' });
    expect(out.content).toBe('hello');
    expect(out.touchedPaths).toEqual([join(dir, 'rel.txt')]);
  });

  test('reads a file outside cwd by absolute and by relative path', async () => {
    const other = temp.create('read-outside');
    const path = join(other, 'outside.txt');
    writeFileSync(path, 'outside');
    const absolute = await read({ path });
    expect(absolute.isError).toBe(false);
    expect(absolute.content).toBe('outside');
    const relative = await read({ path: join('..', basename(other), 'outside.txt') });
    expect(relative.isError).toBe(false);
    expect(relative.content).toBe('outside');
    expect(relative.touchedPaths).toEqual([path]);
  });

  test('reads through a symlink', async () => {
    const target = join(dir, 'real.txt');
    writeFileSync(target, 'real');
    symlinkSync(target, join(dir, 'link.txt'));
    const out = await read({ path: 'link.txt' });
    expect(out.content).toBe('real');
  });

  test('respects offset and limit and ends a partial result with a paging footer', async () => {
    const path = join(dir, 'big.txt');
    writeFileSync(path, Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n'));
    const out = await read({ path, offset: 10, limit: 5 });
    expect(out.content).toBe(
      'line10\nline11\nline12\nline13\nline14\n\n[read_file: showing lines 11-15 of 100; call read_file with offset=15 to continue.]',
    );
    expect(out.meta).toMatchObject({ totalLines: 100, linesReturned: 5, truncated: true });
  });

  test('the default limit of 2000 lines produces a footer on longer files', async () => {
    const path = join(dir, 'long.txt');
    writeFileSync(path, Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n'));
    const out = await read({ path });
    expect(out.meta).toMatchObject({ linesReturned: 2000, truncated: true });
    expect(
      out.content.endsWith(
        'showing lines 1-2000 of 2500; call read_file with offset=2000 to continue.]',
      ),
    ).toBe(true);
    const rest = await read({ path, offset: 2000 });
    expect(rest.meta).toMatchObject({ linesReturned: 500, truncated: false });
    expect(rest.content.startsWith('l2000\n')).toBe(true);
    expect(rest.content).not.toContain('[read_file:');
  });

  test('a window that reaches the end of the file has no footer', async () => {
    const path = join(dir, 'tail.txt');
    writeFileSync(path, 'a\nb\nc');
    const out = await read({ path, offset: 1 });
    expect(out.content).toBe('b\nc');
    expect(out.meta).toMatchObject({ truncated: false });
  });

  test('paginates a large file with a small window', async () => {
    const path = join(dir, 'huge.txt');
    const lines = Array.from(
      { length: 200_000 },
      (_, i) => `line-${i.toString().padStart(10, '0')}`,
    );
    writeFileSync(path, lines.join('\n'));
    const out = await read({ path, offset: 5, limit: 3 });
    expect(out.meta).toMatchObject({ totalLines: 200_000, linesReturned: 3, truncated: true });
    expect(out.content.startsWith('line-0000000005\nline-0000000006\nline-0000000007\n\n')).toBe(
      true,
    );
  });

  test('a trailing newline counts as a final empty line', async () => {
    const path = join(dir, 'trailing.txt');
    writeFileSync(path, 'a\nb\n');
    const out = await read({ path });
    expect(out.content).toBe('a\nb\n');
    expect(out.meta).toMatchObject({ totalLines: 3, linesReturned: 3 });
  });

  test('an empty file is one empty line', async () => {
    const path = join(dir, 'empty.txt');
    writeFileSync(path, '');
    const out = await read({ path });
    expect(out.isError).toBe(false);
    expect(out.content).toBe('');
    expect(out.meta).toMatchObject({ totalLines: 1, linesReturned: 1, truncated: false });
  });

  test('an offset past the end returns a note instead of empty content', async () => {
    const path = join(dir, 'small.txt');
    writeFileSync(path, 'a\nb\nc');
    const out = await read({ path, offset: 100, limit: 10 });
    expect(out.isError).toBe(false);
    expect(out.content).toBe(
      '[read_file: offset 100 is past the end of the file, which has 3 lines]',
    );
    expect(out.meta).toMatchObject({ linesReturned: 0, truncated: false });
  });

  test('cuts lines longer than 2000 characters and says so', async () => {
    const path = join(dir, 'wide.txt');
    writeFileSync(path, `short\n${'x'.repeat(5000)}\nend`);
    const out = await read({ path });
    const lines = out.content.split('\n');
    expect(lines[1]).toBe(`${'x'.repeat(2000)}…`);
    expect(out.content).toContain(
      '[read_file: 1 line(s) longer than 2000 characters were cut and marked with a trailing "…".]',
    );
    expect(out.meta).toMatchObject({ truncated: false, cutLines: 1 });
  });

  test('caps the output at 256 KiB and points to the next offset', async () => {
    const path = join(dir, 'verbose.txt');
    writeFileSync(path, Array.from({ length: 1500 }, () => 'x'.repeat(1000)).join('\n'));
    const out = await read({ path });
    const linesReturned = out.meta?.linesReturned as number;
    expect(linesReturned).toBeGreaterThan(50);
    expect(linesReturned).toBeLessThan(1500);
    expect(out.meta).toMatchObject({ truncated: true, totalLines: 1500 });
    expect(out.content).toContain(
      `[read_file: showing lines 1-${linesReturned} of 1500 (output limit of 256KB reached); call read_file with offset=${linesReturned} to continue.]`,
    );
    const body = out.content.slice(0, out.content.indexOf('\n\n[read_file:'));
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(256 * 1024);
  });

  test('reads multi-byte UTF-8 text', async () => {
    const path = join(dir, 'unicode.txt');
    writeFileSync(path, 'café ☕ 🚀\nsecond line');
    const out = await read({ path });
    expect(out.content).toBe('café ☕ 🚀\nsecond line');
  });

  test('strips a leading UTF-8 BOM', async () => {
    const path = join(dir, 'bom.txt');
    writeFileSync(path, Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    const out = await read({ path });
    expect(out.content).toBe('hi');
  });

  test('refuses a binary file with fs.binary', async () => {
    const path = join(dir, 'icon.bin');
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0x00]));
    const out = await read({ path });
    expect(out.isError).toBe(true);
    expect(errorCode(out)).toBe('fs.binary');
    expect(out.meta?.nulOffset).toBe(4);
    expect(out.content).toContain(path);
  });

  test('a NUL byte after the first 8000 bytes is not checked', async () => {
    const path = join(dir, 'late-nul.txt');
    const head = `${'a'.repeat(79)}\n`.repeat(100);
    writeFileSync(path, Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from([0x00])]));
    const out = await read({ path });
    expect(out.isError).toBe(false);
    expect(out.content.includes('\u0000')).toBe(true);
  });

  test('refuses files over 10 MiB with fs.too_large', async () => {
    const path = join(dir, 'large.txt');
    writeFileSync(path, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    const out = await read({ path });
    expect(errorCode(out)).toBe('fs.too_large');
  });

  test('returns fs.not_found for a missing file', async () => {
    const out = await read({ path: join(dir, 'nope.txt') });
    expect(out.isError).toBe(true);
    expect(errorCode(out)).toBe('fs.not_found');
    expect(out.touchedPaths).toBeUndefined();
  });

  test('returns fs.is_directory for a directory', async () => {
    mkdirSync(join(dir, 'sub'));
    const out = await read({ path: 'sub' });
    expect(errorCode(out)).toBe('fs.is_directory');
  });

  test.skipIf(process.platform === 'win32')('refuses a device file', async () => {
    const out = await read({ path: '/dev/null' });
    expect(errorCode(out)).toBe('fs.not_regular_file');
  });

  test.skipIf(isRoot || process.platform === 'win32')(
    'returns fs.permission_denied for an unreadable file',
    async () => {
      const path = join(dir, 'secret.txt');
      writeFileSync(path, 'secret');
      chmodSync(path, 0o000);
      const out = await read({ path });
      expect(errorCode(out)).toBe('fs.permission_denied');
    },
  );

  test('returns tool.aborted when the signal is already aborted', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x');
    const out = await readFileTool.execute({ path: 'a.txt' }, abortedContext(dir));
    expect(errorCode(out)).toBe('tool.aborted');
  });

  test('rejects invalid arguments with InvalidArgumentError', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\n');
    const invalid: Record<string, unknown>[] = [
      {},
      { path: '' },
      { path: 42 },
      { path: 'a.txt', offset: -1 },
      { path: 'a.txt', offset: 1.5 },
      { path: 'a.txt', limit: 0 },
      { path: 'a.txt', limit: 'abc' },
    ];
    for (const input of invalid) {
      await expect(read(input)).rejects.toBeInstanceOf(InvalidArgumentError);
    }
  });

  test('accepts offset 0', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    const out = await read({ path: 'a.txt', offset: 0 });
    expect(out.content).toBe('hello\n');
  });
});
