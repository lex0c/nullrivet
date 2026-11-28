import { closeSync, constants, fstatSync, readFileSync } from 'node:fs';
import { formatBytes } from '../../context/output-reduction.ts';
import { type DiffBudget, type DiffLine, lineDiff } from '../../tools/line-diff.ts';
import type { ApplyOutcome } from './apply.ts';
import type { Before, Change } from './classify.ts';
import { close, lstatAtOrNull, openDirectoryPath, openPath, SysError } from './dirfd.ts';
import { childKey, KEPT_FILE_BYTES, pathKey } from './snapshot.ts';

// What the sandbox changed in the project, entry by entry, for the operator to review before or
// after it is applied: every path is listed, except the content of a directory the sandbox
// created, which is counted under it. Paths are shown with their control characters escaped, so a
// name cannot rewrite the lines around it.

export type EntryKind = 'file' | 'directory' | 'link' | 'other';

export interface ChangeEntry {
  path: string;
  change: 'added' | 'modified' | 'removed' | 'replaced' | 'mode' | 'refused';
  // What the change leaves at the path; for a removal, what it removes.
  kind: EntryKind;
  // For a replacement, the kind of entry it replaces, and what a directory it replaces holds.
  replaces?: EntryKind;
  held?: { entries: number; bytes: number };
  // Lines added and removed, for a text file small enough to compare, from the bytes the reading of
  // the upper layer hashed: those the application checks.
  lines?: { added: number; removed: number };
  binary?: true;
  // A file whose lines were not counted: comparing it took more than the summary allows for one
  // file, or for all of them together. Counts that would only be an upper bound are not shown.
  uncompared?: true;
  // A file's size, or what a directory removed or created holds.
  bytes?: number;
  entries?: number;
  // The mode, in octal, when it changes, or when an added entry is executable, writable by others
  // than its owner, or sticky.
  mode?: string;
  // Set-user-ID and set-group-ID bits the sandbox set, which are not applied.
  dropped?: string;
  target?: string;
  reason?: string;
  // Why the entry deserves a look: it runs or instructs without being invoked.
  attention?: string;
  // Not carried by events: diff lines are file content.
  snippet?: DiffLine[];
}

const BACKSLASH = 0x5c;
// Characters that change how a row reads without showing: every default-ignorable code point
// (bidirectional controls, marks and isolates, zero-width characters, variation selectors, tag
// characters, fillers, the byte order mark, the soft hyphen), and the line and paragraph
// separators. Wider than the set the terminal output strips, since here two names must never look
// the same. Built from joined strings: the linter's fixes turn a single string into a literal, and
// the escapes of a literal into the characters themselves.
const INVISIBLE = new RegExp(
  [
    '[',
    '\\p{Default_Ignorable_Code_Point}',
    '\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2028\\u2029\\u2060-\\u2064\\u2066-\\u2069\\ufeff',
    ']',
  ].join(''),
  'gu',
);
const CONTROLS = new RegExp(['[', '\\x00-\\x1f\\x7f-\\x9f', ']'].join(''), 'g');

// Control and invisible characters as escapes; backslashes doubled when `exact`, so an escape
// cannot be confused with a name that holds the same characters.
const escapeControls = (text: string, exact = true): string =>
  (exact ? text.replace(/\\/g, '\\\\') : text)
    .replace(CONTROLS, (c) => {
      if (c === '\n') return '\\n';
      if (c === '\t') return '\\t';
      return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
    })
    .replace(INVISIBLE, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);

// A leading byte order mark is kept, not dropped: it tells two names, or two contents, apart.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// The content as text, or null for one that is not: it holds a NUL byte or is not UTF-8.
const textOf = (data: Buffer): string | null => {
  if (data.includes(0)) return null;
  try {
    return decoder.decode(data);
  } catch {
    return null;
  }
};

// A name as text, with a byte that is not UTF-8 shown as \xNN.
const nameText = (name: Buffer): string => {
  try {
    return escapeControls(decoder.decode(name));
  } catch {
    let text = '';
    for (const byte of name) {
      text +=
        byte >= 0x20 && byte < 0x7f && byte !== BACKSLASH
          ? String.fromCharCode(byte)
          : byte === BACKSLASH
            ? '\\\\'
            : `\\x${byte.toString(16).padStart(2, '0')}`;
    }
    return text;
  }
};

export const displayPath = (path: readonly Buffer[]): string => path.map(nameText).join('/');

// A message for the terminal on one row. A reason can carry an error of the system, which can
// quote a name or a link target the sandbox chose.
export const displayText = (text: string): string => escapeControls(text, false);

