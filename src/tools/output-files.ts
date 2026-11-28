import { createHash, type Hash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  formatBytes,
  utf8BoundaryAtOrBefore,
  utf8CompleteLength,
} from '../context/output-reduction.ts';
import { errorMessage } from '../errors.ts';
import { BINARY_SCAN_BYTES, binaryOffset, isNotFoundError, MAX_FILE_BYTES } from './file-io.ts';
import type { CapturedOutput } from './types.ts';

// Output reduced before it reaches the model is saved whole to files the model can read back
// with read_file and grep. Each file is at most MAX_FILE_BYTES, the size those tools accept, so a
// large output is split into numbered parts. The temporary directory is often a tmpfs, which is
// memory, so each output and the whole process have a limit. Files are never removed while the
// process runs, so a path given to the model stays valid until it exits.
const OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

// How many parts an output of `limitBytes` can take. A part ends before it is full only when the
// next piece does not fit in it, and that piece then goes into the next part, so any two parts in a
// row hold more than a whole part.
export const maxOutputParts = (limitBytes: number, partBytes: number): number =>
  2 * Math.ceil(limitBytes / partBytes) + 1;

export const MAX_OUTPUT_PARTS = maxOutputParts(OUTPUT_LIMIT_BYTES, MAX_FILE_BYTES);
const TOTAL_LIMIT_BYTES = 512 * 1024 * 1024;
// Only whole lines are written, so parts end at line boundaries; the incomplete last line waits in
// memory for its newline up to this size, and longer lines are written in pieces.
const LINE_BUFFER_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

// Fixed names, so nothing that comes from a provider or a command ends up in a path.
export type OutputLabel = 'bash-stdout' | 'bash-stderr' | 'git' | 'git-stderr' | 'delegate' | 'job';

export interface OutputFileSystem {
  mkdtempSync(prefix: string): string;
  openSync(path: string, flags: string, mode: number): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  closeSync(fd: number): void;
  unlinkSync(path: string): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

export interface OutputFilesOptions {
  // Directory the private directory of the process is created in; read when the first file is.
  root?: () => string;
  partBytes?: number;
  outputLimitBytes?: number;
  totalLimitBytes?: number;
  lineBufferBytes?: number;
  fs?: OutputFileSystem;
}

export interface SavedOutput {
  // Absolute paths, in order; their concatenation is exactly the saved bytes.
  parts: string[];
  savedBytes: number;
  receivedBytes: number;
  // Why saving stopped before every received byte was written; absent when all were.
  stopReason?: string;
  // Why the capture ended before the end of the output, such as a timeout.
  interrupted?: string;
  // A part has a NUL byte where read_file and grep look for one, so they refuse it as binary.
  binary?: boolean;
  // The SHA-256 of every byte received, and of the bytes saved, for the evidence log.
  receivedSha256?: string;
  savedSha256?: string;
}

export interface FinishOptions {
  // True saves the output even when it stayed under the threshold, since the caller reduced it;
  // false discards the files, because the output reached the model whole.
  keep: boolean;
  interrupted?: string;
}

export interface OutputSpool {
  // Creates the first file at once, so its path exists before any output, for a log read while
  // it grows. False when it could not be created; snapshot gives the reason. An exhausted limit
  // does not prevent it: the file stays empty and the first write records why.
  start(): boolean;
  // Never throws: a failure to save stops saving and is reported by finish.
  push(chunk: Buffer): void;
  // What has been saved so far, without finishing. An incomplete last line is still in memory
  // and not in the files yet.
  snapshot(): SavedOutput;
  // Only the first call has an effect; later calls return the same result. Null when nothing was
  // saved: keep was false or the output was empty.
  finish(options: FinishOptions): SavedOutput | null;
  // What came and what was saved, with their hashes, and the parts kept once finished.
  capture(stream: CapturedOutput['stream']): CapturedOutput;
}

export class OutputFiles {
  readonly fs: OutputFileSystem;
  readonly partBytes: number;
  readonly outputLimitBytes: number;
  readonly totalLimitBytes: number;
  readonly lineBufferBytes: number;
  private readonly root: () => string;
  private dir: string | null = null;
  private sequence = 0;
  // Whether spools hash what they receive and save, for an evidence log: off otherwise, since it
  // costs two passes over every byte.
  hashing = false;
  // Bytes written to files of this process and not removed since.
  private usedBytes = 0;

