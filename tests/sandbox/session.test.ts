import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeToolCall } from '../../src/agent/tool-broker.ts';
import { confirmationCode, WorkspaceSession } from '../../src/cli/workspace-session.ts';
import { SandboxSession } from '../../src/sandbox/session.ts';
import type { WorkspaceLaunch } from '../../src/sandbox/start.ts';
import { WorkerBackend } from '../../src/sandbox/worker-backend.ts';
import { workerCommand } from '../../src/sandbox/worker-command.ts';
import {
  createWorkspaceDirectory,
  referenceTime,
  removeLiveWorkspaceDirectories,
} from '../../src/sandbox/workspace.ts';
import { BUILTIN_TOOLS } from '../../src/tools/index.ts';
import { createJobTools } from '../../src/tools/jobs.ts';
import type { Tool } from '../../src/tools/types.ts';
import { tmpfsDirectory } from '../helpers/sandbox.ts';

// The session's mechanics, with workers that run without a sandbox: what a sandbox writes is put
// in the upper directory by the test itself.

const jobTools = createJobTools(null, 'interactive');
const TOOLS = ['bash', ...jobTools.map((t) => t.name)];
const tool = (name: string): Tool => {
  const found = [...BUILTIN_TOOLS, ...jobTools].find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

const dirs: string[] = [];
const sessions: SandboxSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  removeLiveWorkspaceDirectories();
  for (const dir of dirs.splice(0)) {
    Bun.spawnSync(['chmod', '-R', 'u+rwx', dir]);
    Bun.spawnSync(['rm', '-rf', dir]);
  }
});

const setup = (options: { failAfter?: number } = {}) => {
  const runtime = tmpfsDirectory('nullrivet-session-');
  const project = join(runtime, 'project');
  mkdirSync(project);
  dirs.push(runtime);
  let launches = 0;
  const launch: WorkspaceLaunch = async () => {
    launches += 1;
    if (options.failAfter !== undefined && launches > options.failAfter) {
      return { error: 'bubblewrap is gone' };
    }
    const created = createWorkspaceDirectory({ XDG_RUNTIME_DIR: runtime });
    if ('error' in created) return created;
    const since = referenceTime(created.directory, project);
    const backend = await WorkerBackend.start({
      launch: {
        command: workerCommand(TOOLS, 'interactive'),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir() },
      },
      tools: TOOLS,
      jobs: true,
    });
    return {
      backend,
      workspace: { directory: created.directory, root: project, since },
      warnings: [],
    };
  };
  return { runtime, project, launch, launches: () => launches };
};

const start = async (w: ReturnType<typeof setup>): Promise<SandboxSession> => {
  const first = await w.launch();
  if ('error' in first) throw new Error(first.error);
  const session = new SandboxSession(first, w.launch);
  sessions.push(session);
  return session;
};

const call = (
  session: SandboxSession,
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) =>
  executeToolCall(
    { id: 'c', name, input },
    {
      tools: new Map([[name, tool(name)]]),
      mode: 'auto',
      cwd: tmpdir(),
      signal: signal ?? new AbortController().signal,
      backend: session,
    },
  );

