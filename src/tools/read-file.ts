import { formatBytes } from '../context/output-reduction.ts';
import { optionalInteger, requireNonEmptyString } from './args.ts';
import { loadTextFileBytes } from './file-io.ts';
import { resolvePath } from './paths.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

const DEFAULT_LIMIT = 2000;

// Minified bundles, single-line logs and generated code can have lines of several megabytes. The
// model gains nothing from them, so each line is cut at this length and marked with `…`.
const MAX_LINE_LENGTH = 2000;

// The line limit and the per-line limit bound different dimensions, and 2000 lines of 2000
// characters are several megabytes. This caps a single result at roughly 64k tokens; ordinary
// source files (2000 lines of 40 to 80 characters) stay well below it.
const MAX_OUTPUT_BYTES = 256 * 1024;

const TRUNCATION_MARK = '…';

interface LineWindow {
  lines: string[];
  byteCapped: boolean;
  cutLines: number;
}

const selectWindow = (allLines: string[], offset: number, limit: number): LineWindow => {
  const end = Math.min(offset + limit, allLines.length);
  const lines: string[] = [];
  let bytes = 0;
  let byteCapped = false;
  let cutLines = 0;
  for (let i = offset; i < end; i++) {
    let line = allLines[i] ?? '';
    if (line.length > MAX_LINE_LENGTH) {
      line = `${line.slice(0, MAX_LINE_LENGTH)}${TRUNCATION_MARK}`;
      cutLines++;
    }
    // The first line is always included: a cut line is at most a few KiB, so the result is never
    // empty because of a single long line.
    const added = Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0);
    if (lines.length > 0 && bytes + added > MAX_OUTPUT_BYTES) {
      byteCapped = true;
      break;
    }
    lines.push(line);
    bytes += added;
  }
  return { lines, byteCapped, cutLines };
};

const footerFor = (
  offset: number,
  totalLines: number,
  window: LineWindow,
  truncated: boolean,
): string | undefined => {
  if (offset >= totalLines) {
    const lines = totalLines === 1 ? '1 line' : `${totalLines} lines`;
    return `[read_file: offset ${offset} is past the end of the file, which has ${lines}]`;
  }
  const notes: string[] = [];
  if (truncated) {
    const next = offset + window.lines.length;
    const reason = window.byteCapped
      ? ` (output limit of ${formatBytes(MAX_OUTPUT_BYTES)} reached)`
      : '';
    notes.push(
      `showing lines ${offset + 1}-${next} of ${totalLines}${reason}; call read_file with offset=${next} to continue.`,
    );
  }
  if (window.cutLines > 0) {
    notes.push(
      `${window.cutLines} line(s) longer than ${MAX_LINE_LENGTH} characters were cut and marked with a trailing "${TRUNCATION_MARK}".`,
    );
  }
  return notes.length === 0 ? undefined : `[read_file: ${notes.join(' ')}]`;
};

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file. Returns the lines verbatim, without line-number prefixes. Returns up to `limit` lines (default 2000) starting at the 0-based line `offset`. Lines longer than 2000 characters are cut and end with "…". When the result does not reach the end of the file, it ends with a bracketed "[read_file: …]" note giving the lines shown and the offset to continue from. Binary files, directories and files over 10 MiB are refused. Several read_file calls can be issued in the same turn.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path, absolute or relative to the working directory.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: '0-based index of the first line to return (default 0).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: `Maximum number of lines to return (default ${DEFAULT_LIMIT}).`,
      },
    },
    required: ['path'],
  },
  effect: 'read',
  async execute(input, ctx): Promise<ToolResult> {
    const path = requireNonEmptyString(input, 'path');
    const offset = optionalInteger(input, 'offset', { min: 0 }) ?? 0;
    const limit = optionalInteger(input, 'limit', { min: 1 }) ?? DEFAULT_LIMIT;
    const abs = resolvePath(path, ctx.cwd);

    if (ctx.signal.aborted) return toolError('tool.aborted', 'read_file was aborted');
    const loaded = await loadTextFileBytes(abs);
    if (!loaded.ok) return loaded.error;
    if (ctx.signal.aborted) return toolError('tool.aborted', 'read_file was aborted');

    // TextDecoder strips a leading UTF-8 BOM, as edit_file does when it matches, so text read
    // here lines up with what edit_file searches. Invalid sequences become U+FFFD.
    const allLines = new TextDecoder('utf-8').decode(loaded.bytes).split('\n');
    const totalLines = allLines.length;
    const window = selectWindow(allLines, offset, limit);
    const truncated = offset + window.lines.length < totalLines;

    const text = window.lines.join('\n');
    const footer = footerFor(offset, totalLines, window, truncated);
    let content = text;
    if (footer !== undefined) content = text.length > 0 ? `${text}\n\n${footer}` : footer;

    return {
      content,
      isError: false,
      meta: {
        path: abs,
        bytes: loaded.bytes.length,
        totalLines,
        offset,
        linesReturned: window.lines.length,
        truncated,
        cutLines: window.cutLines,
      },
      touchedPaths: [abs],
    };
  },
};
