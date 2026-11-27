import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../errors.ts';
import { sha256, ZERO_HASH } from './evidence.ts';

// Checks an evidence log and the copies beside it. What it shows depends on what it is given: the
// chain alone shows the material is consistent; the final hash compared with one kept elsewhere
// shows nothing changed since. Three outcomes: complete; consistent but incomplete, as a session
// cut short, or with outputs not wholly preserved; and corrupted, with the first entry that is.
//
// The log may have been altered, so nothing in it is trusted to name a file: a copy is looked for
// only in the directory beside the log, by a name of the form the host gives, never through a link,
// and only as a regular file.

export type VerdictStatus = 'complete' | 'incomplete' | 'corrupted';

export interface Verdict {
  status: VerdictStatus;
  entries: number;
  // The SHA-256 of the last whole line.
  finalHash: string;
  // Why it is not complete, or why it is corrupted.
  reasons: string[];
  // Whether the final hash was compared with one kept elsewhere.
  anchored: boolean;
}

export const COPY_NAME =
  /^(?:c\d+|job-[A-Za-z0-9_-]{1,64})-(?:stdout|stderr|output|log)\.\d+\.txt$/;
export const ENGAGEMENT_COPY = 'engagement.json';
const HASH = /^[0-9a-f]{64}$/;

// The directory of a log's copies: the log's path without its extension.
export const companionOf = (logPath: string): string => logPath.replace(/\.jsonl$/, '');

type Entry = Record<string, unknown> & { seq: number; prev: string; type: string };

class Corrupted extends Error {}

const corrupt = (message: string): never => {
  throw new Corrupted(message);
};

const createSha = () => new Bun.CryptoHasher('sha256');
type Hasher = ReturnType<typeof createSha>;

