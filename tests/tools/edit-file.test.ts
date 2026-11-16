import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { InvalidArgumentError } from '../../src/tools/args.ts';
import { editFileTool } from '../../src/tools/edit-file.ts';
import { abortedContext, errorCode, TempDirs, toolContext } from './fixtures.ts';

const temp = new TempDirs();
let dir: string;

beforeEach(() => {
  dir = temp.create('edit');
});

afterEach(() => {
  temp.cleanup();
});

interface Edit {
  old_string: unknown;
  new_string: unknown;
  replace_all?: unknown;
}

const edit = (path: string, edits: Edit[]) =>
  editFileTool.execute({ path, edits }, toolContext(dir));

const file = (name: string, content: string | Buffer): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const text = (path: string): string => readFileSync(path, 'utf-8');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe('editFileTool: single edit', () => {
  test('is a write tool with an object schema', () => {
    expect(editFileTool.effect).toBe('write');
    expect(editFileTool.inputSchema.type).toBe('object');
    expect(editFileTool.inputSchema.required).toEqual(['path', 'edits']);
  });

  test('replaces a unique occurrence', async () => {
    const path = file('a.ts', 'const x = 1;\nconst y = 2;\n');
    const out = await edit(path, [{ old_string: 'x = 1', new_string: 'x = 42' }]);
    expect(out.isError).toBe(false);
    expect(out.content).toBe(`Applied 1 edit to ${path} (1 replacement).`);
    expect(out.meta).toEqual({
      path,
      edits: [{ replacements: 1, strategy: 'exact' }],
      totalReplacements: 1,
      bytesWritten: Buffer.byteLength('const x = 42;\nconst y = 2;\n'),
      written: true,
    });
    expect(out.touchedPaths).toEqual([path]);
    expect(text(path)).toBe('const x = 42;\nconst y = 2;\n');
  });

  test('inserts new_string literally, without replacement patterns', async () => {
    const path = file('a.ts', 'price = X;\n');
    const out = await edit(path, [{ old_string: 'X', new_string: "'$$5' + '$&' + '$1'" }]);
    expect(out.isError).toBe(false);
    expect(text(path)).toBe("price = '$$5' + '$&' + '$1';\n");
  });

  test('refuses an ambiguous match and lists the matching lines', async () => {
    const path = file('a.ts', 'foo\nfoo\nfoo\n');
    const out = await edit(path, [{ old_string: 'foo', new_string: 'bar' }]);
    expect(errorCode(out)).toBe('edit.ambiguous');
    expect(out.meta).toMatchObject({ editIndex: 0, occurrences: 3, lines: [1, 2, 3] });
    expect(out.content).toContain('edits[0].old_string matches 3 times');
    expect(out.content).toContain('Matches start at lines 1, 2, 3.');
    expect(out.content).toContain('replace_all');
    expect(text(path)).toBe('foo\nfoo\nfoo\n');
  });

  test('lists at most 8 lines of an ambiguous match', async () => {
    const path = file('a.ts', 'foo\n'.repeat(12));
    const out = await edit(path, [{ old_string: 'foo', new_string: 'bar' }]);
    expect(out.meta).toMatchObject({ occurrences: 12, lines: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(out.content).toContain('lines 1, 2, 3, 4, 5, 6, 7, 8, …');
  });

  test('replace_all replaces every occurrence', async () => {
    const path = file('a.ts', 'foo\nfoo\nfoo');
    const out = await edit(path, [{ old_string: 'foo', new_string: 'bar', replace_all: true }]);
    expect(out.content).toBe(`Applied 1 edit to ${path} (3 replacements).`);
    expect(out.meta).toMatchObject({ totalReplacements: 3 });
    expect(text(path)).toBe('bar\nbar\nbar');
  });

  test('returns edit.no_match when old_string is missing', async () => {
    const path = file('a.ts', 'foo\n');
    const out = await edit(path, [{ old_string: 'bar', new_string: 'baz' }]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.content).toContain(`edits[0].old_string was not found in ${path}`);
    expect(out.content).toContain('Read the file');
    expect(out.meta?.diagnosis).toBeUndefined();
  });

  test('returns edit.no_change when old_string equals new_string', async () => {
    const path = file('a.ts', 'foo');
    const out = await edit(path, [{ old_string: 'foo', new_string: 'foo' }]);
    expect(errorCode(out)).toBe('edit.no_change');
    expect(out.content).toContain('edits[0]');
  });

  test('returns fs.not_found for a missing file', async () => {
    const out = await edit(join(dir, 'nope.txt'), [{ old_string: 'a', new_string: 'b' }]);
    expect(errorCode(out)).toBe('fs.not_found');
  });

  test('returns fs.is_directory for a directory', async () => {
    mkdirSync(join(dir, 'sub'));
    const out = await edit(join(dir, 'sub'), [{ old_string: 'a', new_string: 'b' }]);
    expect(errorCode(out)).toBe('fs.is_directory');
  });

  test('refuses a binary file', async () => {
    const path = file('a.bin', Buffer.from([0x61, 0x00, 0x62]));
    const out = await edit(path, [{ old_string: 'a', new_string: 'b' }]);
    expect(errorCode(out)).toBe('fs.binary');
    expect(readFileSync(path)).toEqual(Buffer.from([0x61, 0x00, 0x62]));
  });

  test('refuses a file that is not valid UTF-8 instead of corrupting it', async () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a]); // "caf\xE9\nx\n" in Latin-1
    const path = file('latin1.txt', bytes);
    const out = await edit(path, [{ old_string: 'x', new_string: 'y' }]);
    expect(errorCode(out)).toBe('fs.invalid_utf8');
    expect(readFileSync(path)).toEqual(bytes);
  });

  test('keeps a leading UTF-8 BOM', async () => {
    const path = file('bom.txt', Buffer.concat([BOM, Buffer.from('first\nsecond\n')]));
    const out = await edit(path, [{ old_string: 'first', new_string: 'FIRST' }]);
    expect(out.isError).toBe(false);
    expect(readFileSync(path)).toEqual(Buffer.concat([BOM, Buffer.from('FIRST\nsecond\n')]));
  });

  test('returns tool.aborted and leaves the file untouched', async () => {
    const path = file('a.ts', 'foo');
    const out = await editFileTool.execute(
      { path, edits: [{ old_string: 'foo', new_string: 'bar' }] },
      abortedContext(dir),
    );
    expect(errorCode(out)).toBe('tool.aborted');
    expect(text(path)).toBe('foo');
  });

  test('edits a file outside cwd by absolute and by relative path', async () => {
    const other = temp.create('edit-outside');
    const path = join(other, 'outside.ts');
    writeFileSync(path, 'a = 1;\nb = 2;\n');
    const absolute = await edit(path, [{ old_string: 'a = 1', new_string: 'a = 10' }]);
    expect(absolute.isError).toBe(false);
    const relative = await edit(join('..', basename(other), 'outside.ts'), [
      { old_string: 'b = 2', new_string: 'b = 20' },
    ]);
    expect(relative.isError).toBe(false);
    expect(relative.touchedPaths).toEqual([path]);
    expect(text(path)).toBe('a = 10;\nb = 20;\n');
  });

  test('edits through a symlink and keeps the link', async () => {
    const target = file('real.ts', 'value = 1;\n');
    const link = join(dir, 'link.ts');
    symlinkSync(target, link);
    const out = await edit(link, [{ old_string: 'value = 1', new_string: 'value = 2' }]);
    expect(out.isError).toBe(false);
    expect(text(target)).toBe('value = 2;\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('preserves the mode of the file', async () => {
    const path = file('run.sh', '#!/bin/sh\necho 1\n');
    chmodSync(path, 0o755);
    const out = await edit(path, [{ old_string: 'echo 1', new_string: 'echo 2' }]);
    expect(out.isError).toBe(false);
    expect(text(path)).toBe('#!/bin/sh\necho 2\n');
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  test('preserves CRLF line endings', async () => {
    const path = file('crlf.ts', 'a = 1;\r\nb = 2;\r\n');
    const out = await edit(path, [{ old_string: 'a = 1', new_string: 'a = 10' }]);
    expect(out.isError).toBe(false);
    expect(text(path)).toBe('a = 10;\r\nb = 2;\r\n');
  });
});

describe('editFileTool: argument validation', () => {
  test('rejects malformed input with InvalidArgumentError and leaves the file untouched', async () => {
    const path = file('a.ts', 'foo');
    const invalid: Record<string, unknown>[] = [
      { edits: [{ old_string: 'a', new_string: 'b' }] },
      { path, edits: 'not an array' },
      { path, edits: [] },
      { path, edits: ['foo'] },
      { path, edits: [{ old_string: 'foo' }] },
      { path, edits: [{ old_string: 1, new_string: 'b' }] },
      { path, edits: [{ old_string: 'foo', new_string: 'b', replace_all: 'yes' }] },
    ];
    for (const input of invalid) {
      await expect(editFileTool.execute(input, toolContext(dir))).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
    }
    expect(text(path)).toBe('foo');
  });

  test('names the invalid edit by index', async () => {
    const path = file('a.ts', 'foo');
    const call = edit(path, [
      { old_string: 'foo', new_string: 'bar' },
      { old_string: 'bar', new_string: 3 },
    ]);
    await expect(call).rejects.toThrow("edits[1]: 'new_string' must be a string, got number");
  });

  test('rejects an empty old_string and points to write_file', async () => {
    const path = file('a.ts', 'foo');
    await expect(edit(path, [{ old_string: '', new_string: 'bar' }])).rejects.toThrow(
      /edits\[0\]: 'old_string' must not be empty; use write_file/,
    );
    expect(text(path)).toBe('foo');
  });

  test('rejects more than 50 edits', async () => {
    const path = file('a.ts', 'x');
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      old_string: `${i}`,
      new_string: `${i + 1000}`,
    }));
    await expect(edit(path, tooMany)).rejects.toThrow(/at most 50 edits, got 51/);
  });
});

