import { readFileSync } from 'node:fs';

const NOTE = /^\[(complete|interrupted|truncated) \w+ \(/;
const PARTS = /`(\/[^`]+?)\.(\d{3})\.txt`(?: to `\/[^`]+?\.(\d{3})\.txt`)?/;

// The parts named by each saved-output note of a tool result, in the order the notes appear.
export const savedOutputs = (content: string): string[][] =>
  content
    .split('\n')
    .filter((line) => NOTE.test(line))
    .map((line) => {
      const match = PARTS.exec(line);
      if (match === null) throw new Error(`no parts in note: ${line}`);
      const [, base, first = '', last = first] = match;
      const parts: string[] = [];
      for (let n = Number(first); n <= Number(last); n++) {
        parts.push(`${base}.${String(n).padStart(3, '0')}.txt`);
      }
      return parts;
    });

export const readParts = (parts: readonly string[]): Buffer =>
  Buffer.concat(parts.map((part) => readFileSync(part)));
