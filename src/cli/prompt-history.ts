// Texts submitted in the interactive session, oldest first, recalled with the arrow keys. It
// lives in memory and, when a session file is attached, in that file; nothing else keeps it.

export const PROMPT_HISTORY_LIMIT = 100;

export class PromptHistory {
  private readonly items: string[];
  // Index of the entry shown in the input while browsing; null while the user edits their own
  // text, which is kept as the draft to come back to.
  private position: number | null = null;
  private draft = '';
  private changes = 0;

  constructor(
    entries: readonly string[] = [],
    private readonly limit = PROMPT_HISTORY_LIMIT,
  ) {
    this.items = entries.slice(-limit);
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

  // Records a submitted text and ends browsing. Blank text and a repeat of the latest entry are
  // not added.
  add(text: string): void {
    this.stopBrowsing();
    if (text.trim().length === 0 || this.items.at(-1) === text) return;
    this.items.push(text);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    this.changes++;
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
