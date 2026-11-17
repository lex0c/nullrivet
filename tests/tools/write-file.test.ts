import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { InvalidArgumentError } from '../../src/tools/args.ts';
import { writeFileTool } from '../../src/tools/write-file.ts';
import { abortedContext, errorCode, isRoot, TempDirs, toolContext } from './fixtures.ts';

const temp = new TempDirs();
let dir: string;

beforeEach(() => {
  dir = temp.create('write');
});

afterEach(() => {
  temp.cleanup();
});

const write = (input: Record<string, unknown>, cwd = dir) =>
  writeFileTool.execute(input, toolContext(cwd));

describe('writeFileTool', () => {
  test('is a write tool with an object schema', () => {
    expect(writeFileTool.effect).toBe('write');
    expect(writeFileTool.inputSchema.type).toBe('object');
    expect(writeFileTool.inputSchema.required).toEqual(['path', 'content']);
  });

  test('creates a new file and reports it', async () => {
    const path = join(dir, 'a.txt');
    const out = await write({ path, content: 'hello' });
    expect(out.isError).toBe(false);
    expect(out.content).toBe(`Wrote 5 bytes to ${path} (new file).`);
    expect(out.meta).toEqual({
      path,
      bytesWritten: 5,
      created: true,
      // For the user only: a new file is all added.
      diff: {
        added: 1,
        removed: 0,
        snippet: [{ type: 'add', text: 'hello', newLine: 1 }],
        hiddenChanges: 0,
      },
    });
    expect(out.touchedPaths).toEqual([path]);
    expect(readFileSync(path, 'utf-8')).toBe('hello');
  });

  test('overwrites an existing file', async () => {
    const path = join(dir, 'b.txt');
    writeFileSync(path, 'old content');
    const out = await write({ path: 'b.txt', content: 'new' });
    expect(out.content).toBe(`Wrote 3 bytes to ${path}.`);
    expect(out.meta).toMatchObject({
      created: false,
      bytesWritten: 3,
      diff: { added: 1, removed: 1, hiddenChanges: 0 },
    });
    expect(readFileSync(path, 'utf-8')).toBe('new');
  });

  test('a binary file it replaces gets no diff, and the write is unaffected', async () => {
    const path = join(dir, 'blob.bin');
    writeFileSync(path, Buffer.from([0x00, 0x01, 0x02]));
    const out = await write({ path: 'blob.bin', content: 'text now' });
    expect(out.isError).toBe(false);
    expect(out.meta?.diff).toBeUndefined();
    expect(readFileSync(path, 'utf-8')).toBe('text now');
  });

  test.skipIf(isRoot)('a file it cannot read is still written, without a diff', async () => {
    const path = join(dir, 'w-only.txt');
    writeFileSync(path, 'secret');
    chmodSync(path, 0o200);
    const out = await write({ path: 'w-only.txt', content: 'replaced' });
    expect(out.isError).toBe(false);
    expect(out.meta?.diff).toBeUndefined();
    chmodSync(path, 0o600);
    expect(readFileSync(path, 'utf-8')).toBe('replaced');
  });

  test('counts bytes, not characters', async () => {
    const out = await write({ path: 'u.txt', content: 'café' });
    expect(out.meta).toMatchObject({ bytesWritten: 5 });
  });

  test('writes an empty file', async () => {
    const out = await write({ path: 'empty.txt', content: '' });
    expect(out.isError).toBe(false);
    expect(readFileSync(join(dir, 'empty.txt'), 'utf-8')).toBe('');
  });

  test('creates missing parent directories', async () => {
    const path = join(dir, 'a/b/c/file.txt');
    const out = await write({ path, content: 'x' });
    expect(out.isError).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe('x');
  });

  test('writes outside cwd by absolute and by relative path', async () => {
    const other = temp.create('write-outside');
    const absolute = join(other, 'abs.txt');
    expect((await write({ path: absolute, content: 'abs' })).isError).toBe(false);
    expect(readFileSync(absolute, 'utf-8')).toBe('abs');
    const relative = await write({ path: join('..', basename(other), 'rel.txt'), content: 'rel' });
    expect(relative.isError).toBe(false);
    expect(relative.touchedPaths).toEqual([join(other, 'rel.txt')]);
    expect(readFileSync(join(other, 'rel.txt'), 'utf-8')).toBe('rel');
  });

  test('returns tool.aborted and writes nothing when the signal is aborted', async () => {
    const out = await writeFileTool.execute({ path: 'x.txt', content: 'x' }, abortedContext(dir));
    expect(errorCode(out)).toBe('tool.aborted');
    expect(existsSync(join(dir, 'x.txt'))).toBe(false);
  });

  test('refuses content over 10 MiB and does not create the file', async () => {
    const path = join(dir, 'too-big.txt');
    const out = await write({ path, content: 'a'.repeat(10 * 1024 * 1024 + 1) });
    expect(errorCode(out)).toBe('fs.too_large');
    expect(existsSync(path)).toBe(false);
  });

  test('measures the limit in UTF-8 bytes', async () => {
    const path = join(dir, 'wide.txt');
    // 3.5M characters of 3 bytes each: under the limit in characters, over it in bytes.
    const out = await write({ path, content: '中'.repeat(3_500_000) });
    expect(errorCode(out)).toBe('fs.too_large');
    expect(existsSync(path)).toBe(false);
  });

  test('accepts exactly 10 MiB', async () => {
    const out = await write({ path: 'cap.txt', content: 'a'.repeat(10 * 1024 * 1024) });
    expect(out.isError).toBe(false);
    expect(out.meta).toMatchObject({ bytesWritten: 10 * 1024 * 1024 });
  });

  test('refuses a directory target with fs.is_directory', async () => {
    mkdirSync(join(dir, 'sub'));
    const out = await write({ path: 'sub', content: 'x' });
    expect(errorCode(out)).toBe('fs.is_directory');
    expect(statSync(join(dir, 'sub')).isDirectory()).toBe(true);
  });

  test.skipIf(process.platform === 'win32')('refuses a device target', async () => {
    const out = await write({ path: '/dev/null', content: 'x' });
    expect(errorCode(out)).toBe('fs.not_regular_file');
  });

  test.skipIf(isRoot || process.platform === 'win32')(
    'returns fs.permission_denied when the directory is not writable',
    async () => {
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      try {
        const out = await write({ path: join(locked, 'a.txt'), content: 'x' });
        expect(errorCode(out)).toBe('fs.permission_denied');
        expect(out.content).toContain('directory must be writable');
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  test('preserves the mode of an existing file', async () => {
    const path = join(dir, 'script.sh');
    writeFileSync(path, '#!/bin/sh\necho old\n');
    chmodSync(path, 0o755);
    const out = await write({ path, content: '#!/bin/sh\necho new\n' });
    expect(out.isError).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe('#!/bin/sh\necho new\n');
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  test('leaves no temporary file behind', async () => {
    writeFileSync(join(dir, 'c.txt'), 'old');
    await write({ path: 'c.txt', content: 'new' });
    expect(readdirSync(dir)).toEqual(['c.txt']);
  });

  test('writes through a symlink to its target and keeps the link', async () => {
    const target = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(target, 'old');
    symlinkSync(target, link);
    const out = await write({ path: link, content: 'new' });
    expect(out.isError).toBe(false);
    expect(out.meta).toMatchObject({ created: false });
    expect(readFileSync(target, 'utf-8')).toBe('new');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('writes through a symlink to a file in another directory', async () => {
    const other = temp.create('write-link-target');
    const target = join(other, 'real.txt');
    writeFileSync(target, 'old');
    symlinkSync(target, join(dir, 'link.txt'));
    await write({ path: 'link.txt', content: 'new' });
    expect(readFileSync(target, 'utf-8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['link.txt']);
    expect(readdirSync(other)).toEqual(['real.txt']);
  });

  test('creates the target of a dangling symlink and keeps the link', async () => {
    const target = join(dir, 'not-yet.txt');
    const link = join(dir, 'link.txt');
    symlinkSync(target, link);
    const out = await write({ path: link, content: 'created' });
    expect(out.meta).toMatchObject({ created: true });
    expect(readFileSync(target, 'utf-8')).toBe('created');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('resolves a relative dangling symlink against the link directory', async () => {
    const link = join(dir, 'link.txt');
    symlinkSync('sub/later.txt', link);
    const out = await write({ path: link, content: 'rel' });
    expect(out.isError).toBe(false);
    expect(readFileSync(join(dir, 'sub', 'later.txt'), 'utf-8')).toBe('rel');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('writes the final target of a dangling symlink chain and keeps every link', async () => {
    const leaf = join(dir, 'leaf.txt');
    const mid = join(dir, 'mid.txt');
    const head = join(dir, 'head.txt');
    symlinkSync(leaf, mid);
    symlinkSync(mid, head);
    const out = await write({ path: head, content: 'leaf' });
    expect(out.isError).toBe(false);
    expect(readFileSync(leaf, 'utf-8')).toBe('leaf');
    expect(lstatSync(head).isSymbolicLink()).toBe(true);
    expect(lstatSync(mid).isSymbolicLink()).toBe(true);
  });

  test('rejects invalid arguments with InvalidArgumentError', async () => {
    const invalid: Record<string, unknown>[] = [
      { content: 'x' },
      { path: '', content: 'x' },
      { path: 'a.txt' },
      { path: 'a.txt', content: 42 },
    ];
    for (const input of invalid) {
      await expect(write(input)).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
  });
});
