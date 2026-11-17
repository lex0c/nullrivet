import { readFile, stat } from 'node:fs/promises';
import { formatBytes } from '../context/output-reduction.ts';
import { requireNonEmptyString, requireString } from './args.ts';
import { atomicWrite } from './atomic-write.ts';
import {
  binaryOffset,
  directoryError,
  fileSystemError,
  isNotFoundError,
  MAX_FILE_BYTES,
  notRegularFileError,
} from './file-io.ts';
import { type FileDiff, lineDiff } from './line-diff.ts';
import { pathArgument, resolvePath } from './paths.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

// The text a file holds before it is replaced, only to show the user what changed: null for a
// binary file, whose lines mean nothing, and when it cannot be read. Writing does not depend on
// reading, so a file that can be written but not read is still written, without a diff.
const previousText = async (abs: string): Promise<string | null> => {
  try {
    const bytes = await readFile(abs);
    return binaryOffset(bytes) === -1 ? new TextDecoder().decode(bytes) : null;
  } catch {
    return null;
  }
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create a file or replace its entire content. Missing parent directories are created. Writing through a symlink updates the file the link points to. Content is limited to 10 MiB. For a localized change to an existing file, use edit_file instead: write_file discards everything that is not in `content`.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path, absolute or relative to the working directory.',
      },
      content: {
        type: 'string',
        description: 'Complete new content of the file.',
      },
    },
    required: ['path', 'content'],
  },
  effect: 'write',
  targetPaths: pathArgument,
  async execute(input, ctx): Promise<ToolResult> {
    const path = requireNonEmptyString(input, 'path');
    const content = requireString(input, 'content');
    const abs = resolvePath(path, ctx.cwd);

    // UTF-8 is never shorter than the UTF-16 length, so the first check refuses oversized content
    // without encoding it.
    if (content.length > MAX_FILE_BYTES || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      return toolError(
        'fs.too_large',
        `content exceeds the ${formatBytes(MAX_FILE_BYTES)} limit`,
        'Generate large files with bash instead.',
      );
    }

    let created = false;
    // The text the file had, for the diff shown to the user; null when it cannot be shown.
    let previous: string | null = '';
    try {
      const info = await stat(abs);
      if (info.isDirectory()) return directoryError(abs, 'Provide the path of a file.');
      // Renaming over a device or FIFO would replace it with a regular file.
      if (!info.isFile()) return notRegularFileError(abs);
      previous = info.size <= MAX_FILE_BYTES ? await previousText(abs) : null;
    } catch (error) {
      if (!isNotFoundError(error)) return fileSystemError(error, 'write', abs);
      created = true;
    }

    // Computed before the write: a failure after it would report a write that happened as failed,
    // and the model could repeat it.
    const diff: FileDiff | null = previous === null ? null : lineDiff(previous, content);
    if (ctx.signal.aborted) {
      return toolError('tool.aborted', `write_file was aborted; ${abs} was not written`);
    }
    let written: number;
    try {
      written = atomicWrite(abs, content);
    } catch (error) {
      return fileSystemError(error, 'write', abs);
    }

    return {
      content: `Wrote ${written} bytes to ${abs}${created ? ' (new file)' : ''}.`,
      isError: false,
      meta: { path: abs, bytesWritten: written, created, ...(diff === null ? {} : { diff }) },
      touchedPaths: [abs],
    };
  },
};