  constructor(options: OutputFilesOptions = {}) {
    this.fs = options.fs ?? nodeFs;
    this.root = options.root ?? tmpdir;
    this.partBytes = options.partBytes ?? MAX_FILE_BYTES;
    // Every part must take at least one byte, or splitting would open empty parts forever.
    if (this.partBytes < 1) throw new RangeError('partBytes must be at least 1');
    this.outputLimitBytes = options.outputLimitBytes ?? OUTPUT_LIMIT_BYTES;
    this.totalLimitBytes = options.totalLimitBytes ?? TOTAL_LIMIT_BYTES;
    this.lineBufferBytes = options.lineBufferBytes ?? LINE_BUFFER_BYTES;
  }

  // Bytes are kept in memory until they pass `thresholdBytes`, the size up to which the tool
  // returns its output whole, so a small output reaches the disk only when the caller keeps it.
  spool(label: OutputLabel, thresholdBytes: number): OutputSpool {
    return new Spool(this, label, thresholdBytes);
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  // The directory is created on first use with mkdtemp, which makes it private to the user (0700),
  // and again when something removed it during the run.
  createFile(name: string): { path: string; fd: number } {
    try {
      return this.openInDirectory(name);
    } catch (error) {
      if (this.dir === null || !isNotFoundError(error)) throw error;
      this.dir = null;
      return this.openInDirectory(name);
    }
  }

  private openInDirectory(name: string): { path: string; fd: number } {
    // Resolved because TMPDIR can be relative, and the tools the model passes the path to resolve
    // relative paths against the session directory, not the process directory.
    const path = join(this.directory(), name);
    return { path, fd: this.fs.openSync(path, 'wx', 0o600) };
  }

  // The directory, created now if it does not exist yet, for a sandbox that has to expose it
  // before the first file is written.
  directory(): string {
    this.dir ??= this.fs.mkdtempSync(join(resolve(this.root()), 'nullrivet-'));
    return this.dir;
  }

  hashOutputs(): void {
    this.hashing = true;
  }

  availableBytes(): number {
    return Math.max(0, this.totalLimitBytes - this.usedBytes);
  }

  // Positive when bytes are written, negative when a file is removed.
  record(bytes: number): void {
    this.usedBytes += bytes;
  }

  removeAll(): void {
    if (this.dir === null) return;
    const dir = this.dir;
    this.dir = null;
    this.usedBytes = 0;
    try {
      this.fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Runs while the process exits, when there is nowhere left to report a failure.
    }
  }
}

class Spool implements OutputSpool {
  private received = 0;
  private saved = 0;
  // Over every byte pushed, before any limit stops the saving, and over every byte written; only
  // when the store hashes, for an evidence log.
  private readonly receivedHash: Hash | null;
  private readonly savedHash: Hash | null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private opened = false;
  private line: Buffer[] = [];
  private lineBytes = 0;
  private readonly parts: string[] = [];
  private readonly partSizes: number[] = [];
  private fd: number | null = null;
  private partEndsWithNewline = true;
  private binary = false;
  private sequence = 0;
  private stopReason: string | undefined;
  private finished = false;
  private result: SavedOutput | null = null;

  constructor(
    private readonly store: OutputFiles,
    private readonly label: OutputLabel,
    private readonly thresholdBytes: number,
  ) {
    this.receivedHash = store.hashing ? createHash('sha256') : null;
    this.savedHash = store.hashing ? createHash('sha256') : null;
  }

  start(): boolean {
    if (this.finished || this.stopReason !== undefined) return false;
    if (this.opened) return true;
    this.opened = true;
    return this.openPart();
  }

