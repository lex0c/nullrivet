import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, readSync } from 'node:fs';
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
  | { kind: 'file'; mode: number; size: number; hash: string }
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
  const readDir = (fd: number, mode: number, opaque: boolean): UpperNode => {
    const children = new Map<string, UpperChild>();
    for (const name of readdirAt(fd)) {
      entries += 1;
      if (entries > limits.maxEntries) {
        throw new SnapshotError(`the sandbox changed more than ${limits.maxEntries} entries`);
      }
      let node: UpperNode;
      try {
        node = readEntry(fd, name);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (live && typeof code === 'string' && GONE.has(code)) continue;
        throw error;
      }
      children.set(childKey(name), { name, node });
    }
    return { kind: 'dir', mode, opaque, children };
  };
  const readEntry = (dir: number, name: Buffer): UpperNode => {
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
      if (!readable(dir, name, mode, 0o500)) return UNREADABLE;
      const fd = openDirectoryBeneath(dir, name);
      try {
        return readDir(fd, mode, opaque !== undefined);
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
        if (!fstatSync(fd).isFile()) return { kind: 'other', what: 'an entry that changed type' };
        return {
          kind: 'file',
          mode,
          size: Number(stat.size),
          hash: hashFile(fd),
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
    return readDir(root, 0o755, false);
  } finally {
    closeSync(root);
  }
};
