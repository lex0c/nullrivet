import { dlopen, FFIType, type Pointer, ptr, read } from 'bun:ffi';
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';

// File operations relative to a directory descriptor, for the ChangeSet, which writes into a project
// from a layer the sandbox wrote. Paths are never resolved from the root of the filesystem:
// - every operation that would follow the last component of a path (open, read, write, chmod,
//   stat) is done on a descriptor opened with openat2, beneath the directory and through no
//   symbolic link, the last component included;
// - only operations that never follow the last component (unlink, rmdir, mkdir, symlink, lstat,
//   readlink, listing a directory's xattrs with the l* calls) go through
//   /proc/self/fd/<dir>/<name>, where the directory is the descriptor and the name one component.
// Names are Buffers throughout: a name is any byte string, and decoding it would be lossy.

const SYS_OPENAT2 = 437;
const RESOLVE_NO_XDEV = 0x01n;
const RESOLVE_NO_MAGICLINKS = 0x02n;
const RESOLVE_NO_SYMLINKS = 0x04n;
const RESOLVE_BENEATH = 0x08n;
const RESOLVE = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;
// The same values on x86_64 and arm64, unlike O_DIRECTORY and O_NOFOLLOW, which come from Node.
const O_CLOEXEC = 0o2000000;
const O_PATH = 0o10000000;
export const RENAME_NOREPLACE = 1;
export const RENAME_EXCHANGE = 2;