describe('editFileTool: batches', () => {
  test('applies edits in order and reports each replacement count', async () => {
    const path = file('a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const out = await edit(path, [
      { old_string: 'a = 1', new_string: 'a = 10' },
      { old_string: 'b = 2', new_string: 'b = 20' },
      { old_string: 'c = 3', new_string: 'c = 30' },
    ]);
    expect(out.content).toBe(`Applied 3 edits to ${path} (3 replacements).`);
    expect(out.meta?.edits).toEqual([
      { replacements: 1, strategy: 'exact' },
      { replacements: 1, strategy: 'exact' },
      { replacements: 1, strategy: 'exact' },
    ]);
    expect(text(path)).toBe('const a = 10;\nconst b = 20;\nconst c = 30;\n');
  });

  test('later edits search the result of earlier edits', async () => {
    const path = file('a.ts', 'foo');
    const out = await edit(path, [
      { old_string: 'foo', new_string: 'foo bar' },
      { old_string: 'bar', new_string: 'baz' },
    ]);
    expect(out.meta).toMatchObject({ totalReplacements: 2 });
    expect(text(path)).toBe('foo baz');
  });

  test('a failing edit leaves the file untouched and names the failing edit', async () => {
    const original = 'foo\nbar\n';
    const path = file('a.ts', original);
    const out = await edit(path, [
      { old_string: 'foo', new_string: 'FOO' },
      { old_string: 'missing', new_string: 'X' },
      { old_string: 'bar', new_string: 'BAR' },
    ]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.meta).toMatchObject({ editIndex: 1 });
    expect(out.content).toContain('edits[1].old_string was not found');
    expect(out.content).toContain('none of the 3 edits were applied');
    expect(out.content).toContain('content left by the previous edits');
    expect(text(path)).toBe(original);
  });

  test('replace_all is decided per edit', async () => {
    const path = file('a.ts', 'foo\nfoo\nfoo\nbaz\n');
    const out = await edit(path, [
      { old_string: 'foo', new_string: 'bar', replace_all: true },
      { old_string: 'baz', new_string: 'qux' },
    ]);
    expect(out.meta).toMatchObject({ totalReplacements: 4 });
    expect(text(path)).toBe('bar\nbar\nbar\nqux\n');
  });

  test('uniqueness is checked against the result of earlier edits', async () => {
    const path = file('a.ts', 'x\ny\n');
    const out = await edit(path, [
      { old_string: 'x', new_string: 'y' },
      { old_string: 'y', new_string: 'z' },
    ]);
    expect(errorCode(out)).toBe('edit.ambiguous');
    expect(out.content).toContain('edits[1]');
    expect(text(path)).toBe('x\ny\n');
  });

  test('a batch that restores the original content is not written', async () => {
    const path = file('a.ts', 'foo');
    const before = statSync(path);
    const out = await edit(path, [
      { old_string: 'foo', new_string: 'bar' },
      { old_string: 'bar', new_string: 'foo' },
    ]);
    expect(out.isError).toBe(false);
    expect(out.content).toBe(`The edits leave ${path} unchanged; the file was not written.`);
    expect(out.meta).toMatchObject({ written: false, bytesWritten: 0, totalReplacements: 2 });
    const after = statSync(path);
    // The atomic write replaces the inode, so an unchanged inode and mtime mean no write.
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test('writes once with the final content', async () => {
    const path = file('a.ts', 'aa\nbb\ncc');
    const out = await edit(path, [
      { old_string: 'aa', new_string: 'AA' },
      { old_string: 'bb', new_string: 'BB' },
      { old_string: 'cc', new_string: 'CC' },
    ]);
    expect(out.meta).toMatchObject({ bytesWritten: Buffer.byteLength('AA\nBB\nCC') });
    expect(text(path)).toBe('AA\nBB\nCC');
  });
});

describe('editFileTool: whitespace fallback', () => {
  test('applies a unique near-match with a uniform indentation shift and re-indents new_string', async () => {
    const path = file(
      'a.ts',
      ['class A {', '    foo() {', '        return 1;', '    }', '}', ''].join('\n'),
    );
    const out = await edit(path, [
      {
        old_string: ['foo() {', '    return 1;', '}'].join('\n'),
        new_string: ['foo() {', '    return 2;', '}'].join('\n'),
      },
    ]);
    expect(out.isError).toBe(false);
    expect(out.meta?.edits).toEqual([{ replacements: 1, strategy: 'whitespace' }]);
    expect(out.content).toContain('edits[0].old_string did not match exactly');
    expect(text(path)).toBe(
      ['class A {', '    foo() {', '        return 2;', '    }', '}', ''].join('\n'),
    );
  });

  test('strips indentation when old_string is over-indented', async () => {
    const path = file('a.ts', ['foo() {', '    return 1;', '}', ''].join('\n'));
    const out = await edit(path, [
      {
        old_string: ['    foo() {', '        return 1;', '    }'].join('\n'),
        new_string: ['    foo() {', '        return 2;', '    }'].join('\n'),
      },
    ]);
    expect(out.meta?.edits).toEqual([{ replacements: 1, strategy: 'whitespace' }]);
    expect(text(path)).toBe(['foo() {', '    return 2;', '}', ''].join('\n'));
  });

  test('tolerates trailing whitespace in the file', async () => {
    const path = file('a.ts', ['if (x) {', '  doThing();   ', '}', ''].join('\n'));
    const out = await edit(path, [
      {
        old_string: ['if (x) {', '  doThing();', '}'].join('\n'),
        new_string: ['if (x) {', '  doThing2();', '}'].join('\n'),
      },
    ]);
    expect(out.meta?.edits).toEqual([{ replacements: 1, strategy: 'whitespace' }]);
    expect(text(path)).toBe(['if (x) {', '  doThing2();', '}', ''].join('\n'));
  });

  test('reports a near-match with non-uniform indentation and shows its text', async () => {
    const original = ['    a();', '        b();', '    c();'].join('\n');
    const path = file('a.ts', original);
    const out = await edit(path, [
      { old_string: ['a();', '    b();', '        c();'].join('\n'), new_string: 'x();' },
    ]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.meta).toMatchObject({
      nearMatch: { startLine: 1, endLine: 3 },
      diagnosis: 'whitespace',
    });
    expect(out.content).toContain('(lines 1-3)');
    expect(out.content).toContain(`Copy its exact text into old_string:\n${original}`);
    expect(text(path)).toBe(original);
  });

  test('treats tabs against spaces as unsafe', async () => {
    const path = file('a.ts', '\tfoo();');
    const out = await edit(path, [{ old_string: '    foo();', new_string: '    bar();' }]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.meta).toMatchObject({ nearMatch: { startLine: 1, endLine: 1 } });
    expect(out.content).toContain('(line 1)');
    expect(text(path)).toBe('\tfoo();');
  });

  test('reports the lines of several whitespace near-matches', async () => {
    const original = ['\t\tfoo();', '\tfoo();'].join('\n');
    const path = file('a.ts', original);
    const out = await edit(path, [{ old_string: '  foo();', new_string: '  bar();' }]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.meta).toMatchObject({ nearMatchLines: [1, 2] });
    expect(out.content).toContain('start at lines 1, 2');
    expect(text(path)).toBe(original);
  });

  test('an exact match inside an indented line needs no fallback', async () => {
    const path = file('a.ts', '  const x = 1;\n');
    const out = await edit(path, [{ old_string: 'const x = 1;', new_string: 'const x = 2;' }]);
    expect(out.meta?.edits).toEqual([{ replacements: 1, strategy: 'exact' }]);
    expect(out.content).not.toContain('did not match exactly');
    expect(text(path)).toBe('  const x = 2;\n');
  });

  test('an LF old_string does not match CRLF lines', async () => {
    const original = 'function foo() {\r\n  return 1;\r\n}\r\n';
    const path = file('a.ts', original);
    const out = await edit(path, [
      {
        old_string: 'function foo() {\n  return 1;\n}',
        new_string: 'function foo() {\n  return 2;\n}',
      },
    ]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(text(path)).toBe(original);
  });

  test('a whitespace-only old_string does not match a blank line', async () => {
    const original = 'a();\n\nb();\n';
    const path = file('a.ts', original);
    const out = await edit(path, [{ old_string: '   ', new_string: 'INSERTED' }]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(text(path)).toBe(original);
  });

  test('the fallback is not used with replace_all', async () => {
    const original = 'foo();   \nbar();\n';
    const path = file('a.ts', original);
    const oldString = ['foo();', 'bar();'].join('\n');
    const out = await edit(path, [
      { old_string: oldString, new_string: 'baz();', replace_all: true },
    ]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(text(path)).toBe(original);
    const single = await edit(path, [{ old_string: oldString, new_string: 'baz();' }]);
    expect(single.meta?.edits).toEqual([{ replacements: 1, strategy: 'whitespace' }]);
  });

  test('a later edit in a batch can use the fallback', async () => {
    const path = file(
      'a.ts',
      ['let v = 1;', 'class C {', '    run() {', '        return v;', '    }', '}', ''].join('\n'),
    );
    const out = await edit(path, [
      { old_string: 'let v = 1;', new_string: 'let v = 2;' },
      {
        old_string: ['run() {', '    return v;', '}'].join('\n'),
        new_string: ['run() {', '    return v * 2;', '}'].join('\n'),
      },
    ]);
    expect(out.meta?.edits).toEqual([
      { replacements: 1, strategy: 'exact' },
      { replacements: 1, strategy: 'whitespace' },
    ]);
    expect(out.content).toContain('edits[1].old_string did not match exactly');
    expect(out.content).not.toContain('edits[0].old_string did not match exactly');
    expect(text(path)).toBe(
      ['let v = 2;', 'class C {', '    run() {', '        return v * 2;', '    }', '}', ''].join(
        '\n',
      ),
    );
  });

  test('near-match line numbers refer to the content left by earlier edits', async () => {
    const original = ['DELETE_ME', '    a();', '        b();', '    c();', ''].join('\n');
    const path = file('a.ts', original);
    const out = await edit(path, [
      { old_string: 'DELETE_ME\n', new_string: '' },
      { old_string: ['a();', '    b();', '        c();'].join('\n'), new_string: 'x();' },
    ]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.meta).toMatchObject({ editIndex: 1, nearMatch: { startLine: 1, endLine: 3 } });
    expect(text(path)).toBe(original);
  });

  test('re-indents a new_string with more lines than old_string', async () => {
    const path = file('a.ts', ['    if (x) {', '        a();', '    }', ''].join('\n'));
    await edit(path, [
      {
        old_string: ['if (x) {', '    a();', '}'].join('\n'),
        new_string: ['if (x) {', '    a();', '    b();', '}'].join('\n'),
      },
    ]);
    expect(text(path)).toBe(
      ['    if (x) {', '        a();', '        b();', '    }', ''].join('\n'),
    );
  });

  test('leaves blank lines of new_string empty when re-indenting', async () => {
    const path = file('a.ts', ['    foo() {', '        a();', '    }', ''].join('\n'));
    await edit(path, [
      {
        old_string: ['foo() {', '    a();', '}'].join('\n'),
        new_string: ['foo() {', '    a();', '', '    b();', '}'].join('\n'),
      },
    ]);
    expect(text(path)).toBe(
      ['    foo() {', '        a();', '', '        b();', '    }', ''].join('\n'),
    );
  });

  test('leaves a line shallower than the stripped indentation unchanged', async () => {
    const path = file('a.ts', ['foo() {', '    a();', '}', ''].join('\n'));
    await edit(path, [
      {
        old_string: ['    foo() {', '        a();', '    }'].join('\n'),
        new_string: ['    foo() {', '        a();', '  weird();', '    }'].join('\n'),
      },
    ]);
    expect(text(path)).toBe(['foo() {', '    a();', '  weird();', '}', ''].join('\n'));
  });
});

describe('editFileTool: extended fallbacks and diagnostics', () => {
  const composed = `caf${String.fromCharCode(0x00e9)}`;
  const decomposed = `cafe${String.fromCharCode(0x0301)}`;

  test('applies a near-match that differs only in Unicode normalization', async () => {
    const path = file('a.ts', `const name = '${composed}';\n`);
    const out = await edit(path, [
      { old_string: `const name = '${decomposed}';`, new_string: "const name = 'tea';" },
    ]);
    expect(out.isError).toBe(false);
    expect(out.meta?.edits).toEqual([{ replacements: 1, strategy: 'unicode' }]);
    expect(out.content).toContain('Unicode normalization');
    expect(text(path)).toBe("const name = 'tea';\n");
  });

  test('reports a Unicode near-match whose indentation is not a uniform shift', async () => {
    const original = `\tconst x = '${composed}';\n`;
    const path = file('a.ts', original);
    const out = await edit(path, [
      { old_string: `    const x = '${decomposed}';`, new_string: 'y' },
    ]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.meta).toMatchObject({
      nearMatch: { startLine: 1, endLine: 1 },
      diagnosis: 'unicode',
    });
    expect(text(path)).toBe(original);
  });

  test('reports over-escaped quotes without applying the edit', async () => {
    const original = 'const a = "hello";\n';
    const path = file('a.ts', original);
    const out = await edit(path, [
      { old_string: 'const a = \\"hello\\";', new_string: 'const a = "world";' },
    ]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.meta).toMatchObject({
      nearMatch: { startLine: 1, endLine: 1 },
      diagnosis: 'escaped_quotes',
    });
    expect(out.content).toContain('quotes');
    expect(out.content).toContain('Copy its exact text into old_string:\nconst a = "hello";');
    expect(text(path)).toBe(original);
  });

  test('reports a block whose first and last lines match but whose interior differs', async () => {
    const original = ['function foo() {', '  doA();', '  doB();', '}', ''].join('\n');
    const path = file('a.ts', original);
    const out = await edit(path, [
      { old_string: ['function foo() {', '  doX();', '  doY();', '}'].join('\n'), new_string: 'x' },
    ]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.meta).toMatchObject({
      nearMatch: { startLine: 1, endLine: 4 },
      diagnosis: 'block_anchor',
    });
    expect(out.content).toContain(['function foo() {', '  doA();', '  doB();', '}'].join('\n'));
    expect(text(path)).toBe(original);
  });

  test('omits near-match text over 1600 characters', async () => {
    const interior = Array.from({ length: 40 }, (_, i) => `  line${i}(${'x'.repeat(40)});`);
    const original = ['function big() {', ...interior, '}', ''].join('\n');
    const path = file('a.ts', original);
    const drifted = interior.map((line) => line.replace('line', 'other'));
    const out = await edit(path, [
      { old_string: ['function big() {', ...drifted, '}'].join('\n'), new_string: 'x' },
    ]);
    expect(out.meta).toMatchObject({ diagnosis: 'block_anchor' });
    expect(out.content).toContain('Copy the exact text of that region into old_string.');
    expect(out.content).not.toContain('line0(');
  });

  test('a single missing line gets the generic error without a diagnosis', async () => {
    const path = file('a.ts', 'foo\n');
    const out = await edit(path, [{ old_string: 'bar', new_string: 'baz' }]);
    expect(errorCode(out)).toBe('edit.no_match');
    expect(out.meta?.diagnosis).toBeUndefined();
    expect(out.meta?.nearMatch).toBeUndefined();
  });
});
