import { createHash } from 'node:crypto';
import { fsyncSync, writeSync } from 'node:fs';
import { errorMessage } from '../errors.ts';

// The evidence log of a security session: one JSON object per line, each holding the SHA-256 of
// the line before it. The chain shows the material is consistent; it does not show that it was
// not rewritten whole, which needs its final hash kept elsewhere, as the operator is given it at
// the end of the session.
//
// A line is written whole or the log fails: the sequence and the hash advance only once every
// byte of it was written. Once the log has failed it writes nothing more and throws nothing: the
// session, told once, closes its network and refuses commands by a way that does not depend on it.

export const ZERO_HASH = '0'.repeat(64);
// Past it the log fails, as a full disk would make it: a session does not go on unrecorded.
export const MAX_LOG_BYTES = 1024 ** 3;

export type EvidenceEntry = { type: string } & Record<string, unknown>;

export interface EvidenceFs {
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  fsyncSync(fd: number): void;
}

export interface EvidenceLogOptions {
  fd: number;
  // Told once, the first time a write fails, with why.
  onFailure: (reason: string) => void;
  now?: () => Date;
  fs?: EvidenceFs;
  maxBytes?: number;
}

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export class EvidenceLog {
  private sequence = 0;
  private previous = ZERO_HASH;
  private bytes = 0;
  private failure: string | null = null;
  private closed = false;
  // Copies and other preservations under way, which the end of the session waits for.
  private readonly pending = new Set<Promise<unknown>>();
  private readonly fs: EvidenceFs;
  private readonly now: () => Date;
  private readonly maxBytes: number;

  constructor(private readonly options: EvidenceLogOptions) {
    this.fs = options.fs ?? { writeSync, fsyncSync };
    this.now = options.now ?? (() => new Date());
    this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  }

  // Why the log cannot be written, once it cannot; null while it can.
  failed(): string | null {
    return this.failure;
  }

  get entries(): number {
    return this.sequence;
  }

  // The SHA-256 of the last line written, which the next one holds.
  get lastHash(): string {
    return this.previous;
  }

  // Writes and syncs an entry an action depends on: true only once both are done. The action does
  // not happen without it.
  appendCritical(entry: EvidenceEntry): boolean {
    return this.write(entry, true);
  }

  // Writes an entry, synced when `sync` says so; a failure fails the log.
  append(entry: EvidenceEntry, sync = false): void {
    this.write(entry, sync);
  }

  // Keeps `work` among the preservations the end of the session waits for.
  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return work;
  }

  // Waits up to `ms` for the preservations under way, those that start meanwhile included; says
  // how many did not end in that time.
  async drain(ms: number): Promise<number> {
    const deadline = Date.now() + ms;
    while (this.pending.size > 0 && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(this.pending),
        new Promise((resolve) => {
          timer = setTimeout(resolve, deadline - Date.now());
        }),
      ]);
      clearTimeout(timer);
    }
    return this.pending.size;
  }

  // Resolves once no preservation is under way, however long they take.
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  // Fails the log for what failed beside it, as a copy that could not be written: once.
  markFailed(reason: string): void {
    if (this.failure === null && !this.closed) this.fail(reason);
  }

  // Writes nothing more. The descriptor stays the caller's.
  close(): void {
    this.closed = true;
  }

  private write(entry: EvidenceEntry, sync: boolean): boolean {
    if (this.failure !== null || this.closed) return false;
    const { type, ...fields } = entry;
    const line = `${JSON.stringify({
      seq: this.sequence + 1,
      at: this.now().toISOString(),
      prev: this.previous,
      type,
      ...fields,
    })}\n`;
    const buffer = Buffer.from(line);
    if (this.bytes + buffer.length > this.maxBytes) {
      return this.fail(`the evidence log reached its limit of ${this.maxBytes} bytes`);
    }
    try {
      // A write can take part of a line: the rest is written until all of it is.
      for (let offset = 0; offset < buffer.length; ) {
        const written = this.fs.writeSync(this.options.fd, buffer, offset, buffer.length - offset);
        // A write that takes nothing would otherwise be retried for ever.
        if (written <= 0) throw new Error('no bytes were written');
        offset += written;
      }
      if (sync) this.fs.fsyncSync(this.options.fd);
    } catch (error) {
      return this.fail(`the evidence log cannot be written: ${errorMessage(error)}`);
    }
    this.sequence += 1;
    this.bytes += buffer.length;
    this.previous = sha256(buffer);
    return true;
  }

  private fail(reason: string): false {
    this.failure = reason;
    this.options.onFailure(reason);
    return false;
  }
}
