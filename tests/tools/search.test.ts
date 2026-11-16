import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidArgumentError } from '../../src/tools/args.ts';
import { compileGlob, listFiles } from '../../src/tools/file-walk.ts';
import { globTool } from '../../src/tools/glob.ts';
import { grepTool } from '../../src/tools/grep.ts';
import { abortedContext, errorCode, TempDirs, toolContext } from './fixtures.ts';

const temp = new TempDirs();
afterEach(() => temp.cleanup());

const write = (root: string, path: string, content: string | Uint8Array): void => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
};

const sh = (command: string, cwd: string): void => {
  const result = Bun.spawnSync(['bash', '-c', command], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: 'tester@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdin: 'ignore',
  });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.toString()}`);
};

// A repository with a tracked file, an untracked file, an ignored file, a dependency directory and
// a tracked file deleted from the working tree.
const repo = (): string => {
  const root = temp.create('search-repo');
  write(root, '.gitignore', 'dist/\nnode_modules/\n');
  write(root, 'src/app.ts', 'export const answer = 42;\n');
  write(root, 'src/gone.ts', 'removed\n');
  sh('git init -q -b main && git add . && git commit -qm init && rm src/gone.ts', root);
  write(root, 'src/new.ts', 'const fresh = "Answer";\n');
  write(root, 'dist/app.js', 'const answer = 42;\n');
  write(root, 'node_modules/lib/index.js', 'module.exports = 42;\n');
  return root;
};

const run = (tool: typeof globTool, input: Record<string, unknown>, cwd: string) =>
  tool.execute(input, toolContext(cwd));

describe('listFiles', () => {
  test('inside a repository, files ignored by git are left out', async () => {
    const root = repo();
    const { files } = await listFiles(root, new AbortController().signal);
    expect(files).toContain('src/app.ts');
    expect(files).toContain('src/new.ts');
    expect(files.some((f) => f.startsWith('dist/') || f.startsWith('node_modules/'))).toBe(false);
  });

  test('a directory ignored by git is walked instead', async () => {
    const root = repo();
    const { files } = await listFiles(join(root, 'dist'), new AbortController().signal);
    expect(files).toEqual(['app.js']);
  });

  test('outside a repository, .git and node_modules are skipped', async () => {
    const root = temp.create('search-plain');
    write(root, 'a/b/c.txt', 'x');
    write(root, 'node_modules/x/index.js', 'x');
    write(root, '.git/config', 'x');
    const { files } = await listFiles(root, new AbortController().signal);
    expect(files).toEqual(['a/b/c.txt']);
  });
});

describe('compileGlob', () => {
  test('a pattern without a slash matches names at any depth', () => {
    const match = compileGlob('*.ts', 'pattern');
    expect(match('a.ts')).toBe(true);
    expect(match('src/deep/b.ts')).toBe(true);
    expect(match('src/b.js')).toBe(false);
  });

  test('a pattern with a slash matches the whole relative path', () => {
    const match = compileGlob('src/*.ts', 'pattern');
    expect(match('src/a.ts')).toBe(true);
    expect(match('src/deep/a.ts')).toBe(false);
  });

  test('patterns that leave the search root are refused', () => {
    expect(() => compileGlob('../*.ts', 'pattern')).toThrow(InvalidArgumentError);
    expect(() => compileGlob('/etc/*', 'pattern')).toThrow(InvalidArgumentError);
  });
});

describe('glob', () => {
  test('lists matching files relative to the working directory', async () => {
    const root = repo();
    const result = await run(globTool, { pattern: '*.ts' }, root);
    expect(result.isError).toBe(false);
    expect(result.content).toBe('src/app.ts\nsrc/new.ts');
  });

  test('searches another directory and reports when nothing matches', async () => {
    const root = repo();
    const cwd = temp.create('search-cwd');
    const result = await run(globTool, { pattern: '*.py', path: root }, cwd);
    expect(result.content).toContain('[glob: no files match "*.py"');
    const found = await run(globTool, { pattern: 'app.ts', path: root }, cwd);
    expect(found.content).toBe(join(root, 'src/app.ts'));
  });

  test('caps the result and says how many matched', async () => {
    const root = temp.create('search-many');
    for (let i = 0; i < 520; i++) write(root, `f${String(i).padStart(3, '0')}.txt`, '');
    const result = await run(globTool, { pattern: '*.txt' }, root);
    const lines = result.content.split('\n');
    expect(lines[0]).toBe('f000.txt');
    expect(result.content).toContain('showing the first 500 of 520 matching files');
  });

  test('a file as path is an error', async () => {
    const root = repo();
    const result = await run(globTool, { pattern: '*', path: 'src/app.ts' }, root);
    expect(errorCode(result)).toBe('fs.not_directory');
  });

  test('an aborted call does not list', async () => {
    const root = repo();
    const result = await globTool.execute({ pattern: '*' }, abortedContext(root));
    expect(errorCode(result)).toBe('tool.aborted');
  });
});

describe('grep', () => {
  test('returns matching lines with paths and line numbers, skipping ignored files', async () => {
    const root = repo();
    const result = await run(grepTool, { pattern: 'answer' }, root);
    expect(result.content).toBe('src/app.ts:1: export const answer = 42;');
  });

  test('ignore_case, glob and a single file', async () => {
    const root = repo();
    const both = await run(grepTool, { pattern: 'answer', ignore_case: true }, root);
    expect(both.content.split('\n')).toEqual([
      'src/app.ts:1: export const answer = 42;',
      'src/new.ts:1: const fresh = "Answer";',
    ]);
    const filtered = await run(grepTool, { pattern: 'const', glob: 'new.*' }, root);
    expect(filtered.content).toBe('src/new.ts:1: const fresh = "Answer";');
    const single = await run(grepTool, { pattern: '42', path: 'dist/app.js' }, root);
    expect(single.content).toBe('dist/app.js:1: const answer = 42;');
  });

  test('literal searches for the text as is; an invalid expression explains how', async () => {
    const root = temp.create('search-literal');
    write(root, 'a.txt', 'call(foo\nother\n');
    expect(() => grepTool.execute({ pattern: 'call(' }, toolContext(root))).toThrow(/literal/);
    const result = await run(grepTool, { pattern: 'call(', literal: true }, root);
    expect(result.content).toBe('a.txt:1: call(foo');
  });

  test('skips binary files and cuts long lines', async () => {
    const root = temp.create('search-binary');
    write(root, 'image.bin', new Uint8Array([104, 105, 0, 104, 105]));
    write(root, 'long.txt', `hi ${'z'.repeat(1_000)}\n`);
    const result = await run(grepTool, { pattern: 'hi' }, root);
    expect(result.content.startsWith('long.txt:1: hi zzz')).toBe(true);
    expect(result.content.endsWith('…')).toBe(true);
    expect(result.content).not.toContain('image.bin');
  });

  test('stops at the match limit and says so', async () => {
    const root = temp.create('search-limit');
    write(root, 'a.txt', 'hit\n'.repeat(300));
    const result = await run(grepTool, { pattern: 'hit' }, root);
    expect(result.content.split('\n').filter((l) => l.startsWith('a.txt:'))).toHaveLength(200);
    expect(result.content).toContain('stopped at 200 matches');
  });

  test('reports no matches and missing paths', async () => {
    const root = repo();
    const none = await run(grepTool, { pattern: 'nothing-here' }, root);
    expect(none.isError).toBe(false);
    expect(none.content).toBe('[grep: no matches in 3 files]');
    const missing = await run(grepTool, { pattern: 'x', path: 'nope' }, root);
    expect(errorCode(missing)).toBe('fs.not_found');
  });

  test('a deleted tracked file is not an error', async () => {
    const root = repo();
    rmSync(join(root, 'src/new.ts'));
    const result = await run(grepTool, { pattern: 'removed' }, root);
    expect(result.content).toContain('no matches');
    expect(result.content).not.toContain('unreadable');
  });
});
