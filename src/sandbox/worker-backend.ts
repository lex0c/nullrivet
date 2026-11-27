import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { BackendLostError, type ToolBackend } from '../agent/tool-broker.ts';
import { BoundedCapture } from '../context/bounded-capture.ts';
import { errorMessage } from '../errors.ts';
import { terminalText } from '../sanitize/display.ts';
import { KILL_GRACE_MS, trackProcessGroup } from '../tools/process.ts';
import { type Tool, type ToolContext, type ToolResult, toolError } from '../tools/types.ts';
import { JobProjection } from './job-projection.ts';
import { LineSplitter } from './lines.ts';
import {
  encodeMessage,
  environmentProblem,
  type HostToWorker,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  parseWorkerMessage,
  type WorkerToHost,
} from './protocol.ts';

// How the worker process is started: directly, or inside a sandbox. `inputs` are written to the
// descriptors after the protocol ones (5, 6, ...) and closed, for a launcher that reads
// configuration from descriptors, as bubblewrap does.
export interface WorkerLaunch {
  command: readonly string[];
  // The whole environment of the started process; nothing is inherited.
  env: Record<string, string>;
  inputs?: readonly Uint8Array[];
  // The launcher reports itself on a status descriptor, a first line of JSON, then waits on a gate
  // descriptor until released, as Bubblewrap's --json-status-fd and --block-fd do. Both follow the
  // inputs, at the numbers `gateDescriptors` gives.
  gate?: boolean;
}

// What a gated launcher reported, given to the preparation before its release.
export interface Launched {
  // The launcher's process, whose group holds everything it started.
  pid: number;
  status: string;
}

export interface WorkerBackendOptions {
  launch: WorkerLaunch;
  // The tools the worker must offer, exactly.
  tools: readonly string[];
  readyTimeoutMs?: number;
  // How long a cancelled call may take to return its result.
  cancelGraceMs?: number;
  // The worker runs background jobs, and reports them as they happen.
  jobs?: boolean;
  // For a gated launch: run once the launcher reported itself, before it is released. The worker
  // starts only when it resolves, within the preparation's time. A start that fails does not wait
  // for it: the caller does, before it undoes what the preparation made.
  prepare?: (launched: Launched) => Promise<void>;
  prepareTimeoutMs?: number;
  // Gives up a start still under way, gated or not.
  signal?: AbortSignal;
  // Variables the worker's commands inherit, sent on the protocol's descriptors once it is ready
  // and before any call: a launcher's arguments and environment are readable by every user.
  environment?: Record<string, string>;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
// A cancelled command gets SIGTERM, then SIGKILL after the kill grace, then up to the same grace
// for its output to close: the result can take twice the grace, plus a margin.
const DEFAULT_CANCEL_GRACE_MS = 2 * KILL_GRACE_MS + 3_000;
const SHUTDOWN_GRACE_MS = 3_000;
// The worker waits up to ten seconds for each job it stops, all at once.
const JOBS_STOP_TIMEOUT_MS = 15_000;
const STDERR_CAPTURE_BYTES = 16 * 1024;
const STDERR_SHOWN_CHARS = 2_000;
// Where the protocol descriptors are in the child's stdio, and where launcher inputs start.
const PROTOCOL_STDIO = ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] as const;
const PREPARE_TIMEOUT_MS = 30_000;
// How long the processes of a launcher that was not released may take to be gone once killed.
const ENDED_TIMEOUT_MS = 5_000;
const POLL_MS = 20;

// The descriptors of a gated launcher, after `inputs` launcher inputs.
export const gateDescriptors = (inputs: number): { status: number; gate: number } => ({
  status: PROTOCOL_STDIO.length + inputs,
  gate: PROTOCOL_STDIO.length + inputs + 1,
});

// Gates whose launcher could not be confirmed ended: closing their last writer would release it,
// so they stay open for as long as this process lives.
const shut: Writable[] = [];

