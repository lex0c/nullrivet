import { readFile, stat } from 'node:fs/promises';
import { binaryOffset, isNotFoundError, MAX_FILE_BYTES } from './file-io.ts';

export const MAX_MATCHES = 200;
// Minified bundles and generated files have very long lines; the start of the line is enough to
// decide whether to read the file.
const MAX_LINE_LENGTH = 500;
const MAX_OUTPUT_BYTES = 64 * 1024;
// Files read concurrently. Bounded because each one can be up to MAX_FILE_BYTES.
const READ_BATCH = 8;

export interface SearchRequest {
  // Searched and reported in this order.
  files: { abs: string; display: string }[];
  source: string;
  flags: string;
}

export interface SearchResult {
  lines: string[];
  // Why the search stopped before covering every file, if it did.
  stopped?: string;
  filesSearched: number;
  // Files over MAX_FILE_BYTES or unreadable. Binary files and files deleted since they were
  // listed are skipped without being counted.
  skipped: number;
}

type Loaded = { text: string } | { skipped: boolean };

const load = async (abs: string, decoder: TextDecoder): Promise<Loaded> => {
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { skipped: false };
    if (info.size > MAX_FILE_BYTES) return { skipped: true };
    const bytes = await readFile(abs);
    if (binaryOffset(bytes) >= 0) return { skipped: false };
    return { text: decoder.decode(bytes) };
  } catch (error) {
    return { skipped: !isNotFoundError(error) };
  }
};

export const searchFiles = async (request: SearchRequest): Promise<SearchResult> => {
  const regex = new RegExp(request.source, request.flags);
  const decoder = new TextDecoder('utf-8');
  const result: SearchResult = { lines: [], filesSearched: 0, skipped: 0 };
  let bytes = 0;
  for (let i = 0; i < request.files.length; i += READ_BATCH) {
    const batch = request.files.slice(i, i + READ_BATCH);
    const loaded = await Promise.all(batch.map((file) => load(file.abs, decoder)));
    for (const [index, file] of batch.entries()) {
      const item = loaded[index];
      if (item === undefined) continue;
      if (!('text' in item)) {
        if (item.skipped) result.skipped++;
        continue;
      }
      result.filesSearched++;
      const lines = item.text.split('\n');
      for (let n = 0; n < lines.length; n++) {
        const line = (lines[n] ?? '').replace(/\r$/, '');
        if (!regex.test(line)) continue;
        if (result.lines.length >= MAX_MATCHES) {
          result.stopped = `more than ${MAX_MATCHES} matches`;
          return result;
        }
        const shown = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
        const entry = `${file.display}:${n + 1}: ${shown}`;
        const size = Buffer.byteLength(entry, 'utf8') + 1;
        if (bytes + size > MAX_OUTPUT_BYTES) {
          result.stopped = 'output limit reached';
          return result;
        }
        result.lines.push(entry);
        bytes += size;
      }
    }
  }
  return result;
};
