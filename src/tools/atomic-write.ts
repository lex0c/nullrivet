import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// A plain write(2) leaves a truncated file if the process dies or the disk fills mid-write. Writing
// to a temporary file in the target's directory, fsyncing it and renaming it over the target keeps
// the target either fully old or fully new, because rename(2) is atomic within one filesystem.
//
// Trade-offs of temp + rename: the write needs permission to create files in the target's
// directory, and the target gets a new inode, so hard links keep the old content and inode-based
// watchers see a rename. Ownership is not restored; the file belongs to the user running the agent.

// NAME_MAX is 255 bytes on common filesystems and about 143 on some (eCryptfs). The fixed part of
// the temp name (two dots, a UUID and `.tmp`) is about 42 bytes, so 80 bytes of the original name
// keep the temp name under either limit while leaving an orphaned temp file recognizable.
const TEMP_BASENAME_BYTE_CAP = 80;

// Same limit as the Linux kernel's MAXSYMLINKS; it also stops a symlink cycle.
const MAX_SYMLINK_DEPTH = 40;

// Truncates to at most `maxBytes` of UTF-8 without splitting a multi-byte character. The budget is
// in bytes, not UTF-16 units, because NAME_MAX is a byte limit.
export const truncateUtf8 = (s: string, maxBytes: number): string => {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buf.toString('utf8', 0, end);
};

// A single write(2) may return a short count without throwing (quota pressure, network
// filesystems), so the loop continues until every byte is written. A call that writes nothing
// would loop forever and is reported as an error instead.
export const writeAll = (write: (offset: number) => number, total: number, label: string): void => {
  for (let off = 0; off < total; ) {
    const n = write(off);
    if (n <= 0) {
      throw new Error(`short write: only ${off} of ${total} bytes written to ${label}`);
    }
    off += n;
  }
};

// realpath fails as soon as one link in the chain points to a missing path, and resolving only the
// first link would replace an intermediate link with a regular file. Following every link up to
// the first path that is not a symlink writes the missing leaf and keeps the whole chain intact.
const resolveDanglingTarget = (start: string): string => {
  let current = start;
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return current;
    }
    if (!isLink) return current;
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw new Error(`symlink chain too deep or cyclic at ${start}`);
};

// A symlink is written through: the bytes go to the link's target and the link itself is kept.
// lstat is required to detect a dangling link, which existsSync reports as missing; renaming over
// the link path would replace the link with a regular file.
const resolveWriteTarget = (absPath: string): string => {
  let isLink: boolean;
  try {
    isLink = lstatSync(absPath).isSymbolicLink();
  } catch {
    return absPath;
  }
  if (!isLink) return absPath;
  try {
    return realpathSync(absPath);
  } catch {
    return resolveDanglingTarget(absPath);
  }
};

const fsyncDirectory = (dir: string): void => {
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Some platforms and filesystems cannot fsync a directory. The rename has already happened,
    // so the write succeeded; only the durability of the directory entry is not guaranteed.
  }
};

// Writes `content` as UTF-8 and returns the number of bytes written. Missing parent directories
// are created. An existing target keeps its permission bits, so an executable stays executable.
// `mode` sets the file's permissions from the moment it is created; without it, an existing
// target keeps its mode and a new file gets the default one.
export const atomicWrite = (
  absPath: string,
  content: string,
  options: { mode?: number } = {},
): number => {
  const target = resolveWriteTarget(absPath);
  const buf = Buffer.from(content, 'utf8');
  const dir = dirname(target);
  const tmp = join(
    dir,
    `.${truncateUtf8(basename(target), TEMP_BASENAME_BYTE_CAP)}.${randomUUID()}.tmp`,
  );
  mkdirSync(dir, { recursive: true });
  let fd: number | undefined;
  try {
    // `wx` fails if the path exists, so an unexpected file at the temp path is never overwritten.
    const openedFd = openSync(tmp, 'wx', options.mode ?? 0o666);
    fd = openedFd;
    writeAll((off) => writeSync(openedFd, buf, off), buf.length, tmp);
    if (options.mode !== undefined) {
      fchmodSync(openedFd, options.mode);
    } else {
      try {
        fchmodSync(openedFd, statSync(target).mode & 0o777);
      } catch {
        // The target does not exist yet; the new file keeps the default mode.
      }
    }
    fsyncSync(openedFd);
    closeSync(openedFd);
    fd = undefined;
    renameSync(tmp, target);
    // The rename is recorded in the directory, not in the file; without this fsync a power loss
    // right after a successful return could lose the new name.
    fsyncDirectory(dir);
    return buf.byteLength;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The original error is the one worth reporting.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may not have been created.
    }
    throw error;
  }
};
