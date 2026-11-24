import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { BackendLostError, type ToolBackend } from '../agent/tool-broker.ts';
import { BoundedCapture } from '../context/bounded-capture.ts';
import { terminalText } from '../sanitize/display.ts';
import { KILL_GRACE_MS, trackProcessGroup } from '../tools/process.ts';
import { type Tool, type ToolContext, type ToolResult, toolError } from '../tools/types.ts';
import { LineSplitter } from './lines.ts';
import {
  encodeMessage,
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
}

export interface WorkerBackendOptions {
  launch: WorkerLaunch;
  // The tools the worker must offer, exactly.
  tools: readonly string[];
  readyTimeoutMs?: number;
  // How long a cancelled call may take to return its result.
  cancelGraceMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
// A cancelled command gets SIGTERM, then SIGKILL after the kill grace, then up to the same grace
// for its output to close: the result can take twice the grace, plus a margin.
const DEFAULT_CANCEL_GRACE_MS = 2 * KILL_GRACE_MS + 3_000;
const SHUTDOWN_GRACE_MS = 3_000;
const STDERR_CAPTURE_BYTES = 16 * 1024;
const STDERR_SHOWN_CHARS = 2_000;
// Where the protocol descriptors are in the child's stdio, and where launcher inputs start.
const PROTOCOL_STDIO = ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] as const;

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
  private ready = false;
  private sequence = 0;
  private untrack: () => void = () => undefined;
  private readonly exited: Promise<void>;
  private readonly toWorker: Writable;
  private onReady: ((error: Error | null) => void) | null = null;

  private constructor(
    private readonly child: ChildProcess,
    options: WorkerBackendOptions,
  ) {
    this.offered = new Set(options.tools);
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
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
    const [file, ...args] = options.launch.command;
    if (file === undefined) return Promise.reject(new Error('the worker command is empty'));
    const child = spawn(file, args, {
      stdio: [...PROTOCOL_STDIO, ...inputs.map(() => 'pipe' as const)],
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
    const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => backend.lose(`the worker was not ready within ${seconds(timeoutMs)}`),
        timeoutMs,
      );
      backend.onReady = (error) => {
        clearTimeout(timer);
        backend.onReady = null;
        if (error === null) resolve(backend);
        else reject(error);
      };
    });
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

  private send(message: HostToWorker): void {
    if (this.lost === null) this.toWorker.write(encodeMessage(message));
  }

  private receive(line: string): void {
    if (this.lost !== null) return;
    const parsed = parseWorkerMessage(line);
    if (!parsed.ok) {
      this.lose(`the worker sent ${parsed.reason}`);
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
      this.ready = true;
      this.onReady?.(null);
      return;
    }
    if (!this.ready) {
      this.lose('the worker sent a result before worker.ready');
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
