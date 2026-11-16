import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { InvalidArgumentError } from './args.ts';
import { fileSystemError } from './file-io.ts';
import { configArgs, GIT_TIMEOUT_MS, gitEnv, HARDENING_CONFIG } from './git.ts';
import { resolvePath } from './paths.ts';
import { runProcess } from './process.ts';
import { type ToolResult, toolError } from './types.ts';

// Bounds the enumeration of a huge tree; past it the search covers only part of the tree and says
// so.
export const MAX_LISTED_FILES = 200_000;
const GIT_LIST_CAPTURE_BYTES = 32 * 1024 * 1024;
// Nested repositories inside nested repositories; deeper ones are not entered.
const MAX_NESTING = 8;
const GITLINK_MODE = '160000';

export const LISTING_TRUNCATED_NOTE = `the directory has more than ${MAX_LISTED_FILES} files and only part of it was searched; narrow 'path'`;

// Outside a git repository there are no ignore rules to apply; these directories hold metadata or
// dependencies and would dominate any search.
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

export interface FileList {
  // Relative to the listed root, with '/' separators.
  files: string[];
  truncated: boolean;
}

// Inside a git repository the list comes from git, so files ignored by git are left out; ignore
// rules are too intricate to reimplement. A root that git ignores entirely (dependencies, build
// output) yields nothing there and is walked instead.
export const listFiles = (root: string, signal: AbortSignal): Promise<FileList> =>
  listTree(root, signal, MAX_LISTED_FILES, 0);

const listTree = async (
  root: string,
  signal: AbortSignal,
  budget: number,
  nesting: number,
): Promise<FileList> => {
  const fromGit = await listGitFiles(root, signal, budget, nesting);
  if (fromGit !== null && fromGit.files.length > 0) return fromGit;
  return walkFiles(root, signal, budget);
};

interface GitEntries {
  entries: string[];
  truncated: boolean;
}

const gitEntries = async (
  root: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<GitEntries | null> => {
  let run: Awaited<ReturnType<typeof runProcess>>;
  try {
    run = await runProcess({
      file: 'git',
      args: ['--no-pager', ...configArgs(HARDENING_CONFIG), 'ls-files', '-z', ...args],
      cwd: root,
      env: gitEnv(),
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
      stdoutLimitBytes: GIT_LIST_CAPTURE_BYTES,
    });
  } catch {
    return null;
  }
  if (run.termination !== 'exited' || run.exitCode !== 0) return null;
  let output = run.stdout;
  const truncated = run.stdoutBytes > GIT_LIST_CAPTURE_BYTES;
  if (truncated) {
    // The capture keeps the head and the tail of an oversized output; only the head is used, up
    // to its last complete entry.
    output = output.slice(0, output.lastIndexOf('\0', output.indexOf('\n[... ')) + 1);
  }
  return { entries: output.split('\0').filter((entry) => entry.length > 0), truncated };
};

// git lists a submodule as one entry (mode 160000 in the index) and an untracked repository nested
// in the tree as one 'dir/' entry. Both are listed in turn, so their files are searched too.
//
// Tracked files deleted from the working tree are still listed; callers that need existing files
// check them. Unmerged files appear once per conflict stage, hence the deduplication.
const listGitFiles = async (
  root: string,
  signal: AbortSignal,
  budget: number,
  nesting: number,
): Promise<FileList | null> => {
  const [tracked, untracked] = await Promise.all([
    gitEntries(root, ['--stage'], signal),
    gitEntries(root, ['--others', '--exclude-standard'], signal),
  ]);
  if (tracked === null || untracked === null) return null;

  const files = new Set<string>();
  const nested: string[] = [];
  for (const entry of tracked.entries) {
    // `<mode> <object> <stage>\t<path>`
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    if (entry.startsWith(`${GITLINK_MODE} `)) nested.push(path);
    else files.add(path);
  }
  for (const entry of untracked.entries) {
    if (entry.endsWith('/')) nested.push(entry.slice(0, -1));
    else files.add(entry);
  }

  let truncated = tracked.truncated || untracked.truncated;
  const list = [...files];
  if (list.length > budget) {
    list.length = budget;
    truncated = true;
  }
  if (nesting < MAX_NESTING) {
    for (const dir of [...new Set(nested)]) {
      if (signal.aborted || list.length >= budget) break;
      const inner = await listTree(join(root, dir), signal, budget - list.length, nesting + 1);
      for (const file of inner.files) list.push(`${dir}/${file}`);
      truncated ||= inner.truncated;
    }
  }
  return { files: list, truncated };
};

// Symbolic links are listed but not followed, which keeps a link cycle from looping. Directories
// that cannot be read are skipped.
const walkFiles = async (root: string, signal: AbortSignal, budget: number): Promise<FileList> => {
  const files: string[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    if (signal.aborted) break;
    const relativeDir = pending.pop() ?? '';
    let entries: Dirent[];
    try {
      entries = await readdir(relativeDir === '' ? root : `${root}/${relativeDir}`, {
        withFileTypes: true,
      });
    } catch (error) {
      if (relativeDir === '') throw error;
      continue;
    }
    for (const entry of entries) {
      const path = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
        continue;
      }
      if (files.length >= budget) return { files, truncated: true };
      files.push(path);
    }
  }
  return { files, truncated: false };
};

// Resolves the `path` argument of a search to a directory and lists its files, or explains why it
// cannot.
export const listDirectory = async (
  pathArg: string | undefined,
  cwd: string,
  signal: AbortSignal,
): Promise<{ ok: true; root: string; list: FileList } | { ok: false; error: ToolResult }> => {
  const root = resolvePath(pathArg ?? '.', cwd);
  try {
    if (!(await stat(root)).isDirectory()) {
      return {
        ok: false,
        error: toolError(
          'fs.not_directory',
          `${root} is not a directory`,
          'Set path to a directory.',
        ),
      };
    }
    return { ok: true, root, list: await listFiles(root, signal) };
  } catch (error) {
    return { ok: false, error: fileSystemError(error, 'read', root) };
  }
};

export type PathMatcher = (relativePath: string) => boolean;

// A pattern without '/' matches file names at any depth, as in .gitignore, so `*.ts` finds every
// TypeScript file. A pattern with '/' matches the whole path relative to the search root. A
// leading './' is dropped, since listed paths never start with it.
export const compileGlob = (pattern: string, key: string): PathMatcher => {
  const normalized = pattern.replace(/^(\.\/)+/, '');
  if (normalized.length === 0) {
    throw new InvalidArgumentError(`'${key}' must name files, for example "*.ts"`);
  }
  if (isAbsolute(normalized) || normalized.split(/[/\\]/).includes('..')) {
    throw new InvalidArgumentError(
      `'${key}' is matched against paths inside 'path'; set 'path' to search another directory`,
    );
  }
  const glob = new Bun.Glob(normalized);
  if (!normalized.includes('/')) {
    return (path) => glob.match(path.slice(path.lastIndexOf('/') + 1));
  }
  return (path) => glob.match(path);
};
