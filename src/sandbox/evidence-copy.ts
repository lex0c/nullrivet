import { createHash } from 'node:crypto';
import {
  close,
  closeSync,
  constants,
  fstatSync,
  fsync,
  read,
  type Stats,
  unlinkSync,
  write,
} from 'node:fs';
import { promisify } from 'node:util';
import { errorMessage } from '../errors.ts';
import { at, openInRoot } from './changeset/dirfd.ts';
import type { EvidenceStore } from './evidence-store.ts';
import { JOB_LOG_PART, OUTPUT_PART } from './protocol.ts';

// Copies of what a call or a job wrote, from the sandbox's /tmp into the evidence directory, read
// through the root of the sandbox's processes. The sandbox can put anything in its /tmp, so a part
// is taken only by a path of the output code's form, resolved as the sandbox sees it, through no
// link at all, without blocking on a FIFO, as a regular file no larger than a part; and only if it
// is still the same file, of the same size, once copied. A command can rewrite a part before it is
// copied: the copy is then not what the worker saved, which the record says rather than hides.

const readAsync = promisify(read);
const writeAsync = promisify(write);
const fsyncAsync = promisify(fsync);
const closeAsync = promisify(close);
const CHUNK_BYTES = 1024 * 1024;

export const COPIES_LIMIT_BYTES = 2 * 1024 ** 3;

const PART_PATHS = { calls: OUTPUT_PART, jobs: JOB_LOG_PART } as const;

// An output as the worker reported it: what came and what was saved, with their hashes.
export interface ReportedOutput {
  stream: 'stdout' | 'stderr' | 'log';
  receivedBytes: number;
  receivedSha256?: string;
  savedBytes: number;
  savedSha256?: string;
  parts: string[];
  stopReason?: string;
  interrupted?: string;
}

export interface CopyPlace {
  kind: keyof typeof PART_PATHS;
  // The root directory of the sandbox's processes, opened.
  rootFd: number;
}

export interface CopyContext {
  store: EvidenceStore;
  partBytes: number;
  // Bytes the session's copies may still take.
  budget: { left: number };
}

// Why a part was not copied: the copies' limit, which the record tells; the source, which the
// sandbox can alter or replace, told as not preserved; or the evidence directory itself, a write or
// a sync that failed there, which fails the evidence log.
type Cause = 'limit' | 'source' | 'evidence';

class Refused extends Error {
  constructor(
    message: string,
    readonly kind: Cause = 'source',
  ) {
    super(message);
  }
}

const same = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size;

