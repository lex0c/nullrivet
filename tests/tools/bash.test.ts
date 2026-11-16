import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool, buildChildEnv } from '../../src/tools/bash.ts';
import type { ToolContext } from '../../src/tools/types.ts';

let dir: string;

beforeEach(async () => {
  // Resolved, because pwd reports the physical path and the temporary directory can sit behind a
  // symbolic link (/var/folders is /private/var/folders on macOS).
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nullrivet-bash-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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
    expect(result.content).toContain('100000\n[exit code 0]');
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
