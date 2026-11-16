import type { Stats } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Agent } from '../agent/agent.ts';
import { type ConversationSnapshot, parseConversationSnapshot } from '../agent/snapshot.ts';
import { errorMessage } from '../errors.ts';
import type { ProviderEffort } from '../providers/types.ts';
import { atomicWrite } from '../tools/atomic-write.ts';
import { isNotFoundError } from '../tools/file-io.ts';
import { type ExecutionMode, isExecutionMode } from '../tools/policy.ts';
import { EFFORT_LEVELS } from './args.ts';

// A session file holds a conversation so it can be continued after nullrivet exits. Nothing is
// written unless the user names a file. The file holds prompts and tool output, which can include
// secrets read from files, so it is created readable by its owner only. Loading it gives its
// history the authority of the user's own messages, so only files the user wrote are meant to be
// loaded, and anything that is not exactly a session file is refused.

export const SESSION_FORMAT = 'nullrivet-session';
export const SESSION_VERSION = 1;
// Well above what a compacted conversation reaches, and small enough to read into memory.
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const SESSION_FILE_MODE = 0o600;

export interface SessionData {
  createdAt: string;
  updatedAt: string;
  // Where the session was last run, for continuing with the same model.
  model: string;
  effort?: ProviderEffort;
  // Recorded to warn about a change, never applied: permissions come from the invocation only.
  mode: ExecutionMode;
  cwd: string;
  conversation: ConversationSnapshot;
}

type Parsed = { ok: true; data: SessionData } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseSessionFile = (text: string): Parsed => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'it is not JSON' };
  }
  if (!isRecord(value) || value.format !== SESSION_FORMAT) {
    return { ok: false, error: 'it is not a nullrivet session file' };
  }
  if (value.version !== SESSION_VERSION) {
    return {
      ok: false,
      error: `its format version ${String(value.version)} is not supported by this nullrivet`,
    };
  }
  const { createdAt, updatedAt, model, effort, mode, cwd } = value;
  if (
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    typeof model !== 'string' ||
    typeof cwd !== 'string'
  ) {
    return { ok: false, error: 'createdAt, updatedAt, model and cwd must be strings' };
  }
  if (typeof mode !== 'string' || !isExecutionMode(mode)) {
    return { ok: false, error: 'mode must be auto or readonly' };
  }
  if (effort !== undefined && !EFFORT_LEVELS.includes(effort as ProviderEffort)) {
    return { ok: false, error: `effort must be one of ${EFFORT_LEVELS.join(', ')}` };
  }
  const conversation = parseConversationSnapshot(value.conversation);
  if (!conversation.ok) return { ok: false, error: conversation.error };
  return {
    ok: true,
    data: {
      createdAt,
      updatedAt,
      model,
      ...(effort === undefined ? {} : { effort: effort as ProviderEffort }),
      mode,
      cwd,
      conversation: conversation.snapshot,
    },
  };
};

interface FileStamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

const stampOf = (info: Stats): FileStamp => ({
  ino: info.ino,
  size: info.size,
  mtimeMs: info.mtimeMs,
});

export type OpenResult =
  | { ok: true; file: SessionFile; data: SessionData | null }
  | { ok: false; error: string };

export interface SessionState {
  model: string;
  effort: ProviderEffort | undefined;
  mode: ExecutionMode;
  cwd: string;
  conversation: ConversationSnapshot;
}

export class SessionFile {
  private constructor(
    readonly path: string,
    // What the file looked like after this process last read or wrote it; null before it exists.
    private stamp: FileStamp | null,
    private readonly createdAt: string,
  ) {}

