import { closeSync, constants, fstatSync } from 'node:fs';
import {
  lstatAtOrNull,
  openBeneath,
  openDirectoryBeneath,
  readdirAt,
  readlinkAt,
  SysError,
} from './dirfd.ts';
import { childKey, hashFile, pathKey, type UpperNode } from './snapshot.ts';

// The changes the upper layer makes to the project, found by comparing each of its entries with
// what the project holds at the same path, read through descriptors beneath the project root.

export type Before = 'absent' | 'file' | 'dir' | 'symlink' | 'other';

export type Change =
  | {
      op: 'write';
      path: Buffer[];
      before: Before;
      node: Extract<UpperNode, { kind: 'file' }>;
      mode: number;
      droppedBits: number;
      // The content is the project's; only the mode changes.
      modeOnly?: true;
    }
  | { op: 'mkdir'; path: Buffer[]; mode: number; droppedBits: number }
  | { op: 'symlink'; path: Buffer[]; target: Buffer }
  // A mode change of a directory; a file's is a write of a new file.
  | { op: 'chmod'; path: Buffer[]; mode: number; droppedBits: number }
  | {
      op: 'remove';
      path: Buffer[];
      before: Exclude<Before, 'absent'>;
      entries: number;
      bytes: number;
    }
  | { op: 'refuse'; path: Buffer[]; reason: string };

const GIT = Buffer.from('.git');
// The reason of every refused change under .git, which git commands in the sandbox make.
export const GIT_NEVER_CHANGED = '.git is never changed';
// Set-user-ID and set-group-ID never reach the project.
const DROPPED_BITS = 0o6000;

// The mode of an entry the project already has, for a change of its mode alone. A bit of
// DROPPED_BITS the project's entry has, and the upper layer still shows, is kept: the sandbox did
// not add it, and a set-group-ID directory is copied to the upper layer for any change inside it.
const keptMode = (upperMode: number, lowerMode: number): { mode: number; droppedBits: number } => {
  const kept = upperMode & lowerMode & DROPPED_BITS;
  return {
    mode: (upperMode & ~DROPPED_BITS) | kept,
    droppedBits: upperMode & DROPPED_BITS & ~kept,
  };
};

const kindOf = (stat: ReturnType<typeof lstatAtOrNull>): Before => {
  if (stat === null) return 'absent';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'dir';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
};

// Null when the project's file cannot be read: it is then written over, as a changed file is.
const hashLower = (dir: number, name: Buffer): string | null => {
  let fd: number;
  try {
    fd = openBeneath(dir, name, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof SysError && error.code === 'EACCES') return null;
    throw error;
  }
  try {
    return fstatSync(fd).isFile() ? hashFile(fd) : null;
  } finally {
    closeSync(fd);
  }
};

interface Removal {
  entries: number;
  bytes: number;
  refused: string | null;
}

// What removing a directory of the project takes away. Never a .git directory, at any depth, and
// never across a mount: the agent saw the mount's content, not what it would delete.
const measure = (dir: number, name: Buffer): Removal => {
  let fd: number;
  try {
    fd = openDirectoryBeneath(dir, name);
  } catch (error) {
    if (error instanceof SysError && error.code === 'EXDEV') {
      return { entries: 0, bytes: 0, refused: 'it is a mount point' };
    }
    throw error;
  }
  try {
    const total: Removal = { entries: 0, bytes: 0, refused: null };
    for (const child of readdirAt(fd)) {
      if (child.equals(GIT)) return { ...total, refused: 'it holds a .git directory' };
      const stat = lstatAtOrNull(fd, child);
      if (stat === null) continue;
      total.entries += 1;
      if (stat.isDirectory()) {
        const inner = measure(fd, child);
        if (inner.refused !== null) return { ...total, refused: inner.refused };
        total.entries += inner.entries;
        total.bytes += inner.bytes;
      } else {
        total.bytes += Number(stat.size);
      }
    }
    return total;
  } finally {
    closeSync(fd);
  }
};

