import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  describeSavedOutput,
  type OutputFileSystem,
  OutputFiles,
  type OutputFilesOptions,
  type OutputSpool,
  type SavedOutput,
} from '../../src/tools/output-files.ts';
import { readParts } from '../helpers/saved-output.ts';
import { TempDirs } from './fixtures.ts';

const temp = new TempDirs();

afterEach(() => temp.cleanup());

const store = (options: OutputFilesOptions = {}): { files: OutputFiles; root: string } => {
  const root = temp.create('output-files');
  return { files: new OutputFiles({ root: () => root, ...options }), root };
};

const realFs = (overrides: Partial<OutputFileSystem> = {}): OutputFileSystem => ({
  mkdtempSync: (prefix) => mkdtempSync(prefix),
  openSync: (path, flags, mode) => openSync(path, flags, mode),
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  closeSync: (fd) => closeSync(fd),
  unlinkSync: (path) => unlinkSync(path),
  rmSync: (path, options) => rmSync(path, options),
  ...overrides,
});

// Pushes the input in chunks of varying sizes, as a pipe delivers it.
const pushInChunks = (spool: OutputSpool, input: Buffer): void => {
  const sizes = [1, 7, 3, 64, 5, 19];
  let offset = 0;
  for (let i = 0; offset < input.length; i++) {
    const size = sizes[i % sizes.length] ?? 1;
    spool.push(input.subarray(offset, offset + size));
    offset += size;
  }
};

const save = (files: OutputFiles, input: Buffer, threshold = 0): SavedOutput => {
  const spool = files.spool('bash-stdout', threshold);
  pushInChunks(spool, input);
  const saved = spool.finish({ keep: true });
  if (saved === null) throw new Error('nothing was saved');
  return saved;
};