let libc: ReturnType<typeof load> | null = null;
let errnoAddress: Pointer | null = null;
const load = () =>
  dlopen('libc.so.6', {
    syscall: {
      args: [FFIType.i64, FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    renameat2: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
      returns: FFIType.i32,
    },
    llistxattr: { args: [FFIType.cstring, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    lgetxattr: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    lsetxattr: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.i32],
      returns: FFIType.i32,
    },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
const lib = () => {
  if (libc === null) {
    libc = load();
    errnoAddress = libc.symbols.__errno_location() as Pointer;
  }
  return libc.symbols;
};

const ERRNO_NAMES = new Map(
  Object.entries(osConstants.errno).map(([name, value]) => [value, name] as const),
);

// An error of a system call, with the code Node gives its own (`ELOOP`, `EXDEV`...).
export class SysError extends Error {
  constructor(
    readonly code: string,
    readonly operation: string,
  ) {
    super(`${operation}: ${code}`);
    this.name = 'SysError';
  }
}

// errno is read from the address found when the library was loaded, with no other call between the
// failed one and the read: a caller decides from the code whether an entry is absent.
const fail = (operation: string): never => {
  if (errnoAddress === null) throw new Error('errno is read before the library is loaded');
  const errno = read.i32(errnoAddress, 0);
  throw new SysError(ERRNO_NAMES.get(errno) ?? `errno ${errno}`, operation);
};

const cString = (name: Buffer): Buffer => {
  if (name.includes(0)) throw new SysError('EINVAL', 'a name holds a NUL byte');
  return Buffer.concat([name, Buffer.from([0])]);
};

// The path of `name` in the directory of `dir`, for the operations that never follow the last
// component. `name` must be one component.
export const at = (dir: number, name?: Buffer): Buffer => {
  const base = Buffer.from(`/proc/self/fd/${dir}`);
  if (name === undefined) return base;
  if (
    name.length === 0 ||
    name.includes(0x2f) ||
    name.equals(Buffer.from('.')) ||
    name.equals(Buffer.from('..'))
  ) {
    throw new SysError('EINVAL', 'a name must be one path component');
  }
  return Buffer.concat([base, Buffer.from('/'), name]);
};

// Opens the entry at `names` beneath `dir` one component at a time, so a path longer than the
// system's limit for a path name can be reached; each step is an openBeneath. An empty path opens
// `dir` itself again.
export const openPath = (dir: number, names: readonly Buffer[], flags: number): number => {
  if (names.length === 0) return openBeneath(dir, Buffer.from('.'), flags);
  let current = dir;
  try {
    for (const [index, name] of names.entries()) {
      at(current, name);
      const last = index === names.length - 1;
      const next = openBeneath(
        current,
        name,
        last ? flags : constants.O_RDONLY | constants.O_DIRECTORY,
      );
      if (current !== dir) closeSync(current);
      current = next;
    }
    return current;
  } catch (error) {
    if (current !== dir) closeSync(current);
    throw error;
  }
};

export const openDirectoryPath = (dir: number, names: readonly Buffer[]): number =>
  openPath(dir, names, constants.O_RDONLY | constants.O_DIRECTORY);

// Opens a directory as the root of later resolution. The path is the operator's own choice.
export const openDirectory = (path: string): number =>
  openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);

// Opens `name` (one component or several, separated by "/") beneath `dir`, through no symbolic
// link and no other mount, and never a symbolic link as the last component.
export const openBeneath = (dir: number, name: Buffer, flags: number, mode = 0): number => {
  const how = new BigUint64Array([BigInt(flags | O_CLOEXEC), BigInt(mode), RESOLVE]);
  const fd = Number(lib().syscall(SYS_OPENAT2, dir, cString(name), ptr(how), 24n));
  if (fd < 0) fail('openat2');
  return fd;
};

// A descriptor that only identifies the entry: it can be opened whatever the entry's mode, and is
// enough for fstat and for chmodFd.
export const openPathBeneath = (dir: number, name: Buffer): number =>
  openBeneath(dir, name, O_PATH);

// Changes the mode of the entry a descriptor holds, an O_PATH one included. /proc/self/fd/N leads
// to the inode the descriptor holds, not to whatever now has its name.
export const chmodFd = (fd: number, mode: number): void => chmodSync(`/proc/self/fd/${fd}`, mode);

export const openDirectoryBeneath = (dir: number, name: Buffer): number =>
  openBeneath(dir, name, constants.O_RDONLY | constants.O_DIRECTORY);

export const renameBeneath = (
  fromDir: number,
  fromName: Buffer,
  toDir: number,
  toName: Buffer,
  flags: number,
): void => {
  at(fromDir, fromName);
  at(toDir, toName);
  if (lib().renameat2(fromDir, cString(fromName), toDir, cString(toName), flags) < 0) {
    fail('renameat2');
  }
};

export const lstatAt = (dir: number, name: Buffer) => lstatSync(at(dir, name), { bigint: true });

// Null when nothing is there.
export const lstatAtOrNull = (dir: number, name: Buffer) => {
  try {
    return lstatAt(dir, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

export const readdirAt = (dir: number): Buffer[] =>
  readdirSync(at(dir), { encoding: 'buffer' }).sort(Buffer.compare);

export const readlinkAt = (dir: number, name: Buffer): Buffer =>
  readlinkSync(at(dir, name), { encoding: 'buffer' });

export const unlinkAt = (dir: number, name: Buffer): void => unlinkSync(at(dir, name));
export const rmdirAt = (dir: number, name: Buffer): void => rmdirSync(at(dir, name));
export const mkdirAt = (dir: number, name: Buffer, mode: number): void =>
  mkdirSync(at(dir, name), { mode });
export const symlinkAt = (target: Buffer, dir: number, name: Buffer): void =>
  symlinkSync(target, at(dir, name));

// The extended attributes of `name` in `dir`, without following it.
export const xattrsAt = (dir: number, name: Buffer): Map<string, Buffer> => {
  const path = cString(at(dir, name));
  const size = Number(lib().llistxattr(path, null, 0n));
  if (size < 0) fail('llistxattr');
  const result = new Map<string, Buffer>();
  if (size === 0) return result;
  const names = Buffer.alloc(size);
  const listed = Number(lib().llistxattr(path, ptr(names), BigInt(size)));
  if (listed < 0) fail('llistxattr');
  for (const key of names.subarray(0, listed).toString('latin1').split('\0')) {
    if (key.length === 0) continue;
    const keyC = Buffer.from(`${key}\0`, 'latin1');
    const length = Number(lib().lgetxattr(path, keyC, null, 0n));
    if (length < 0) fail('lgetxattr');
    const value = Buffer.alloc(length);
    if (length > 0 && Number(lib().lgetxattr(path, keyC, ptr(value), BigInt(length))) < 0) {
      fail('lgetxattr');
    }
    result.set(key, value);
  }
  return result;
};

// Sets an extended attribute of `path`, without following it.
export const setXattr = (path: string, key: string, value: Buffer): void => {
  const data = value.length === 0 ? Buffer.alloc(1) : value;
  if (
    lib().lsetxattr(
      cString(Buffer.from(path)),
      cString(Buffer.from(key, 'latin1')),
      ptr(data),
      BigInt(value.length),
      0,
    ) < 0
  ) {
    fail('lsetxattr');
  }
};

const LOCK_EX = 2;
const LOCK_NB = 4;

// Takes the exclusive lock of an open file without waiting. False when another open file holds it,
// in this process or any other; the lock ends when the file is closed, or its process ends.
export const tryLock = (fd: number): boolean => {
  if (lib().flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
  try {
    return fail('flock');
  } catch (error) {
    if (error instanceof SysError && (error.code === 'EWOULDBLOCK' || error.code === 'EAGAIN')) {
      return false;
    }
    throw error;
  }
};

export const close = (fd: number): void => closeSync(fd);