interface PendingCall {
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

const seconds = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

// Values from the worker named in the reason of a loss, which reaches the model in every refused
// call and the interface, are cut: a line can be megabytes long.
const SHOWN_VALUE_CHARS = 200;
const shown = (value: string): string =>
  value.length <= SHOWN_VALUE_CHARS ? value : `${value.slice(0, SHOWN_VALUE_CHARS)}...`;

// Runs tool calls in a worker process over the protocol. Everything the worker sends is checked;
// a violation, the worker's exit or a closed descriptor makes the backend lost for good: pending
// calls fail, later ones are refused, and the process group is killed.
export class WorkerBackend implements ToolBackend {
  private readonly pending = new Map<string, PendingCall>();
  private readonly offered: ReadonlySet<string>;
  private readonly stderr = new BoundedCapture(STDERR_CAPTURE_BYTES);
  private readonly cancelGraceMs: number;
  private lost: string | null = null;
  private closing = false;
  // The background jobs the worker runs, when it was started with them.
  readonly jobs: JobProjection | undefined;
  private ready = false;
  private sequence = 0;
  private untrack: () => void = () => undefined;
  // Whether a gated launcher was released, or the launch has no gate.
  private released: boolean;
  private readonly exited: Promise<void>;
  private readonly toWorker: Writable;
  private onReady: ((error: Error | null) => void) | null = null;
  // The stop of the jobs asked for and not answered yet.
  private stoppingJobs: {
    promise: Promise<void>;
    answer: (running: number) => void;
    abandon: (reason: string) => void;
  } | null = null;

