import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripAnsi } from '../sanitize/ansi.ts';

export const INSTRUCTIONS_FILE_NAME = 'AGENTS.md';
const DEFAULT_MAX_FILE_BYTES = 16 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 48 * 1024;
const DEFAULT_MAX_DEPTH = 16;

export interface InstructionFile {
  // Canonical path of the AGENTS.md file.
  path: string;
  // Directory whose files the instructions apply to.
  dir: string;
  content: string;
  truncated: boolean;
}

export interface DiscoveryResult {
  files: InstructionFile[];
  warnings: string[];
}

export interface InstructionsLoaderOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  home?: string;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const readPrefix = async (
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> => {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return { text: buffer.toString('utf8'), truncated: size > maxBytes };
  } finally {
    await handle.close();
  }
};

const sanitize = (text: string): string => stripAnsi(text.replace(/\r\n?/g, '\n')).trim();

// Loads existing AGENTS.md files as project instructions, read-only and kept only in memory.
// The instructions that apply to a path are the AGENTS.md files of its ancestor directories up to
// the repository root. Outside a repository the walk stops below the home directory and the
// filesystem root, so unrelated files in shared parents are not picked up. This bounds which
// instructions apply; it never restricts which paths the tools may access.
export class InstructionsLoader {
  private readonly loaded = new Map<string, InstructionFile>();
  // Bytes each loaded file counts against the total limit.
  private readonly sizes = new Map<string, number>();
  private readonly lookups = new Map<string, string | null>();
  private readonly gitRoots = new Map<string, boolean>();
  private totalBytes = 0;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxDepth: number;
  private readonly home: string;

  constructor(options: InstructionsLoaderOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.home = options.home ?? homedir();
  }

  list(): InstructionFile[] {
    return [...this.loaded.values()];
  }

  // Forgets everything so the next discovery reads the files again.
  reset(): void {
    this.loaded.clear();
    this.sizes.clear();
    this.lookups.clear();
    this.gitRoots.clear();
    this.totalBytes = 0;
  }

  // Forgets every loaded file except the given ones, so instructions that were attached to a
  // discarded conversation are attached again when their paths are touched in a new one.
  retainOnly(paths: ReadonlySet<string>): void {
    for (const path of [...this.loaded.keys()]) {
      if (paths.has(path)) continue;
      this.loaded.delete(path);
      this.totalBytes -= this.sizes.get(path) ?? 0;
      this.sizes.delete(path);
    }
  }

  // Returns only files that were not loaded before, ordered from the outermost directory to the
  // innermost, so more specific instructions come last.
  async discover(paths: readonly string[]): Promise<DiscoveryResult> {
    const files: InstructionFile[] = [];
    const warnings: string[] = [];
    for (const path of paths) {
      const start = await this.startDirectory(path);
      if (start === null) continue;
      for (const dir of await this.ancestors(start)) {
        const candidate = await this.lookup(dir);
        if (candidate === null || this.loaded.has(candidate)) continue;
        const file = await this.load(candidate, dir, warnings);
        if (file !== null) files.push(file);
      }
    }
    return { files, warnings };
  }

  private async startDirectory(path: string): Promise<string | null> {
    let current = path;
    for (let depth = 0; depth <= this.maxDepth; depth++) {
      try {
        const info = await stat(current);
        return await realpath(info.isDirectory() ? current : dirname(current));
      } catch {
        // A path that does not exist yet (a file about to be created) is governed by the
        // instructions of its nearest existing ancestor.
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
      }
    }
    return null;
  }

  private async isGitRoot(dir: string): Promise<boolean> {
    const cached = this.gitRoots.get(dir);
    if (cached !== undefined) return cached;
    const result = await exists(join(dir, '.git'));
    this.gitRoots.set(dir, result);
    return result;
  }

  private async ancestors(start: string): Promise<string[]> {
    const dirs: string[] = [];
    let current = start;
    for (let depth = 0; depth < this.maxDepth; depth++) {
      dirs.push(current);
      if (await this.isGitRoot(current)) break;
      const parent = dirname(current);
      if (parent === current || parent === '/') break;
      if (parent === this.home && !(await this.isGitRoot(parent))) break;
      current = parent;
    }
    return dirs.reverse();
  }

  private async lookup(dir: string): Promise<string | null> {
    const cached = this.lookups.get(dir);
    if (cached !== undefined) return cached;
    const candidate = join(dir, INSTRUCTIONS_FILE_NAME);
    let resolved: string | null = null;
    try {
      if ((await stat(candidate)).isFile()) resolved = await realpath(candidate);
    } catch {
      resolved = null;
    }
    this.lookups.set(dir, resolved);
    return resolved;
  }

  private async load(
    path: string,
    dir: string,
    warnings: string[],
  ): Promise<InstructionFile | null> {
    const remaining = this.maxTotalBytes - this.totalBytes;
    if (remaining <= 0) {
      warnings.push(`${path} was not loaded: the total size limit for AGENTS.md files was reached`);
      return null;
    }
    let read: { text: string; truncated: boolean };
    try {
      read = await readPrefix(path, Math.min(this.maxFileBytes, remaining));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${path} could not be read: ${reason}`);
      return null;
    }
    if (read.truncated) warnings.push(`${path} was truncated to fit the size limit`);
    const file: InstructionFile = {
      path,
      dir,
      content: sanitize(read.text),
      truncated: read.truncated,
    };
    const bytes = Buffer.byteLength(read.text, 'utf8');
    this.loaded.set(path, file);
    this.sizes.set(path, bytes);
    this.totalBytes += bytes;
    return file;
  }
}

const escapeClosingTag = (text: string): string =>
  text.replaceAll('</project_instructions>', '<\\/project_instructions>');

export const renderInstructionFiles = (files: readonly InstructionFile[]): string =>
  files
    .map((file) =>
      [
        `<project_instructions source="${file.path}" applies_to="${file.dir}">`,
        escapeClosingTag(file.content),
        ...(file.truncated ? ['[truncated: the file exceeds the size limit]'] : []),
        '</project_instructions>',
      ].join('\n'),
    )
    .join('\n\n');