  snapshot(): SavedOutput {
    return {
      parts: [...this.parts],
      savedBytes: this.saved,
      receivedBytes: this.received,
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
      ...(this.binary ? { binary: true } : {}),
      ...this.hashes(),
    };
  }

  capture(stream: CapturedOutput['stream']): CapturedOutput {
    const { receivedSha256 = '', savedSha256 = '' } = this.hashes();
    return {
      stream,
      receivedBytes: this.received,
      receivedSha256,
      savedBytes: this.saved,
      savedSha256,
      parts: this.result === null ? [] : [...this.result.parts],
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
      ...(this.result?.interrupted === undefined ? {} : { interrupted: this.result.interrupted }),
    };
  }

  private hashes(): { receivedSha256?: string; savedSha256?: string } {
    if (this.receivedHash === null || this.savedHash === null) return {};
    return {
      receivedSha256: this.receivedHash.copy().digest('hex'),
      savedSha256: this.savedHash.copy().digest('hex'),
    };
  }

  push(chunk: Buffer): void {
    if (this.finished || chunk.length === 0) return;
    this.received += chunk.length;
    this.receivedHash?.update(chunk);
    if (this.stopReason !== undefined) return;
    try {
      if (this.opened) {
        this.accept(chunk);
        return;
      }
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      if (this.pendingBytes <= this.thresholdBytes) return;
      this.opened = true;
      const buffered = Buffer.concat(this.pending);
      this.pending = [];
      this.pendingBytes = 0;
      this.accept(buffered);
    } catch (error) {
      this.stop(`saving failed: ${errorMessage(error)}`);
    }
  }

  finish(options: FinishOptions): SavedOutput | null {
    if (this.finished) return this.result;
    this.finished = true;
    if (options.keep && this.stopReason === undefined) {
      try {
        // The caller decides on the text it reduced, which can be longer than the bytes counted
        // here (invalid UTF-8 decodes to longer replacement characters), so the threshold may not
        // have been passed.
        if (!this.opened && this.pendingBytes > 0) {
          this.opened = true;
          this.accept(Buffer.concat(this.pending));
        }
        if (this.lineBytes > 0) this.flushLine(true);
      } catch (error) {
        this.stop(`saving failed: ${errorMessage(error)}`);
      }
    }
    this.pending = [];
    this.line = [];
    this.lineBytes = 0;
    this.closePart();
    if (!options.keep || (this.parts.length === 0 && this.stopReason === undefined)) {
      this.removeParts();
      return null;
    }
    this.result = {
      parts: [...this.parts],
      savedBytes: this.saved,
      receivedBytes: this.received,
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
      ...(options.interrupted === undefined ? {} : { interrupted: options.interrupted }),
      ...(this.binary ? { binary: true } : {}),
      ...this.hashes(),
    };
    return this.result;
  }

  private accept(data: Buffer): void {
    const lastNewline = data.lastIndexOf(NEWLINE);
    if (lastNewline !== -1) {
      const lines = data.subarray(0, lastNewline + 1);
      this.line.push(lines);
      this.lineBytes += lines.length;
      this.flushLine();
    }
    const rest = lastNewline === -1 ? data : data.subarray(lastNewline + 1);
    if (rest.length === 0) return;
    this.line.push(rest);
    this.lineBytes += rest.length;
    if (this.lineBytes > this.store.lineBufferBytes) this.flushLine();
  }

  // Before the end of the stream, a UTF-8 character split between chunks stays in memory until the
  // rest of it arrives, so every write ends between characters.
  private flushLine(atEnd = false): void {
    const data = this.line.length === 1 ? this.line[0] : Buffer.concat(this.line);
    this.line = [];
    this.lineBytes = 0;
    if (data === undefined) return;
    const complete = atEnd ? data.length : utf8CompleteLength(data);
    if (complete < data.length) {
      const partial = data.subarray(complete);
      this.line = [partial];
      this.lineBytes = partial.length;
    }
    this.write(data.subarray(0, complete));
  }

