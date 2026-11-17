// Texts submitted in the interactive session, oldest first, recalled with the arrow keys. It
// lives in memory and, when a session file is attached, in that file; nothing else keeps it.

export const PROMPT_HISTORY_LIMIT = 100;
// The history is saved with the session, and compaction never shortens it, so pasted prompts are
// bounded too: one that is too large to be worth recalling is not kept, and the oldest entries
// are dropped past the total. This keeps the history from pushing a session file past the size
// it may have.
export const PROMPT_HISTORY_MAX_BYTES = 1024 * 1024;
export const PROMPT_ENTRY_MAX_BYTES = 64 * 1024;

export interface PromptHistoryLimits {
  entries?: number;
  bytes?: number;
  entryBytes?: number;
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

export class PromptHistory {
  private readonly items: string[] = [];
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  // Index of the entry shown in the input while browsing; null while the user edits their own
  // text, which is kept as the draft to come back to.
  private position: number | null = null;
  private draft = '';
  private changes = 0;

  constructor(entries: readonly string[] = [], limits: PromptHistoryLimits = {}) {
    this.maxEntries = limits.entries ?? PROMPT_HISTORY_LIMIT;
    this.maxBytes = limits.bytes ?? PROMPT_HISTORY_MAX_BYTES;
    this.maxEntryBytes = limits.entryBytes ?? PROMPT_ENTRY_MAX_BYTES;
    for (const entry of entries) this.push(entry);
  }

  entries(): readonly string[] {
    return this.items;
  }

  // Counts additions, so a copy that is up to date need not be written again.
  get revision(): number {
    return this.changes;
  }

  get browsing(): boolean {
    return this.position !== null;
  }

  // Records a submitted text and ends browsing. Blank text, a repeat of the latest entry and text
  // over the entry limit are not added.
  add(text: string): void {
    this.stopBrowsing();
    if (text.trim().length === 0 || this.items.at(-1) === text) return;
    if (this.push(text)) this.changes++;
  }

  private push(text: string): boolean {
    const size = byteLength(text);
    if (size > this.maxEntryBytes) return false;
    this.items.push(text);
    this.totalBytes += size;
    while (this.items.length > this.maxEntries || this.totalBytes > this.maxBytes) {
      this.totalBytes -= byteLength(this.items.shift() ?? '');
    }
    return true;
  }

  // The entry before the one shown, staying at the oldest; null when the history is empty. The
  // first call keeps `current` as the draft.
  previous(current: string): string | null {
    if (this.items.length === 0) return null;
    if (this.position === null) {
      this.draft = current;
      this.position = this.items.length - 1;
    } else if (this.position > 0) {
      this.position -= 1;
    }
    return this.items[this.position] ?? null;
  }

  // The entry after the one shown, or the draft past the newest; null when not browsing.
  next(): string | null {
    if (this.position === null) return null;
    if (this.position < this.items.length - 1) {
      this.position += 1;
      return this.items[this.position] ?? null;
    }
    const draft = this.draft;
    this.stopBrowsing();
    return draft;
  }

  // Editing a recalled entry makes it the user's own text: the next ↑ starts again from the
  // newest entry and keeps the edited text as the draft.
  stopBrowsing(): void {
    this.position = null;
    this.draft = '';
  }
}
