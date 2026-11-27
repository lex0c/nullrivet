import { type ChildProcess, spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { errorMessage } from '../../errors.ts';
import { proxyBwrapArgs } from '../bwrap.ts';
import { LineSplitter } from '../lines.ts';
import { type SyscallArch, seccompProgram } from '../seccomp.ts';
import { sandboxedProxy } from '../worker-command.ts';
import { GIVEN_UP } from './namespace.ts';
import type { ProxyEvent, ProxyPolicy } from './proxy.ts';
import { encodeLine, MAX_PROXY_LINE_BYTES, parseProxyLine } from './proxy-wire.ts';
import type { Scope } from './ruleset.ts';
import { confirmScope, emptied, type HelperScope, unitCgroup } from './scoped.ts';

// The proxy the security session runs, wherever it runs: a process of its own in production, or
// the same code in the host's process in tests.
export interface RunningProxy {
  // Its port on the host's loopback.
  readonly port: number;
  // Why it ended; settles only when it does.
  readonly ended: Promise<string>;
  // Puts a refresh's direct scope in force, and resolves once the proxy holds it.
  setDirect(direct: Scope): Promise<void>;
  // Ends it with every connection, and resolves once nothing of it is left.
  stop(): Promise<void>;
}

export interface ProxyStart {
  policy: ProxyPolicy;
  report: (event: ProxyEvent) => void;
  signal?: AbortSignal;
}

export type ProxyFactory = (start: ProxyStart) => Promise<RunningProxy>;

const READY_TIMEOUT_MS = 10_000;
const SCOPE_SET_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 2_000;
const OUTPUT_KEPT_CHARS = 500;
// Where Bubblewrap reads the seccomp program, after the standard streams.
const SECCOMP_FD = 3;

// What the proxy's process may take, beside the sandbox's own limits: an absolute share of a CPU,
// since it relays what the sandbox sends whatever else the host runs. Its runtime starts threads by
// the number of processors, twenty at rest on twelve: the task limit leaves room for large hosts,
// and still stops a runaway.
export const PROXY_PROCESS_LIMITS = {
  tasks: 256,
  memoryBytes: 256 * 1024 * 1024,
  cpuWeight: 20,
  cpuQuotaPercent: 50,
};

export interface ProxyProcessOptions {
  bwrap: string;
  arch: SyscallArch;
  // An env program in a system directory, which starts Bubblewrap with nothing of the host's
  // environment.
  clean: string;
  scope: HelperScope;
}

class ProxyProcess implements RunningProxy {
  readonly ended: Promise<string>;
  port = 0;
  private stopping = false;
  private cgroup: string | null = null;
  private failure: string | null = null;
  private onListening: ((port: number) => void) | null = null;
  private onScopeSet: (() => void) | null = null;

  constructor(
    private readonly child: ChildProcess,
    private readonly scope: HelperScope,
    report: (event: ProxyEvent) => void,
  ) {
    let output = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (output.length < OUTPUT_KEPT_CHARS) output += chunk.toString();
    });
    const splitter = new LineSplitter(
      MAX_PROXY_LINE_BYTES,
      (line) => {
        const message = parseProxyLine(line);
        if (message === null) return this.lose('the proxy sent a malformed line');
        switch (message.type) {
          case 'listening':
            this.onListening?.(message.port);
            return;
          case 'scope.set':
            this.onScopeSet?.();
            return;
          case 'error':
            this.failure ??= message.message;
            return;
          default:
            report(message);
        }
      },
      () => this.lose('a line from the proxy exceeds the limit'),
    );
    child.stdout?.on('data', (chunk: Buffer) => splitter.push(chunk));
    child.stdin?.on('error', () => undefined);
    this.ended = new Promise((resolve) => {
      child.once('error', (error) => resolve(`the proxy could not start: ${error.message}`));
      // On close, not exit: the exit can come before the last line it wrote, its error among them.
      child.once('close', (code, signal) => {
        if (this.stopping) return resolve('the proxy was stopped');
        const how = signal === null ? `with code ${code}` : `on ${signal}`;
        const why = this.failure ?? output.trim().slice(0, 300);
        resolve(`the proxy exited ${how}${why === '' ? '' : `: ${why}`}`);
      });
    });
  }

  // Resolves once the proxy listens, in the scope named with its limits.
  async ready(policy: ProxyPolicy, signal?: AbortSignal): Promise<void> {
    let settle: () => void = () => undefined;
    const listening = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the proxy did not listen within ${READY_TIMEOUT_MS} ms`)),
        READY_TIMEOUT_MS,
      );
      const abort = (): void => reject(new Error(GIVEN_UP));
      settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.onListening = null;
      };
      if (signal?.aborted === true) abort();
      signal?.addEventListener('abort', abort, { once: true });
      void this.ended.then((reason) => reject(new Error(reason)));
      this.onListening = resolve;
    });
    this.child.stdin?.write(encodeLine({ type: 'policy', policy }));
    try {
      this.port = await listening;
    } finally {
      settle();
    }
    // Bubblewrap, run in place by systemd-run and env, is the process followed.
    this.cgroup = confirmScope(this.child.pid as number, this.scope, 'the proxy', /^bwrap$/);
  }

  setDirect(direct: Scope): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        reject(new Error('the proxy is not running'));
        return;
      }
      const timer = setTimeout(() => {
        this.onScopeSet = null;
        reject(new Error(`the proxy did not take the scope within ${SCOPE_SET_TIMEOUT_MS} ms`));
      }, SCOPE_SET_TIMEOUT_MS);
      this.onScopeSet = () => {
        clearTimeout(timer);
        this.onScopeSet = null;
        resolve();
      };
      this.child.stdin?.write(encodeLine({ type: 'scope', direct }));
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // The end of its input closes every connection; a proxy that does not end is killed.
    this.child.stdin?.end();
    const timer = setTimeout(() => this.kill(), STOP_GRACE_MS);
    await this.ended;
    clearTimeout(timer);
    const path = this.cgroup ?? unitCgroup(this.scope.unit);
    if (path !== null) await emptied(path, 'the proxy');
  }

  // Ends a proxy that did not start as it must, and rejects with why.
  async discard(error: unknown): Promise<never> {
    this.stopping = true;
    this.kill();
    await this.ended;
    const path = this.cgroup ?? unitCgroup(this.scope.unit);
    if (path !== null) {
      try {
        await emptied(path, 'the proxy');
      } catch (left) {
        throw new Error(`${errorMessage(error)}; ${errorMessage(left)}`);
      }
    }
    throw error;
  }

  private lose(reason: string): void {
    this.failure ??= reason;
    this.kill();
  }

  private kill(): void {
    const { child } = this;
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

// Starts the proxy as a process of its own, in a sandbox and a scope of its own: it handles what
// the sandbox sends, so it holds nothing the host has, and costs no more than its limits.
export const proxyProcess =
  (options: ProxyProcessOptions): ProxyFactory =>
  async ({ policy, report, signal }) => {
    const [file, ...args] = [
      ...options.scope.prefix,
      options.clean,
      '-i',
      'PATH=/usr/bin:/bin',
      'TZ=UTC',
      options.bwrap,
      ...proxyBwrapArgs(sandboxedProxy(), SECCOMP_FD),
    ];
    const child = spawn(file as string, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: options.scope.env,
      // Out of the terminal's process group: an interrupt there is the host's to handle.
      detached: true,
    });
    const program = child.stdio[SECCOMP_FD] as Writable;
    program.on('error', () => undefined);
    program.end(seccompProgram(options.arch));
    const proxy = new ProxyProcess(child, options.scope, report);
    try {
      await proxy.ready(policy, signal);
    } catch (error) {
      await proxy.discard(error);
    }
    return proxy;
  };
