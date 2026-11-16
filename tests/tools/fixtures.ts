import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext, ToolResult } from '../../src/tools/types.ts';

export const toolContext = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
});

export const abortedContext = (cwd: string): ToolContext => {
  const controller = new AbortController();
  controller.abort();
  return { cwd, signal: controller.signal };
};

export const errorCode = (result: ToolResult): unknown => result.meta?.errorCode;

// Tracks temp directories so a single afterEach call removes all of them.
export class TempDirs {
  private readonly dirs: string[] = [];

  create(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `nullrivet-${prefix}-`));
    this.dirs.push(dir);
    return dir;
  }

  cleanup(): void {
    for (const dir of this.dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
}

export const isRoot = process.getuid?.() === 0;
