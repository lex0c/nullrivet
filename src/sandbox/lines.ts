const NEWLINE = 0x0a;

// Splits a byte stream into newline-terminated lines without holding more than `maxBytes` of one
// line in memory. The text before a newline is passed to `onLine`; a line that grows past the
// limit calls `onOverflow` once and the splitter takes nothing more.
export class LineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private stopped = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: Buffer): void {
    let rest = chunk;
    while (!this.stopped && rest.length > 0) {
      const end = rest.indexOf(NEWLINE);
      const piece = end === -1 ? rest : rest.subarray(0, end);
      if (this.pendingBytes + piece.length > this.maxBytes) {
        this.stopped = true;
        this.pending = [];
        this.onOverflow();
        return;
      }
      if (end === -1) {
        this.pending.push(piece);
        this.pendingBytes += piece.length;
        return;
      }
      const line = Buffer.concat([...this.pending, piece]).toString('utf8');
      this.pending = [];
      this.pendingBytes = 0;
      rest = rest.subarray(end + 1);
      this.onLine(line);
    }
  }
}
