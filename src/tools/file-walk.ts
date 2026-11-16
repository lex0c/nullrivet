import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { InvalidArgumentError } from './args.ts';
import { configArgs, GIT_TIMEOUT_MS, gitEnv, HARDENING_CONFIG } from './git.ts';
import { runProcess } from './process.ts';

// Bounds the enumeration of a huge tree; past it the search covers only part of the tree and says
// so.
export const MAX_LISTED_FILES = 200_000;
const GIT_LIST_CAPTURE_BYTES = 32 * 1024 * 1024;

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
export const listFiles = async (root: string, signal: AbortSignal): Promise<FileList> => {
  const fromGit = await listGitFiles(root, signal);
  if (fromGit !== null && fromGit.files.length > 0) return fromGit;
  return walkFiles(root, signal);
};

// Tracked files deleted from the working tree are still listed; callers that need existing files
// check them. Unmerged files appear once per conflict stage, hence the deduplication.
const listGitFiles = async (root: string, signal: AbortSignal): Promise<FileList | null> => {
  let run: Awaited<ReturnType<typeof runProcess>>;
  try {
    run = await runProcess({
      file: 'git',
      args: [
        '--no-pager',
        ...configArgs(HARDENING_CONFIG),
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ],
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
  let truncated = run.stdoutBytes > GIT_LIST_CAPTURE_BYTES;
  if (truncated) {
    // The capture keeps the head and the tail of an oversized output; only the head is used, up
    // to its last complete entry.
    output = output.slice(0, output.lastIndexOf('\0', output.indexOf('\n[... ')) + 1);
  }
  const files = [...new Set(output.split('\0').filter((entry) => entry.length > 0))];
  if (files.length > MAX_LISTED_FILES) {
    files.length = MAX_LISTED_FILES;
    truncated = true;
  }
  return { files, truncated };
};

// Symbolic links are listed but not followed, which keeps a link cycle from looping. Directories
// that cannot be read are skipped.
const walkFiles = async (root: string, signal: AbortSignal): Promise<FileList> => {
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
      if (files.length >= MAX_LISTED_FILES) return { files, truncated: true };
      files.push(path);
    }
  }
  return { files, truncated: false };
};

export type PathMatcher = (relativePath: string) => boolean;

// A pattern without '/' matches file names at any depth, as in .gitignore, so `*.ts` finds every
// TypeScript file. A pattern with '/' matches the whole path relative to the search root.
export const compileGlob = (pattern: string, key: string): PathMatcher => {
  if (isAbsolute(pattern) || pattern.split(/[/\\]/).includes('..')) {
    throw new InvalidArgumentError(
      `'${key}' is matched against paths inside 'path'; set 'path' to search another directory`,
    );
  }
  const glob = new Bun.Glob(pattern);
  if (!pattern.includes('/')) {
    return (path) => glob.match(path.slice(path.lastIndexOf('/') + 1));
  }
  return (path) => glob.match(path);
};
