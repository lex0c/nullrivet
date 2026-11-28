import { lstatSync, readdirSync, readlinkSync, type Stats } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { errorMessage } from '../../errors.ts';
import { ETC_FILES, HOSTS_DIRECTORY, NSSWITCH, ROOT_LINKS } from '../bwrap.ts';
import type { CpioEntry } from './cpio.ts';
import { readBounded } from './files.ts';

// What the guest sees, as the sandbox shows it to QEMU. Each directory the profile binds becomes a
// 9p export, mounted at the same path in the guest. The files the profile binds one by one, which
// 9p cannot export, are copied into the initramfs. Nothing of the host's /etc is exported but the
// directory of the hosts file, and neither /, /dev, /proc nor /sys: the sandbox binds /dev/kvm for
// QEMU, which an export of /dev would hand the guest.
//
// An export reaches what the sandbox has mounted under it, as the profile's worker does: a project
// inside the home directory is seen through both, and a read-only bind inside a writable export
// stays read-only, since the host's mount refuses the write.

export interface GuestExport {
  tag: string;
  // Where QEMU finds it in the sandbox, and where the guest mounts it.
  path: string;
  readOnly: boolean;
}

export interface GuestView {
  project: string;
  home: string;
  readOnlyDirs: readonly string[];
  workerDir: string;
  identity: { passwd: string; group: string };
}

export type HostEntry =
  | { path: string; kind: 'directory' }
  | { path: string; kind: 'link'; target: string }
  | { path: string; kind: 'file'; data: Buffer };

// What the guest's root takes of the host: the root links, or directories on a host whose /usr is
// not merged, and the files of /etc the profile binds.
export interface HostEntries {
  root: HostEntry[];
  etc: HostEntry[];
}

export interface GuestManifest {
  // In the order the guest mounts them: each after any it is inside.
  exports: GuestExport[];
  // The initramfs, but for the init and the modules.
  entries: CpioEntry[];
}

const MAX_ETC_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
// The kernel's filesystems, the host's /etc, and what the initramfs keeps for itself: its init and
// the kernel's modules.
const NEVER_EXPORTED = ['/dev', '/proc', '/sys', '/etc', '/init', '/modules'];

// An absolute, normalized path that neither is nor is under what the guest must not reach.
const exportable = (path: string): boolean =>
  isAbsolute(path) &&
  normalize(path) === path &&
  path !== '/' &&
  !path.endsWith('/') &&
  !path.includes('\n') &&
  (path === HOSTS_DIRECTORY ||
    !NEVER_EXPORTED.some((root) => path === root || path.startsWith(`${root}/`)));

const depth = (path: string): number => path.split('/').length;

// Every directory from the root down to `path`, as the initramfs names them.
const ancestry = (path: string): string[] => {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
};

