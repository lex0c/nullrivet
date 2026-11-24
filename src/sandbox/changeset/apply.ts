import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  readSync,
  writeSync,
} from 'node:fs';
import { errorMessage } from '../../errors.ts';
import type { Change } from './classify.ts';
import {
  chmodFd,
  lstatAt,
  lstatAtOrNull,
  mkdirAt,
  openBeneath,
  openDirectory,
  openDirectoryBeneath,
  openDirectoryPath,
  openPath,
  openPathBeneath,
  RENAME_EXCHANGE,
  RENAME_NOREPLACE,
  readdirAt,
  renameBeneath,
  rmdirAt,
  SysError,
  symlinkAt,
  unlinkAt,
} from './dirfd.ts';
import { childKey, pathKey } from './snapshot.ts';
import { linksInsideProject } from './validate.ts';

// Applies the changes to the project, one entry at a time, after checking each against what the
// project held when the sandbox started. Timestamps are taken as signs of change: an entry whose
// change time is not before the start, or not what this process left there, changed on the host.
// The project's own processes are trusted; the content to write comes from the upper layer, which
// is not, and is checked against the hash taken when the layer was read.
//
// Each file is replaced whole or not at all; an entry that changes type is removed and then
// created, two steps. The set is not a transaction: a failure, or an interruption of this process,
// leaves the entries before it applied.
//
// Symbolic links are created last, each checked again over the project as it then is: an entry a
// link leads through may not have been applied.

export interface ApplyOptions {
  projectRoot: number;
  // The project's real path, against which absolute link targets are resolved.
  projectPath: string;
  upperPath: string;
  // Changes since this time, in nanoseconds, are the host's: entries changed at or after it are
  // conflicts.
  since: bigint;
  // Called between the check of a file and its replacement, where a change on the host races with
  // this process. Only tests use it, to make that change at that moment.
  afterCheck?: (change: Change) => void;
}

export interface NotApplied {
  change: Change;
  reason: string;
}

export interface ApplyOutcome {
  applied: Change[];
  // Found before anything was written.
  conflicts: NotApplied[];
  refused: NotApplied[];
  // Why the application stopped before the end, and what it did not reach.
  stopped: NotApplied | null;
  notReached: Change[];
}

type Stat = ReturnType<typeof lstatAt>;
type SymlinkChange = Extract<Change, { op: 'symlink' }>;

class Conflict extends Error {
  override name = 'Conflict';
}

const parentKey = (path: readonly Buffer[]): string => pathKey(path.slice(0, -1));
const inodeKey = (stat: { dev: bigint; ino: bigint }): string => `${stat.dev}:${stat.ino}`;
const tempName = (kind: string): Buffer =>
  Buffer.from(`.nullrivet-${kind}-${randomBytes(8).toString('hex')}`);
const nameOf = (path: readonly Buffer[]): Buffer => {
  const name = path.at(-1);
  if (name === undefined) throw new Error('a change has an empty path');
  return name;
};

