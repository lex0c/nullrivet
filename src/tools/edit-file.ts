import { formatBytes } from '../context/output-reduction.ts';
import {
  InvalidArgumentError,
  optionalBoolean,
  requireNonEmptyString,
  requireString,
} from './args.ts';
import { atomicWrite } from './atomic-write.ts';
import { fileSystemError, loadTextFileBytes, MAX_FILE_BYTES } from './file-io.ts';
import { pathArgument, resolvePath } from './paths.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

interface EditOperation {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

// `whitespace` and `unicode` mean old_string did not match exactly and a fallback located the
// region; the model is told so it copies the file's text verbatim next time.
type MatchStrategy = 'exact' | 'whitespace' | 'unicode';

// A batch larger than this is usually better expressed as a write_file rewrite, and a long list of
// literal replacements is likely to contain an ambiguous match somewhere.
const MAX_EDITS = 50;

// Bounds the near-match text echoed in an error, so a large old_string cannot produce a large error.
const NEAR_MATCH_TEXT_CAP = 1600;

const MAX_LISTED_LINES = 8;

const UTF8_BOM = '\uFEFF';

const readEdit = (item: unknown, index: number): EditOperation => {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new InvalidArgumentError(
      `'edits[${index}]' must be an object with old_string and new_string`,
    );
  }
  const record = item as Record<string, unknown>;
  try {
    const oldString = requireString(record, 'old_string');
    if (oldString.length === 0) {
      throw new InvalidArgumentError(
        "'old_string' must not be empty; use write_file to create or replace a whole file",
      );
    }
    return {
      oldString,
      newString: requireString(record, 'new_string'),
      replaceAll: optionalBoolean(record, 'replace_all') ?? false,
    };
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw new InvalidArgumentError(`edits[${index}]: ${error.message}`);
    }
    throw error;
  }
};

const readEdits = (input: Record<string, unknown>): EditOperation[] => {
  const value = input.edits;
  if (!Array.isArray(value)) throw new InvalidArgumentError("'edits' must be an array of edits");
  if (value.length === 0) throw new InvalidArgumentError("'edits' must contain at least one edit");
  if (value.length > MAX_EDITS) {
    throw new InvalidArgumentError(
      `'edits' must contain at most ${MAX_EDITS} edits, got ${value.length}`,
    );
  }
  return value.map((item, index) => readEdit(item, index));
};

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
};

// 1-based line number of a character offset.
const lineAt = (text: string, charIndex: number): number =>
  text.slice(0, charIndex).split('\n').length;

// Stops after `limit` occurrences: only a few are shown, and a needle with thousands of matches
// should not cost a full scan per match.
const occurrenceLines = (haystack: string, needle: string, limit: number): number[] => {
  const out: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && out.length < limit) {
    out.push(lineAt(haystack, idx));
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
};

const leadingWhitespace = (line: string): string =>
  line.slice(0, line.length - line.trimStart().length);

// Trims only spaces and tabs. A `\r` stays significant: if an LF old_string could match CRLF
// lines, the replacement lines would be written without `\r` and mix the file's line endings.
const trimSpacesTabs = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === ' ' || s[start] === '\t')) start++;
  while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return s.slice(start, end);
};

type IndentShift =
  | { type: 'none' }
  | { type: 'add'; prefix: string }
  | { type: 'strip'; prefix: string };

const sameShift = (a: IndentShift, b: IndentShift): boolean => {
  if (a.type === 'add' && b.type === 'add') return a.prefix === b.prefix;
  if (a.type === 'strip' && b.type === 'strip') return a.prefix === b.prefix;
  return a.type === 'none' && b.type === 'none';
};

// The single indentation change that maps every old_string line onto the matching file line, or
// null when there is none (tabs against spaces, a different change per line). Only a uniform shift
// can be applied to new_string safely. Blank lines carry no indentation and are skipped.
const uniformShift = (fileLines: string[], needleLines: string[]): IndentShift | null => {
  let shift: IndentShift | null = null;
  for (let i = 0; i < fileLines.length; i++) {
    const needleLine = needleLines[i] ?? '';
    if (needleLine.trim() === '') continue;
    const fileIndent = leadingWhitespace(fileLines[i] ?? '');
    const needleIndent = leadingWhitespace(needleLine);
    let here: IndentShift;
    if (fileIndent === needleIndent) here = { type: 'none' };
    else if (fileIndent.length > needleIndent.length && fileIndent.endsWith(needleIndent))
      here = { type: 'add', prefix: fileIndent.slice(0, fileIndent.length - needleIndent.length) };
    else if (needleIndent.length > fileIndent.length && needleIndent.endsWith(fileIndent))
      here = {
        type: 'strip',
        prefix: needleIndent.slice(0, needleIndent.length - fileIndent.length),
      };
    else return null;
    if (shift === null) shift = here;
    else if (!sameShift(shift, here)) return null;
  }
  return shift ?? { type: 'none' };
};

