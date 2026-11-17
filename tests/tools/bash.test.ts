import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { bashTool, buildChildEnv } from '../../src/tools/bash.ts';
import { MAX_FILE_BYTES } from '../../src/tools/file-io.ts';
import { grepTool } from '../../src/tools/grep.ts';
import { removeOutputFiles } from '../../src/tools/output-files.ts';
import { readFileTool } from '../../src/tools/read-file.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import { readParts, savedOutputs } from '../helpers/saved-output.ts';

let dir: string;

beforeEach(async () => {
  // Resolved, because pwd reports the physical path and the temporary directory can sit behind a
  // symbolic link (/var/folders is /private/var/folders on macOS).
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nullrivet-bash-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterAll(() => removeOutputFiles());

// What `seq 1 count` prints.
const sequence = (count: number): string =>
  `${Array.from({ length: count }, (_, i) => i + 1).join('\n')}\n`;

const ctx = (signal: AbortSignal = new AbortController().signal): ToolContext => ({
  cwd: dir,
  signal,
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (check: () => boolean, ms = 3_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
};

describe('bash tool', () => {
  test('captures stdout and the exit code', async () => {
    const result = await bashTool.execute({ command: 'echo hello' }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toBe('hello\n\n[exit code 0]');
    expect(result.meta?.exitCode).toBe(0);
    expect(result.touchedPaths).toEqual([dir]);
  });

  test('a non-zero exit is reported but is not a tool error', async () => {
    const result = await bashTool.execute({ command: 'echo oops >&2; exit 3' }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('[stderr]\noops');
    expect(result.content).toContain('[exit code 3]');
  });

  test('runs in a relative or absolute cwd, including outside the session directory', async () => {
    await mkdir(join(dir, 'sub'));
    const relative = await bashTool.execute({ command: 'pwd', cwd: 'sub' }, ctx());
    expect(relative.content).toStartWith(join(dir, 'sub'));
    const outside = await bashTool.execute({ command: 'pwd', cwd: tmpdir() }, ctx());
    expect(outside.isError).toBe(false);
  });

  test('rejects a cwd that does not exist', async () => {
    const result = await bashTool.execute({ command: 'pwd', cwd: 'missing' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.meta?.errorCode).toBe('fs.not_found');
  });

  test('stdin is empty, so commands that read it do not hang', async () => {
    const result = await bashTool.execute({ command: 'cat; echo done', timeout_ms: 5_000 }, ctx());
    expect(result.content).toContain('done');
    expect(result.meta?.termination).toBe('exited');
  });

  test('the command text is not visible to the command or its environment', async () => {
    const result = await bashTool.execute(
      { command: 'echo "[${__NULLRIVET_COMMAND:-unset}]"; env | grep -c __NULLRIVET || true' },
      ctx(),
    );
    expect(result.content).toStartWith('[unset]\n0');
  });

  test('agent credentials are removed from the child environment', () => {
    const env = buildChildEnv(
      { PATH: '/usr/bin', OPENROUTER_API_KEY: 'secret', NULLRIVET_MODEL: 'x', HOME: '/home/u' },
      'true',
    );
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.NULLRIVET_MODEL).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
  });

  test('background jobs are terminated when the command finishes', async () => {
    const pidFile = join(dir, 'bg.pid');
    const started = Date.now();
    const result = await bashTool.execute(
      { command: `sleep 30 & echo $! > ${pidFile}; echo started` },
      ctx(),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.content).toContain('started');
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  test('a timeout terminates the whole process group', async () => {
    const pidFile = join(dir, 'child.pid');
    const result = await bashTool.execute(
      { command: `sleep 30 & echo $! > ${pidFile}; sleep 30`, timeout_ms: 300 },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.meta?.termination).toBe('timeout');
    expect(result.content).toContain('timed out after 300ms');
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  test('an abort terminates the whole process group', async () => {
    const pidFile = join(dir, 'child.pid');
    const controller = new AbortController();
    const pending = bashTool.execute(
      { command: `sleep 30 & echo $! > ${pidFile}; sleep 30` },
      ctx(controller.signal),
    );
    await waitUntil(() => Bun.file(pidFile).size > 0);
    controller.abort();
    const result = await pending;
    expect(result.meta?.termination).toBe('aborted');
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  test('large output keeps the first and last lines', async () => {
    const result = await bashTool.execute({ command: 'seq 1 100000' }, ctx());
    expect(result.content).toStartWith('1\n2\n');
    expect(result.content).toContain('lines elided');
    expect(result.content).toContain('100000\n[exit code 0]\n[complete stdout (');
    expect(savedOutputs(result.content)).toHaveLength(1);
    expect(result.meta?.stdoutBytes).toBeGreaterThan(500_000);
  });

  test('rejects invalid arguments', async () => {
    await expect(bashTool.execute({ command: '' }, ctx())).rejects.toThrow(
      "'command' must not be empty",
    );
    await expect(bashTool.execute({ command: 'true', timeout_ms: 5 }, ctx())).rejects.toThrow(
      "'timeout_ms' must be >= 100",
    );
  });
});

describe('bash tool output files', () => {
  test('a small output is returned whole and not saved', async () => {
    const result = await bashTool.execute({ command: 'seq 1 100' }, ctx());
    expect(savedOutputs(result.content)).toEqual([]);
    expect(result.content).toBe(`${sequence(100)}\n[exit code 0]`);
  });

  test('the complete output is saved, beyond the memory bound of the capture', async () => {
    const result = await bashTool.execute({ command: 'seq 1 1000000' }, ctx());
    const outputs = savedOutputs(result.content);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toHaveLength(1);
    expect(result.content).toContain('dropped');
    expect(readParts(outputs[0] ?? []).toString()).toBe(sequence(1_000_000));
  });

  test('output reduced by its decoding but small in bytes is saved too', async () => {
    const result = await bashTool.execute(
      { command: "head -c 8000 /dev/zero | tr '\\0' '\\377'" },
      ctx(),
    );
    expect(result.content).toContain('dropped');
    const [parts = []] = savedOutputs(result.content);
    expect(readParts(parts).equals(Buffer.alloc(8000, 0xff))).toBe(true);
  });

  test('an output over the file size limit is split into parts read_file and grep accept', async () => {
    const result = await bashTool.execute({ command: 'seq 1 2000000' }, ctx());
    const [parts = []] = savedOutputs(result.content);
    expect(parts).toHaveLength(2);
    const [first = '', last = ''] = parts;
    for (const part of parts) expect(statSync(part).size).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect(readFileSync(first).at(-1)).toBe(0x0a);
    expect(readParts(parts).toString()).toBe(sequence(2_000_000));

    expect(readFileTool.effect).toBe('read');
    const read = await readFileTool.execute({ path: last, offset: 0, limit: 1 }, ctx());
    expect(read.isError).toBe(false);
    expect(read.content).toMatch(/^\d+\n/);
    expect(grepTool.effect).toBe('read');
    const found = await grepTool.execute(
      {
        pattern: '^1999999$',
        path: dirname(last),
        glob: basename(last).replace(/\.\d+\.txt$/, '.*.txt'),
      },
      ctx(),
    );
    expect(found.content).toContain(`${basename(last)}:`);
    expect(found.content).toContain(': 1999999');
  });

  test('stdout and stderr are saved to separate files', async () => {
    const result = await bashTool.execute(
      { command: 'seq 1 200000 & seq 1 200000 >&2; wait' },
      ctx(),
    );
    const outputs = savedOutputs(result.content);
    expect(outputs).toHaveLength(2);
    expect(result.content).toMatch(
      /\[exit code 0\]\n\[complete stdout .+\]\n\[complete stderr .+\]$/,
    );
    expect(outputs[0]?.[0]).toContain('-bash-stdout.001.txt');
    expect(outputs[1]?.[0]).toContain('-bash-stderr.001.txt');
    for (const parts of outputs) expect(readParts(parts).toString()).toBe(sequence(200_000));
  });

  test('a timeout marks the saved output as interrupted', async () => {
    const result = await bashTool.execute(
      { command: 'seq 1 100000; sleep 30', timeout_ms: 1_000 },
      ctx(),
    );
    expect(result.content).toContain('[interrupted stdout (');
    expect(result.content).toContain('received before the command timed out');
    const [parts = []] = savedOutputs(result.content);
    expect(readParts(parts).toString()).toBe(sequence(100_000));
  });

  test('output cut off by killing processes left running is marked as interrupted', async () => {
    const result = await bashTool.execute(
      { command: `(trap '' TERM; seq 1 100000; exec sleep 30) & sleep 0.5` },
      ctx(),
    );
    expect(result.content).toContain(
      'received before the processes the command left running were killed',
    );
  }, 10_000);
});
