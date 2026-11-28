import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, readSync, statfsSync } from 'node:fs';
import { totalmem } from 'node:os';
import {
  chmodFd,
  lstatAt,
  openBeneath,
  openDirectory,
  openDirectoryBeneath,
  openPathBeneath,
  readdirAt,
  readlinkAt,
  xattrsAt,
} from './dirfd.ts';

// What the overlay's upper layer holds, read once the worker has stopped, so nothing changes it
// while it is read. The upper layer was written by the sandbox and is read as untrusted input:
// links are never followed, and anything the overlay does not produce stops the reading. A
// reading while the sandbox runs, for a preview, changes nothing in the layer, which the overlay
// does not expect to change under it, and passes over entries removed while it reads.

export type UpperNode =
  // `content`: the bytes hashed, kept for a small file; see KEPT_FILE_BYTES.
  | { kind: 'file'; mode: number; size: number; hash: string; content?: Buffer }
  | { kind: 'dir'; mode: number; opaque: boolean; children: Map<string, UpperChild> }
  | { kind: 'symlink'; target: Buffer }
  | { kind: 'whiteout' }
  | { kind: 'other'; what: string };

export interface UpperChild {
  name: Buffer;
  node: UpperNode;
}

export interface SnapshotLimits {
  maxEntries: number;
  maxFileBytes: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxEntries: 200_000,
  maxFileBytes: 1024 * 1024 * 1024,
};

export class SnapshotError extends Error {
  override name = 'SnapshotError';
}

export const childKey = (name: Buffer): string => name.toString('hex');
export const pathKey = (path: readonly Buffer[]): string => path.map(childKey).join('/');

const OVERLAY_PREFIX = 'user.overlay.';
// Set by the user through the overlay, which escapes them: not markers.
const ESCAPED_PREFIX = 'user.overlay.overlay.';
// Markers the overlay writes that carry nothing to apply.
const IGNORED_MARKERS = new Set(['origin', 'impure', 'uuid', 'nlink', 'upper']);
// Markers that change what an entry means in ways this reader does not handle.
const REFUSED_MARKERS = new Set(['metacopy', 'redirect']);

const markers = (dir: number, name: Buffer): Map<string, Buffer> => {
  const found = new Map<string, Buffer>();
  for (const [key, value] of xattrsAt(dir, name)) {
    if (!key.startsWith(OVERLAY_PREFIX) || key.startsWith(ESCAPED_PREFIX)) continue;
    const marker = key.slice(OVERLAY_PREFIX.length);
    if (IGNORED_MARKERS.has(marker)) continue;
    if (REFUSED_MARKERS.has(marker)) {
      throw new SnapshotError(`the upper layer uses the overlay feature ${marker}`);
    }
    found.set(marker, value);
  }
  return found;
};

const CHUNK = 1024 * 1024;

// Files up to this size keep the bytes that were hashed, within KEPT_TOTAL_BYTES for a reading:
// the summary shows the lines of exactly the bytes the application checks, never those of a
// second reading, which a sandbox still running could change in between.
export const KEPT_FILE_BYTES = 1024 * 1024;
const KEPT_TOTAL_BYTES = 32 * 1024 * 1024;

interface Read {
  hash: string;
  content?: Buffer;
}

// The hash of the file's `size` bytes, with the bytes themselves when `keep`. Null when the file
// holds fewer or more: it changed while it was read. Reading stops at `size`, so a file that grows
// while it is read, as a sparse one can, costs no more than the size first seen.
const readExactly = (fd: number, size: number, keep: boolean): Read | null => {
  const hash = createHash('sha256');
  const content = keep ? Buffer.alloc(size) : null;
  const chunk = content === null ? Buffer.alloc(Math.min(CHUNK, Math.max(size, 1))) : null;
  let done = 0;
  while (done < size) {
    const target = content ?? (chunk as Buffer);
    const offset = content === null ? 0 : done;
    const read = readSync(
      fd,
      target,
      offset,
      Math.min(CHUNK, size - done, target.length - offset),
      null,
    );
    if (read === 0) return null;
    hash.update(target.subarray(offset, offset + read));
    done += read;
  }
  if (readSync(fd, Buffer.alloc(1), 0, 1, null) > 0) return null;
  return content === null ? { hash: hash.digest('hex') } : { hash: hash.digest('hex'), content };
};

// What the files of a reading may hold in all, each name of a file counted: what the sandbox's
// storage holds. Past it, the sandbox made one file many names, which the application would write
// as many copies into the project, or it rewrote files while they were read; the reading stops.
const storageBytes = (path: string): number => {
  const info = statfsSync(path);
  const size = info.blocks * info.bsize;
  return size > 0 ? size : totalmem();
};

export const hashFile = (fd: number): string => {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(CHUNK);
  for (;;) {
    const read = readSync(fd, buffer, 0, CHUNK, null);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
  }
  return hash.digest('hex');
};

// Directories deeper than this are refused unread: every change's path is opened and checked from
// the project's root, so the work of classifying, checking links and applying grows with depth
// for each entry. Source trees, dependencies included, stay far below it.
export const MAX_DEPTH = 64;

const UNREADABLE: UpperNode = {
  kind: 'other',
  what: 'an entry the sandbox left without read permission',
};

// Codes of an entry removed, or replaced by one of another type, between two steps of reading it:
// a link where a file or a directory was is refused by the descriptor-based open.
const GONE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

