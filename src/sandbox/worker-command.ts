import { fileURLToPath } from 'node:url';
import { WORKER_ARGUMENT } from './protocol.ts';

// The compiled binary embeds its modules under /$bunfs/ and runs its own entry point whatever
// arguments it gets. From source, bun runs the entry point with the flags of its shebang, which
// keep a project's .env and bunfig.toml from being loaded.
const COMPILED = import.meta.url.startsWith('file:///$bunfs/');
const SOURCE_DIR = fileURLToPath(new URL('..', import.meta.url));

export const workerCommand = (tools: readonly string[]): string[] => {
  const args = [WORKER_ARGUMENT, '--tools', tools.join(',')];
  if (COMPILED) return [process.execPath, ...args];
  return [
    process.execPath,
    '--no-env-file',
    '--config=/dev/null',
    fileURLToPath(new URL('../main.ts', import.meta.url)),
    ...args,
  ];
};

// What a sandbox must expose for workerCommand to run: the binary, or bun and the source
// directory. Only the source directory: the package root above it may hold a .env with keys.
export const workerFiles = (): string[] =>
  COMPILED ? [process.execPath] : [process.execPath, SOURCE_DIR.replace(/\/$/, '')];
