import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startProcess } from '../../src/tools/process.ts';
import { TempDirs } from './fixtures.ts';

const temp = new TempDirs();

afterEach(() => temp.cleanup());

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

const bash = (command: string, cwd: string) => ({
  file: 'bash',
  args: ['-c', command],
  cwd,
  env: { PATH: process.env.PATH ?? '' },
});

describe('startProcess', () => {
  test('resolves once the process exists, and done with its result', async () => {
    const cwd = temp.create('process');
    const handle = await startProcess(bash('echo out; echo err >&2; exit 4', cwd));
    expect(handle.pid).toBeGreaterThan(0);
    const result = await handle.done;
    expect(result.exitCode).toBe(4);
    expect(result.termination).toBe('exited');
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
  });

  test('rejects when the program cannot start', async () => {
    const cwd = temp.create('process');
    await expect(
      startProcess({ file: 'nullrivet-no-such-program', args: [], cwd, env: {} }),
    ).rejects.toThrow();
  });

  test('terminate ends the whole process group', async () => {
    const cwd = temp.create('process');
    const pidFile = join(cwd, 'child.pid');
    const handle = await startProcess(bash(`sleep 30 & echo $! > ${pidFile}; sleep 30`, cwd));
    expect(await waitUntil(() => Bun.file(pidFile).size > 0)).toBe(true);
    handle.terminate('aborted');
    const result = await handle.done;
    expect(result.termination).toBe('aborted');
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntil(() => !isAlive(child) && !isAlive(handle.pid))).toBe(true);
  });

  test('only the first termination counts, and none after the process exited', async () => {
    const cwd = temp.create('process');
    // bash exits at once while a process that ignores SIGTERM keeps the pipes open for a while,
    // so terminate arrives after the exit but before the run ends.
    const handle = await startProcess(bash(`(trap '' TERM; sleep 1) & exit 0`, cwd));
    // Once bash is reaped its exit has been seen; the short margin covers the event delivery.
    expect(await waitUntil(() => !isAlive(handle.pid))).toBe(true);
    await Bun.sleep(50);
    handle.terminate('aborted');
    const result = await handle.done;
    expect(result.termination).toBe('exited');
    expect(result.exitCode).toBe(0);

    const second = await startProcess(bash('sleep 30', cwd));
    second.terminate('timeout');
    second.terminate('aborted');
    expect((await second.done).termination).toBe('timeout');
  });

  test('a timeout and an abort signal are optional', async () => {
    const cwd = temp.create('process');
    const controller = new AbortController();
    const handle = await startProcess({
      ...bash('sleep 30', cwd),
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort();
    expect((await handle.done).termination).toBe('aborted');

    const timed = await startProcess({ ...bash('sleep 30', cwd), timeoutMs: 100 });
    expect((await timed.done).termination).toBe('timeout');
  });
});