// Files that run, or steer the next agent, without anyone invoking them.
const attentionFor = (path: readonly Buffer[]): string | undefined => {
  const parts = path.map((part) => part.toString('latin1'));
  const name = parts.at(-1);
  if (name === 'AGENTS.md' || name === 'CLAUDE.md' || name === '.cursorrules') {
    return 'instructions for coding agents';
  }
  if (parts.length > 1 && (parts[0] === '.claude' || parts[0] === '.cursor')) {
    return "a coding agent's settings, which can run commands";
  }
  if (parts[0] === '.vscode' && name === 'tasks.json') {
    return 'editor tasks, which can run when the folder opens';
  }
  if (parts[0] === '.devcontainer') return 'runs when a development container is built';
  if (name === '.envrc') return 'runs when a shell enters its directory';
  if (parts[0] === '.github' && parts[1] === 'workflows') return 'a CI workflow';
  if (parts.length === 1 && name === '.gitlab-ci.yml') return 'a CI workflow';
  if (parts[0] === '.husky' || parts[0] === '.githooks') return 'a git hook';
  return undefined;
};

const kindOf = (before: Exclude<Before, 'absent'>): EntryKind => {
  if (before === 'dir') return 'directory';
  if (before === 'symlink') return 'link';
  return before;
};

// Write permission for the group or others, or the sticky bit, which the project's own entries
// rarely have.
const notableMode = (mode: number): boolean => (mode & 0o1022) !== 0;

const octal = (mode: number): string => (mode & 0o7777).toString(8).padStart(3, '0');

const droppedText = (bits: number): string | undefined => {
  const names = [
    ...((bits & 0o4000) !== 0 ? ['set-user-ID'] : []),
    ...((bits & 0o2000) !== 0 ? ['set-group-ID'] : []),
  ];
  return names.length === 0 ? undefined : names.join(' and ');
};

// Files larger than this are not compared line by line.
const MAX_DIFF_BYTES = KEPT_FILE_BYTES;

// What the summary compares in all: it runs on the host, after the sandbox, over files the
// sandbox wrote, as many as its storage holds. Past either limit, the files left are listed with
// their size only.
export interface CompareBudget extends DiffBudget {
  bytes: number;
}

const COMPARE_BUDGET: CompareBudget = { bytes: 32 * 1024 * 1024, steps: 20_000_000 };

// The content of the regular file at `path` beneath `root`, when it is small enough to compare;
// null when it is not, or cannot be read.
const readSmall = (root: number, path: readonly Buffer[]): Buffer | null => {
  let fd: number;
  try {
    fd = openPath(root, path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof SysError || (error as NodeJS.ErrnoException).code !== undefined) {
      return null;
    }
    throw error;
  }
  try {
    const info = fstatSync(fd);
    return info.isFile() && info.size <= MAX_DIFF_BYTES ? readFileSync(fd) : null;
  } finally {
    closeSync(fd);
  }
};

const modeAt = (root: number, path: readonly Buffer[]): number | null => {
  const name = path.at(-1);
  if (name === undefined) return null;
  let dir: number;
  try {
    dir = openDirectoryPath(root, path.slice(0, -1));
  } catch {
    return null;
  }
  try {
    const info = lstatAtOrNull(dir, name);
    return info === null ? null : Number(info.mode) & 0o7777;
  } catch {
    return null;
  } finally {
    close(dir);
  }
};

type WriteChange = Extract<Change, { op: 'write' }>;