export const readUpper = (
  upperPath: string,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
  // Read while the worker runs: nothing in the layer is changed, and entries removed while it is
  // read are left out.
  live = false,
): UpperNode => {
  // The upper layer belongs to this process, and nothing else writes it once the worker stopped,
  // so an entry the sandbox left without read permission is given it back to be read. While the
  // worker runs, the entry is reported unreadable instead.
  const readable = (dir: number, name: Buffer, mode: number, needed: number): boolean => {
    if ((mode & needed) === needed) return true;
    if (live) return false;
    const fd = openPathBeneath(dir, name);
    try {
      chmodFd(fd, (mode & 0o7777) | needed);
    } finally {
      closeSync(fd);
    }
    return true;
  };
  let entries = 0;
  // The work of a reading, and what an application writes, are bounded by what the sandbox's
  // storage holds: a sparse file, whose size the storage does not hold, is refused unread, the
  // names of one inode, hard links, are read once, and the files' sizes, counted for each name,
  // stay within the size of the storage.
  const reads = new Map<string, Read | null>();
  const sizeLimit = storageBytes(upperPath);
  let named = 0;
  let kept = 0;
  const readDir = (fd: number, mode: number, opaque: boolean, depth: number): UpperNode => {
    const children = new Map<string, UpperChild>();
    for (const name of readdirAt(fd)) {
      entries += 1;
      if (entries > limits.maxEntries) {
        throw new SnapshotError(`the sandbox changed more than ${limits.maxEntries} entries`);
      }
      let node: UpperNode;
      try {
        node = readEntry(fd, name, depth + 1);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (live && typeof code === 'string' && GONE.has(code)) continue;
        throw error;
      }
      children.set(childKey(name), { name, node });
    }
    return { kind: 'dir', mode, opaque, children };
  };
  const readEntry = (dir: number, name: Buffer, depth: number): UpperNode => {
    const stat = lstatAt(dir, name);
    const mode = Number(stat.mode) & 0o7777;
    if (stat.isCharacterDevice() && stat.rdev === 0n) return { kind: 'whiteout' };
    if (stat.isSymbolicLink()) return { kind: 'symlink', target: readlinkAt(dir, name) };
    if (stat.isDirectory()) {
      const found = markers(dir, name);
      const opaque = found.get('opaque');
      if (opaque !== undefined && !opaque.equals(Buffer.from('y'))) {
        throw new SnapshotError('a directory of the upper layer has an unknown opaque marker');
      }
      for (const marker of found.keys()) {
        if (marker !== 'opaque') {
          throw new SnapshotError(`a directory of the upper layer has the marker ${marker}`);
        }
      }
      if (depth > MAX_DEPTH) {
        return { kind: 'other', what: `a directory more than ${MAX_DEPTH} levels deep` };
      }
      if (!readable(dir, name, mode, 0o500)) return UNREADABLE;
      const fd = openDirectoryBeneath(dir, name);
      try {
        return readDir(fd, mode, opaque !== undefined, depth);
      } finally {
        closeSync(fd);
      }
    }
    if (stat.isFile()) {
      const found = markers(dir, name);
      if (found.has('whiteout')) return { kind: 'whiteout' };
      for (const marker of found.keys()) {
        throw new SnapshotError(`a file of the upper layer has the marker ${marker}`);
      }
      if (stat.size > BigInt(limits.maxFileBytes)) {
        return { kind: 'other', what: `a file larger than ${limits.maxFileBytes} bytes` };
      }
      if (!readable(dir, name, mode, 0o400)) return UNREADABLE;
      const fd = openBeneath(dir, name, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        // Checked again on what was opened, which a running sandbox could have replaced.
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile()) return { kind: 'other', what: 'an entry that changed type' };
        if (opened.size > BigInt(limits.maxFileBytes)) {
          return { kind: 'other', what: `a file larger than ${limits.maxFileBytes} bytes` };
        }
        if (opened.blocks * 512n < opened.size) return { kind: 'other', what: 'a sparse file' };
        const size = Number(opened.size);
        named += size;
        if (named > sizeLimit) {
          throw new SnapshotError(
            `the sandbox's files hold more than its storage, ${sizeLimit} bytes, counting each name of a file: it gave files many names, or rewrote them while they were read`,
          );
        }
        const inode = `${opened.dev}:${opened.ino}`;
        let read = reads.get(inode);
        if (read === undefined) {
          const keep = size <= KEPT_FILE_BYTES && kept + size <= KEPT_TOTAL_BYTES;
          read = readExactly(fd, size, keep);
          if (read?.content !== undefined) kept += size;
          reads.set(inode, read);
        }
        if (read === null) return { kind: 'other', what: 'a file that changed while it was read' };
        return {
          kind: 'file',
          mode,
          size,
          hash: read.hash,
          ...(read.content === undefined ? {} : { content: read.content }),
        };
      } finally {
        closeSync(fd);
      }
    }
    if (stat.isFIFO()) return { kind: 'other', what: 'a FIFO' };
    if (stat.isSocket()) return { kind: 'other', what: 'a socket' };
    return { kind: 'other', what: 'a device' };
  };
  const root = openDirectory(upperPath);
  try {
    return readDir(root, 0o755, false, 0);
  } finally {
    closeSync(root);
  }
};