describe.if(process.platform === 'linux')('a restartable sandbox session', () => {
  test('replaces its sandbox and its directory, and runs later calls in the new one', async () => {
    const w = setup();
    const session = await start(w);
    const first = session.workspace;
    if (first === null) throw new Error('no workspace');
    const cycle = await session.cycle((workspace) => workspace.directory.path);
    expect(cycle).toEqual({ result: first.directory.path, stopped: null, warnings: [] });
    expect(existsSync(first.directory.path)).toBe(false);
    expect(session.workspace?.directory.path).not.toBe(first.directory.path);
    expect(existsSync(session.workspace?.directory.upper ?? '')).toBe(true);
    expect(session.failure()).toBeNull();
    expect((await call(session, 'bash', { command: 'echo again' })).content).toContain('again');
  }, 30_000);

  test('cuts a call short with a tool error, and makes calls wait until the new sandbox runs', async () => {
    const w = setup();
    const session = await start(w);
    const running = call(session, 'bash', { command: 'sleep 10' });
    await Bun.sleep(300);
    let waited: Promise<{ content: string }> | null = null;
    const cycle = session.cycle(() => {
      // Made while the sandbox is replaced: it waits for the new one.
      waited = call(session, 'bash', { command: 'echo after' });
    });
    const cut = await running;
    expect(cut.isError).toBe(true);
    expect(cut.content).toContain('sandbox.restarted');
    await cycle;
    expect((await (waited as unknown as Promise<{ content: string }>)).content).toContain('after');
    expect(session.failure()).toBeNull();
  }, 30_000);

  test('gives up a call that waits for the sandbox when the task is interrupted', async () => {
    const w = setup();
    const session = await start(w);
    const controller = new AbortController();
    let waited: Promise<{ content: string }> | null = null;
    await session.cycle(() => {
      waited = call(session, 'bash', { command: 'echo never' }, controller.signal);
      controller.abort();
    });
    expect((await (waited as unknown as Promise<{ content: string }>)).content).toContain(
      'tool.cancelled',
    );
  }, 30_000);

  test('counts the jobs of every sandbox, and reports those of a stopped one as lost', async () => {
    const w = setup();
    const session = await start(w);
    await call(session, 'bash_background', { command: 'sleep 30' });
    expect(session.jobs.running()).toBe(1);
    await session.cycle(() => undefined);
    expect(session.jobs.running()).toBe(0);
    expect(session.jobs.pendingEvents().map((e) => e.type)).toEqual(['job.lost']);
    // The note of a stopped sandbox goes with the next prompt, and starts no turn.
    expect(session.jobs.hasPendingEvents()).toBe(false);
    await call(session, 'bash_background', { command: 'sleep 30' });
    expect(session.jobs.startedCount).toBe(2);
    expect(session.jobs.running()).toBe(1);
    session.jobs.markDelivered(session.jobs.pendingEvents());
    expect(session.jobs.pendingEvents()).toEqual([]);
    expect(session.jobs.startedCount).toBe(2);
  }, 30_000);

  test('ends its tools for good when the new sandbox does not start', async () => {
    const w = setup({ failAfter: 1 });
    const session = await start(w);
    const cycle = await session.cycle(() => 'done');
    expect(cycle.stopped).toBe('the sandbox did not restart: bubblewrap is gone');
    expect(session.workspace).toBeNull();
    const refused = await call(session, 'bash', { command: 'echo x' });
    expect(refused.content).toContain('sandbox.lost');
    expect(refused.content).toContain('did not restart');
  }, 30_000);

  test('keeps a sandbox that failed on its own failed, and starts no other', async () => {
    const w = setup();
    const session = await start(w);
    // The worker is ended from outside, as a crash would.
    const backend = (session as unknown as { current: { backend: WorkerBackend } }).current.backend;
    (backend as unknown as { child: { kill: (s: string) => void } }).child.kill('SIGKILL');
    const deadline = Date.now() + 5_000;
    while (session.failure() === null && Date.now() < deadline) await Bun.sleep(20);
    const failed = session.failure();
    expect(failed).not.toBeNull();
    const cycle = await session.cycle(() => undefined);
    expect(cycle.stopped).toBe(failed);
    expect(w.launches()).toBe(1);
  }, 30_000);
});