  // Reads an existing session, or prepares a new one that the first save creates.
  static async open(path: string): Promise<OpenResult> {
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error) {
      if (!isNotFoundError(error)) {
        return { ok: false, error: `cannot read the session file ${path}: ${errorMessage(error)}` };
      }
      try {
        if (!(await stat(dirname(path))).isDirectory()) throw new Error('not a directory');
      } catch {
        return {
          ok: false,
          error: `the directory of the session file does not exist: ${dirname(path)}`,
        };
      }
      return { ok: true, file: new SessionFile(path, null, new Date().toISOString()), data: null };
    }
    // A link would let the session be written somewhere other than the path the user named.
    if (info.isSymbolicLink()) {
      return { ok: false, error: `the session file is a symbolic link: ${path}` };
    }
    if (!info.isFile()) {
      return { ok: false, error: `the session file is not a regular file: ${path}` };
    }
    if (info.size > MAX_SESSION_BYTES) {
      return { ok: false, error: `the session file is larger than 64 MiB: ${path}` };
    }
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      return { ok: false, error: `cannot read the session file ${path}: ${errorMessage(error)}` };
    }
    const parsed = parseSessionFile(text);
    if (!parsed.ok) {
      return { ok: false, error: `${path} cannot be loaded as a session: ${parsed.error}` };
    }
    return {
      ok: true,
      file: new SessionFile(path, stampOf(info), parsed.data.createdAt),
      data: parsed.data,
    };
  }

  // Writes the whole state atomically, so a crash leaves either the previous state or the new one.
  // Throws when the file was changed by something else since this process last touched it:
  // overwriting it would discard that change.
  async save(state: SessionState): Promise<void> {
    let current: Stats | null;
    try {
      current = await lstat(this.path);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      current = null;
    }
    if (current === null && this.stamp !== null) {
      throw new Error('the file was removed by something else');
    }
    if (current !== null) {
      if (current.isSymbolicLink()) throw new Error('the file was replaced by a symbolic link');
      const before = this.stamp;
      if (
        before === null ||
        before.ino !== current.ino ||
        before.size !== current.size ||
        before.mtimeMs !== current.mtimeMs
      ) {
        throw new Error('the file was changed by something else');
      }
    }
    const data = {
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      model: state.model,
      ...(state.effort === undefined ? {} : { effort: state.effort }),
      mode: state.mode,
      cwd: state.cwd,
      conversation: state.conversation,
    };
    atomicWrite(this.path, `${JSON.stringify(data, null, 2)}\n`, { mode: SESSION_FILE_MODE });
    this.stamp = stampOf(await lstat(this.path));
  }
}

// Keeps a session file up to date with an agent's conversation, through the agent's checkpoint.
// A file that cannot be written is detached with one warning; the task itself goes on.
export class SessionLink {
  private file: SessionFile | null = null;
  private savedAt: Date | null = null;

  constructor(
    private readonly agent: Agent,
    private readonly cwd: string,
    public warn: (message: string) => void,
  ) {}

  get path(): string | null {
    return this.file?.path ?? null;
  }

  attach(file: SessionFile): void {
    this.file = file;
    this.savedAt = null;
    this.agent.checkpoint = () => this.save();
  }

  detach(): void {
    this.file = null;
    this.agent.checkpoint = null;
  }

  async save(): Promise<void> {
    const file = this.file;
    if (file === null) return;
    try {
      await file.save({
        model: this.agent.provider.id,
        effort: this.agent.effort,
        mode: this.agent.mode,
        cwd: this.cwd,
        conversation: this.agent.conversation.snapshot(),
      });
      this.savedAt = new Date();
    } catch (error) {
      this.detach();
      this.warn(`the session is no longer saved to ${file.path}: ${errorMessage(error)}`);
    }
  }

  status(): string {
    if (this.file === null) return 'No session file is attached. /session <file> saves to one.';
    const messages = this.agent.conversation.messages().length;
    const saved =
      this.savedAt === null
        ? 'not saved yet'
        : `last saved at ${this.savedAt.toLocaleTimeString()}`;
    return `Session file: ${this.file.path} (${messages} messages, ${saved}).`;
  }
}
