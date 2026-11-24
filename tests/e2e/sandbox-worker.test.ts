import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_ARGUMENT } from '../../src/sandbox/protocol.ts';
import { WorkerBackend } from '../../src/sandbox/worker-backend.ts';
import { BUILTIN_TOOLS } from '../../src/tools/index.ts';
import type { Tool } from '../../src/tools/types.ts';
import { cliCommand } from './harness.ts';

const tool = (name: string): Tool => {
  const found = BUILTIN_TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// The worker is the CLI's own entry point started with the hidden argument, so this runs the
// sources or, with NULLRIVET_EXECUTABLE, the compiled binary, whose modules live in $bunfs.
describe.if(process.platform === 'linux')('the sandbox worker entry point', () => {
  test('serves tools over the protocol, grep in its thread included', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-e2e-worker-')));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.txt'), 'hay\nneedle here\n');
    const tools = ['grep', 'bash'];
    const backend = await WorkerBackend.start({
      launch: {
        command: cliCommand([WORKER_ARGUMENT, '--tools', tools.join(',')]),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
      },
      tools,
    });
    try {
      const signal = new AbortController().signal;
      const found = await backend.execute(
        tool('grep'),
        { pattern: 'needle' },
        { cwd: dir, signal },
      );
      expect(found.content).toBe('a.txt:2: needle here');
      const ran = await backend.execute(tool('bash'), { command: 'echo ok' }, { cwd: dir, signal });
      expect(ran.content).toContain('ok');
    } finally {
      await backend.close();
    }
  }, 30_000);
});