export const applyChanges = (changes: readonly Change[], options: ApplyOptions): ApplyOutcome => {
  // The times this process left on entries it changed, so its own writes are not conflicts.
  const ours = new Map<string, { ctime: bigint; mtime: bigint }>();
  const unchanged = (stat: {
    dev: bigint;
    ino: bigint;
    ctimeNs: bigint;
    mtimeNs: bigint;
  }): boolean => {
    // The change time alone: any change to an entry sets it to the present, while a modification
    // time can be in the future without any change, as an archive from a skewed clock leaves it.
    if (stat.ctimeNs < options.since) return true;
    const left = ours.get(inodeKey(stat));
    return left !== undefined && left.ctime === stat.ctimeNs && left.mtime === stat.mtimeNs;
  };
  const record = (fd: number): void => {
    const stat = fstatSync(fd, { bigint: true });
    ours.set(inodeKey(stat), { ctime: stat.ctimeNs, mtime: stat.mtimeNs });
  };
  const recordAt = (dir: number, name: Buffer): void => {
    const stat = lstatAt(dir, name);
    ours.set(inodeKey(stat), { ctime: stat.ctimeNs, mtime: stat.mtimeNs });
  };

  const openParent = (path: readonly Buffer[]): number =>
    openDirectoryPath(options.projectRoot, path.slice(0, -1));

  // Right before a change is written: the directory held open is still the one at its path in
  // the project. A directory can be moved after it was opened, out of the project included.
  const ensureInside = (dir: number, path: readonly Buffer[]): void => {
    const again = openDirectoryPath(options.projectRoot, path.slice(0, -1));
    try {
      const held = fstatSync(dir, { bigint: true });
      const now = fstatSync(again, { bigint: true });
      if (held.dev !== now.dev || held.ino !== now.ino) {
        throw new Conflict('its directory was moved on the host');
      }
    } finally {
      closeSync(again);
    }
  };

  const withParent = <T>(path: readonly Buffer[], use: (fd: number) => T): T => {
    const fd = openParent(path);
    try {
      return use(fd);
    } finally {
      closeSync(fd);
    }
  };

  // Every entry of a detached directory, checked before it is deleted.
  const treeUnchanged = (fd: number): boolean => {
    for (const name of readdirAt(fd)) {
      const stat = lstatAt(fd, name);
      if (!unchanged(stat)) return false;
      if (stat.isDirectory()) {
        const child = openDirectoryBeneath(fd, name);
        try {
          if (!treeUnchanged(child)) return false;
        } finally {
          closeSync(child);
        }
      }
    }
    return true;
  };
  // The directory is detached and goes away whatever its mode: one its owner cannot write, as a
  // module cache leaves them, would otherwise stop the removal half-way.
  const removeTree = (fd: number): void => {
    const { mode } = fstatSync(fd);
    if ((mode & 0o700) !== 0o700) fchmodSync(fd, (mode & 0o7777) | 0o700);
    for (const name of readdirAt(fd)) {
      const stat = lstatAt(fd, name);
      if (stat.isDirectory()) {
        const child = openDirectoryBeneath(fd, name);
        try {
          removeTree(child);
        } finally {
          closeSync(child);
        }
        rmdirAt(fd, name);
      } else {
        unlinkAt(fd, name);
      }
    }
  };

  // Copies a file of the upper layer to a new temporary file in `dir`, checking its hash.
  const writeTemp = (dir: number, path: readonly Buffer[], hash: string, mode: number): Buffer => {
    const temp = tempName('new');
    const source = openPath(openUpper(), path, constants.O_RDONLY | constants.O_NONBLOCK);
    let target: number | null = null;
    try {
      target = openBeneath(
        dir,
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const read = readSync(source, buffer, 0, buffer.length, null);
        if (read === 0) break;
        digest.update(buffer.subarray(0, read));
        let written = 0;
        while (written < read) written += writeSync(target, buffer, written, read - written);
      }
      if (digest.digest('hex') !== hash) {
        throw new Error('a file of the sandbox changed after it was read');
      }
      fchmodSync(target, mode);
      fsyncSync(target);
      return temp;
    } catch (error) {
      if (target !== null) {
        closeSync(target);
        target = null;
        unlinkAt(dir, temp);
      }
      throw error;
    } finally {
      if (target !== null) closeSync(target);
      closeSync(source);
    }
  };
  let upperFd: number | null = null;
  const openUpper = (): number => {
    upperFd ??= openDirectory(options.upperPath);
    return upperFd;
  };

  // Moves an entry to a trash name, checks it is still what was checked, and deletes it; or puts
  // it back. Deleting a detached entry cannot race with a change made under its name.
  const removeEntry = (dir: number, name: Buffer, before: Change & { op: 'remove' }): void => {
    const trash = tempName('trash');
    ensureInside(dir, before.path);
    if (before.before === 'dir') {
      const fd = openDirectoryBeneath(dir, name);
      try {
        const pre = fstatSync(fd, { bigint: true });
        if (!unchanged(pre)) throw new Conflict('the directory changed on the host');
        renameBeneath(dir, name, dir, trash, RENAME_NOREPLACE);
        // The entry renamed must be the directory held open: another one can have taken its name
        // since it was opened.
        const moved = lstatAt(dir, trash);
        const post = fstatSync(fd, { bigint: true });
        if (
          moved.dev !== pre.dev ||
          moved.ino !== pre.ino ||
          post.mtimeNs !== pre.mtimeNs ||
          !treeUnchanged(fd)
        ) {
          renameBeneath(dir, trash, dir, name, RENAME_NOREPLACE);
          throw new Conflict('something in the directory changed on the host');
        }
        removeTree(fd);
      } finally {
        closeSync(fd);
      }
      rmdirAt(dir, trash);
      return;
    }
    const pre = lstatAt(dir, name);
    if (!unchanged(pre) || kindMatches(pre, before.before) === false) {
      throw new Conflict('the entry changed on the host');
    }
    renameBeneath(dir, name, dir, trash, RENAME_NOREPLACE);
    const post = lstatAt(dir, trash);
    if (post.ino !== pre.ino || post.mtimeNs !== pre.mtimeNs || post.size !== pre.size) {
      renameBeneath(dir, trash, dir, name, RENAME_NOREPLACE);
      throw new Conflict('the entry changed on the host');
    }
    unlinkAt(dir, trash);
  };

  const applyOne = (change: Change): void => {
    if (change.op === 'refuse') return;
    const name = nameOf(change.path);
    withParent(change.path, (dir) => {
      const parent = fstatSync(dir, { bigint: true });
      switch (change.op) {
        case 'remove':
          if (!unchanged(parent)) throw new Conflict('its directory changed on the host');
          removeEntry(dir, name, change);
          break;
        case 'mkdir':
        case 'symlink':
        case 'write': {
          if (change.op === 'write' && change.before === 'file') {
            const fd = openPathBeneath(dir, name);
            try {
              const pre = fstatSync(fd, { bigint: true });
              if (!pre.isFile() || !unchanged(pre))
                throw new Conflict('the file changed on the host');
              options.afterCheck?.(change);
              const temp = writeTemp(dir, change.path, change.node.hash, change.mode);
              ensureInside(dir, change.path);
              renameBeneath(dir, temp, dir, name, RENAME_EXCHANGE);
              // The exchange changes the change time of both files; the old one is identified by
              // its inode, and its size and modification time show whether it was written since.
              const post = fstatSync(fd, { bigint: true });
              const swapped = lstatAt(dir, temp);
              if (
                swapped.ino !== pre.ino ||
                post.size !== pre.size ||
                post.mtimeNs !== pre.mtimeNs
              ) {
                renameBeneath(dir, temp, dir, name, RENAME_EXCHANGE);
                unlinkAt(dir, temp);
                throw new Conflict('the file changed on the host');
              }
              unlinkAt(dir, temp);
              recordAt(dir, name);
            } finally {
              closeSync(fd);
            }
            break;
          }
          // An addition: nothing there, in a directory nobody else changed.
          if (!unchanged(parent)) throw new Conflict('its directory changed on the host');
          if (lstatAtOrNull(dir, name) !== null)
            throw new Conflict('something was created there on the host');
          ensureInside(dir, change.path);
          if (change.op === 'mkdir') {
            mkdirAt(dir, name, 0o700);
            const fd = openDirectoryBeneath(dir, name);
            try {
              fchmodSync(fd, writableDirectory(change.path, change.mode));
              record(fd);
            } finally {
              closeSync(fd);
            }
          } else if (change.op === 'symlink') {
            symlinkAt(change.target, dir, name);
          } else {
            const temp = writeTemp(dir, change.path, change.node.hash, change.mode);
            try {
              renameBeneath(dir, temp, dir, name, RENAME_NOREPLACE);
            } catch (error) {
              unlinkAt(dir, temp);
              if (error instanceof SysError && error.code === 'EEXIST') {
                throw new Conflict('something was created there on the host');
              }
              throw error;
            }
            recordAt(dir, name);
          }
          break;
        }
        case 'chmod': {
          const fd = openPathBeneath(dir, name);
          try {
            const pre = fstatSync(fd, { bigint: true });
            if (!unchanged(pre) || !kindMatches(pre, change.before)) {
              throw new Conflict('the entry changed on the host');
            }
            ensureInside(dir, change.path);
            chmodFd(
              fd,
              change.before === 'dir' ? writableDirectory(change.path, change.mode) : change.mode,
            );
            record(fd);
          } finally {
            closeSync(fd);
          }
          break;
        }
      }
      record(dir);
    });
  };

  // Checks that change nothing, before anything is written: an entry in conflict is left out,
  // and so is everything beneath it or replacing it.
  const preflight = (change: Change, removed: Set<string>, created: Set<string>): string | null => {
    if (change.op === 'refuse') return null;
    const name = nameOf(change.path);
    if (created.has(parentKey(change.path))) return null;
    try {
      return withParent(change.path, (dir) => {
        const target = lstatAtOrNull(dir, name);
        const parent = fstatSync(dir, { bigint: true });
        switch (change.op) {
          case 'remove':
            if (target === null) return 'the entry is gone from the host';
            if (!unchanged(parent) || !unchanged(target) || !kindMatches(target, change.before)) {
              return 'the entry changed on the host';
            }
            if (change.before === 'dir') {
              const fd = openDirectoryBeneath(dir, name);
              try {
                if (!treeUnchanged(fd)) return 'something in the directory changed on the host';
              } finally {
                closeSync(fd);
              }
            }
            return null;
          case 'chmod':
            if (target === null || !unchanged(target)) return 'the entry changed on the host';
            return null;
          case 'write':
            if (change.before === 'file') {
              if (target === null || !target.isFile() || !unchanged(target)) {
                return 'the file changed on the host';
              }
              return null;
            }
            break;
          default:
            break;
        }
        if (!unchanged(parent)) return 'its directory changed on the host';
        if (target !== null && !removed.has(pathKey(change.path))) {
          return 'something was created there on the host';
        }
        return null;
      });
    } catch (error) {
      if (error instanceof Conflict) return error.message;
      if (error instanceof SysError || (error as NodeJS.ErrnoException).code !== undefined) {
        return `it cannot be reached on the host: ${errorMessage(error)}`;
      }
      throw error;
    }
  };

  // A directory is kept open to its owner while entries are written into it; a mode that would
  // close it is set once everything is written, from the deepest directory up.
  const finalModes: { path: readonly Buffer[]; mode: number }[] = [];
  const writableDirectory = (path: readonly Buffer[], mode: number): number => {
    if ((mode & 0o700) !== 0o700) finalModes.push({ path, mode });
    return mode | 0o700;
  };
  const setFinalModes = (): void => {
    for (const { path, mode } of finalModes.reverse()) {
      const fd = openDirectoryPath(options.projectRoot, path);
      try {
        if (!unchanged(fstatSync(fd, { bigint: true }))) {
          throw new Conflict('the directory changed on the host');
        }
        fchmodSync(fd, mode);
        record(fd);
      } finally {
        closeSync(fd);
      }
    }
  };

  const outcome: ApplyOutcome = {
    applied: [],
    conflicts: [],
    refused: [],
    stopped: null,
    notReached: [],
  };
  const left = new Set<string>();
  // Whether the entry, or a directory above it, is left out.
  const underLeftOut = (path: readonly Buffer[]): boolean => {
    let key = '';
    for (const part of path) {
      key = key === '' ? childKey(part) : `${key}/${childKey(part)}`;
      if (left.has(key)) return true;
    }
    return false;
  };
  const removed = new Set<string>();
  const created = new Set<string>();
  const toApply: Change[] = [];
  for (const change of changes) {
    const key = pathKey(change.path);
    if (change.op === 'refuse') {
      outcome.refused.push({ change, reason: change.reason });
      left.add(key);
      continue;
    }
    const reason = underLeftOut(change.path)
      ? 'an entry it depends on is not applied'
      : preflight(change, removed, created);
    if (reason !== null) {
      outcome.conflicts.push({ change, reason });
      left.add(key);
      continue;
    }
    if (change.op === 'remove') removed.add(key);
    if (change.op === 'mkdir') created.add(key);
    toApply.push(change);
  }

  // Applies `list` in order, up to the first failure; true when it reached the end.
  const run = (list: readonly Change[]): boolean => {
    for (const [index, change] of list.entries()) {
      try {
        applyOne(change);
        outcome.applied.push(change);
      } catch (error) {
        outcome.stopped = { change, reason: errorMessage(error) };
        outcome.notReached.push(...list.slice(index + 1));
        return false;
      }
    }
    return true;
  };
  const entries = toApply.filter((change) => change.op !== 'symlink');
  const links = toApply.filter((change): change is SymlinkChange => change.op === 'symlink');

  try {
    if (!run(entries)) {
      outcome.notReached.push(...links);
    } else if (links.length > 0) {
      let checked: Change[] | null = null;
      try {
        checked = linksInsideProject(links, options.projectRoot, options.projectPath);
      } catch (error) {
        outcome.stopped = {
          change: links[0] as Change,
          reason: `checking the links failed: ${errorMessage(error)}`,
        };
        outcome.notReached.push(...links.slice(1));
      }
      if (checked !== null) {
        for (const change of checked) {
          if (change.op === 'refuse') outcome.refused.push({ change, reason: change.reason });
        }
        run(checked.filter((change) => change.op !== 'refuse'));
      }
    }
    try {
      setFinalModes();
    } catch (error) {
      // Reported even after a stop: the directories not reached keep the mode they were given to
      // be written into.
      const reason = `setting the mode of a directory failed: ${errorMessage(error)}`;
      outcome.stopped =
        outcome.stopped === null
          ? { change: outcome.applied.at(-1) ?? (toApply[0] as Change), reason }
          : { ...outcome.stopped, reason: `${outcome.stopped.reason}; ${reason}` };
    }
  } finally {
    if (upperFd !== null) closeSync(upperFd);
  }
  return outcome;
};

const kindMatches = (stat: Stat, before: string): boolean => {
  if (before === 'file') return stat.isFile();
  if (before === 'dir') return stat.isDirectory();
  if (before === 'symlink') return stat.isSymbolicLink();
  return !stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink();
};