export const describeChanges = (
  changes: readonly Change[],
  projectRoot: number,
  limits: CompareBudget = COMPARE_BUDGET,
): ChangeEntry[] => {
  const budget = { ...limits };
  const content = (change: WriteChange, entry: ChangeEntry): void => {
    if (change.node.size > MAX_DIFF_BYTES) return;
    // The new side is the content the reading kept, never a second reading of the upper layer;
    // a reading that kept no more is past its own limit.
    const after = change.node.content;
    if (budget.bytes <= 0 || budget.steps <= 0 || after === undefined) {
      entry.uncompared = true;
      return;
    }
    const before = change.before === 'file' ? readSmall(projectRoot, change.path) : Buffer.alloc(0);
    if (before === null) return;
    budget.bytes -= after.length + before.length;
    const afterText = textOf(after);
    const beforeText = textOf(before);
    if (afterText === null || beforeText === null) {
      entry.binary = true;
      return;
    }
    const diff = lineDiff(beforeText, afterText, budget);
    if (diff.approximate === true) {
      entry.uncompared = true;
      return;
    }
    entry.lines = { added: diff.added, removed: diff.removed };
    if (diff.snippet.length > 0) entry.snippet = diff.snippet;
  };

  const entries: ChangeEntry[] = [];
  // New directories, by path key: what is created inside one is counted under it.
  const created = new Map<string, ChangeEntry>();
  const createdAbove = (path: readonly Buffer[]): ChangeEntry | undefined => {
    let key = '';
    for (const [index, part] of path.slice(0, -1).entries()) {
      key = index === 0 ? childKey(part) : `${key}/${childKey(part)}`;
      const entry = created.get(key);
      if (entry !== undefined) return entry;
    }
    return undefined;
  };

  for (let index = 0; index < changes.length; index++) {
    const first = changes[index] as Change;
    const next = changes[index + 1];
    // A removal followed by an entry at the same path is one replacement.
    const replacing =
      first.op === 'remove' &&
      next !== undefined &&
      next.op !== 'remove' &&
      next.op !== 'refuse' &&
      pathKey(next.path) === pathKey(first.path)
        ? first
        : null;
    const change = replacing === null ? first : (next as Change);
    if (replacing !== null) index += 1;
    const attention = attentionFor(change.path);
    const above = createdAbove(change.path);
    if (above !== undefined && change.op !== 'refuse') {
      above.entries = (above.entries ?? 0) + 1;
      if (change.op === 'write') above.bytes = (above.bytes ?? 0) + change.node.size;
      // Counted under it, and listed as well when it deserves a look.
      if (attention === undefined) continue;
    }
    const entry: ChangeEntry = (() => {
      const path = displayPath(change.path);
      switch (change.op) {
        case 'refuse':
          return { path, change: 'refused', kind: 'other', reason: change.reason };
        case 'remove':
          return {
            path,
            change: 'removed',
            kind: kindOf(change.before),
            ...(change.before === 'dir'
              ? { entries: change.entries - 1, bytes: change.bytes }
              : {}),
          };
        case 'chmod': {
          const before = modeAt(projectRoot, change.path);
          return {
            path,
            change: 'mode',
            kind: 'directory',
            mode: before === null ? octal(change.mode) : `${octal(before)} → ${octal(change.mode)}`,
          };
        }
        case 'mkdir':
          return {
            path,
            change: 'added',
            kind: 'directory',
            ...(notableMode(change.mode) ? { mode: octal(change.mode) } : {}),
          };
        case 'symlink':
          return { path, change: 'added', kind: 'link', target: nameText(change.target) };
        case 'write': {
          const entry: ChangeEntry = {
            path,
            change: change.before === 'file' ? 'modified' : 'added',
            kind: 'file',
            bytes: change.node.size,
          };
          if (change.before === 'file') {
            const before = modeAt(projectRoot, change.path);
            if (before !== null && before !== change.mode) {
              entry.mode = `${octal(before)} → ${octal(change.mode)}`;
            }
            if (change.modeOnly === true) entry.change = 'mode';
          } else if ((change.mode & 0o111) !== 0 || notableMode(change.mode)) {
            entry.mode = octal(change.mode);
          }
          if (change.modeOnly !== true) content(change, entry);
          return entry;
        }
      }
    })();
    if (replacing !== null) {
      entry.change = 'replaced';
      entry.replaces = kindOf(replacing.before);
      if (replacing.before === 'dir') {
        entry.held = { entries: replacing.entries - 1, bytes: replacing.bytes };
      }
    }
    if (change.op === 'mkdir') created.set(pathKey(change.path), entry);
    const dropped = 'droppedBits' in change ? droppedText(change.droppedBits) : undefined;
    if (dropped !== undefined) entry.dropped = dropped;
    if (attention !== undefined) entry.attention = attention;
    entries.push(entry);
  }
  return entries;
};

