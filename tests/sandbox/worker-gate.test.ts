import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxHost } from '../../src/sandbox/bwrap.ts';
import {
  gateDescriptors,
  type Launched,
  WorkerBackend,
  type WorkerBackendOptions,
} from '../../src/sandbox/worker-backend.ts';
import { workerCommand } from '../../src/sandbox/worker-command.ts';
import { sandboxTestsRun } from '../helpers/sandbox.ts';

const linux = process.platform === 'linux';
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nullrivet-gate-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const { status, gate } = gateDescriptors(0);
// A launcher as Bubblewrap is one: it reports itself, waits on its gate, then runs the worker,
// leaving a marker once it passed the gate.
const LAUNCHER = join(scratch, 'launcher');
writeFileSync(
  LAUNCHER,
  `#!/bin/sh\nprintf '{"child-pid": %s}\\n' "$$" >&${status}\nhead -c 1 <&${gate} >/dev/null\nmarker=$1\nshift\ntouch "$marker"\nexec "$@"\n`,
);
// One that does not wait.
const EAGER = join(scratch, 'eager');
writeFileSync(
  EAGER,
  `#!/bin/sh\nprintf '{"child-pid": %s}\\n' "$$" >&${status}\nmarker=$1\nshift\ntouch "$marker"\nexec "$@"\n`,
);
// One that exits and leaves a process of its group waiting on the gate.
const LEAVING = join(scratch, 'leaving');
writeFileSync(
  LEAVING,
  `#!/bin/sh\nprintf '{"child-pid": %s}\\n' "$$" >&${status}\n( head -c 1 <&${gate} >/dev/null; touch "$1" ) &\nsleep 0.2\nexit 3\n`,
);
chmodSync(LAUNCHER, 0o755);
chmodSync(EAGER, 0o755);
chmodSync(LEAVING, 0o755);

let markers = 0;
const marker = (): string => {
  markers += 1;
  return join(scratch, `ran-${markers}`);
};

const backends: WorkerBackend[] = [];
afterAll(async () => {
  await Promise.all(backends.map((backend) => backend.close()));
});

const gated = (
  launcher: string,
  ran: string,
  prepare: (launched: Launched) => Promise<void>,
  options: Partial<WorkerBackendOptions> = {},
) =>
  WorkerBackend.start({
    launch: {
      command: [launcher, ran, ...workerCommand(['read_file'])],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir() },
      gate: true,
    },
    tools: ['read_file'],
    prepare,
    ...options,
  }).then((backend) => {
    backends.push(backend);
    return backend;
  });

// Nothing ran past the gate: checked again a while later, when a release would have shown.
const neverRan = async (ran: string): Promise<void> => {
  expect(existsSync(ran)).toBe(false);
  await Bun.sleep(500);
  expect(existsSync(ran)).toBe(false);
};

describe.if(linux)('a gated worker', () => {
  test('is released once prepared, and only then', async () => {
    const ran = marker();
    let seen: Launched | null = null;
    const backend = await gated(LAUNCHER, ran, async (launched) => {
      seen = launched;
      await Bun.sleep(200);
      expect(existsSync(ran)).toBe(false);
    });
    expect(existsSync(ran)).toBe(true);
    expect(seen).not.toBeNull();
    const launched = seen as unknown as Launched;
    expect(launched.status).toBe(`{"child-pid": ${launched.pid}}`);
    expect(backend.failure()).toBeNull();
  });

  test('is never released when its preparation fails', async () => {
    const ran = marker();
    await expect(
      gated(LAUNCHER, ran, async () => {
        throw new Error('no network');
      }),
    ).rejects.toThrow('the sandbox was not prepared: no network');
    await neverRan(ran);
  });

  test('is never released when its preparation takes too long', async () => {
    const ran = marker();
    await expect(
      gated(LAUNCHER, ran, () => new Promise(() => undefined), { prepareTimeoutMs: 300 }),
    ).rejects.toThrow('the sandbox was not prepared: not prepared within 300 ms');
    await neverRan(ran);
  });

  test('is never released when its start is given up during the preparation', async () => {
    const ran = marker();
    const giveUp = new AbortController();
    setTimeout(() => giveUp.abort(), 200);
    await expect(
      gated(LAUNCHER, ran, () => new Promise(() => undefined), { signal: giveUp.signal }),
    ).rejects.toThrow('the start of the sandbox was given up');
    await neverRan(ran);
  });

  test('is never released by a process its launcher left on the gate', async () => {
    const ran = marker();
    // Its launcher gone, the process it left is killed, and confirmed gone, before the gate closes.
    const error = await gated(LEAVING, ran, () => Bun.sleep(1_000)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('the worker exited with code 3');
    await neverRan(ran);
  });

  test('is lost when the worker says it is ready before it was released', async () => {
    await expect(gated(EAGER, marker(), () => Bun.sleep(1_000))).rejects.toThrow(
      'the worker sent worker.ready before it was released',
    );
  });

  test('needs a preparation, which an ungated launch does not take', async () => {
    await expect(
      WorkerBackend.start({
        launch: { command: [LAUNCHER], env: {}, gate: true },
        tools: [],
      }),
    ).rejects.toThrow('a gated launch needs a preparation');
  });
});

describe.if(sandboxTestsRun)("Bubblewrap's gate", () => {
  // Why a gate is closed only once its launcher is confirmed gone.
  test('opens on an end of file as on data', async () => {
    const host = sandboxHost();
    if (typeof host === 'string') throw new Error(host);
    const ran = marker();
    const child = spawn(
      host.bwrap,
      [
        '--unshare-all',
        '--unshare-user',
        '--die-with-parent',
        '--ro-bind',
        '/',
        '/',
        '--bind',
        scratch,
        scratch,
        '--block-fd',
        '3',
        'touch',
        ran,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] },
    );
    await Bun.sleep(300);
    expect(existsSync(ran)).toBe(false);
    child.stdio[3]?.destroy();
    await new Promise((resolve) => child.once('exit', resolve));
    expect(existsSync(ran)).toBe(true);
  });
});