export const classify = (upper: UpperNode, projectRoot: number): Change[] => {
  const changes: Change[] = [];
  // Paths whose removal was refused: what would replace them cannot be applied either.
  const blocked = new Set<string>();

  // A removal takes away a name, whatever the entry is: a device, FIFO or socket the project has
  // is removed like a file, and only creating one is refused. A refused removal is reported once,
  // at its path; what the sandbox put there instead is left out with it.
  const remove = (dir: number, name: Buffer, path: Buffer[], before: Exclude<Before, 'absent'>) => {
    if (before !== 'dir') {
      changes.push({ op: 'remove', path, before, entries: 1, bytes: 0 });
      return;
    }
    const removal = measure(dir, name);
    if (removal.refused !== null) {
      changes.push({
        op: 'refuse',
        path,
        reason: `the directory is not removed: ${removal.refused}`,
      });
      blocked.add(pathKey(path));
      return;
    }
    changes.push({
      op: 'remove',
      path,
      before,
      entries: removal.entries + 1,
      bytes: removal.bytes,
    });
  };

  const walk = (
    node: Extract<UpperNode, { kind: 'dir' }>,
    lower: number | null,
    parent: Buffer[],
    hidesLower: boolean,
  ) => {
    const entries = [...node.children.values()].sort((a, b) => Buffer.compare(a.name, b.name));
    if (lower !== null && hidesLower) {
      // An opaque directory replaces the one below: what is only below goes away.
      for (const name of readdirAt(lower)) {
        if (node.children.has(childKey(name))) continue;
        const path = [...parent, name];
        if (name.equals(GIT)) {
          changes.push({ op: 'refuse', path, reason: GIT_NEVER_CHANGED });
          continue;
        }
        const before = kindOf(lstatAtOrNull(lower, name));
        if (before !== 'absent') remove(lower, name, path, before);
      }
    }
    for (const { name, node: child } of entries) {
      const path = [...parent, name];
      if (name.equals(GIT)) {
        changes.push({ op: 'refuse', path, reason: GIT_NEVER_CHANGED });
        continue;
      }
      const before = lower === null ? 'absent' : kindOf(lstatAtOrNull(lower, name));
      const replaceBefore = (): boolean => {
        if (before === 'absent' || lower === null) return true;
        remove(lower, name, path, before);
        return !blocked.has(pathKey(path));
      };
      switch (child.kind) {
        case 'whiteout':
          if (before !== 'absent' && lower !== null) remove(lower, name, path, before);
          break;
        case 'other':
          changes.push({ op: 'refuse', path, reason: `${child.what} is not applied` });
          break;
        case 'file': {
          const mode = child.mode & ~DROPPED_BITS;
          const droppedBits = child.mode & DROPPED_BITS;
          if (before === 'file' && lower !== null) {
            const lowerStat = lstatAtOrNull(lower, name);
            if (
              lowerStat !== null &&
              Number(lowerStat.size) === child.size &&
              hashLower(lower, name) === child.hash
            ) {
              const lowerMode = Number(lowerStat.mode) & 0o7777;
              const kept = keptMode(child.mode, lowerMode);
              if (kept.mode !== lowerMode) {
                // A mode belongs to the inode, which every hard link shares, and a link outside
                // the project can be made up to the moment the mode is set: the file gets a new
                // inode with the new mode instead.
                changes.push({
                  op: 'write',
                  path,
                  before: 'file',
                  node: child,
                  ...kept,
                  modeOnly: true,
                });
              }
              break;
            }
            changes.push({ op: 'write', path, before: 'file', node: child, mode, droppedBits });
            break;
          }
          if (!replaceBefore()) break;
          changes.push({ op: 'write', path, before: 'absent', node: child, mode, droppedBits });
          break;
        }
        case 'symlink': {
          if (
            before === 'symlink' &&
            lower !== null &&
            readlinkAt(lower, name).equals(child.target)
          )
            break;
          if (!replaceBefore()) break;
          changes.push({ op: 'symlink', path, target: child.target });
          break;
        }
        case 'dir': {
          const mode = child.mode & ~DROPPED_BITS;
          const droppedBits = child.mode & DROPPED_BITS;
          if (before === 'dir' && lower !== null) {
            let fd: number;
            try {
              fd = openDirectoryBeneath(lower, name);
            } catch (error) {
              // The sandbox saw the directory under the mount, not the mount's content.
              if (error instanceof SysError && error.code === 'EXDEV') {
                changes.push({ op: 'refuse', path, reason: 'it is a mount point' });
                break;
              }
              throw error;
            }
            const lowerStat = lstatAtOrNull(lower, name);
            if (lowerStat !== null) {
              const lowerMode = Number(lowerStat.mode) & 0o7777;
              const kept = keptMode(child.mode, lowerMode);
              if (kept.mode !== lowerMode) {
                changes.push({ op: 'chmod', path, ...kept });
              }
            }
            try {
              walk(child, fd, path, hidesLower || child.opaque);
            } finally {
              closeSync(fd);
            }
            break;
          }
          if (!replaceBefore()) break;
          changes.push({ op: 'mkdir', path, mode, droppedBits });
          walk(child, null, path, true);
          break;
        }
      }
    }
  };

  if (upper.kind !== 'dir') throw new Error('the upper layer is not a directory');
  walk(upper, projectRoot, [], false);
  return changes;
};
