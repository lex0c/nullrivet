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
import type { Before, Change } from './classify.ts';
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
import { linksInsideProject, REPLACEMENT_LEFT_OUT } from './validate.ts';

// Applies the changes to the project, one entry at a time, after checking each against what the
// project held when the sandbox started. Timestamps are taken as signs of change: an entry whose
// change time is not before the start, or not what this process left there, changed on the host.
// The project's own processes are trusted; the content to write comes from the upper layer, which
// is not, and is checked against the hash taken when the layer was read.
//
// An entry of the project that is replaced, by a new version or by an entry of another type, is
// exchanged with the new one, made beforehand under a temporary name: its path holds one or the
// other at every moment, and a failure before the exchange leaves the project's in place. The set
// is not a transaction: a failure, or an interruption of this process, leaves the entries before
// it applied.
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
  // Called at each step of moving an entry into or out of its path, where a change on the host
  // races with this process and where a failure or an interruption leaves the work half done.
  // Only tests use it, to make that change, fail or end the process at that moment.
  step?: (step: ApplyStep, change: Change) => void;
}

// `checked`: the project's entry was checked, and the new one is about to be made. `moving`: the
// new one is made, and the rename or exchange is next. `moved`: the project's entry was moved
// out, and is about to be checked again. `deleting`: it was confirmed, and is about to be deleted.
// An added file goes through `moving` only.
export type ApplyStep = 'checked' | 'moving' | 'moved' | 'deleting';

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
type RemoveChange = Extract<Change, { op: 'remove' }>;
type Creation = Extract<Change, { op: 'write' | 'mkdir' | 'symlink' }>;
type Existing = Exclude<Before, 'absent'>;

class Conflict extends Error {
  override name = 'Conflict';
}

// The project's entry is no longer at its path, and deleting it failed: the change is applied,
// and the error names where what is left of the entry stays.
class NotDeleted extends Error {
  override name = 'NotDeleted';
}

// The project's entry, identified by its inode as it was checked. A directory is held open, to
// check what it holds once it is detached.
interface Held {
  stat: Stat;
  dir: number | null;
}

// Codes of opening a directory that was there at the check: something else has its name now.
const REPLACED = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EXDEV']);

