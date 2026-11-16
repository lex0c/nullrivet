import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidArgumentError, optionalBoolean, optionalString, requireString } from './args.ts';
import { fileSystemError, loadTextFileBytes } from './file-io.ts';
import { compileGlob, LISTING_TRUNCATED_NOTE, listDirectory } from './file-walk.ts';
import type { SearchRequest, SearchResult } from './grep-search.ts';
import { displayPath, resolvePath } from './paths.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

const SEARCH_TIMEOUT_MS = 60_000;

// From source, the worker module sits next to this file. In a compiled binary, import.meta.url
// names the executable, and the build embeds the worker entry point under the executable's virtual
// root by its path relative to src/. The URL is absolute in both cases: a relative specifier that
// is not embedded would be looked up in the working directory, where a repository could place a
// file of that name.
const COMPILED_ROOT = 'file:///$bunfs/';
const workerUrl = (): URL =>
  import.meta.url.startsWith(COMPILED_ROOT)
    ? new URL('./tools/grep-worker.ts', import.meta.url)
    : new URL('./grep-worker.ts', import.meta.url);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compilePattern = (pattern: string, literal: boolean, ignoreCase: boolean): RegExp => {
  try {
    return new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? 'i' : '');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidArgumentError(
      `'pattern' is not a valid regular expression (${reason}); set 'literal' to true to search for the text as is`,
    );
  }
};

type WorkerReply = { ok: true; result: SearchResult } | { ok: false; message: string };
type SearchOutcome = WorkerReply | 'aborted' | 'timeout';

// Matching runs in a worker that is terminated on abort or timeout, because a pattern with
// catastrophic backtracking never yields to the event loop.
const runSearch = (request: SearchRequest, signal: AbortSignal): Promise<SearchOutcome> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    const worker = new Worker(workerUrl());
    let settled = false;
    const settle = (outcome: SearchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      resolve(outcome);
    };
    const onAbort = (): void => settle('aborted');
    const timer = setTimeout(() => settle('timeout'), SEARCH_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => settle(event.data);
    worker.onerror = (event: ErrorEvent) => settle({ ok: false, message: event.message });
    worker.postMessage(request);
  });

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a regular expression (JavaScript syntax), line by line. Returns the matching lines as "path:line: text", with 1-based line numbers. `path` is a file or a directory (default: the working directory); `glob` limits a directory search to matching files, with the same rules as the glob tool. Inside a git repository, files ignored by git are skipped; elsewhere, hidden entries and node_modules are skipped; binary files and files over 10 MiB are always skipped. Set `literal` to search for the text as is. Lines are cut at 500 characters. Returns at most 200 matches.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression, or plain text with literal.' },
      path: {
        type: 'string',
        description: 'File or directory to search, absolute or relative to the working directory.',
      },
      glob: {
        type: 'string',
        description: 'Only search files matching this glob, such as "*.ts".',
      },
      ignore_case: { type: 'boolean', description: 'Match case-insensitively.' },
      literal: { type: 'boolean', description: 'Treat the pattern as plain text.' },
    },
    required: ['pattern'],
  },
  effect: 'read',
  async execute(input, ctx): Promise<ToolResult> {
    const pattern = requireString(input, 'pattern');
    if (pattern.length === 0) throw new InvalidArgumentError("'pattern' must not be empty");
    const regex = compilePattern(
      pattern,
      optionalBoolean(input, 'literal') ?? false,
      optionalBoolean(input, 'ignore_case') ?? false,
    );
    const globArg = optionalString(input, 'glob');
    const filter =
      globArg === undefined || globArg.length === 0 ? undefined : compileGlob(globArg, 'glob');
    const pathArg = optionalString(input, 'path');
    const target = resolvePath(pathArg ?? '.', ctx.cwd);
    const notes: string[] = [];

    let isFile: boolean;
    try {
      isFile = (await stat(target)).isFile();
    } catch (error) {
      return fileSystemError(error, 'read', target);
    }

    let files: SearchRequest['files'];
    if (isFile) {
      // Reports a binary, oversized or unreadable file as an error instead of an empty search.
      const loaded = await loadTextFileBytes(target);
      if (!loaded.ok) return loaded.error;
      files = [{ abs: target, display: displayPath(target, ctx.cwd) }];
    } else {
      const listed = await listDirectory(pathArg, ctx.cwd, ctx.signal);
      if (!listed.ok) return listed.error;
      const { root, list } = listed;
      const selected = filter === undefined ? list.files : list.files.filter(filter);
      files = selected.sort().map((path) => {
        const abs = join(root, path);
        return { abs, display: displayPath(abs, ctx.cwd) };
      });
      if (list.truncated) notes.push(LISTING_TRUNCATED_NOTE);
    }

    const outcome = await runSearch(
      { files, source: regex.source, flags: regex.flags },
      ctx.signal,
    );
    if (outcome === 'aborted') return toolError('tool.aborted', 'grep was aborted');
    if (outcome === 'timeout') {
      return toolError(
        'grep.timeout',
        `the search was stopped after ${SEARCH_TIMEOUT_MS / 1_000}s`,
        'Narrow the path or the glob, or simplify the pattern.',
      );
    }
    if (!outcome.ok) return toolError('grep.failed', outcome.message);
    const result = outcome.result;

    if (result.skipped > 0) {
      notes.unshift(`${result.skipped} file(s) over 10 MiB or unreadable were skipped`);
    }
    if (result.stopped !== undefined) {
      notes.unshift(
        `${result.stopped}; showing the first ${result.lines.length}, narrow the pattern, the path or the glob to see the rest`,
      );
    }
    if (result.lines.length === 0) {
      const searched = result.filesSearched === 1 ? '1 file' : `${result.filesSearched} files`;
      notes.unshift(`no matches in ${searched}`);
    }
    const footer = notes.length === 0 ? '' : `[grep: ${notes.join('; ')}]`;
    const content = [result.lines.join('\n'), footer]
      .filter((part) => part.length > 0)
      .join('\n\n');

    return {
      content,
      isError: false,
      meta: {
        path: target,
        filesSearched: result.filesSearched,
        matches: result.lines.length,
        stopped: result.stopped !== undefined,
      },
      touchedPaths: [target],
    };
  },
};
