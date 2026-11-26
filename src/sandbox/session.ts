import { BackendLostError, type ToolBackend } from '../agent/tool-broker.ts';
import { errorMessage } from '../errors.ts';
import type { BackgroundJobs, JobEvent } from '../tools/jobs.ts';
import { type Tool, type ToolContext, type ToolResult, toolError } from '../tools/types.ts';
import type { JobProjection } from './job-projection.ts';
import type { StartedWorkspace, WorkspaceLaunch, WorkspaceSandbox } from './start.ts';
import { removeWorkspaceDirectory } from './workspace.ts';

// The background jobs of a session whose sandbox restarts: each sandbox reports its own jobs, and
// the agent reads them all through this one registry. The jobs of a sandbox that stopped are lost
// with it; their notes still reach the model with the next prompt, but start no turn of their own,
// as the projection of a stopped sandbox has it.
export class SessionJobs implements BackgroundJobs {
  private readonly projections: JobProjection[] = [];
  private readonly listeners = new Set<() => void>();
  // Jobs started by sandboxes whose projections were forgotten.
  private forgottenStarts = 0;

  // Adds the jobs of a sandbox that started; those of earlier sandboxes are forgotten once their
  // notes were delivered.
  attach(projection: JobProjection): void {
    this.prune();
    this.projections.push(projection);
    projection.onEvent(() => {
      for (const listener of this.listeners) listener();
    });
  }

  get startedCount(): number {
    return this.projections.reduce((sum, p) => sum + p.startedCount, this.forgottenStarts);
  }

  pendingEvents(): JobEvent[] {
    return this.projections.flatMap((p) => p.pendingEvents()).sort((a, b) => a.at - b.at);
  }

  // Each projection ignores the events of jobs it does not know: job ids carry the random prefix
  // of the sandbox's registry.
  markDelivered(events: readonly JobEvent[]): void {
    for (const projection of this.projections) projection.markDelivered(events);
    this.prune();
  }

  hasPendingEvents(): boolean {
    return this.projections.some((p) => p.hasPendingEvents());
  }

  onEvent(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dropEvents(): void {
    for (const projection of this.projections) projection.dropEvents();
    this.prune();
  }

  running(): number {
    return this.projections.reduce((sum, p) => sum + p.running(), 0);
  }

  private prune(): void {
    const latest = this.projections.at(-1);
    for (const projection of [...this.projections]) {
      if (projection === latest || projection.pendingEvents().length > 0) continue;
      this.forgottenStarts += projection.startedCount;
      this.projections.splice(this.projections.indexOf(projection), 1);
    }
  }
}

export interface Cycle<T> {
  result: T;
  // Why no sandbox runs after the cycle, or null when a new one started.
  stopped: string | null;
  warnings: string[];
}

// The tool backend of an interactive workspace session: one sandbox at a time, replaced by a new
// one, on a new overlay over the project as it is then, each time the operator applies or
// discards the changes. The overlay of a stopped sandbox is never mounted again: once the project
// under it changed, what the overlay shows of it is undefined.
//
// Calls made while the sandbox is replaced wait for the new one; a call the stop cut short gets a
// tool error, and the session goes on. A sandbox that fails on its own, or one that does not
// start, ends the session's tools for good, as with any sandbox: the reason can be a worker that
// misbehaved.
export class SandboxSession implements ToolBackend {
  readonly jobs = new SessionJobs();
  private current: WorkspaceSandbox | null;
  // Workers stopped on purpose: what they lose is not a failure of the session.
  private readonly stopping = new WeakSet<object>();
  private paused: Promise<void> | null = null;
  private lost: string | null = null;
  private closed = false;

  constructor(
    first: WorkspaceSandbox,
    private readonly launch: WorkspaceLaunch,
  ) {
    this.current = first;
    this.attachJobs(first);
  }

  // The workspace of the running sandbox, or of the one that failed; null once none is left.
  get workspace(): StartedWorkspace | null {
    return this.current?.workspace ?? null;
  }

  failure(): string | null {
    if (this.lost !== null) return this.lost;
    const current = this.current;
    if (current === null || this.stopping.has(current.backend)) return null;
    return current.backend.failure();
  }

