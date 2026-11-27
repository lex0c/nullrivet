import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, sep } from 'node:path';
import { errorMessage } from '../errors.ts';
import { isWithinDirectory } from '../tools/paths.ts';
import { at } from './changeset/dirfd.ts';
import { EvidenceLog } from './evidence.ts';
import { ENGAGEMENT_COPY } from './evidence-verify.ts';

// Where a session's evidence goes: the operator's directory, opened one component at a time
// without following a link, so that what is checked is what is written to; a log in it, and a
// directory of the same name beside it for the engagement file and the copies of outputs. Each
// file and the directory entry that names it are synced before the session goes on, so that what
// the log says was written survives a loss of power.

export interface EvidenceStore {
  log: EvidenceLog;
  // The log's path, for the operator.
  path: string;
  // Opens a new file of the companion directory for writing, by a name of the host's own, and
  // gives its descriptor; syncCompanion syncs the directory once it is written.
  createFile(name: string): number;
  syncCompanion(): void;
  companionFd: number;
  close(): void;
}

export interface EvidenceStoreOptions {
  dir: string;
  // Directories the sandbox sees: the evidence must not be inside one.
  forbidden: readonly string[];
  engagementBytes: Buffer;
  onFailure: (reason: string) => void;
  now?: () => Date;
  // For tests: a smaller limit for the log, which fails as a full disk would.
  maxBytes?: number;
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

// Opens an existing directory by its real path, one component at a time, none of them a link.
const openReal = (path: string): number => {
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const name of path.split(sep).filter((part) => part !== '')) {
      const next = openSync(at(fd, Buffer.from(name)), DIRECTORY);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
};

const writeAll = (fd: number, bytes: Uint8Array): void => {
  for (let offset = 0; offset < bytes.length; ) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('no bytes were written');
    offset += written;
  }
};

// The time of the start as the name of the session's files: 20261120T120000Z.
const stamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

export const openEvidenceStore = (
  options: EvidenceStoreOptions,
): EvidenceStore | { error: string } => {
  const opened: number[] = [];
  const closeAll = (): void => {
    for (const fd of opened.splice(0).reverse()) closeSync(fd);
  };
  // Gives why the store cannot be opened, with what was opened of it closed.
  const fail = (why: string): { error: string } => {
    closeAll();
    return { error: `the evidence directory ${options.dir}: ${why}` };
  };
  try {
    let parent: string;
    try {
      parent = realpathSync(dirname(options.dir));
    } catch (error) {
      return fail(`its parent cannot be found: ${errorMessage(error)}`);
    }
    const parentFd = openReal(parent);
    opened.push(parentFd);
    const name = Buffer.from(basename(options.dir));
    try {
      mkdirSync(at(parentFd, name), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const dirFd = openSync(at(parentFd, name), DIRECTORY);
    opened.push(dirFd);
    const info = fstatSync(dirFd);
    if (info.uid !== process.getuid?.()) return fail('it belongs to another user');
    if ((info.mode & 0o022) !== 0) {
      return fail('others than its owner can write to it');
    }
    // The real path of what was opened, not of what the name leads to now.
    const real = readlinkSync(`/proc/self/fd/${dirFd}`);
    for (const root of options.forbidden) {
      let seen: string;
      try {
        seen = realpathSync(root);
      } catch {
        continue;
      }
      if (isWithinDirectory(seen, real)) {
        return fail(`it is inside ${seen}, which the sandbox sees`);
      }
    }
    const base = stamp((options.now ?? (() => new Date()))());
    let session = '';
    for (let attempt = 1; session === ''; attempt += 1) {
      const candidate =
        attempt === 1 ? `${base}-${process.pid}` : `${base}-${process.pid}-${attempt}`;
      try {
        mkdirSync(at(dirFd, Buffer.from(candidate)), { mode: 0o700 });
        session = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) throw error;
      }
    }
    const companionFd = openSync(at(dirFd, Buffer.from(session)), DIRECTORY);
    opened.push(companionFd);
    const createFile = (file: string): number =>
      openSync(at(companionFd, Buffer.from(file)), NEW_FILE, 0o600);
    // The engagement file as read, then its directory entry; then the log and its entry.
    const engagement = createFile(ENGAGEMENT_COPY);
    try {
      writeAll(engagement, options.engagementBytes);
      fsyncSync(engagement);
    } finally {
      closeSync(engagement);
    }
    fsyncSync(companionFd);
    const logFd = openSync(
      at(dirFd, Buffer.from(`${session}.jsonl`)),
      NEW_FILE | constants.O_APPEND,
      0o600,
    );
    opened.push(logFd);
    fsyncSync(dirFd);
    const log = new EvidenceLog({
      fd: logFd,
      onFailure: options.onFailure,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
    return {
      log,
      path: `${real}/${session}.jsonl`,
      createFile,
      syncCompanion: () => fsyncSync(companionFd),
      companionFd,
      close: () => {
        log.close();
        closeAll();
      },
    };
  } catch (error) {
    return fail(errorMessage(error));
  }
};
