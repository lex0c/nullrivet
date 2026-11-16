import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { formatBytes } from '../context/output-reduction.ts';
import { errorMessage } from '../errors.ts';
import { type ToolResult, toolError } from './types.ts';

// Shared by read_file, edit_file and write_file. Files are loaded whole, so the cap bounds memory
// use and the time the event loop spends on a single read; larger files are better handled with
// bash (grep, head, tail, sed).
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Git uses the same window to classify a file as binary. A NUL byte never occurs in UTF-8 text,
// and images, object files and archives contain one near the start. UTF-16 text is also
// classified as binary; it would decode to unreadable text anyway.
const BINARY_SCAN_BYTES = 8000;

export type FileOperation = 'read' | 'write';

const errnoCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

export const isNotFoundError = (error: unknown): boolean => {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export const directoryError = (abs: string, hint: string): ToolResult =>
  toolError('fs.is_directory', `${abs} is a directory, not a file`, hint);

export const notRegularFileError = (abs: string): ToolResult =>
  toolError(
    'fs.not_regular_file',
    `${abs} is not a regular file (it is a device, FIFO or socket)`,
    'Use bash to work with special files.',
  );

export const fileSystemError = (
  error: unknown,
  operation: FileOperation,
  abs: string,
): ToolResult => {
  switch (errnoCode(error)) {
    case 'ENOENT':
      return toolError('fs.not_found', `no such file: ${abs}`);
    case 'ENOTDIR':
      return toolError('fs.not_found', `a component of the path is not a directory: ${abs}`);
    case 'EACCES':
    case 'EPERM':
      return toolError(
        'fs.permission_denied',
        `permission denied: cannot ${operation} ${abs}`,
        operation === 'write'
          ? 'The file is replaced through a temporary file, so its directory must be writable too.'
          : undefined,
      );
    case 'EISDIR':
      return directoryError(abs, 'Provide the path of a file.');
    default: {
      const reason = errorMessage(error);
      return toolError(`fs.${operation}_failed`, `cannot ${operation} ${abs}: ${reason}`);
    }
  }
};

export type LoadResult = { ok: true; bytes: Uint8Array } | { ok: false; error: ToolResult };

// Loads a regular text file for read_file and edit_file, refusing directories, special files,
// files over MAX_FILE_BYTES and binary files. Symlinks are followed.
export const loadTextFileBytes = async (abs: string): Promise<LoadResult> => {
  let info: Stats;
  try {
    info = await stat(abs);
  } catch (error) {
    return { ok: false, error: fileSystemError(error, 'read', abs) };
  }
  if (info.isDirectory()) {
    return {
      ok: false,
      error: directoryError(abs, 'List a directory with bash, for example `ls`.'),
    };
  }
  // A FIFO or a character device such as /dev/zero would block or never reach end of file.
  if (!info.isFile()) return { ok: false, error: notRegularFileError(abs) };
  if (info.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: toolError(
        'fs.too_large',
        `${abs} is ${formatBytes(info.size)}, over the ${formatBytes(MAX_FILE_BYTES)} limit`,
        'Use bash (grep, head, tail, sed) to work with part of the file.',
      ),
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(abs);
  } catch (error) {
    return { ok: false, error: fileSystemError(error, 'read', abs) };
  }
  const scanLength = Math.min(bytes.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < scanLength; i++) {
    if (bytes[i] === 0) {
      const error = toolError(
        'fs.binary',
        `${abs} is a binary file (NUL byte at offset ${i})`,
        'Use bash (for example `file`, `xxd` or `hexdump`) to inspect raw bytes.',
      );
      return { ok: false, error: { ...error, meta: { ...error.meta, nulOffset: i } } };
    }
  }
  return { ok: true, bytes };
};