  // Splits the data over parts, cutting after the last newline that fits. A line that does not fit
  // starts a new part; only a line longer than a whole part, or one written in pieces, is cut at
  // the byte limit, and then before the start of a UTF-8 character. When no character starts in
  // the room left, the part ends where it is.
  private write(data: Buffer): void {
    let rest = data;
    while (rest.length > 0 && this.stopReason === undefined) {
      const limit = this.limitReason();
      if (limit !== undefined) {
        this.stop(limit);
        return;
      }
      if (this.fd === null && !this.openPart()) return;
      const room = this.store.partBytes - this.currentPartSize();
      if (room === 0) {
        this.closePart();
        continue;
      }
      if (rest.length <= room) {
        this.writeBytes(rest);
        return;
      }
      const newline = rest.lastIndexOf(NEWLINE, room - 1);
      let cut: number;
      if (newline !== -1) {
        cut = newline + 1;
      } else if (this.currentPartSize() > 0 && this.partEndsWithNewline) {
        this.closePart();
        continue;
      } else {
        const boundary = utf8BoundaryAtOrBefore(rest, room);
        if (boundary === 0 && this.currentPartSize() > 0) {
          this.closePart();
          continue;
        }
        cut = boundary || room;
      }
      this.writeBytes(rest.subarray(0, cut));
      this.closePart();
      rest = rest.subarray(cut);
    }
  }

  // Writes what the limits allow. The writes are synchronous: chunks stay in order and a command
  // that produces output faster than it is saved waits for it, without separate flow control.
  // Blocking the event loop for each write is acceptable for a temporary directory.
  private writeBytes(data: Buffer): void {
    const fd = this.fd;
    if (fd === null) return;
    const partOffset = this.currentPartSize();
    const outputRoom = this.store.outputLimitBytes - this.saved;
    const processRoom = this.store.availableBytes();
    const allowed = Math.min(outputRoom, processRoom);
    const bytes =
      data.length <= allowed ? data : data.subarray(0, utf8BoundaryAtOrBefore(data, allowed));
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = this.store.fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('no bytes were written');
        this.savedHash?.update(bytes.subarray(offset, offset + written));
        offset += written;
        this.saved += written;
        this.partSizes[this.partSizes.length - 1] = this.currentPartSize() + written;
        this.store.record(written);
      }
    } catch (error) {
      this.stop(`write failed: ${errorMessage(error)}`);
      return;
    }
    if (bytes.length > 0) this.partEndsWithNewline = bytes[bytes.length - 1] === NEWLINE;
    if (
      partOffset < BINARY_SCAN_BYTES &&
      binaryOffset(bytes.subarray(0, BINARY_SCAN_BYTES - partOffset)) !== -1
    ) {
      this.binary = true;
    }
    if (bytes.length < data.length) {
      this.stop(outputRoom <= processRoom ? this.outputLimitReason() : this.processLimitReason());
    }
  }

  private limitReason(): string | undefined {
    if (this.saved >= this.store.outputLimitBytes) return this.outputLimitReason();
    if (this.store.availableBytes() === 0) return this.processLimitReason();
    return undefined;
  }

  private outputLimitReason(): string {
    return `the ${formatBytes(this.store.outputLimitBytes)} limit per output was reached`;
  }

  private processLimitReason(): string {
    return `the ${formatBytes(this.store.totalLimitBytes)} limit for the output files of this process was reached`;
  }

  private openPart(): boolean {
    try {
      if (this.sequence === 0) this.sequence = this.store.nextSequence();
      const index = String(this.parts.length + 1).padStart(3, '0');
      const { path, fd } = this.store.createFile(`${this.sequence}-${this.label}.${index}.txt`);
      this.fd = fd;
      this.parts.push(path);
      this.partSizes.push(0);
      this.partEndsWithNewline = true;
      return true;
    } catch (error) {
      this.stop(`could not create an output file: ${errorMessage(error)}`);
      return false;
    }
  }

  private currentPartSize(): number {
    return this.partSizes[this.partSizes.length - 1] ?? 0;
  }

