import { closeSync, realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import type { Change } from './classify.ts';
import { lstatAtOrNull, openDirectoryPath, readlinkAt, SysError } from './dirfd.ts';
import { childKey, pathKey, type UpperNode } from './snapshot.ts';

// A symbolic link is applied only when it resolves inside the project, or to the system's own
// files under /usr, as a Python virtual environment's interpreter link does. It is resolved over
// the tree the project would have with it, following every link on the way, since a link inside
// the project can lead out of it. Links are checked twice: over the upper layer and the project,
// for the summary, and over the project itself right before they are created, when what was not
// applied is known.
//
// The links are checked with each other present. One that is refused is absent from the project,
// which changes no other verdict: a link that passes through it resolves through the same steps
// from there, and is refused as well.

const MAX_HOPS = 40;
// Lookups the links of one check may take in all. Each looks a path up from the project's root,
// and a link's target can name thousands of parts and lead through other links: the rest of the
// links are refused once it is spent.
const MAX_LOOKUPS = 1_000_000;
const SYSTEM_PREFIX = Buffer.from('/usr/');
const DOT = Buffer.from('.');
const DOTDOT = Buffer.from('..');

// `unknown`: the project could not be read there, or holds there an entry that is not applied, so
// where a link through it leads is not known.
type Final = { kind: 'absent' | 'dir' | 'other' | 'unknown' } | { kind: 'symlink'; target: Buffer };
type Lookup = (path: Buffer[]) => Final;
type SymlinkChange = Extract<Change, { op: 'symlink' }>;

export const LINK_LEAVES = 'the link leads out of the project';
export const LINK_TOO_COSTLY = 'the links take too many steps to resolve';
// The reason a removal is not applied when the entry the sandbox put in its place is not.
export const REPLACEMENT_LEFT_OUT = 'the entry that replaces it is not applied';

const split = (path: Buffer): Buffer[] => {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= path.length; i++) {
    if (i === path.length || path[i] === 0x2f) {
      if (i > start) parts.push(path.subarray(start, i));
      start = i + 1;
    }
  }
  return parts;
};

const SYSTEM = Buffer.from('/usr');
const SLASH = Buffer.from('/');

