import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles } from '../../src/tools/file-walk.ts';
import { gitTool } from '../../src/tools/git.ts';
import { removeOutputFiles } from '../../src/tools/output-files.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import { readParts, savedOutputs } from '../helpers/saved-output.ts';

let dir: string;

const sh = (command: string, cwd = dir): string => {
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
  return result.stdout.toString();
};

const ctx = (cwd = dir): ToolContext => ({ cwd, signal: new AbortController().signal });

const git = (input: Record<string, unknown>, cwd = dir) => gitTool.execute(input, ctx(cwd));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nullrivet-git-'));
  sh(
    'git init -q -b main && printf "one\\ntwo\\n" > a.txt && git add a.txt && git commit -qm first',
  );
  sh('printf "one\\ntwo\\nthree\\n" > a.txt && git commit -qam second');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterAll(() => removeOutputFiles());

describe('git tool', () => {
  test('is a read tool', () => {
    expect(gitTool.effect).toBe('read');
  });

  test('status reports the branch and modified files', async () => {
    sh('echo four >> a.txt');
    const result = await git({ subcommand: 'status' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('## main');
    expect(result.content).toContain(' M a.txt');
  });

  test('diff covers the worktree, the index, refs and paths', async () => {
    expect((await git({ subcommand: 'diff' })).content).toBe('[no changes]');
    sh('echo four >> a.txt');
    expect((await git({ subcommand: 'diff' })).content).toContain('+four');
    sh('git add a.txt');
    expect((await git({ subcommand: 'diff' })).content).toBe('[no changes]');
    expect((await git({ subcommand: 'diff', staged: true })).content).toContain('+four');
    const between = await git({ subcommand: 'diff', base: 'HEAD~1', target: 'HEAD', stat: true });
    expect(between.content).toContain('a.txt | 1 +');
    const filtered = await git({ subcommand: 'diff', staged: true, paths: ['missing.txt'] });
    expect(filtered.content).toBe('[no changes]');
  });

  test('a large diff is reduced and saved whole to a file', async () => {
    sh('seq 1 20000 > big.txt && git add big.txt && git commit -qm big');
    sh("seq 1 20000 | sed 's/$/ changed/' > big.txt");
    const result = await git({ subcommand: 'diff' });
    expect(result.content).toContain('lines elided');
    const outputs = savedOutputs(result.content);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.[0]).toContain('-git.001.txt');
    expect(readParts(outputs[0] ?? []).toString()).toBe(
      sh('git --no-pager diff --no-ext-diff --no-textconv --ignore-submodules=all'),
    );
  });

  test('a small diff is not saved', async () => {
    sh('echo four >> a.txt');
    const result = await git({ subcommand: 'diff' });
    expect(result.content).toContain('+four');
    expect(savedOutputs(result.content)).toEqual([]);
  });

  test('log honours max_count and oneline', async () => {
    const result = await git({ subcommand: 'log', max_count: 1, oneline: true });
    expect(result.content.trim().split('\n')).toHaveLength(1);
    expect(result.content).toContain('second');
  });

  test('show prints a commit or a file at a revision', async () => {
    expect((await git({ subcommand: 'show', ref: 'HEAD' })).content).toContain('+three');
    expect((await git({ subcommand: 'show', ref: 'HEAD~1:a.txt' })).content).toBe('one\ntwo\n');
  });

  test('blame accepts a line range', async () => {
    const result = await git({ subcommand: 'blame', path: 'a.txt', start_line: 3, end_line: 3 });
    expect(result.content.trim().split('\n')).toHaveLength(1);
    expect(result.content).toContain('three');
  });

  test('rejects refs that would be parsed as options', async () => {
    await expect(git({ subcommand: 'log', ref: '--output=/tmp/x' })).rejects.toThrow(
      "'ref' must not start with '-'",
    );
    await expect(git({ subcommand: 'diff', base: '-p' })).rejects.toThrow(
      "'base' must not start with '-'",
    );
    await expect(git({ subcommand: 'push' })).rejects.toThrow("'subcommand' must be one of");
  });

  test('reports a directory outside a repository as a tool error', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'nullrivet-nogit-'));
    try {
      const result = await git({ subcommand: 'status' }, outside);
      expect(result.isError).toBe(true);
      expect(result.meta?.errorCode).toBe('git.failed');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  describe('hostile repository configuration', () => {
    let sentinels: string;

    beforeEach(async () => {
      sentinels = join(dir, '.sentinels');
      sh(`mkdir ${sentinels}`);
      const hook = join(dir, '.hook.sh');
      await writeFile(
        hook,
        [
          '#!/bin/sh',
          'name="$1"; shift',
          `touch "${sentinels}/$name"`,
          'case "$name" in',
          '  filter_*|pager) exec cat ;;',
          '  textconv) exec cat "$1" ;;',
          '  *) exit 1 ;;',
          'esac',
          '',
        ].join('\n'),
      );
      await chmod(hook, 0o755);
      sh(
        [
          `git config core.fsmonitor "${hook} fsmonitor"`,
          `git config filter.evil.clean "${hook} filter_clean"`,
          `git config filter.evil.smudge "${hook} filter_smudge"`,
          `git config filter.evil.process "${hook} filter_process"`,
          `git config diff.evil.textconv "${hook} textconv"`,
          `git config diff.evil.command "${hook} diff_command"`,
          `git config diff.external "${hook} ext_diff"`,
          `git config core.pager "${hook} pager"`,
          `git config core.hooksPath "${dir}/.hooks"`,
          `mkdir .hooks && printf '#!/bin/sh\\ntouch ${sentinels}/post_index_change\\n' > .hooks/post-index-change && chmod +x .hooks/post-index-change`,
          `printf '*.txt filter=evil diff=evil\\n' > .gitattributes`,
          'echo four >> a.txt',
          'touch -t 200001010000 a.txt',
        ].join(' && '),
      );
    });

    const fired = async (): Promise<string[]> => (await readdir(sentinels)).sort();

    test('the fixture does execute programs through plain git', async () => {
      Bun.spawnSync(['git', 'diff'], {
        cwd: dir,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      expect((await fired()).length).toBeGreaterThan(0);
    });

    test('listing files for glob and grep executes nothing either', async () => {
      const { files } = await listFiles(dir, new AbortController().signal);
      expect(files).toContain('a.txt');
      expect(await fired()).toEqual([]);
    });

    test('no subcommand executes a program configured by the repository', async () => {
      const calls: Record<string, unknown>[] = [
        { subcommand: 'status' },
        { subcommand: 'diff' },
        { subcommand: 'diff', staged: true },
        { subcommand: 'diff', base: 'HEAD~1', target: 'HEAD' },
        { subcommand: 'log', max_count: 5 },
        { subcommand: 'show', ref: 'HEAD' },
        { subcommand: 'show', ref: 'HEAD:a.txt' },
        { subcommand: 'blame', path: 'a.txt' },
      ];
      for (const call of calls) {
        const result = await git(call);
        expect({ call, isError: result.isError, content: result.content }).toMatchObject({
          isError: false,
        });
      }
      expect(await fired()).toEqual([]);
    });

    test('status does not rewrite the index', async () => {
      const before = (await stat(join(dir, '.git', 'index'))).mtimeMs;
      await Bun.sleep(20);
      await git({ subcommand: 'status' });
      expect((await stat(join(dir, '.git', 'index'))).mtimeMs).toBe(before);
    });
  });
});