export const guestManifest = (
  view: GuestView,
  host: HostEntries,
): GuestManifest | { error: string } => {
  const wanted: GuestExport[] = [
    { tag: 'usr', path: '/usr', readOnly: true },
    ...host.root
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => ({
        tag: `root${entry.path.replaceAll('/', '')}`,
        path: entry.path,
        readOnly: true,
      })),
    { tag: 'worker', path: view.workerDir, readOnly: true },
    { tag: 'hosts', path: HOSTS_DIRECTORY, readOnly: true },
    { tag: 'tmp', path: '/tmp', readOnly: false },
    { tag: 'home', path: view.home, readOnly: false },
    { tag: 'project', path: view.project, readOnly: false },
    ...view.readOnlyDirs.map((path, index) => ({ tag: `ro${index}`, path, readOnly: true })),
  ];
  for (const entry of wanted) {
    if (!exportable(entry.path)) return { error: `the guest cannot be given ${entry.path}` };
  }
  const paths = new Set<string>();
  for (const entry of wanted) {
    if (paths.has(entry.path)) return { error: `the guest is given ${entry.path} twice` };
    paths.add(entry.path);
  }
  const exports = [...wanted].sort((a, b) => depth(a.path) - depth(b.path));

  const directories = new Set<string>(['dev', 'proc', 'sys', 'etc']);
  for (const entry of exports)
    for (const directory of ancestry(entry.path)) directories.add(directory);
  for (const entry of host.etc) {
    if (entry.kind === 'directory') directories.add(entry.path.slice(1));
  }
  const links = new Map<string, string>();
  for (const entry of host.root) {
    if (entry.kind === 'link') links.set(entry.path.slice(1), entry.target);
  }
  for (const entry of exports) {
    if (links.has(entry.path.split('/')[1] as string)) {
      return { error: `the guest cannot be given ${entry.path}: it is under a link of the root` };
    }
  }
  // Every directory belongs to root and is not writable by others, the root first: what the guest
  // may write is in the exports.
  const entries: CpioEntry[] = [
    { kind: 'directory', path: '.', mode: 0o755 },
    ...[...directories]
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
      .map((path): CpioEntry => ({ kind: 'directory', path, mode: 0o755 })),
    { kind: 'char', path: 'dev/console', mode: 0o600, major: 5, minor: 1 },
    ...[...links].map(([path, target]): CpioEntry => ({ kind: 'link', path, target })),
    { kind: 'file', path: 'etc/passwd', mode: 0o644, data: Buffer.from(view.identity.passwd) },
    { kind: 'file', path: 'etc/group', mode: 0o644, data: Buffer.from(view.identity.group) },
    { kind: 'file', path: 'etc/nsswitch.conf', mode: 0o644, data: Buffer.from(NSSWITCH) },
    { kind: 'link', path: 'etc/hosts', target: `${HOSTS_DIRECTORY}/hosts` },
    ...host.etc.flatMap((entry): CpioEntry[] => {
      const path = entry.path.slice(1);
      if (entry.kind === 'link') return [{ kind: 'link', path, target: entry.target }];
      if (entry.kind === 'file') return [{ kind: 'file', path, mode: 0o644, data: entry.data }];
      return [];
    }),
  ];
  return { exports, entries };
};

// One entry of the host, read at `at`, as the guest's root copies it to `path`: a link, a regular
// file, or a directory; null when absent or of another kind. Any other failure to read it is
// thrown.
const hostEntry = (path: string, at: string): HostEntry | null => {
  let info: Stats;
  try {
    info = lstatSync(at);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) return { path, kind: 'link', target: readlinkSync(at) };
  if (info.isDirectory()) return { path, kind: 'directory' };
  if (info.isFile()) return { path, kind: 'file', data: readBounded(at, MAX_ETC_FILE_BYTES) };
  return null;
};

// What this host gives the guest's root: the root links and the files of /etc the profile binds,
// with the links a directory of them holds, such as Debian's /etc/alternatives. `root` is where
// the host's filesystem starts, for tests.
export const hostEntries = (root = ''): HostEntries | { error: string } => {
  const read = (path: string): HostEntry | null => {
    try {
      return hostEntry(path, `${root}${path}`);
    } catch (error) {
      throw new Error(`${path} cannot be read for the guest: ${errorMessage(error)}`);
    }
  };
  try {
    const links = ROOT_LINKS.map(read).filter((entry): entry is HostEntry => entry !== null);
    const etc: HostEntry[] = [];
    for (const path of [...ETC_FILES, '/etc/localtime']) {
      const entry = read(path);
      if (entry === null) continue;
      etc.push(entry);
      if (entry.kind !== 'directory') continue;
      let names: string[];
      try {
        names = readdirSync(`${root}${path}`);
      } catch (error) {
        throw new Error(`${path} cannot be listed for the guest: ${errorMessage(error)}`);
      }
      if (names.length > MAX_DIRECTORY_ENTRIES) {
        throw new Error(`${path} holds more than ${MAX_DIRECTORY_ENTRIES} entries for the guest`);
      }
      for (const name of names) {
        const inner = read(`${path}/${name}`);
        if (inner?.kind === 'link') etc.push(inner);
      }
    }
    return { root: links, etc };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};