// Blank lines become empty instead of carrying indentation. A strip that does not fit a line
// leaves that line unchanged rather than guessing.
const applyShift = (line: string, shift: IndentShift): string => {
  if (line.trim() === '') return '';
  if (shift.type === 'none') return line;
  if (shift.type === 'add') return shift.prefix + line;
  return line.startsWith(shift.prefix) ? line.slice(shift.prefix.length) : line;
};

interface NearMatch {
  startLine: number;
  endLine: number;
  text?: string;
}

const nearMatch = (startLine: number, endLine: number, text: string): NearMatch => ({
  startLine,
  endLine,
  ...(text.length <= NEAR_MATCH_TEXT_CAP ? { text } : {}),
});

// 0-based start indices of the line spans whose lines all equal the needle lines after
// `normalize`. Every fallback locates regions through this; only the normalization differs.
const findSpans = (
  hayLines: string[],
  needleNorm: string[],
  normalize: (line: string) => string,
): number[] => {
  const n = needleNorm.length;
  const starts: number[] = [];
  if (n === 0 || n > hayLines.length) return starts;
  for (let s = 0; s + n <= hayLines.length; s++) {
    let match = true;
    for (let k = 0; k < n; k++) {
      if (normalize(hayLines[s + k] ?? '') !== needleNorm[k]) {
        match = false;
        break;
      }
    }
    if (match) starts.push(s);
  }
  return starts;
};

const replaceSpan = (
  hayLines: string[],
  start: number,
  length: number,
  newStr: string,
  shift: IndentShift,
): string => {
  const newLines = newStr.split('\n').map((line) => applyShift(line, shift));
  return [...hayLines.slice(0, start), ...newLines, ...hayLines.slice(start + length)].join('\n');
};

type WhitespaceResult =
  | { kind: 'applied'; content: string }
  | { kind: 'unsafe'; near: NearMatch }
  | { kind: 'multiple'; lines: number[] }
  | { kind: 'none' };

// Most edit misses are old_string drifting from the file in whitespace only: indentation typed
// from memory or trailing spaces. A unique region that matches line by line, ignoring leading and
// trailing whitespace, is applied when one uniform indentation shift explains the difference;
// new_string is re-indented with the same shift. Anything less certain is reported with its
// location instead of guessed.
const whitespaceFallback = (current: string, oldStr: string, newStr: string): WhitespaceResult => {
  const needleLines = oldStr.split('\n');
  const hayLines = current.split('\n');
  const n = needleLines.length;
  if (n > hayLines.length) return { kind: 'none' };
  // A whitespace-only old_string would match the first blank line of the file.
  if (needleLines.every((line) => line.trim() === '')) return { kind: 'none' };
  const starts = findSpans(hayLines, needleLines.map(trimSpacesTabs), trimSpacesTabs);
  if (starts.length === 0) return { kind: 'none' };
  if (starts.length > 1) {
    return { kind: 'multiple', lines: starts.slice(0, MAX_LISTED_LINES).map((s) => s + 1) };
  }
  const s = starts[0] ?? 0;
  const span = hayLines.slice(s, s + n);
  const shift = uniformShift(span, needleLines);
  if (shift === null) return { kind: 'unsafe', near: nearMatch(s + 1, s + n, span.join('\n')) };
  return { kind: 'applied', content: replaceSpan(hayLines, s, n, newStr, shift) };
};

type ExtendedResult =
  | { kind: 'applied'; content: string }
  | { kind: 'unsafe'; near: NearMatch }
  | { kind: 'escape_drift'; near: NearMatch }
  | { kind: 'block_anchor'; near: NearMatch }
  | { kind: 'none' };