  private closePart(): void {
    const fd = this.fd;
    if (fd === null) return;
    this.fd = null;
    try {
      this.store.fs.closeSync(fd);
    } catch (error) {
      this.stop(`closing an output file failed: ${errorMessage(error)}`);
    }
  }

  private stop(reason: string): void {
    this.stopReason ??= reason;
    this.pending = [];
    this.line = [];
    this.lineBytes = 0;
    this.closePart();
  }

  // A part that cannot be removed now is removed with the directory when the process exits, and
  // its bytes stay counted until then. One removed by removeAll is already gone and uncounted.
  private removeParts(): void {
    this.parts.forEach((path, index) => {
      try {
        this.store.fs.unlinkSync(path);
        this.store.record(-(this.partSizes[index] ?? 0));
      } catch {
        // Handled as described above: the exit removes it, and the limit keeps counting it.
      }
    });
    this.parts.length = 0;
    this.partSizes.length = 0;
    this.saved = 0;
  }
}

const partGlob = (path: string): string => basename(path).replace(/\.\d+\.txt$/, '.*.txt');

const quoted = (text: string): string => `\`${text}\``;

// The line naming where the complete output of a reduced result is, for the model. Paths are
// quoted, so punctuation after them is not taken as part of the path. `subject` names the output,
// such as stdout. A `growing` output is still being written, so it is never called complete.
export const describeSavedOutput = (
  saved: SavedOutput,
  subject = 'output',
  options: { growing?: boolean } = {},
): string => {
  const first = saved.parts[0];
  const last = saved.parts.at(-1);
  if (first === undefined || last === undefined) {
    return `[${subject} not saved: ${saved.stopReason ?? 'nothing was written'}]`;
  }
  const single = saved.parts.length === 1;
  const where = single
    ? `saved to ${quoted(first)}`
    : `saved in ${saved.parts.length} parts, ${quoted(first)} to ${quoted(last)}`;
  const hint = saved.binary
    ? 'it contains NUL bytes, which read_file and grep refuse as binary'
    : single
      ? 'read it with read_file or search it with grep'
      : `read each part with read_file, or search all of them with grep (path ${quoted(dirname(first))}, glob ${quoted(partGlob(first))})`;
  const size = formatBytes(saved.savedBytes);
  if (options.growing === true) {
    const stopped = saved.stopReason === undefined ? '' : `; saving stopped: ${saved.stopReason}`;
    return `[${subject} so far (${size}) ${where}${stopped}; ${hint}]`;
  }
  if (saved.stopReason !== undefined) {
    const interrupted =
      saved.interrupted === undefined ? '' : `; the capture also ended early: ${saved.interrupted}`;
    return `[truncated ${subject} (${size} of ${formatBytes(saved.receivedBytes)} received) ${where}; saving stopped: ${saved.stopReason}${interrupted}; ${hint}]`;
  }
  if (saved.interrupted !== undefined) {
    return `[interrupted ${subject} (${size}, received before ${saved.interrupted}) ${where}; ${hint}]`;
  }
  return `[complete ${subject} (${size}) ${where}; ${hint}]`;
};

// Finishes a spool once the caller knows whether it reduced the output, and returns the line naming
// the saved files for the result, or null when nothing was kept.
export const finishOutput = (
  spool: OutputSpool,
  reduced: boolean,
  subject: string,
  interrupted: string | undefined,
): string | null => {
  const saved = spool.finish({
    keep: reduced,
    ...(interrupted === undefined ? {} : { interrupted }),
  });
  return saved === null ? null : describeSavedOutput(saved, subject);
};

// The files of this process, removed when it exits.
export const outputFiles = new OutputFiles();

// Logs of background jobs, with a limit of their own, so a verbose job does not use up the room
// for tool output.
export const jobLogs = new OutputFiles({ totalLimitBytes: 256 * 1024 * 1024 });

export const removeOutputFiles = (): void => {
  outputFiles.removeAll();
  jobLogs.removeAll();
};