const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i} ${'x'.repeat(i % 37)}`).join('\n');

describe('output files', () => {
  test('an output under the threshold is not written unless the caller keeps it', () => {
    const { files, root } = store();
    const dropped = files.spool('bash-stdout', 100);
    dropped.push(Buffer.from('a'.repeat(100)));
    expect(readdirSync(root)).toEqual([]);
    expect(dropped.finish({ keep: false })).toBeNull();
    expect(readdirSync(root)).toEqual([]);

    // A caller can reduce an output the spool counted as small: invalid UTF-8 decodes to
    // replacement characters three times its size.
    const kept = files.spool('bash-stdout', 100);
    const input = Buffer.alloc(80, 0xff);
    kept.push(input);
    const saved = kept.finish({ keep: true });
    expect(readParts(saved?.parts ?? []).equals(input)).toBe(true);
  });

  test('the parts concatenate to exactly the received bytes, text or binary', () => {
    const { files } = store({ partBytes: 64, lineBufferBytes: 16 });
    const binary = Buffer.from(Array.from({ length: 700 }, (_, i) => (i * 37) % 256));
    const input = Buffer.concat([
      Buffer.from(`${lines(50)}\nação 😀 終わり\n`),
      binary,
      Buffer.from('tail without newline'),
    ]);
    const saved = save(files, input);
    expect(readParts(saved.parts).equals(input)).toBe(true);
    expect(saved.savedBytes).toBe(input.length);
    expect(saved.receivedBytes).toBe(input.length);
    expect(saved.stopReason).toBeUndefined();
    expect(saved.interrupted).toBeUndefined();
  });

  test('parts stay within the part size and end at line boundaries', () => {
    const { files } = store({ partBytes: 64, lineBufferBytes: 64 });
    const input = Buffer.from(lines(200));
    const saved = save(files, input);
    expect(saved.parts.length).toBeGreaterThan(10);
    saved.parts.forEach((part, index) => {
      const bytes = readFileSync(part);
      expect(bytes.length).toBeLessThanOrEqual(64);
      if (index < saved.parts.length - 1) expect(bytes.at(-1)).toBe(0x0a);
    });
    expect(readParts(saved.parts).equals(input)).toBe(true);
    expect(readParts(saved.parts).at(-1)).not.toBe(0x0a);
  });

  test('a line longer than a part is cut before a UTF-8 character, never inside one', () => {
    const { files } = store({ partBytes: 16, lineBufferBytes: 1024 });
    const input = Buffer.from(`${'a'.repeat(14)}😀${'b'.repeat(20)}`);
    const saved = save(files, input);
    expect(readParts(saved.parts).equals(input)).toBe(true);
    for (const part of saved.parts) {
      const bytes = readFileSync(part);
      expect(bytes.length).toBeLessThanOrEqual(16);
      expect(new TextDecoder().decode(bytes)).not.toContain('�');
    }
    expect(readFileSync(saved.parts[0] ?? '').toString()).toBe('a'.repeat(14));
  });

  test('a long line written in pieces still ends each part between UTF-8 characters', () => {
    const { files } = store({ partBytes: 16, lineBufferBytes: 4 });
    const spool = files.spool('bash-stdout', 0);
    spool.push(Buffer.from('a'.repeat(15)));
    // A character split between two chunks, arriving when the part has one byte of room left.
    const accent = Buffer.from('é');
    spool.push(accent.subarray(0, 1));
    spool.push(Buffer.concat([accent.subarray(1), Buffer.from('b'.repeat(20))]));
    const saved = spool.finish({ keep: true });
    const input = Buffer.from(`${'a'.repeat(15)}é${'b'.repeat(20)}`);
    expect(readParts(saved?.parts ?? []).equals(input)).toBe(true);
    for (const part of saved?.parts ?? []) {
      expect(new TextDecoder().decode(readFileSync(part))).not.toContain('\uFFFD');
    }
  });

  test('the limit per output stops saving and keeps what was written', () => {
    const { files } = store({ partBytes: 64, outputLimitBytes: 100 });
    const input = Buffer.from(lines(40));
    const saved = save(files, input);
    expect(saved.savedBytes).toBeLessThanOrEqual(100);
    expect(saved.savedBytes).toBeGreaterThan(90);
    expect(saved.receivedBytes).toBe(input.length);
    expect(saved.stopReason).toBe('the 100B limit per output was reached');
    expect(readParts(saved.parts).equals(input.subarray(0, saved.savedBytes))).toBe(true);
  });

  test('the limit for the process stops later outputs and never removes earlier ones', () => {
    const { files } = store({ totalLimitBytes: 150 });
    const first = save(files, Buffer.from('1'.repeat(100)));
    const second = save(files, Buffer.from('2'.repeat(100)));
    const third = save(files, Buffer.from('3'.repeat(100)));
    expect(first.stopReason).toBeUndefined();
    expect(readParts(first.parts).toString()).toBe('1'.repeat(100));
    expect(second.savedBytes).toBe(50);
    expect(second.stopReason).toBe(
      'the 150B limit for the output files of this process was reached',
    );
    expect(third.parts).toEqual([]);
    expect(describeSavedOutput(third)).toBe(
      '[output not saved: the 150B limit for the output files of this process was reached]',
    );
  });

  test('a stopped output that was also interrupted reports both', () => {
    const { files } = store({ outputLimitBytes: 10 });
    const spool = files.spool('bash-stdout', 0);
    spool.push(Buffer.from('0123456789abcdef'));
    const saved = spool.finish({ keep: true, interrupted: 'the command timed out' });
    expect(saved?.stopReason).toBe('the 10B limit per output was reached');
    expect(saved?.interrupted).toBe('the command timed out');
    expect(describeSavedOutput(saved as SavedOutput)).toContain(
      'saving stopped: the 10B limit per output was reached; the capture also ended early: the command timed out;',
    );
  });

  test('discarding removes the parts and returns exactly their bytes to the process limit', () => {
    const { files, root } = store({ partBytes: 64, totalLimitBytes: 200 });
    const spool = files.spool('bash-stdout', 0);
    pushInChunks(spool, Buffer.from(`${lines(10)}\n`));
    const [dir = ''] = readdirSync(root);
    expect(readdirSync(join(root, dir)).length).toBe(2);
    expect(spool.finish({ keep: false })).toBeNull();
    expect(readdirSync(join(root, dir))).toEqual([]);
    const next = save(files, Buffer.from('n'.repeat(200)));
    expect(next.stopReason).toBeUndefined();
    expect(next.savedBytes).toBe(200);
  });

  test('a finished spool ignores further calls', () => {
    const { files } = store();
    const spool = files.spool('bash-stdout', 0);
    spool.push(Buffer.from('first\n'));
    const saved = spool.finish({ keep: true });
    spool.push(Buffer.from('late\n'));
    expect(spool.finish({ keep: false })).toBe(saved);
    expect(readParts(saved?.parts ?? []).toString()).toBe('first\n');
    expect(saved?.receivedBytes).toBe(6);

    const discarded = files.spool('git', 0);
    discarded.push(Buffer.from('gone\n'));
    expect(discarded.finish({ keep: false })).toBeNull();
    expect(discarded.finish({ keep: true })).toBeNull();
  });

  test('short writes still save every byte', () => {
    const { files } = store({
      fs: realFs({
        writeSync: (fd, buffer, offset, length) =>
          writeSync(fd, buffer, offset, Math.min(length, 3)),
      }),
    });
    const input = Buffer.from(lines(30));
    expect(readParts(save(files, input).parts).equals(input)).toBe(true);
  });

  test('a failing write stops saving without throwing and counts only written bytes', () => {
    let written = 0;
    const { files } = store({
      fs: realFs({
        writeSync: (fd, buffer, offset, length) => {
          if (written >= 40) throw new Error('ENOSPC: no space left on device, write');
          const n = writeSync(fd, buffer, offset, Math.min(length, 40 - written));
          written += n;
          return n;
        },
      }),
    });
    const input = Buffer.from('x\n'.repeat(100));
    const spool = files.spool('bash-stdout', 0);
    expect(() => pushInChunks(spool, input)).not.toThrow();
    const saved = spool.finish({ keep: true });
    expect(saved?.savedBytes).toBe(40);
    expect(saved?.receivedBytes).toBe(200);
    expect(saved?.stopReason).toBe('write failed: ENOSPC: no space left on device, write');
    expect(readParts(saved?.parts ?? []).equals(input.subarray(0, 40))).toBe(true);
  });

  test('a relative root gives absolute paths', () => {
    const root = temp.create('output-files');
    const files = new OutputFiles({ root: () => relative(process.cwd(), root) });
    const [part = ''] = save(files, Buffer.from('data\n')).parts;
    expect(isAbsolute(part)).toBe(true);
    expect(part.startsWith(join(root, 'nullrivet-'))).toBe(true);
  });

  test('a directory removed during the run is created again', () => {
    const { files } = store();
    const first = save(files, Buffer.from('one\n'));
    rmSync(dirname(first.parts[0] ?? ''), { recursive: true, force: true });
    const second = save(files, Buffer.from('two\n'));
    expect(second.stopReason).toBeUndefined();
    expect(readParts(second.parts).toString()).toBe('two\n');
  });

  test('output with a NUL byte is marked as binary', () => {
    const { files } = store();
    const saved = save(files, Buffer.from('name\0other\0'));
    expect(saved.binary).toBe(true);
    expect(describeSavedOutput(saved)).toContain(
      'it contains NUL bytes, which read_file and grep refuse as binary',
    );
    expect(save(files, Buffer.from('text\n')).binary).toBeUndefined();
  });

  test('a directory that cannot be created is reported in the note', () => {
    const root = temp.create('output-files');
    const files = new OutputFiles({ root: () => join(root, 'missing') });
    const saved = save(files, Buffer.from('data\n'));
    expect(saved.parts).toEqual([]);
    expect(describeSavedOutput(saved)).toStartWith(
      '[output not saved: could not create an output file: ',
    );
  });

  test('a part size under one byte is refused', () => {
    expect(() => new OutputFiles({ partBytes: 0 })).toThrow('partBytes must be at least 1');
  });

  test('the directory and the files are private to the user', () => {
    const { files } = store();
    const saved = save(files, Buffer.from('secret\n'));
    const part = saved.parts[0] ?? '';
    expect(statSync(dirname(part)).mode & 0o777).toBe(0o700);
    expect(statSync(part).mode & 0o777).toBe(0o600);
  });

  test('removeAll removes the directory, and later outputs use a new one', () => {
    const { files } = store();
    const first = save(files, Buffer.from('one\n'));
    files.removeAll();
    expect(existsSync(dirname(first.parts[0] ?? ''))).toBe(false);
    const second = save(files, Buffer.from('two\n'));
    expect(dirname(second.parts[0] ?? '')).not.toBe(dirname(first.parts[0] ?? ''));
    expect(readParts(second.parts).toString()).toBe('two\n');
  });

  test('start creates the first file at once, even when the limit is used up', () => {
    const { files } = store({ totalLimitBytes: 4 });
    save(files, Buffer.from('12345678\n'));
    const spool = files.spool('job', 0);
    expect(spool.start()).toBe(true);
    const [part = ''] = spool.snapshot().parts;
    expect(statSync(part).size).toBe(0);
    spool.push(Buffer.from('more\n'));
    expect(spool.snapshot()).toMatchObject({
      savedBytes: 0,
      receivedBytes: 5,
      stopReason: 'the 4B limit for the output files of this process was reached',
    });
  });

  test('a growing output is described as saved so far, never as complete', () => {
    const one = '/tmp/nullrivet-Ab12/3-job.001.txt';
    const log = { parts: [one], savedBytes: 2048, receivedBytes: 2048 };
    expect(describeSavedOutput(log, 'log', { growing: true })).toBe(
      `[log so far (2KB) saved to \`${one}\`; read it with read_file or search it with grep]`,
    );
    expect(describeSavedOutput({ ...log, stopReason: 'disk full' }, 'log', { growing: true })).toBe(
      `[log so far (2KB) saved to \`${one}\`; saving stopped: disk full; read it with read_file or search it with grep]`,
    );
    expect(describeSavedOutput({ ...log, binary: true }, 'log', { growing: true })).toContain(
      'it contains NUL bytes, which read_file and grep refuse as binary',
    );
  });

  test('the note names the parts, quoted, and how to read them', () => {
    const one = '/tmp/nullrivet-Ab12/3-git.001.txt';
    const three = ['/tmp/nullrivet-Ab12/3-git.001.txt', '', '/tmp/nullrivet-Ab12/3-git.003.txt'];
    const base = { savedBytes: 2_411_724, receivedBytes: 2_411_724 };
    expect(describeSavedOutput({ ...base, parts: [one] })).toBe(
      `[complete output (2.3MB) saved to \`${one}\`; read it with read_file or search it with grep]`,
    );
    expect(describeSavedOutput({ ...base, parts: three }, 'stdout')).toBe(
      `[complete stdout (2.3MB) saved in 3 parts, \`${three[0]}\` to \`${three[2]}\`; read each part with read_file, or search all of them with grep (path \`/tmp/nullrivet-Ab12\`, glob \`3-git.*.txt\`)]`,
    );
    expect(
      describeSavedOutput({ ...base, parts: [one], interrupted: 'the command timed out' }),
    ).toBe(
      `[interrupted output (2.3MB, received before the command timed out) saved to \`${one}\`; read it with read_file or search it with grep]`,
    );
    expect(
      describeSavedOutput(
        { parts: [one], savedBytes: 1024, receivedBytes: 4096, stopReason: 'write failed: ENOSPC' },
        'report',
      ),
    ).toBe(
      `[truncated report (1KB of 4KB received) saved to \`${one}\`; saving stopped: write failed: ENOSPC; read it with read_file or search it with grep]`,
    );
    expect(describeSavedOutput({ ...base, parts: [], stopReason: 'disk full' }, 'stderr')).toBe(
      '[stderr not saved: disk full]',
    );
  });
});