// Runs only after the whitespace fallback found nothing, in this order:
//   1. Unicode normalization: the only difference is composed against decomposed characters.
//      Applied under the same conditions as the whitespace fallback (unique region, uniform
//      indentation shift); a unique region without a uniform shift is reported.
//   2. Over-escaped quotes: old_string has \' or \" where the file has bare quotes, an artifact of
//      tool-call serialization. Reported, never applied, because the backslash may be intended.
//   3. Block anchor: the first and last lines bound a region of the same length whose interior
//      differs. Reported, never applied, because the interior is unverified.
const extendedMatch = (current: string, oldStr: string, newStr: string): ExtendedResult => {
  const needleLines = oldStr.split('\n');
  const hayLines = current.split('\n');
  const n = needleLines.length;
  if (n > hayLines.length) return { kind: 'none' };
  if (needleLines.every((line) => line.trim() === '')) return { kind: 'none' };

  const nfc = (line: string): string => trimSpacesTabs(line).normalize('NFC');
  const nfcStarts = findSpans(hayLines, needleLines.map(nfc), nfc);
  if (nfcStarts.length === 1) {
    const s = nfcStarts[0] ?? 0;
    const span = hayLines.slice(s, s + n);
    const shift = uniformShift(span, needleLines);
    if (shift !== null) {
      return { kind: 'applied', content: replaceSpan(hayLines, s, n, newStr, shift) };
    }
    return { kind: 'unsafe', near: nearMatch(s + 1, s + n, span.join('\n')) };
  }

  const deEscaped = oldStr.replaceAll("\\'", "'").replaceAll('\\"', '"');
  if (deEscaped !== oldStr) {
    const deStarts = findSpans(hayLines, deEscaped.split('\n').map(trimSpacesTabs), trimSpacesTabs);
    if (deStarts.length === 1) {
      const s = deStarts[0] ?? 0;
      return {
        kind: 'escape_drift',
        near: nearMatch(s + 1, s + n, hayLines.slice(s, s + n).join('\n')),
      };
    }
  }

  if (n >= 3) {
    const firstNorm = trimSpacesTabs(needleLines[0] ?? '');
    const lastNorm = trimSpacesTabs(needleLines[n - 1] ?? '');
    if (firstNorm !== '' && lastNorm !== '') {
      const firstHits: number[] = [];
      const lastHits: number[] = [];
      for (let i = 0; i < hayLines.length; i++) {
        const trimmed = trimSpacesTabs(hayLines[i] ?? '');
        if (trimmed === firstNorm) firstHits.push(i);
        if (trimmed === lastNorm) lastHits.push(i);
      }
      if (firstHits.length === 1 && lastHits.length === 1) {
        const s = firstHits[0] ?? 0;
        const e = lastHits[0] ?? 0;
        if (e - s + 1 === n) {
          return {
            kind: 'block_anchor',
            near: nearMatch(s + 1, e + 1, hayLines.slice(s, e + 1).join('\n')),
          };
        }
      }
    }
  }

  return { kind: 'none' };
};

interface EditFailure {
  code: string;
  message: string;
  hint?: string;
  meta?: Record<string, unknown>;
}

type EditOutcome =
  | { ok: true; content: string; replacements: number; strategy: MatchStrategy }
  | { ok: false; failure: EditFailure };

const lineRange = (start: number, end: number): string =>
  start === end ? `line ${start}` : `lines ${start}-${end}`;

const copyRegionHint = (near: NearMatch, description: string): string => {
  const located = `${description} (${lineRange(near.startLine, near.endLine)}).`;
  return near.text === undefined
    ? `${located} Copy the exact text of that region into old_string.`
    : `${located} Copy its exact text into old_string:\n${near.text}`;
};

const nearMatchMeta = (near: NearMatch): Record<string, unknown> => ({
  nearMatch: { startLine: near.startLine, endLine: near.endLine },
});

const noMatch = (
  index: number,
  abs: string,
  hint: string,
  meta?: Record<string, unknown>,
): EditOutcome => ({
  ok: false,
  failure: {
    code: 'edit.no_match',
    message: `edits[${index}].old_string was not found in ${abs}`,
    hint,
    ...(meta === undefined ? {} : { meta }),
  },
});

