import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { optionalString, requireNonEmptyString } from './args.ts';
import { fileSystemError } from './file-io.ts';
import { compileGlob, type FileList, listFiles, MAX_LISTED_FILES } from './file-walk.ts';
import { displayPath, resolvePath } from './paths.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

const MAX_RESULTS = 500;

export const LISTING_TRUNCATED_NOTE = `the directory has more than ${MAX_LISTED_FILES} files and only part of it was searched; narrow 'path'`;

const exists = async (abs: string): Promise<boolean> => {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
};

// Resolves `path` to a directory and lists its files, or explains why it cannot.
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

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by path pattern. Returns the files under `path` (default: the working directory) that match `pattern`, sorted, one per line. A pattern without "/" matches file names at any depth ("*.ts", "README*"); a pattern with "/" matches the path relative to `path` ("src/**/*.test.ts"). Supports *, **, ?, [abc] and {a,b}. Inside a git repository, files ignored by git are left out; elsewhere, .git and node_modules directories are skipped. Returns at most 500 paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern, for example "*.ts" or "src/**/*.ts".',
      },
      path: {
        type: 'string',
        description: 'Directory to search, absolute or relative to the working directory.',
      },
    },
    required: ['pattern'],
  },
  effect: 'read',
  async execute(input, ctx): Promise<ToolResult> {
    const pattern = requireNonEmptyString(input, 'pattern');
    const matches = compileGlob(pattern, 'pattern');
    if (ctx.signal.aborted) return toolError('tool.aborted', 'glob was aborted');
    const listed = await listDirectory(optionalString(input, 'path'), ctx.cwd, ctx.signal);
    if (!listed.ok) return listed.error;
    if (ctx.signal.aborted) return toolError('tool.aborted', 'glob was aborted');
    const { root, list } = listed;

    const matched = list.files.filter(matches).sort();
    const shown: string[] = [];
    for (const relativePath of matched) {
      if (shown.length >= MAX_RESULTS) break;
      const abs = join(root, relativePath);
      // Tracked files deleted from the working tree are still listed by git.
      if (await exists(abs)) shown.push(displayPath(abs, ctx.cwd));
    }

    const notes: string[] = [];
    if (shown.length === 0) {
      notes.push(`no files match "${pattern}" under ${displayPath(root, ctx.cwd)}`);
    } else if (matched.length > shown.length && shown.length >= MAX_RESULTS) {
      notes.push(
        `showing the first ${MAX_RESULTS} of ${matched.length} matching files; narrow the pattern or the path`,
      );
    }
    if (list.truncated) notes.push(LISTING_TRUNCATED_NOTE);
    const footer = notes.length === 0 ? '' : `[glob: ${notes.join('; ')}]`;
    const content = [shown.join('\n'), footer].filter((part) => part.length > 0).join('\n\n');

    return {
      content,
      isError: false,
      meta: {
        root,
        matches: matched.length,
        shown: shown.length,
        listingTruncated: list.truncated,
      },
      touchedPaths: [root],
    };
  },
};