const changedOnHost = (before: Existing): string => {
  if (before === 'file') return 'the file changed on the host';
  if (before === 'dir') return 'the directory changed on the host';
  return 'the entry changed on the host';
};

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
    const temp = tempName('apply');
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

  const holdEntry = (dir: number, name: Buffer, before: Existing): Held => {
    const conflict = changedOnHost(before);
    if (before !== 'dir') {
      const stat = lstatAtOrNull(dir, name);
      if (stat === null || !unchanged(stat) || !kindMatches(stat, before)) {
        throw new Conflict(conflict);
      }
      return { stat, dir: null };
    }
    let fd: number;
    try {
      fd = openDirectoryBeneath(dir, name);
    } catch (error) {
      if (error instanceof SysError && REPLACED.has(error.code)) throw new Conflict(conflict);
      throw error;
    }
    const stat = fstatSync(fd, { bigint: true });
    if (!unchanged(stat)) {
      closeSync(fd);
      throw new Conflict(conflict);
    }
    return { stat, dir: fd };
  };

  // Whether the entry at `name` is still the one held, with no change since the check. Checked
  // again right before it is moved: making the new entry can take long.
  const unchangedSinceHeld = (dir: number, name: Buffer, held: Held): boolean => {
    const now =
      held.dir === null ? lstatAtOrNull(dir, name) : fstatSync(held.dir, { bigint: true });
    return now !== null && now.dev === held.stat.dev && now.ino === held.stat.ino && unchanged(now);
  };

  // Whether the entry now under `name` is the one held, unchanged since it was checked: another
  // one can have taken its name since, or it can have been written, or had its mode or owner
  // changed. Moving an entry changes its change time, so what each of those changes sets is
  // compared instead; a change to its extended attributes alone does not show here.
  const stillHeld = (dir: number, name: Buffer, held: Held): boolean => {
    const moved = lstatAt(dir, name);
    if (
      moved.dev !== held.stat.dev ||
      moved.ino !== held.stat.ino ||
      moved.mtimeNs !== held.stat.mtimeNs ||
      moved.mode !== held.stat.mode ||
      moved.uid !== held.stat.uid ||
      moved.gid !== held.stat.gid
    ) {
      return false;
    }
    return held.dir === null ? moved.size === held.stat.size : treeUnchanged(held.dir);
  };

  // Deletes the project's entry, detached under `trash`: a change made under its old name cannot
  // reach it.
  const deleteHeld = (dir: number, trash: Buffer, held: Held, change: Change): void => {
    try {
      options.step?.('deleting', change);
      if (held.dir === null) {
        unlinkAt(dir, trash);
      } else {
        removeTree(held.dir);
        rmdirAt(dir, trash);
      }
    } catch (error) {
      throw new NotDeleted(
        `deleting the project's entry failed, and it is left as ${trash.toString()} in the same ` +
          `directory: ${errorMessage(error)}`,
      );
    }
  };

  // Moves an entry to a trash name, checks it is still what was checked, and deletes it; or puts
  // it back.
  const removeEntry = (dir: number, name: Buffer, change: RemoveChange): void => {
    const held = holdEntry(dir, name, change.before);
    try {
      options.step?.('checked', change);
      if (!unchangedSinceHeld(dir, name, held)) throw new Conflict(changedOnHost(change.before));
      ensureInside(dir, change.path);
      const trash = tempName('trash');
      options.step?.('moving', change);
      try {
        renameBeneath(dir, name, dir, trash, RENAME_NOREPLACE);
      } catch (error) {
        if (error instanceof SysError && error.code === 'ENOENT') {
          throw new Conflict(changedOnHost(change.before));
        }
        throw error;
      }
      // Out of its path from here: the entry goes back unless it is confirmed, a failure of the
      // check included.
      let same = false;
      try {
        options.step?.('moved', change);
        same = stillHeld(dir, trash, held);
      } finally {
        if (!same) renameBeneath(dir, trash, dir, name, RENAME_NOREPLACE);
      }
      if (!same) throw new Conflict(changedOnHost(change.before));
      deleteHeld(dir, trash, held, change);
    } finally {
      if (held.dir !== null) closeSync(held.dir);
    }
  };

  // Makes the entry of `change` under a temporary name in `dir`. A directory is made empty and
  // open to its owner; it gets its mode once it is in place.
  const createAt = (dir: number, change: Creation): Buffer => {
    if (change.op === 'write') return writeTemp(dir, change.path, change.node.hash, change.mode);
    const temp = tempName('apply');
    if (change.op === 'mkdir') mkdirAt(dir, temp, 0o700);
    else symlinkAt(change.target, dir, temp);
    return temp;
  };

  // Puts the entry of `change` in place of the project's entry at `name`, by exchanging the two.
  // The project's entry is deleted once it is confirmed to be the one checked; otherwise the
  // exchange is undone and the new entry deleted.
  const replaceEntry = (dir: number, name: Buffer, before: Existing, change: Creation): void => {
    const held = holdEntry(dir, name, before);
    try {
      options.step?.('checked', change);
      const temp = createAt(dir, change);
      // What the temporary name holds: the new entry until the exchange, the project's after it.
      // When that is not known, nothing under it is deleted.
      let holds: 'new' | 'old' | 'unknown' = 'new';
      // The new file or directory, to record the times it is left with.
      let made: number | null = null;
      try {
        if (change.op !== 'symlink') made = openPathBeneath(dir, temp);
        if (!unchangedSinceHeld(dir, name, held)) throw new Conflict(changedOnHost(before));
        ensureInside(dir, change.path);
        options.step?.('moving', change);
        try {
          renameBeneath(dir, temp, dir, name, RENAME_EXCHANGE);
        } catch (error) {
          if (error instanceof SysError && error.code === 'ENOENT') {
            throw new Conflict(changedOnHost(before));
          }
          throw error;
        }
        holds = 'unknown';
        let same = false;
        try {
          options.step?.('moved', change);
          same = stillHeld(dir, temp, held);
        } finally {
          if (!same) {
            renameBeneath(dir, temp, dir, name, RENAME_EXCHANGE);
            holds = 'new';
          }
        }
        if (!same) throw new Conflict(changedOnHost(before));
        holds = 'old';
        if (made !== null) {
          if (change.op === 'mkdir') chmodFd(made, writableDirectory(change.path, change.mode));
          record(made);
        }
      } finally {
        if (made !== null) closeSync(made);
        if (holds === 'new') {
          if (change.op === 'mkdir') rmdirAt(dir, temp);
          else unlinkAt(dir, temp);
        }
      }
      deleteHeld(dir, temp, held, change);
    } finally {
      if (held.dir !== null) closeSync(held.dir);
    }
  };

  // Applies one change; `replacing` is the removal that makes room for it, done in the same step.
  const applyOne = (change: Change, replacing?: RemoveChange): void => {
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
            replaceEntry(dir, name, 'file', change);
            break;
          }
          if (!unchanged(parent)) throw new Conflict('its directory changed on the host');
          if (replacing !== undefined) {
            replaceEntry(dir, name, replacing.before, change);
            break;
          }
          // An addition: nothing there, in a directory nobody else changed.
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
              options.step?.('moving', change);
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
            if (!unchanged(pre) || !pre.isDirectory()) {
              throw new Conflict('the directory changed on the host');
            }
            ensureInside(dir, change.path);
            chmodFd(fd, writableDirectory(change.path, change.mode));
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
            if (target === null || !unchanged(target) || !target.isDirectory()) {
              return 'the directory changed on the host';
            }
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
  // A removal that makes room for an entry is applied only with that entry: when the entry is
  // left out, the project's one stays.
  const ready: Change[] = [];
  for (const change of toApply) {
    if (change.op === 'remove' && left.has(pathKey(change.path))) {
      outcome.conflicts.push({ change, reason: REPLACEMENT_LEFT_OUT });
    } else {
      ready.push(change);
    }
  }

  // A removal that makes room for an entry is applied with it, as one replacement: the two are
  // one unit, reported together.
  const removalAt = new Map(
    ready
      .filter((change): change is RemoveChange => change.op === 'remove')
      .map((change) => [pathKey(change.path), change] as const),
  );
  const replaced = new Set(
    ready
      .filter((change) => change.op !== 'remove' && removalAt.has(pathKey(change.path)))
      .map((change) => pathKey(change.path)),
  );
  const unitOf = (change: Change): Change[] => {
    const removal = change.op === 'remove' ? undefined : removalAt.get(pathKey(change.path));
    return removal === undefined ? [change] : [removal, change];
  };
  // Applies `units` in order, up to the first failure; true when it reached the end. The change a
  // unit stops at is its last: the entry a removal makes room for.
  const run = (units: readonly Change[][]): boolean => {
    for (const [index, unit] of units.entries()) {
      const change = unit.at(-1) as Change;
      const removal = unit.length > 1 ? (unit[0] as RemoveChange) : undefined;
      try {
        applyOne(change, removal);
        outcome.applied.push(...unit);
      } catch (error) {
        outcome.stopped = { change, reason: errorMessage(error) };
        if (error instanceof NotDeleted) {
          // The entry is no longer at its path: only deleting it failed.
          outcome.applied.push(...unit);
        } else {
          outcome.notReached.push(...unit.slice(0, -1));
        }
        outcome.notReached.push(...units.slice(index + 1).flat());
        return false;
      }
    }
    return true;
  };
  // Links go last, each with the removal that makes room for it, so that a link refused by the
  // second check leaves the project's entry at its path in place.
  const links = ready.filter((change): change is SymlinkChange => change.op === 'symlink');
  const entries = ready
    .filter(
      (change) =>
        change.op !== 'symlink' && !(change.op === 'remove' && replaced.has(pathKey(change.path))),
    )
    .map(unitOf);

  try {
    if (!run(entries)) {
      outcome.notReached.push(...links.flatMap(unitOf));
    } else if (links.length > 0) {
      let checked: Change[] | null = null;
      try {
        checked = linksInsideProject(links, options.projectRoot, options.projectPath);
      } catch (error) {
        const first = links[0] as SymlinkChange;
        outcome.stopped = {
          change: first,
          reason: `checking the links failed: ${errorMessage(error)}`,
        };
        outcome.notReached.push(...links.flatMap(unitOf).filter((change) => change !== first));
      }
      if (checked !== null) {
        const units: Change[][] = [];
        for (const change of checked) {
          if (change.op !== 'refuse') {
            units.push(unitOf(change));
            continue;
          }
          outcome.refused.push({ change, reason: change.reason });
          const removal = removalAt.get(pathKey(change.path));
          if (removal !== undefined) {
            outcome.refused.push({ change: removal, reason: REPLACEMENT_LEFT_OUT });
          }
        }
        run(units);
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
          ? { change: outcome.applied.at(-1) ?? (ready[0] as Change), reason }
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