// Copies one part into a new file of the evidence directory; gives its length and SHA-256.
const copyPart = async (
  place: CopyPlace,
  part: string,
  copyName: string,
  context: CopyContext,
  whole: ReturnType<typeof createHash>,
): Promise<{ bytes: number; sha256: string }> => {
  if (!PART_PATHS[place.kind].test(part)) throw new Refused(`${part} is not a part's path`);
  let source: number;
  try {
    source = openInRoot(place.rootFd, part, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new Refused(`${part} cannot be opened: ${errorMessage(error)}`);
  }
  let target: number | null = null;
  let reserved = 0;
  try {
    const before = fstatSync(source);
    if (!before.isFile()) throw new Refused(`${part} is not a regular file`);
    if (before.size > context.partBytes) throw new Refused(`${part} is larger than a part`);
    // Reserved before anything is awaited: copies under way at once must not share what is left.
    if (before.size > context.budget.left) {
      throw new Refused(`the copies reached their limit of ${COPIES_LIMIT_BYTES} bytes`, 'limit');
    }
    context.budget.left -= before.size;
    reserved = before.size;
    try {
      target = context.store.createFile(copyName);
    } catch (error) {
      throw new Refused(`the copy of ${part} cannot be made: ${errorMessage(error)}`, 'evidence');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let bytes = 0;
    // One byte more than a part may hold: a part that grew past it is refused, not cut.
    for (;;) {
      const room = Math.min(CHUNK_BYTES, context.partBytes + 1 - bytes);
      if (room <= 0) throw new Refused(`${part} grew larger than a part`);
      const { bytesRead: got } = await readAsync(source, buffer, 0, room, null);
      if (got === 0) break;
      const chunk = buffer.subarray(0, got);
      for (let offset = 0; offset < got; ) {
        let bytesWritten: number;
        try {
          ({ bytesWritten } = await writeAsync(target, chunk, offset, got - offset));
        } catch (error) {
          throw new Refused(
            `the copy of ${part} cannot be written: ${errorMessage(error)}`,
            'evidence',
          );
        }
        if (bytesWritten <= 0) {
          throw new Refused(`the copy of ${part} cannot be written: no bytes were`, 'evidence');
        }
        offset += bytesWritten;
      }
      hash.update(chunk);
      whole.update(chunk);
      bytes += got;
    }
    if (!same(before, fstatSync(source))) throw new Refused(`${part} changed while it was copied`);
    try {
      await fsyncAsync(target);
    } catch (error) {
      throw new Refused(`the copy of ${part} cannot be synced: ${errorMessage(error)}`, 'evidence');
    }
    // What the reservation held beyond what was copied goes back.
    context.budget.left += reserved - bytes;
    reserved = 0;
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    context.budget.left += reserved;
    if (target !== null) {
      closeSync(target);
      target = null;
      try {
        unlinkSync(at(context.store.companionFd, Buffer.from(copyName)));
      } catch {
        // Left as it is: the record does not name it, and the verification reads only what it names.
      }
    }
    throw error instanceof Refused ? error : new Refused(`${part}: ${errorMessage(error)}`);
  } finally {
    closeSync(source);
    if (target !== null) await closeAsync(target);
  }
};

// The record of an output in the evidence log: held whole in the result, copied from its parts and
// checked against what the worker saved, or not preserved, with why.
export const preserveOutput = async (
  output: ReportedOutput,
  owner: string,
  place: CopyPlace,
  context: CopyContext,
): Promise<{
  record: Record<string, unknown>;
  // A copy the sandbox's side kept from being made or made as saved, for the operator.
  problem: string | null;
  // The evidence directory's own failure, which fails the evidence log.
  fatal: string | null;
}> => {
  const base = {
    stream: output.stream,
    receivedBytes: output.receivedBytes,
    ...(output.receivedSha256 === undefined ? {} : { receivedSha256: output.receivedSha256 }),
    savedBytes: output.savedBytes,
    ...(output.savedSha256 === undefined ? {} : { savedSha256: output.savedSha256 }),
    ...(output.stopReason === undefined ? {} : { stopReason: output.stopReason }),
    ...(output.interrupted === undefined ? {} : { interrupted: output.interrupted }),
  };
  // Whether everything the capture received was saved. A process cut short, as by a timeout or the
  // end of the session, is told apart by `interrupted`: what came before it was saved all the same.
  const complete = output.receivedBytes === output.savedBytes && output.stopReason === undefined;
  if (output.parts.length === 0) {
    // A call's output the result holds whole; or, saving having stopped, nothing to copy.
    return output.stopReason === undefined && output.stream !== 'log'
      ? { record: { ...base, preservation: 'inline', complete: true }, problem: null, fatal: null }
      : {
          record: {
            ...base,
            preservation: 'omitted',
            omitted: output.stopReason ?? 'nothing was saved',
            complete: false,
            matchesSaved: null,
          },
          problem: null,
          fatal: null,
        };
  }
  const whole = createHash('sha256');
  const copies: { name: string; bytes: number; sha256: string }[] = [];
  try {
    for (const [index, part] of output.parts.entries()) {
      const name = `${owner}-${output.stream}.${index + 1}.txt`;
      copies.push({ name, ...(await copyPart(place, part, name, context, whole)) });
    }
    try {
      context.store.syncCompanion();
    } catch (error) {
      throw new Refused(
        `the evidence directory cannot be synced: ${errorMessage(error)}`,
        'evidence',
      );
    }
  } catch (error) {
    const why = errorMessage(error);
    const cause: Cause = error instanceof Refused ? error.kind : 'evidence';
    return {
      record: { ...base, preservation: 'omitted', omitted: why, complete, matchesSaved: null },
      problem: cause === 'source' ? `an output could not be copied: ${why}` : null,
      fatal: cause === 'evidence' ? why : null,
    };
  }
  const copiedBytes = copies.reduce((sum, copy) => sum + copy.bytes, 0);
  const copiedSha256 = whole.digest('hex');
  const matchesSaved =
    output.savedSha256 === undefined
      ? null
      : copiedBytes === output.savedBytes && copiedSha256 === output.savedSha256;
  return {
    record: {
      ...base,
      preservation: 'parts',
      complete,
      copies,
      copiedBytes,
      copiedSha256,
      matchesSaved,
    },
    problem:
      matchesSaved === false
        ? `a copy of ${owner}'s ${output.stream} is not what the worker saved: a command may have rewritten it before it was copied`
        : null,
    fatal: null,
  };
};
