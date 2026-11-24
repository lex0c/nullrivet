import { fileURLToPath } from 'node:url';
import { WORKER_ARGUMENT } from './protocol.ts';

// The compiled binary embeds its modules under /$bunfs/ and runs its own entry point whatever
// arguments it gets. From source, bun runs the entry point with the flags of its shebang, which
// keep a project's .env and bunfig.toml from being loaded.
const COMPILED = import.meta.url.startsWith('file:///$bunfs/');
// Only the source directory: the package root above it may hold a .env with keys.
const SOURCE_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

// Where a sandbox exposes the worker's own files: a fixed path, so the paths the tools and the
// home directory show do not tell where nullrivet is installed. The mount table still names the
// source of every bind, so the install path is not secret; hiding it would mean copying the
// runtime, about 100 MB, into memory for every session.
export const SANDBOX_WORKER_DIR = '/.nullrivet-worker';

const commandFor = (binary: string, sourceDir: string, tools: readonly string[]): string[] => {
  const args = [WORKER_ARGUMENT, '--tools', tools.join(',')];
  if (COMPILED) return [binary, ...args];
  return [binary, '--no-env-file', '--config=/dev/null', `${sourceDir}/main.ts`, ...args];
};

// The worker started on the host itself, as tests start it.
export const workerCommand = (tools: readonly string[]): string[] =>
  commandFor(process.execPath, SOURCE_DIR, tools);

export interface SandboxedWorker {
  command: string[];
  // Host paths and where the sandbox binds them, read-only.
  mounts: { source: string; target: string }[];
}

// The worker started inside a sandbox, from its files bound under SANDBOX_WORKER_DIR.
export const sandboxedWorker = (tools: readonly string[]): SandboxedWorker => {
  const binary = `${SANDBOX_WORKER_DIR}/${COMPILED ? 'nullrivet' : 'bun'}`;
  const sourceDir = `${SANDBOX_WORKER_DIR}/src`;
  return {
    command: commandFor(binary, sourceDir, tools),
    mounts: [
      { source: process.execPath, target: binary },
      ...(COMPILED ? [] : [{ source: SOURCE_DIR, target: sourceDir }]),
    ],
  };
};