// Edits a batch sequentially: `current` is the result of the previous edits, not the file on disk.
const applyEdit = (
  current: string,
  edit: EditOperation,
  index: number,
  abs: string,
): EditOutcome => {
  if (edit.oldString === edit.newString) {
    return {
      ok: false,
      failure: {
        code: 'edit.no_change',
        message: `edits[${index}] has identical old_string and new_string`,
        hint: 'Each edit must change the text it matches.',
      },
    };
  }
  const occurrences = countOccurrences(current, edit.oldString);
  if (occurrences > 1 && !edit.replaceAll) {
    const lines = occurrenceLines(current, edit.oldString, MAX_LISTED_LINES);
    const more = occurrences > lines.length ? ', …' : '';
    return {
      ok: false,
      failure: {
        code: 'edit.ambiguous',
        message: `edits[${index}].old_string matches ${occurrences} times in ${abs}`,
        hint: `Matches start at lines ${lines.join(', ')}${more}. Add surrounding lines so old_string matches once, or set replace_all to true on this edit.`,
        meta: { occurrences, lines },
      },
    };
  }
  if (occurrences > 0) {
    if (edit.replaceAll) {
      return {
        ok: true,
        content: current.split(edit.oldString).join(edit.newString),
        replacements: occurrences,
        strategy: 'exact',
      };
    }
    // Sliced rather than String.replace, which would expand `$&`, `$1` or `$$` in new_string.
    const at = current.indexOf(edit.oldString);
    return {
      ok: true,
      content: current.slice(0, at) + edit.newString + current.slice(at + edit.oldString.length),
      replacements: 1,
      strategy: 'exact',
    };
  }

  // The fallbacks look for a single region, which does not fit replace_all.
  if (!edit.replaceAll) {
    const ws = whitespaceFallback(current, edit.oldString, edit.newString);
    if (ws.kind === 'applied') {
      return { ok: true, content: ws.content, replacements: 1, strategy: 'whitespace' };
    }
    if (ws.kind === 'unsafe') {
      return noMatch(
        index,
        abs,
        copyRegionHint(
          ws.near,
          'The file has a region that differs from old_string only in whitespace, but not by one uniform indentation shift',
        ),
        { ...nearMatchMeta(ws.near), diagnosis: 'whitespace' },
      );
    }
    if (ws.kind === 'multiple') {
      return noMatch(
        index,
        abs,
        `Regions that differ from old_string only in whitespace start at lines ${ws.lines.join(', ')}. Copy the exact text of one of them and add surrounding lines so it matches once.`,
        { nearMatchLines: ws.lines, diagnosis: 'whitespace' },
      );
    }

    const ext = extendedMatch(current, edit.oldString, edit.newString);
    if (ext.kind === 'applied') {
      return { ok: true, content: ext.content, replacements: 1, strategy: 'unicode' };
    }
    if (ext.kind === 'unsafe') {
      return noMatch(
        index,
        abs,
        copyRegionHint(
          ext.near,
          'The file has a region that matches old_string after Unicode normalization, but its indentation differs by more than one uniform shift',
        ),
        { ...nearMatchMeta(ext.near), diagnosis: 'unicode' },
      );
    }
    if (ext.kind === 'escape_drift') {
      return noMatch(
        index,
        abs,
        copyRegionHint(
          ext.near,
          'The file has a region that matches old_string once the backslashes before quotes (\\\' or \\") are removed; the file uses unescaped quotes',
        ),
        { ...nearMatchMeta(ext.near), diagnosis: 'escaped_quotes' },
      );
    }
    if (ext.kind === 'block_anchor') {
      return noMatch(
        index,
        abs,
        copyRegionHint(
          ext.near,
          'The file has a region whose first and last lines match old_string, but the lines between them differ',
        ),
        { ...nearMatchMeta(ext.near), diagnosis: 'block_anchor' },
      );
    }
  }

  const sequenceNote =
    index > 0
      ? ' Edits apply in order, so this one was searched for in the content left by the previous edits.'
      : '';
  return noMatch(
    index,
    abs,
    `Read the file to copy the exact text, including indentation.${sequenceNote}`,
  );
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const FALLBACK_DESCRIPTION: Record<Exclude<MatchStrategy, 'exact'>, string> = {
  whitespace: 'ignoring indentation and trailing whitespace',
  unicode: 'ignoring indentation, trailing whitespace and Unicode normalization',
};

const successContent = (
  abs: string,
  strategies: MatchStrategy[],
  totalReplacements: number,
): string => {
  const lines = [
    `Applied ${plural(strategies.length, 'edit')} to ${abs} (${plural(totalReplacements, 'replacement')}).`,
  ];
  strategies.forEach((strategy, index) => {
    if (strategy === 'exact') return;
    lines.push(
      `edits[${index}].old_string did not match exactly; it was applied to the only region that matches when ${FALLBACK_DESCRIPTION[strategy]}, with new_string re-indented to the file. Copy old_string verbatim from the file next time.`,
    );
  });
  return lines.join('\n');
};

const decodeUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const hasUtf8Bom = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace text in an existing file. `edits` is an array of { old_string, new_string, replace_all? }; pass an array even for a single change. Edits apply in order: each one searches the content produced by the previous edits. The batch is all-or-nothing: if any edit fails, the file is not modified and the error names the failing edit by index. old_string must match exactly once unless replace_all is true. If old_string has no exact match, a single region that differs only in indentation, trailing whitespace or Unicode normalization is used instead, new_string is re-indented to the file, and the result says so. Errors for a missing or ambiguous old_string give the line numbers of the closest matches. At most 50 edits per call. To create a file or replace all of its content, use write_file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path, absolute or relative to the working directory.',
      },
      edits: {
        type: 'array',
        description: 'Edits to apply in order. Each edit searches the result of the previous ones.',
        minItems: 1,
        maxItems: MAX_EDITS,
        items: {
          type: 'object',
          properties: {
            old_string: {
              type: 'string',
              description:
                'Exact text to replace, copied from the file. Include enough surrounding lines to match once unless replace_all is true.',
            },
            new_string: {
              type: 'string',
              description: 'Replacement text. An empty string deletes old_string.',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace every occurrence instead of requiring a single match.',
            },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  effect: 'write',
  targetPaths: pathArgument,
  async execute(input, ctx): Promise<ToolResult> {
    const path = requireNonEmptyString(input, 'path');
    const edits = readEdits(input);
    const abs = resolvePath(path, ctx.cwd);

    if (ctx.signal.aborted) {
      return toolError('tool.aborted', `edit_file was aborted; ${abs} was not modified`);
    }
    const loaded = await loadTextFileBytes(abs);
    if (!loaded.ok) return loaded.error;
    // read_file decodes leniently, but here the content is written back: invalid bytes decoded
    // to U+FFFD would replace the original bytes everywhere in the file.
    const original = decodeUtf8(loaded.bytes);
    if (original === undefined) {
      return toolError(
        'fs.invalid_utf8',
        `${abs} is not valid UTF-8 text`,
        'edit_file rewrites the whole file and would replace every invalid byte. Use write_file to replace the whole content, or bash for byte-level changes.',
      );
    }
    // The decoder drops a leading BOM, so old_string can match the first line as read_file shows
    // it; the BOM is restored on write so the edit does not change the file's encoding marker.
    const bom = hasUtf8Bom(loaded.bytes) ? UTF8_BOM : '';

    let working = original;
    const results: { replacements: number; strategy: MatchStrategy }[] = [];
    for (const [index, edit] of edits.entries()) {
      const outcome = applyEdit(working, edit, index, abs);
      if (!outcome.ok) {
        const { code, message, hint, meta } = outcome.failure;
        const batchNote =
          edits.length > 1 ? `; none of the ${edits.length} edits were applied` : '';
        const error = toolError(code, `${message}${batchNote}`, hint);
        return { ...error, meta: { ...error.meta, editIndex: index, ...meta } };
      }
      working = outcome.content;
      results.push({ replacements: outcome.replacements, strategy: outcome.strategy });
    }
    const totalReplacements = results.reduce((sum, r) => sum + r.replacements, 0);

    // Individual edits cannot be no-ops, but a batch can restore the original text (a to b, then
    // b to a). Skipping the write leaves the modification time and file watchers unaffected.
    if (working === original) {
      return {
        content: `The edits leave ${abs} unchanged; the file was not written.`,
        isError: false,
        meta: { path: abs, edits: results, totalReplacements, bytesWritten: 0, written: false },
        touchedPaths: [abs],
      };
    }

    const output = bom + working;
    const outputBytes = Buffer.byteLength(output, 'utf8');
    if (outputBytes > MAX_FILE_BYTES) {
      return toolError(
        'fs.too_large',
        `the edited content of ${abs} would be ${formatBytes(outputBytes)}, over the ${formatBytes(MAX_FILE_BYTES)} limit`,
      );
    }
    if (ctx.signal.aborted) {
      return toolError('tool.aborted', `edit_file was aborted; ${abs} was not modified`);
    }
    let written: number;
    try {
      written = atomicWrite(abs, output);
    } catch (error) {
      return fileSystemError(error, 'write', abs);
    }

    return {
      content: successContent(
        abs,
        results.map((r) => r.strategy),
        totalReplacements,
      ),
      isError: false,
      meta: { path: abs, edits: results, totalReplacements, bytesWritten: written, written: true },
      touchedPaths: [abs],
    };
  },
};
