import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { optionalString, requireNonEmptyString } from './args.ts';
import { compileGlob, LISTING_TRUNCATED_NOTE, listDirectory } from './file-walk.ts';
import { displayPath } from './paths.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

const MAX_RESULTS = 500;
const STAT_BATCH = 32;

const exists = async (abs: string): Promise<boolean> => {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
};

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by path pattern. Returns the files under `path` (default: the working directory) that match `pattern`, sorted, one per line. A pattern without "/" matches file names at any depth ("*.ts", "README*"); a pattern with "/" matches the path relative to `path` ("src/**/*.test.ts"). Supports *, **, ?, [abc] and {a,b}. Inside a git repository, files ignored by git are left out; elsewhere, hidden entries and node_modules are skipped. Returns at most 500 paths.',
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
    // Tracked files deleted from the working tree are still listed by git.
    for (let i = 0; i < matched.length && shown.length < MAX_RESULTS; i += STAT_BATCH) {
      const batch = matched.slice(i, i + STAT_BATCH).map((path) => join(root, path));
      const present = await Promise.all(batch.map(exists));
      for (const [index, abs] of batch.entries()) {
        if (present[index] === true && shown.length < MAX_RESULTS) {
          shown.push(displayPath(abs, ctx.cwd));
        }
      }
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
