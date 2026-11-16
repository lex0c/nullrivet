import { formatBytes } from './output-reduction.ts';

// Accumulates a byte stream in bounded memory. Once the limit is reached it keeps the first and
// the last half of the limit and counts what was dropped in between.
export class BoundedCapture {
  private readonly head: Buffer[] = [];
  private readonly tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private droppedBytes = 0;
  totalBytes = 0;

  constructor(private readonly limit: number) {}

  push(input: Buffer): void {
    this.totalBytes += input.length;
    const half = Math.floor(this.limit / 2);
    let chunk = input;
    if (this.headBytes < half) {
      const take = Math.min(chunk.length, half - this.headBytes);
      this.head.push(chunk.subarray(0, take));
      this.headBytes += take;
      chunk = chunk.subarray(take);
      if (chunk.length === 0) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > half) {
      const first = this.tail[0];
      if (first === undefined) break;
      const excess = this.tailBytes - half;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.droppedBytes += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.droppedBytes += excess;
      }
    }
  }

  text(): string {
    if (this.droppedBytes === 0)
      return Buffer.concat([...this.head, ...this.tail]).toString('utf8');
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    return `${head}\n[... ${formatBytes(this.droppedBytes)} dropped ...]\n${tail}`;
  }
}