  async execute(
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    while (this.paused !== null && !context.signal.aborted) {
      await untilAborted(this.paused, context.signal);
    }
    if (context.signal.aborted) {
      return toolError(
        'tool.cancelled',
        `${tool.name} was not executed: it was interrupted while the sandbox restarted`,
      );
    }
    const lost = this.failure();
    const current = this.current;
    if (lost !== null || current === null) {
      throw new BackendLostError(lost ?? 'the sandbox stopped');
    }
    try {
      return await current.backend.execute(tool, input, context);
    } catch (error) {
      if (!(error instanceof BackendLostError) || !this.stopping.has(current.backend)) throw error;
      return toolError(
        'sandbox.restarted',
        `${tool.name} did not complete: the sandbox stopped when the user applied or discarded its changes`,
        'A new sandbox runs on the project as it is now; repeat the call if it is still needed.',
      );
    }
  }

  // Stops the sandbox, runs `work` on its workspace once nothing writes it, removes the workspace
  // and starts a new sandbox, unless the session's tools have already failed or `restart` is
  // false, as when the session ends. Tool calls wait meanwhile. One cycle runs at a time. An error
  // `work` throws is thrown once the cycle is done.
  async cycle<T>(work: (workspace: StartedWorkspace) => T, restart = true): Promise<Cycle<T>> {
    if (this.paused !== null) throw new Error('the sandbox is already being replaced');
    const current = this.current;
    if (current === null) throw new Error(this.lost ?? 'no sandbox runs');
    let resume = (): void => undefined;
    this.paused = new Promise((resolve) => {
      resume = resolve;
    });
    let done: { result: T } | { error: unknown };
    let stopped: string | null;
    const warnings: string[] = [];
    try {
      // A sandbox that failed before stays failed: its failure is read before the stop hides it.
      const failed = this.failure();
      this.stopping.add(current.backend);
      await current.backend.close();
      try {
        done = { result: work(current.workspace) };
      } catch (error) {
        done = { error };
      }
      this.current = null;
      this.removeWorkspace(current.workspace, warnings);
      stopped = failed ?? (restart ? await this.restart(warnings) : 'the session ended');
      this.lost = stopped;
    } finally {
      this.paused = null;
      resume();
    }
    if ('error' in done) throw done.error;
    return { result: done.result, stopped, warnings };
  }

  // Starts the next sandbox; returns why none runs, or null.
  private async restart(warnings: string[]): Promise<string | null> {
    if (this.closed) return 'the session ended';
    const next = await this.launch();
    if ('error' in next) return `the sandbox did not restart: ${next.error}`;
    if (this.closed) {
      // The session ended while the sandbox started.
      this.stopping.add(next.backend);
      await next.backend.close();
      this.removeWorkspace(next.workspace, warnings);
      return 'the session ended';
    }
    this.current = { backend: next.backend, workspace: next.workspace };
    this.attachJobs(next);
    warnings.push(...next.warnings);
    return null;
  }

  private removeWorkspace(workspace: StartedWorkspace, warnings: string[]): void {
    try {
      removeWorkspaceDirectory(workspace.directory);
    } catch (error) {
      warnings.push(
        `the directory of the stopped sandbox, ${workspace.directory.path}, could not be removed: ${errorMessage(error)}; nullrivet removes it when it exits`,
      );
    }
  }

  // Stops the sandbox for good, at the end of the session. Its workspace is left to the caller; a
  // sandbox that a cycle under way starts is stopped by the cycle, with its workspace.
  async close(): Promise<void> {
    this.closed = true;
    const current = this.current;
    if (current === null) return;
    this.stopping.add(current.backend);
    await current.backend.close();
  }

  private attachJobs(sandbox: WorkspaceSandbox): void {
    const jobs = sandbox.backend.jobs;
    if (jobs === undefined) throw new Error('the workspace sandbox runs no background jobs');
    this.jobs.attach(jobs);
  }
}

// Resolves when `promise` settles or `signal` aborts, whichever comes first.
const untilAborted = (promise: Promise<void>, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    void promise.then(done);
  });