describe.if(process.platform === 'linux')('the changes of a workspace session', () => {
  test('applies what was shown, and leaves out what changed after it, with what depends on it', async () => {
    const w = setup();
    const session = await start(w);
    const notes: { text: string; data?: string }[] = [];
    const changes = new WorkspaceSession(w.project, session, (note) => notes.push(note));
    const upper = session.workspace?.directory.upper ?? '';
    writeFileSync(join(upper, 'shown.txt'), 'shown\n');
    writeFileSync(join(upper, 'edited.txt'), 'first\n');
    mkdirSync(join(upper, 'lib'));
    writeFileSync(join(upper, 'lib', 'a.txt'), 'a\n');
    const preview = changes.preview();
    if ('error' in preview) throw new Error(preview.error);
    expect(preview.pending).toBe(3);
    // What the sandbox does between the preview and the application.
    writeFileSync(join(upper, 'edited.txt'), 'second\n');
    writeFileSync(join(upper, 'late.txt'), 'late\n');
    const applied = await changes.apply(preview);
    expect(applied.failure).toBeNull();
    expect(applied.stopped).toBeNull();
    expect(applied.report?.applied.sort()).toEqual(['lib', 'lib/a.txt', 'shown.txt']);
    expect(applied.report?.notApplied).toEqual([
      { path: 'edited.txt', status: 'conflict', reason: 'it changed after the changes were shown' },
      { path: 'late.txt', status: 'conflict', reason: 'it changed after the changes were shown' },
    ]);
    expect(readFileSync(join(w.project, 'shown.txt'), 'utf8')).toBe('shown\n');
    expect(existsSync(join(w.project, 'edited.txt'))).toBe(false);
    // The new sandbox starts empty: nothing of the earlier one is left to apply.
    const after = changes.preview();
    expect('error' in after ? after.error : after.entries).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('3 applied, 2 not applied and discarded');
    expect(notes[0]?.data).toContain(
      'not applied (conflict, it changed after the changes were shown): late.txt',
    );
  }, 30_000);

  test('applies a file again once the new sandbox changed it again', async () => {
    const w = setup();
    const session = await start(w);
    const changes = new WorkspaceSession(w.project, session, () => undefined);
    for (const content of ['first\n', 'second\n']) {
      // The new sandbox starts right after the earlier application wrote the file.
      writeFileSync(join(session.workspace?.directory.upper ?? '', 'app.txt'), content);
      const preview = changes.preview();
      if ('error' in preview) throw new Error(preview.error);
      const applied = await changes.apply(preview);
      expect(applied.report).toEqual({ applied: ['app.txt'], notApplied: [], stopped: null });
      expect(readFileSync(join(w.project, 'app.txt'), 'utf8')).toBe(content);
    }
  }, 30_000);

  test('a new directory changed after it was shown is left out, with its content', async () => {
    const w = setup();
    const session = await start(w);
    const changes = new WorkspaceSession(w.project, session, () => undefined);
    const upper = session.workspace?.directory.upper ?? '';
    mkdirSync(join(upper, 'lib'), { mode: 0o755 });
    writeFileSync(join(upper, 'lib', 'a.txt'), 'a\n');
    const preview = changes.preview();
    if ('error' in preview) throw new Error(preview.error);
    Bun.spawnSync(['chmod', '700', join(upper, 'lib')]);
    const applied = await changes.apply(preview);
    expect(applied.report?.applied).toEqual([]);
    expect(applied.report?.notApplied.map((e) => [e.path, e.reason])).toEqual([
      ['lib', 'it changed after the changes were shown'],
      ['lib/a.txt', 'an entry it depends on is not applied'],
    ]);
    expect(existsSync(join(w.project, 'lib'))).toBe(false);
  }, 30_000);

  test('discards the changes, and tells the model which', async () => {
    const w = setup();
    const session = await start(w);
    const notes: { text: string; data?: string }[] = [];
    const changes = new WorkspaceSession(w.project, session, (note) => notes.push(note));
    writeFileSync(join(session.workspace?.directory.upper ?? '', 'new.txt'), 'x\n');
    const preview = changes.preview();
    if ('error' in preview) throw new Error(preview.error);
    const discarded = await changes.discard(preview);
    expect(discarded.stopped).toBeNull();
    expect(existsSync(join(w.project, 'new.txt'))).toBe(false);
    expect(notes[0]?.text).toContain("The user discarded the sandbox's changes: 1 entry");
    expect(notes[0]?.data).toBe('added: new.txt');
  }, 30_000);

  test('reads the changes while the sandbox runs without changing them', async () => {
    const w = setup();
    const session = await start(w);
    const changes = new WorkspaceSession(w.project, session, () => undefined);
    const upper = session.workspace?.directory.upper ?? '';
    writeFileSync(join(upper, 'locked.txt'), 'x\n', { mode: 0o000 });
    const preview = changes.preview();
    if ('error' in preview) throw new Error(preview.error);
    expect(preview.entries).toEqual([
      {
        path: 'locked.txt',
        change: 'refused',
        kind: 'other',
        reason: 'an entry the sandbox left without read permission is not applied',
      },
    ]);
    expect(Bun.spawnSync(['stat', '-c', '%a', join(upper, 'locked.txt')]).stdout.toString()).toBe(
      '0\n',
    );
  }, 30_000);

  test('a confirmation code is four hexadecimal digits, new each time', () => {
    const codes = new Set(Array.from({ length: 20 }, confirmationCode));
    for (const code of codes) expect(code).toMatch(/^[0-9A-F]{4}$/);
    expect(codes.size).toBeGreaterThan(1);
  });
});