// The SHA-256 and length of a copy, read beside the log, or why it cannot be. What is read goes
// into `into` too, so that the copies of an output are read once.
const readCopy = (
  dir: string,
  name: string,
  into?: Hasher,
): { sha256: string; bytes: number } | string => {
  if (!COPY_NAME.test(name) && name !== ENGAGEMENT_COPY) return `"${name}" is not a copy's name`;
  let fd: number;
  try {
    fd = openSync(
      join(dir, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return `${name} cannot be opened: ${errorMessage(error)}`;
  }
  try {
    if (!fstatSync(fd).isFile()) return `${name} is not a regular file`;
    const hash = createSha();
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
      hash.update(buffer.subarray(0, read));
      into?.update(buffer.subarray(0, read));
      bytes += read;
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    closeSync(fd);
  }
};

interface Copy {
  name: string;
  bytes: number;
  sha256: string;
}

const isCopy = (value: unknown): value is Copy => {
  if (typeof value !== 'object' || value === null) return false;
  const copy = value as Record<string, unknown>;
  return (
    typeof copy.name === 'string' &&
    typeof copy.bytes === 'number' &&
    typeof copy.sha256 === 'string' &&
    HASH.test(copy.sha256)
  );
};

// The outputs an entry records: a call's, or a job's log.
const outputsOf = (entry: Entry): Record<string, unknown>[] => {
  const outputs =
    entry.type === 'tool.finished'
      ? entry.outputs
      : entry.type === 'job.finished'
        ? [entry.log]
        : [];
  return Array.isArray(outputs)
    ? outputs.filter(
        (output): output is Record<string, unknown> =>
          typeof output === 'object' && output !== null,
      )
    : [];
};

export const verifyEvidence = (logPath: string, expectedHash?: string): Verdict => {
  const dir = companionOf(logPath);
  const reasons: string[] = [];
  let entries = 0;
  let finalHash = ZERO_HASH;
  const verdict = (status: VerdictStatus): Verdict => ({
    status,
    entries,
    finalHash,
    reasons,
    anchored: expectedHash !== undefined,
  });
  try {
    if (!logPath.endsWith('.jsonl')) corrupt(`${logPath} is not an evidence log (.jsonl)`);
    const text = readFileSync(logPath);
    const started = new Set<string>();
    const ended = new Set<string>();
    const jobsStarted = new Set<string>();
    const jobsEnded = new Set<string>();
    let sessionEnded = false;
    let partial = false;
    let at = 0;
    while (at < text.length) {
      const end = text.indexOf(0x0a, at);
      if (end === -1) {
        partial = true;
        break;
      }
      const line = text.subarray(at, end + 1);
      at = end + 1;
      const seq = entries + 1;
      let entry: Entry;
      try {
        entry = JSON.parse(line.toString('utf8')) as Entry;
      } catch {
        return corrupt(`entry ${seq} is not JSON`);
      }
      if (typeof entry !== 'object' || entry === null || entry.seq !== seq) {
        corrupt(`entry ${seq} is out of sequence`);
      }
      if (entry.prev !== finalHash)
        corrupt(`entry ${seq} does not hold the hash of the one before`);
      if (sessionEnded) corrupt(`entry ${seq} comes after the end of the session`);
      if (seq === 1 && entry.type !== 'session.started') {
        corrupt('the log does not start with session.started');
      }
      const callId = typeof entry.callId === 'string' ? entry.callId : null;
      switch (entry.type) {
        case 'session.started': {
          if (seq !== 1) corrupt(`entry ${seq} starts the session again`);
          const engagement = entry.engagement as { sha256?: unknown } | undefined;
          const copy = readCopy(dir, ENGAGEMENT_COPY);
          if (typeof copy === 'string') corrupt(`the engagement's copy: ${copy}`);
          else if (engagement?.sha256 !== copy.sha256) {
            corrupt("the engagement's copy is not the file the session read");
          }
          break;
        }
        case 'tool.started':
          if (callId === null || started.has(callId)) corrupt(`entry ${seq} reuses a call id`);
          started.add(callId as string);
          break;
        case 'tool.finished':
          if (callId === null || !started.has(callId) || ended.has(callId)) {
            corrupt(`entry ${seq} ends a call that was not started, or ended already`);
          }
          ended.add(callId as string);
          break;
        case 'tool.refused':
          // Refused before its intent was written, a call has an id of its own; after, the id of
          // its start.
          if (callId === null) corrupt(`entry ${seq} has no call id`);
          if (entry.started === true) {
            if (!started.has(callId as string) || ended.has(callId as string)) {
              corrupt(`entry ${seq} refuses a call that was not started, or ended already`);
            }
          } else if (started.has(callId as string)) {
            corrupt(`entry ${seq} reuses a call id`);
          } else {
            started.add(callId as string);
          }
          ended.add(callId as string);
          break;
        case 'job.started': {
          const jobId = String(entry.jobId);
          if (jobsStarted.has(jobId)) corrupt(`entry ${seq} starts job ${jobId} again`);
          if (callId === null || !started.has(callId)) {
            corrupt(`entry ${seq} starts a job for a call that was not started`);
          }
          jobsStarted.add(jobId);
          break;
        }
        case 'job.finished': {
          const jobId = String(entry.jobId);
          if (!jobsStarted.has(jobId) || jobsEnded.has(jobId)) {
            corrupt(`entry ${seq} ends job ${jobId}, which was not started, or ended already`);
          }
          jobsEnded.add(jobId);
          break;
        }
        case 'session.ended':
          sessionEnded = true;
          break;
        default:
          break;
      }
      for (const output of outputsOf(entry)) {
        const copies = output.copies;
        if (copies !== undefined) {
          if (!Array.isArray(copies) || !copies.every(isCopy)) {
            corrupt(`entry ${seq} records its copies in a form the host does not write`);
          }
          const whole = createSha();
          for (const copy of copies as Copy[]) {
            const found = readCopy(dir, copy.name, whole);
            if (typeof found === 'string') corrupt(`entry ${seq}: ${found}`);
            else if (found.sha256 !== copy.sha256 || found.bytes !== copy.bytes) {
              corrupt(`entry ${seq}: the copy ${copy.name} is not what was copied`);
            }
          }
          if (output.copiedSha256 !== undefined && whole.digest('hex') !== output.copiedSha256) {
            corrupt(`entry ${seq}: its copies together are not what was copied`);
          }
        }
        if (output.matchesSaved === false) {
          reasons.push(
            `entry ${seq}: a copy differs from what the worker saved, which a command could have rewritten before it was copied`,
          );
        }
        if (output.preservation === 'omitted' && typeof output.omitted === 'string') {
          reasons.push(`entry ${seq}: an output was not preserved: ${output.omitted}`);
        } else if (output.complete === false) {
          const why =
            typeof output.stopReason === 'string' ? output.stopReason : 'its capture was cut short';
          reasons.push(`entry ${seq}: an output was not saved whole: ${why}`);
        }
      }
      entries = seq;
      finalHash = sha256(line);
    }
    if (expectedHash !== undefined && expectedHash !== finalHash) {
      corrupt(`the final hash is ${finalHash}, not the one expected, ${expectedHash}`);
    }
    if (partial) reasons.push('the last line is cut short: the session ended while writing it');
    if (!sessionEnded) reasons.push('the session has no end recorded');
    const open = [...started].filter((id) => !ended.has(id));
    if (open.length > 0)
      reasons.push(`calls started without an outcome recorded: ${open.join(', ')}`);
    const running = [...jobsStarted].filter((id) => !jobsEnded.has(id));
    if (running.length > 0) {
      reasons.push(`jobs started without an end recorded: ${running.join(', ')}`);
    }
    return verdict(reasons.length === 0 ? 'complete' : 'incomplete');
  } catch (error) {
    if (!(error instanceof Corrupted)) {
      return {
        ...verdict('corrupted'),
        reasons: [`the log cannot be read: ${errorMessage(error)}`],
      };
    }
    return { ...verdict('corrupted'), reasons: [error.message] };
  }
};

// The verdict as the operator reads it.
export const formatVerdict = (verdict: Verdict): string => {
  if (verdict.status === 'corrupted') {
    return [
      `corrupted after ${verdict.entries} entries:`,
      ...verdict.reasons.map((why) => `- ${why}`),
    ].join('\n');
  }
  const head =
    verdict.status === 'complete'
      ? `complete: ${verdict.entries} entries`
      : `consistent, but incomplete: ${verdict.entries} entries`;
  return [
    head,
    ...verdict.reasons.map((why) => `- ${why}`),
    `final hash: ${verdict.finalHash}`,
    verdict.anchored
      ? 'the final hash is the one expected'
      : 'only the consistency of the log was checked: compare its final hash with one kept apart from it, with --expected-hash',
  ].join('\n');
};