  private constructor(
    private readonly child: ChildProcess,
    options: WorkerBackendOptions,
  ) {
    this.offered = new Set(options.tools);
    this.released = options.launch.gate !== true;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.jobs = options.jobs === true ? new JobProjection() : undefined;
    this.toWorker = child.stdio[3] as Writable;
    const fromWorker = child.stdio[4] as Readable;
    if (child.pid !== undefined) this.untrack = trackProcessGroup(child.pid);
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.untrack();
        const how = signal === null ? `with code ${code}` : `on ${signal}`;
        this.lose(`the worker exited ${how}`);
        resolve();
      });
    });
    child.once('error', (error) => this.lose(`the worker could not start: ${error.message}`));
    child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk));
    const splitter = new LineSplitter(
      MAX_LINE_BYTES,
      (line) => this.receive(line),
      () => this.lose('the worker sent a line over the size limit'),
    );
    fromWorker.on('data', (chunk: Buffer) => splitter.push(chunk));
    fromWorker.on('end', () => this.lose('the worker closed its protocol descriptor'));
    fromWorker.on('error', (error) =>
      this.lose(`the protocol descriptor failed: ${error.message}`),
    );
    this.toWorker.on('error', (error) =>
      this.lose(`the protocol descriptor failed: ${error.message}`),
    );
  }

  // Starts the worker and resolves once it is ready, or rejects with why it is not; a worker that
  // did not get ready is not left running.
  static start(options: WorkerBackendOptions): Promise<WorkerBackend> {
    const inputs = options.launch.inputs ?? [];
    const environment =
      options.environment === undefined ? null : environmentProblem(options.environment);
    if (environment !== null) {
      return Promise.reject(new Error(`the worker would refuse its environment: ${environment}`));
    }
    const gated = options.launch.gate === true;
    const [file, ...args] = options.launch.command;
    if (file === undefined) return Promise.reject(new Error('the worker command is empty'));
    if (gated !== (options.prepare !== undefined)) {
      return Promise.reject(new Error('a gated launch needs a preparation, and only one has it'));
    }
    const child = spawn(file, args, {
      stdio: [
        ...PROTOCOL_STDIO,
        ...inputs.map(() => 'pipe' as const),
        ...(gated ? (['pipe', 'pipe'] as const) : []),
      ],
      env: options.launch.env,
      // In a group of its own, so an interrupt in the terminal does not reach it and the exit
      // handler can kill everything it started.
      detached: true,
      cwd: '/',
    });
    inputs.forEach((data, index) => {
      const stream = child.stdio[PROTOCOL_STDIO.length + index] as Writable;
      stream.on('error', () => undefined);
      stream.end(data);
    });
    const backend = new WorkerBackend(child, options);
    const abort = (): void => backend.lose('the start of the sandbox was given up');
    if (options.signal?.aborted === true) abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const started = gated ? backend.passGate(options, inputs.length) : backend.whenReady(options);
    return started.finally(() => options.signal?.removeEventListener('abort', abort));
  }

  private whenReady(options: WorkerBackendOptions): Promise<WorkerBackend> {
    const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      if (this.lost !== null) {
        reject(new Error(this.lost));
        return;
      }
      const timer = setTimeout(
        () => this.lose(`the worker was not ready within ${seconds(timeoutMs)}`),
        timeoutMs,
      );
      this.onReady = (error) => {
        clearTimeout(timer);
        this.onReady = null;
        if (error !== null) {
          reject(error);
          return;
        }
        if (options.environment !== undefined) {
          this.send({ type: 'worker.environment', variables: options.environment });
        }
        resolve(this);
      };
    });
  }

  // Reads the launcher's report, runs the preparation, and releases the launcher only when it
  // succeeded. Otherwise the launcher is killed and its group confirmed empty before the gate is
  // closed: an end of file on the gate releases the launcher as data does.
  private async passGate(options: WorkerBackendOptions, inputs: number): Promise<WorkerBackend> {
    const { status: statusFd, gate: gateFd } = gateDescriptors(inputs);
    const status = this.child.stdio[statusFd] as Readable;
    const gate = this.child.stdio[gateFd] as Writable;
    status.on('error', () => undefined);
    gate.on('error', () => undefined);
    const pid = this.child.pid;
    const prepareTimeoutMs = options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (pid === undefined) throw new Error(this.lost ?? 'the launcher did not start');
      const prepared = (async () => {
        const line = await this.firstLine(status);
        await (options.prepare as NonNullable<WorkerBackendOptions['prepare']>)({
          pid,
          status: line,
        });
      })();
      // The preparation is not waited for once the start is given up or the launcher is lost.
      prepared.catch(() => undefined);
      await Promise.race([
        prepared,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`not prepared within ${seconds(prepareTimeoutMs)}`)),
            prepareTimeoutMs,
          );
          this.onReady = (error) => {
            if (error !== null) reject(error);
          };
        }),
      ]);
      this.onReady = null;
      if (this.lost !== null) throw new Error(this.lost);
    } catch (error) {
      this.lose(`the sandbox was not prepared: ${errorMessage(error)}`);
      const reason = this.lost ?? errorMessage(error);
      if (await this.groupEnded()) {
        gate.destroy();
        status.destroy();
        throw new Error(reason);
      }
      shut.push(gate);
      throw new Error(
        `${reason}; its processes could not be confirmed ended, so its gate stays shut`,
      );
    } finally {
      clearTimeout(deadline);
    }
    this.released = true;
    gate.end('x');
    // The launcher reports its exit there too; nothing more is read.
    status.resume();
    return this.whenReady(options);
  }

  // The first line the launcher writes on its status descriptor.
  private firstLine(status: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = '';
      const onData = (chunk: Buffer): void => {
        text += chunk.toString();
        const end = text.indexOf('\n');
        if (end !== -1) {
          finish();
          resolve(text.slice(0, end));
        } else if (text.length > MAX_LINE_BYTES) {
          finish();
          reject(new Error('the launcher reported a line over the size limit'));
        }
      };
      const onEnd = (): void => {
        finish();
        reject(new Error(this.lost ?? 'the launcher reported nothing'));
      };
      const finish = (): void => {
        status.off('data', onData);
        status.off('end', onEnd);
        status.pause();
      };
      status.on('data', onData);
      status.on('end', onEnd);
    });
  }

  // Whether the launcher has exited and every process of its group is gone, within the time
  // allowed. A process of the group that is still there would be released by the gate's end.
  private async groupEnded(): Promise<boolean> {
    const pid = this.child.pid;
    if (pid === undefined) return true;
    const deadline = Date.now() + ENDED_TIMEOUT_MS;
    const exited = await Promise.race([
      this.exited.then(() => true),
      Bun.sleep(ENDED_TIMEOUT_MS).then(() => false),
    ]);
    if (!exited) return false;
    while (Date.now() < deadline) {
      try {
        process.kill(-pid, 0);
      } catch {
        // ESRCH: no process of the group is left.
        return true;
      }
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        return true;
      }
      await Bun.sleep(POLL_MS);
    }
    return false;
  }

  failure(): string | null {
    return this.lost;
  }

  execute(tool: Tool, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (this.lost !== null) return Promise.reject(new BackendLostError(this.lost));
    if (!this.offered.has(tool.name)) {
      return Promise.resolve(
        toolError('sandbox.unsupported', `${tool.name} does not run in the sandbox`),
      );
    }
    this.sequence += 1;
    const id = String(this.sequence);
    const line = encodeMessage({
      type: 'tool.execute',
      id,
      name: tool.name,
      input,
      cwd: context.cwd,
    });
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      return Promise.resolve(
        toolError('input.too_large', `the arguments of ${tool.name} are too large to send`),
      );
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        this.send({ type: 'tool.cancel', id });
        timer = setTimeout(
          () =>
            this.lose(
              `${tool.name} did not return within ${seconds(this.cancelGraceMs)} of its cancellation`,
            ),
          this.cancelGraceMs,
        );
      };
      const cleanup = (): void => {
        context.signal.removeEventListener('abort', onAbort);
        clearTimeout(timer);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      this.toWorker.write(line);
      if (context.signal.aborted) onAbort();
      else context.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Ends every background job the worker runs, and resolves once it confirmed they ended; rejects
  // when one did not, or when the worker does not answer in time. The worker and its sandbox go on.
  stopJobs(timeoutMs = JOBS_STOP_TIMEOUT_MS): Promise<void> {
    if (this.lost !== null) return Promise.reject(new BackendLostError(this.lost));
    if (this.stoppingJobs !== null) return this.stoppingJobs.promise;
    let answer: (running: number) => void = () => undefined;
    let abandon: (reason: string) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      // A worker that does not answer in time is lost, as for a cancelled call: jobs it could not
      // confirm ended go with it, and no late answer is taken for another stop.
      const timer = setTimeout(() => {
        const reason = `the worker did not confirm the jobs ended within ${seconds(timeoutMs)}`;
        this.lose(reason);
        reject(new Error(reason));
      }, timeoutMs);
      answer = (running) => {
        clearTimeout(timer);
        this.stoppingJobs = null;
        if (running === 0) resolve();
        else reject(new Error(`${running} background jobs did not end`));
      };
      abandon = (reason) => {
        clearTimeout(timer);
        this.stoppingJobs = null;
        reject(new BackendLostError(reason));
      };
    });
    this.stoppingJobs = {
      promise,
      answer: (running) => answer(running),
      abandon: (reason) => abandon(reason),
    };
    this.send({ type: 'jobs.stop' });
    return promise;
  }

  // Asks the worker to stop, then kills what remains of its group. Later calls are refused.
  async close(): Promise<void> {
    if (this.lost === null) {
      // The worker closes its descriptor and exits on shutdown; that is the close, not a failure.
      this.closing = true;
      this.send({ type: 'worker.shutdown' });
      this.toWorker.end();
      const timer = setTimeout(() => this.killGroup(), SHUTDOWN_GRACE_MS);
      await this.exited;
      clearTimeout(timer);
    }
    this.lose('the sandbox was closed');
    await this.exited;
  }

  // Sets variables the worker's commands started from now on inherit; those running keep theirs.
  // Sent ahead of any later call on the same descriptor, so that call sees them.
  setEnvironment(variables: Record<string, string>): void {
    const problem = environmentProblem(variables);
    if (problem !== null) throw new Error(`the worker would refuse its environment: ${problem}`);
    this.send({ type: 'worker.environment', variables });
  }

  private send(message: HostToWorker): void {
    if (this.lost === null) this.toWorker.write(encodeMessage(message));
  }

  private receive(line: string): void {
    if (this.lost !== null) return;
    const parsed = parseWorkerMessage(line);
    if (!parsed.ok) {
      this.lose(`the worker broke the protocol: ${parsed.reason}`);
      return;
    }
    this.handle(parsed.message);
  }

  private handle(message: WorkerToHost): void {
    if (message.type === 'worker.error') {
      this.lose(`the worker reported: ${terminalText(message.message)}`);
      return;
    }
    if (message.type === 'worker.ready') {
      if (this.ready) {
        this.lose('the worker sent worker.ready twice');
        return;
      }
      const tools = message.tools;
      const expected = [...this.offered];
      const same =
        tools.length === expected.length &&
        new Set(tools).size === tools.length &&
        tools.every((name) => this.offered.has(name));
      if (message.protocol !== PROTOCOL_VERSION) {
        this.lose(`the worker speaks protocol ${message.protocol}, not ${PROTOCOL_VERSION}`);
        return;
      }
      if (!same) {
        this.lose(
          `the worker offered ${shown(tools.join(', '))} instead of ${expected.join(', ')}`,
        );
        return;
      }
      if (!this.released) {
        this.lose('the worker sent worker.ready before it was released');
        return;
      }
      this.ready = true;
      this.onReady?.(null);
      return;
    }
    if (!this.ready) {
      this.lose(`the worker sent ${message.type} before worker.ready`);
      return;
    }
    if (message.type === 'jobs.stopped') {
      if (this.stoppingJobs === null) {
        this.lose('the worker sent jobs.stopped without being asked');
        return;
      }
      this.stoppingJobs.answer(message.running);
      return;
    }
    if (message.type !== 'tool.result') {
      if (this.jobs === undefined) {
        this.lose(`the worker sent ${message.type}, but it runs no background jobs`);
        return;
      }
      const violation = this.jobs.receive(message);
      if (violation !== null) this.lose(`the worker broke the job protocol: ${shown(violation)}`);
      return;
    }
    const call = this.pending.get(message.id);
    if (call === undefined) {
      this.lose(`the worker sent a result for an unknown call id ${shown(message.id)}`);
      return;
    }
    this.pending.delete(message.id);
    call.cleanup();
    call.resolve(message.result);
  }

  private lose(cause: string): void {
    if (this.lost !== null) return;
    const reason = this.closing ? 'the sandbox was closed' : cause;
    // The worker's diagnostics explain a failed start. Once it is ready, commands share its
    // stderr through the sandbox's init process, so what arrives there is no longer its own.
    const diagnostics = terminalText(this.stderr.text()).trim().slice(-STDERR_SHOWN_CHARS);
    this.lost = diagnostics.length === 0 || this.ready ? reason : `${reason}: ${diagnostics}`;
    for (const call of this.pending.values()) {
      call.cleanup();
      call.reject(new BackendLostError(this.lost));
    }
    this.pending.clear();
    this.stoppingJobs?.abandon(this.lost);
    this.jobs?.lose();
    this.onReady?.(new Error(this.lost));
    this.toWorker.destroy();
    this.killGroup();
  }

  private killGroup(): void {
    // Once the process has exited its id may be reused, so its group is no longer signalled.
    const child = this.child;
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // ESRCH: the group has already exited.
    }
  }
}
