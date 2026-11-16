import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidArgumentError, optionalBoolean, optionalString, requireString } from './args.ts';
import {
  binaryOffset,
  fileSystemError,
  isNotFoundError,
  loadTextFileBytes,
  MAX_FILE_BYTES,
} from './file-io.ts';
import { compileGlob } from './file-walk.ts';
import { LISTING_TRUNCATED_NOTE, listDirectory } from './glob.ts';
import { displayPath, resolvePath } from './paths.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

const MAX_MATCHES = 200;
// Minified bundles and generated files have very long lines; the start of the line is enough to
// decide whether to read the file.
const MAX_LINE_LENGTH = 500;
const MAX_OUTPUT_BYTES = 64 * 1024;

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

interface SearchState {
  lines: string[];
  bytes: number;
  // Why the search stopped early, if it did.
  stopped: string | undefined;
}

const searchText = (text: string, display: string, regex: RegExp, state: SearchState): void => {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    if (!regex.test(line)) continue;
    const shown = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
    const entry = `${display}:${i + 1}: ${shown}`;
    const size = Buffer.byteLength(entry, 'utf8') + 1;
    if (state.bytes + size > MAX_OUTPUT_BYTES) {
      state.stopped = 'output limit reached';
      return;
    }
    state.lines.push(entry);
    state.bytes += size;
    if (state.lines.length >= MAX_MATCHES) {
      state.stopped = `stopped at ${MAX_MATCHES} matches`;
      return;
    }
  }
};

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a regular expression (JavaScript syntax), line by line. Returns the matching lines as "path:line: text", with 1-based line numbers. `path` is a file or a directory (default: the working directory); `glob` limits a directory search to matching files, with the same rules as the glob tool. Inside a git repository, files ignored by git are skipped; binary files and files over 10 MiB are always skipped. Set `literal` to search for the text as is. Lines are cut at 500 characters. Returns at most 200 matches.',
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
    const state: SearchState = { lines: [], bytes: 0, stopped: undefined };
    const decoder = new TextDecoder('utf-8');
    const notes: string[] = [];
    let filesSearched = 0;

    let isFile: boolean;
    try {
      isFile = (await stat(target)).isFile();
    } catch (error) {
      return fileSystemError(error, 'read', target);
    }

    if (isFile) {
      const loaded = await loadTextFileBytes(target);
      if (!loaded.ok) return loaded.error;
      searchText(decoder.decode(loaded.bytes), displayPath(target, ctx.cwd), regex, state);
      filesSearched = 1;
    } else {
      const listed = await listDirectory(pathArg, ctx.cwd, ctx.signal);
      if (!listed.ok) return listed.error;
      const { root, list } = listed;
      const files = (filter === undefined ? list.files : list.files.filter(filter)).sort();
      let skipped = 0;
      for (const relativePath of files) {
        if (ctx.signal.aborted) return toolError('tool.aborted', 'grep was aborted');
        const abs = join(root, relativePath);
        let bytes: Uint8Array;
        try {
          const info = await stat(abs);
          if (!info.isFile()) continue;
          if (info.size > MAX_FILE_BYTES) {
            skipped++;
            continue;
          }
          bytes = await readFile(abs);
        } catch (error) {
          // Tracked files deleted from the working tree are still listed by git.
          if (!isNotFoundError(error)) skipped++;
          continue;
        }
        if (binaryOffset(bytes) >= 0) continue;
        filesSearched++;
        searchText(decoder.decode(bytes), displayPath(abs, ctx.cwd), regex, state);
        if (state.stopped !== undefined) break;
      }
      if (skipped > 0) notes.push(`${skipped} file(s) over 10 MiB or unreadable were skipped`);
      if (list.truncated) notes.push(LISTING_TRUNCATED_NOTE);
    }

    if (state.stopped !== undefined) {
      notes.unshift(`${state.stopped}; narrow the pattern, the path or the glob to see the rest`);
    }
    if (state.lines.length === 0) {
      const files = filesSearched === 1 ? '1 file' : `${filesSearched} files`;
      notes.unshift(`no matches in ${files}`);
    }
    const footer = notes.length === 0 ? '' : `[grep: ${notes.join('; ')}]`;
    const content = [state.lines.join('\n'), footer].filter((part) => part.length > 0).join('\n\n');

    return {
      content,
      isError: false,
      meta: {
        path: target,
        filesSearched,
        matches: state.lines.length,
        stopped: state.stopped !== undefined,
      },
      touchedPaths: [target],
    };
  },
};
