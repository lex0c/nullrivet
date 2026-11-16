import { stat } from 'node:fs/promises';
import { formatBytes } from '../context/output-reduction.ts';
import { requireNonEmptyString, requireString } from './args.ts';
import { atomicWrite } from './atomic-write.ts';
import {
  directoryError,
  fileSystemError,
  isNotFoundError,
  MAX_FILE_BYTES,
  notRegularFileError,
} from './file-io.ts';
import { resolvePath } from './paths.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

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
    try {
      const info = await stat(abs);
      if (info.isDirectory()) return directoryError(abs, 'Provide the path of a file.');
      // Renaming over a device or FIFO would replace it with a regular file.
      if (!info.isFile()) return notRegularFileError(abs);
    } catch (error) {
      if (!isNotFoundError(error)) return fileSystemError(error, 'write', abs);
      created = true;
    }

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
      meta: { path: abs, bytesWritten: written, created },
      touchedPaths: [abs],
    };
  },
};
