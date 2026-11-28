// The initramfs a guest boots from: a cpio archive in the "newc" format, which the kernel unpacks
// into the guest's first root filesystem. Every entry belongs to root and carries no time, so that
// the same contents always give the same archive, whose hash the evidence records.

export type CpioEntry =
  | { kind: 'directory'; path: string; mode: number }
  | { kind: 'file'; path: string; mode: number; data: Uint8Array }
  | { kind: 'link'; path: string; target: string }
  | { kind: 'char'; path: string; mode: number; major: number; minor: number };

const S_IFCHR = 0o020000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const MAGIC = '070701';
const HEADER_BYTES = 110;
const TRAILER = 'TRAILER!!!';
// A device number the kernel's unpacker takes: 12 bits of major, 20 of minor.
const MAX_MAJOR = 0xfff;
const MAX_MINOR = 0xfffff;

// The root itself, as a directory entry: the kernel unpacks into a root that exists, and gives it
// the entry's mode, which is otherwise the world-writable one of its tmpfs.
const ROOT = '.';

// A path the archive may hold: relative, with no empty, `.` or `..` component, and no NUL.
const validPath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\0') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

const parentOf = (path: string): string | null => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? null : path.slice(0, slash);
};

const padding = (length: number): Buffer => Buffer.alloc((4 - (length % 4)) % 4);

// Each field is eight hex digits: a member whose data or name is larger cannot be written.
const MAX_FIELD = 0xffffffff;

// One member: its header, its name, NUL-terminated, and its data, each padded to four bytes.
const member = (
  ino: number,
  mode: number,
  data: Uint8Array,
  rdev: readonly [number, number],
  path: string,
): Buffer => {
  const name = Buffer.from(`${path}\0`, 'utf8');
  if (data.length > MAX_FIELD || name.length > MAX_FIELD) {
    throw new Error(`the initramfs cannot hold ${path}: it is too large`);
  }
  // ino, mode, uid, gid, nlink, mtime, filesize, devmajor, devminor, rdevmajor, rdevminor,
  // namesize, check.
  const fields = [ino, mode, 0, 0, 1, 0, data.length, 0, 0, rdev[0], rdev[1], name.length, 0];
  const head = Buffer.from(
    MAGIC + fields.map((value) => value.toString(16).padStart(8, '0')).join(''),
    'ascii',
  );
  return Buffer.concat([
    head,
    name,
    padding(HEADER_BYTES + name.length),
    data,
    padding(data.length),
  ]);
};

// The archive of `entries`, in the order given: the kernel's unpacker makes no parent directory, so
// each entry's parent must come before it.
export const cpioArchive = (entries: readonly CpioEntry[]): Buffer => {
  const seen = new Map<string, CpioEntry['kind']>();
  const members: Buffer[] = [];
  entries.forEach((entry, index) => {
    const { path } = entry;
    const root = path === ROOT && entry.kind === 'directory' && index === 0;
    if (!root && !validPath(path)) {
      throw new Error(`the initramfs cannot hold the path ${JSON.stringify(path)}`);
    }
    if (seen.has(path)) throw new Error(`the initramfs holds ${path} twice`);
    const parent = parentOf(path);
    if (parent !== null && seen.get(parent) !== 'directory') {
      throw new Error(`the initramfs holds ${path} before its directory ${parent}`);
    }
    const ino = index + 1;
    switch (entry.kind) {
      case 'directory':
        members.push(
          member(ino, S_IFDIR | permissions(entry.mode, path), new Uint8Array(), [0, 0], path),
        );
        break;
      case 'file':
        members.push(
          member(ino, S_IFREG | permissions(entry.mode, path), entry.data, [0, 0], path),
        );
        break;
      case 'link':
        if (entry.target.length === 0 || entry.target.includes('\0')) {
          throw new Error(`the initramfs cannot hold a link to ${JSON.stringify(entry.target)}`);
        }
        members.push(member(ino, S_IFLNK | 0o777, Buffer.from(entry.target, 'utf8'), [0, 0], path));
        break;
      case 'char':
        if (!deviceNumber(entry.major, MAX_MAJOR) || !deviceNumber(entry.minor, MAX_MINOR)) {
          throw new Error(`the initramfs cannot hold the device ${entry.major}:${entry.minor}`);
        }
        members.push(
          member(
            ino,
            S_IFCHR | permissions(entry.mode, path),
            new Uint8Array(),
            [entry.major, entry.minor],
            path,
          ),
        );
        break;
    }
    seen.set(path, entry.kind);
  });
  members.push(member(0, 0, new Uint8Array(), [0, 0], TRAILER));
  return Buffer.concat(members);
};

// The permission bits of an entry. No setuid, setgid or sticky bit: nothing in the initramfs needs
// one.
const permissions = (mode: number, path: string): number => {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error(`the initramfs cannot give ${path} the mode ${mode.toString(8)}`);
  }
  return mode;
};

const deviceNumber = (value: number, max: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= max;