// An absolute target under /usr, with no `..` component that would lead back out of it, that stays
// under /usr on the host: links there can lead elsewhere, as to /etc. What counts is where the
// longest existing part of the target resolves; the rest does not exist, and holds no link.
const underSystem = (target: Buffer): boolean => {
  if (!target.subarray(0, SYSTEM_PREFIX.length).equals(SYSTEM_PREFIX)) return false;
  const parts = split(target);
  if (parts.some((part) => part.equals(DOTDOT))) return false;
  for (let length = parts.length; length > 0; length--) {
    const path = Buffer.concat(parts.slice(0, length).flatMap((part) => [SLASH, part]));
    let real: Buffer;
    try {
      real = realpathSync(path, { encoding: 'buffer' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return false;
    }
    return real.equals(SYSTEM) || real.subarray(0, SYSTEM_PREFIX.length).equals(SYSTEM_PREFIX);
  }
  return false;
};

// What the project holds at a path, read through descriptors beneath its root.
const projectAt = (projectRoot: number, path: Buffer[]): Final => {
  const name = path.at(-1);
  if (name === undefined) return { kind: 'dir' };
  let dir = projectRoot;
  let opened: number | null = null;
  try {
    if (path.length > 1) {
      opened = openDirectoryPath(projectRoot, path.slice(0, -1));
      dir = opened;
    }
    const stat = lstatAtOrNull(dir, name);
    if (stat === null) return { kind: 'absent' };
    if (stat.isSymbolicLink()) return { kind: 'symlink', target: readlinkAt(dir, name) };
    return { kind: stat.isDirectory() ? 'dir' : 'other' };
  } catch (error) {
    // A parent that is missing or not a directory holds nothing. One that cannot be opened
    // otherwise, such as a mount point, a link or a directory without permission, may hold a link
    // that leads out, so it is not taken as empty.
    if (error instanceof SysError) {
      return error.code === 'ENOENT' || error.code === 'ENOTDIR'
        ? { kind: 'absent' }
        : { kind: 'unknown' };
    }
    throw error;
  } finally {
    if (opened !== null) closeSync(opened);
  }
};

// Why a link in `linkDir` with `target` is refused, or null when it stays inside the project or
// under /usr. `budget` holds the lookups left to the check.
const refusal = (
  lookup: Lookup,
  projectPath: string,
  linkDir: Buffer[],
  target: Buffer,
  budget: { lookups: number },
): string | null => {
  const inside = leadsInside(lookup, projectPath, linkDir, target, budget);
  if (inside === null) return LINK_TOO_COSTLY;
  return inside ? null : LINK_LEAVES;
};

// Whether a link in `linkDir` with `target` stays inside the project or under /usr; null when the
// budget ran out first.
const leadsInside = (
  lookup: Lookup,
  projectPath: string,
  linkDir: Buffer[],
  target: Buffer,
  budget: { lookups: number },
): boolean | null => {
  const rootPrefix = Buffer.from(projectPath.endsWith(sep) ? projectPath : `${projectPath}${sep}`);
  const insideRoot = (link: Buffer): boolean =>
    link.subarray(0, rootPrefix.length).equals(rootPrefix);
  let resolved: Buffer[] = [...linkDir];
  let queue: Buffer[];
  if (isAbsolute(target.toString('latin1'))) {
    if (!insideRoot(target)) return underSystem(target);
    resolved = [];
    queue = split(target.subarray(rootPrefix.length));
  } else {
    queue = split(target);
  }
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift() as Buffer;
    if (part.equals(DOT)) continue;
    if (part.equals(DOTDOT)) {
      if (resolved.length === 0) return false;
      resolved.pop();
      continue;
    }
    const candidate = [...resolved, part];
    budget.lookups -= 1;
    if (budget.lookups < 0) return null;
    const found = lookup(candidate);
    if (found.kind === 'unknown') return false;
    if (found.kind !== 'symlink') {
      // Only the last part may be absent or other than a directory: an entry made there later, by
      // another application or on the host, would decide where the rest leads, as a link that
      // turns `missing/../..` into a way out.
      if (found.kind !== 'dir' && queue.length > 0) return false;
      resolved = candidate;
      continue;
    }
    hops += 1;
    if (hops > MAX_HOPS) return false;
    const rest = queue;
    if (isAbsolute(found.target.toString('latin1'))) {
      if (!insideRoot(found.target)) return underSystem(found.target) && rest.length === 0;
      resolved = [];
      queue = [...split(found.target.subarray(rootPrefix.length)), ...rest];
    } else {
      queue = [...split(found.target), ...rest];
    }
  }
  return true;
};

const refuseLeaving = (
  changes: readonly Change[],
  lookup: Lookup,
  projectPath: string,
): Change[] => {
  const budget = { lookups: MAX_LOOKUPS };
  return changes.map((change) => {
    if (change.op !== 'symlink') return change;
    const reason = refusal(lookup, projectPath, change.path.slice(0, -1), change.target, budget);
    if (reason === null) return change;
    return { op: 'refuse', path: change.path, reason } satisfies Change;
  });
};

// The changes, with each link that leads out of the project refused; over the tree the upper
// layer and the project make together.
export const symlinkTargetsInside = (
  changes: readonly Change[],
  upper: UpperNode,
  projectRoot: number,
  projectPath: string,
): Change[] => {
  // Paths whose entry is refused keep what the project has there, not what the upper layer shows.
  const refused = new Set(
    changes.filter((change) => change.op === 'refuse').map((change) => pathKey(change.path)),
  );
  const lookup: Lookup = (path) => {
    let node: UpperNode | undefined = upper;
    let hidden = false;
    let key = '';
    for (let i = 0; i < path.length; i++) {
      const part = path[i] as Buffer;
      key = i === 0 ? childKey(part) : `${key}/${childKey(part)}`;
      if (refused.has(key)) return { kind: 'unknown' };
      if (node === undefined || node.kind !== 'dir') {
        return hidden ? { kind: 'absent' } : projectAt(projectRoot, path);
      }
      hidden = hidden || node.opaque;
      node = node.children.get(childKey(part))?.node;
      if (node === undefined) return hidden ? { kind: 'absent' } : projectAt(projectRoot, path);
      if (node.kind === 'whiteout') return { kind: 'absent' };
      if (i < path.length - 1 && node.kind !== 'dir') return { kind: 'absent' };
    }
    if (node === undefined) return { kind: 'absent' };
    if (node.kind === 'symlink') return { kind: 'symlink', target: node.target };
    if (node.kind === 'dir') return { kind: 'dir' };
    return { kind: 'other' };
  };
  const checked = refuseLeaving(changes, lookup, projectPath);
  // A refused link leaves the project's entry at its path in place.
  const leaving = new Set(
    checked
      .filter((change, index) => change.op === 'refuse' && changes[index]?.op === 'symlink')
      .map((change) => pathKey(change.path)),
  );
  return checked.map((change) =>
    change.op === 'remove' && leaving.has(pathKey(change.path))
      ? { op: 'refuse', path: change.path, reason: REPLACEMENT_LEFT_OUT }
      : change,
  );
};

export const LINK_THROUGH_REFUSED = 'it leads through a link that is not applied';

// The links of `links`, with each one that leads out refused; over the project as it is, with the
// links about to be created. They come in the order to create them: each after the links it leads
// through. A link is checked with those present, so it must never exist without them: created in
// this order, and with the creation stopping at the first failure, a link whose way depends on a
// link that could not be made is never made either, and never leads through the project's entry
// there instead.
export const linksInsideProject = (
  links: readonly SymlinkChange[],
  projectRoot: number,
  projectPath: string,
): Change[] => {
  const pending = new Map(links.map((link) => [pathKey(link.path), link.target]));
  // The pending links each resolution passed through.
  let through = new Set<string>();
  const lookup: Lookup = (path) => {
    const key = pathKey(path);
    const target = pending.get(key);
    if (target === undefined) return projectAt(projectRoot, path);
    through.add(key);
    return { kind: 'symlink', target };
  };
  const budget = { lookups: MAX_LOOKUPS };
  const checked = new Map<string, { change: Change; through: Set<string> }>();
  for (const link of links) {
    through = new Set();
    const reason = refusal(lookup, projectPath, link.path.slice(0, -1), link.target, budget);
    const change: Change = reason === null ? link : { op: 'refuse', path: link.path, reason };
    checked.set(pathKey(link.path), { change, through });
  }
  // Depth first, each link after those it passes through. A link that passes through one refused,
  // or through itself, reached again while its own are being placed, is refused as well.
  const ordered: Change[] = [];
  const state = new Map<string, 'placing' | 'placed'>();
  const place = (key: string): boolean => {
    const entry = checked.get(key);
    if (entry === undefined) return true;
    const seen = state.get(key);
    if (seen === 'placed') return entry.change.op !== 'refuse';
    if (seen === 'placing') return false;
    state.set(key, 'placing');
    let kept = entry.change.op !== 'refuse';
    for (const dependency of entry.through) {
      if (dependency !== key && !place(dependency)) kept = false;
    }
    if (!kept && entry.change.op !== 'refuse') {
      entry.change = { op: 'refuse', path: entry.change.path, reason: LINK_THROUGH_REFUSED };
    }
    state.set(key, 'placed');
    ordered.push(entry.change);
    return kept;
  };
  for (const key of checked.keys()) place(key);
  return ordered;
};