export interface Paint {
  added: (text: string) => string;
  removed: (text: string) => string;
  attention: (text: string) => string;
  dim: (text: string) => string;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

// Diffs shown, at most; a long list of changes shows the first ones only.
const SNIPPET_ENTRIES = 10;

export const formatChanges = (entries: readonly ChangeEntry[], paint: Paint): string => {
  if (entries.length === 0) return 'The sandbox made no changes to the project.\n';
  const lines = ['Changes in the sandbox:'];
  let snippets = 0;
  let hiddenSnippets = 0;
  let uncompared = 0;
  for (const entry of entries) {
    if (entry.uncompared === true) uncompared += 1;
    const details: string[] = [];
    if (entry.replaces !== undefined) {
      details.push(
        entry.held === undefined || entry.held.entries === 0
          ? `replaces a ${entry.replaces}`
          : `replaces a ${entry.replaces} of ${plural(entry.held.entries, 'entry', 'entries')}, ${formatBytes(entry.held.bytes)}`,
      );
    }
    if (entry.lines !== undefined) {
      details.push(
        [
          entry.lines.added > 0 ? paint.added(`+${entry.lines.added}`) : '',
          entry.lines.removed > 0 ? paint.removed(`-${entry.lines.removed}`) : '',
        ]
          .filter((part) => part.length > 0)
          .join(' '),
      );
    } else if (entry.binary === true) {
      details.push(`binary, ${formatBytes(entry.bytes ?? 0)}`);
    } else if (entry.kind === 'file' && entry.bytes !== undefined && entry.change !== 'mode') {
      details.push(formatBytes(entry.bytes));
    }
    if (entry.kind === 'directory' && entry.entries !== undefined && entry.entries > 0) {
      details.push(
        `${plural(entry.entries, 'entry', 'entries')}, ${formatBytes(entry.bytes ?? 0)}`,
      );
    }
    if (entry.mode !== undefined) {
      details.push(entry.change === 'mode' ? entry.mode : `mode ${entry.mode}`);
    }
    if (entry.dropped !== undefined) details.push(`${entry.dropped} not applied`);
    if (entry.reason !== undefined) details.push(displayText(entry.reason));
    const path =
      entry.kind === 'directory'
        ? `${entry.path}/`
        : entry.target === undefined
          ? entry.path
          : `${entry.path} → ${entry.target}`;
    const shown = details.filter((part) => part.length > 0).join(', ');
    const status = entry.change.padEnd(8);
    lines.push(
      `  ${entry.change === 'refused' ? paint.attention(status) : status} ${path}${shown.length > 0 ? `  ${paint.dim(shown)}` : ''}${entry.attention === undefined ? '' : `  ${paint.attention(`! ${entry.attention}`)}`}`,
    );
    if (entry.snippet === undefined) continue;
    if (snippets === SNIPPET_ENTRIES) {
      hiddenSnippets += 1;
      continue;
    }
    snippets += 1;
    for (const line of entry.snippet) {
      const text = terminalLine(line.text);
      if (line.type === 'add') lines.push(`      ${paint.added(`+ ${text}`)}`);
      else if (line.type === 'del') lines.push(`      ${paint.removed(`- ${text}`)}`);
      else lines.push(`      ${paint.dim(`  ${text}`)}`);
    }
  }
  if (hiddenSnippets > 0) {
    lines.push(
      paint.dim(
        `  The diffs of ${plural(hiddenSnippets, 'more file', 'more files')} are not shown.`,
      ),
    );
  }
  if (uncompared > 0) {
    lines.push(
      paint.dim(
        `  The lines of ${plural(uncompared, 'file', 'files')} were not counted: the summary limits how much it compares.`,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
};

// A line of a file, for one terminal row, with its tabs spaced.
const terminalLine = (text: string): string => escapeControls(text.replace(/\t/g, '  '), false);

export interface NotAppliedEntry {
  path: string;
  status: 'conflict' | 'refused' | 'stopped' | 'not reached';
  reason?: string;
}

export interface ApplyReport {
  applied: string[];
  notApplied: NotAppliedEntry[];
  stopped: { path: string; reason: string } | null;
}

export const applyReport = (outcome: ApplyOutcome): ApplyReport => ({
  applied: outcome.applied.map((change) => displayPath(change.path)),
  notApplied: [
    ...outcome.conflicts.map(({ change, reason }) => ({
      path: displayPath(change.path),
      status: 'conflict' as const,
      reason,
    })),
    ...outcome.refused.map(({ change, reason }) => ({
      path: displayPath(change.path),
      status: 'refused' as const,
      reason,
    })),
    // A change whose old entry could not be deleted is applied, and only reported as the stop.
    ...(outcome.stopped === null || outcome.applied.includes(outcome.stopped.change)
      ? []
      : [
          {
            path: displayPath(outcome.stopped.change.path),
            status: 'stopped' as const,
            reason: outcome.stopped.reason,
          },
        ]),
    ...outcome.notReached.map((change) => ({
      path: displayPath(change.path),
      status: 'not reached' as const,
    })),
  ],
  stopped:
    outcome.stopped === null
      ? null
      : { path: displayPath(outcome.stopped.change.path), reason: outcome.stopped.reason },
});

export const formatApplyReport = (report: ApplyReport, paint: Paint): string => {
  const lines: string[] = [];
  const total = report.applied.length + report.notApplied.length;
  lines.push(
    report.notApplied.length === 0 && report.stopped === null
      ? 'Applied the changes to the project.'
      : `Applied ${report.applied.length} of ${plural(total, 'change', 'changes')} to the project.`,
  );
  if (report.stopped !== null) {
    // What was applied before the stop is listed: the project is now partly changed.
    lines.push(
      paint.attention(
        `The application stopped at ${report.stopped.path}: ${displayText(report.stopped.reason)}`,
      ),
    );
    lines.push('Applied:');
    for (const path of report.applied) lines.push(`  ${path}`);
  }
  if (report.notApplied.length > 0) {
    lines.push('Not applied:');
    for (const entry of report.notApplied) {
      const status = entry.status.padEnd(11);
      lines.push(
        `  ${paint.attention(status)} ${entry.path}${entry.reason === undefined ? '' : `  ${paint.dim(displayText(entry.reason))}`}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
};
