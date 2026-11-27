import { mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngagementWindow } from '../agent/tool-broker.ts';
import { errorMessage } from '../errors.ts';
import {
  atLeast,
  type LaunchOptions,
  OVERLAY_BWRAP_VERSION,
  type SandboxHost,
  securityLaunch,
} from './bwrap.ts';
import {
  authorizedAmong,
  describeScope,
  type Engagement,
  hostAddresses,
  hostsFile,
  type LookupAll,
  lookupAll,
  type ResolvedEngagement,
  readEngagement,
  resolveEngagement,
  windowState,
} from './engagement.ts';
import { defaultLimits, type LimitedStart, limitedLaunch, prepareLimits } from './limits.ts';
import { NetworkControl } from './network/control.ts';
import { GIVEN_UP, type NetworkTools, networkTools, pinNamespaces } from './network/namespace.ts';
import { PASTA_LIMITS, type PastaAddress } from './network/pasta.ts';
import type { Scope } from './network/ruleset.ts';
import { type Launched, WorkerBackend } from './worker-backend.ts';
import {
  createSandboxDirectory,
  removeWorkspaceDirectory,
  type SandboxDirectory,
} from './workspace.ts';

// A sandbox of the `security` profile: the network of the engagement's scope, within its window,
// and nothing else. One owner for all it holds, the worker, the network with pasta's scope, the
// directory of the hosts file and the watch over the window, so that one close ends them in order.
//
// The window is held by the kernel, which compares each packet's time with it, whatever this
// process is doing. The watch here does the rest, as soon as it can: at the end it closes the
// network for good, cancels the commands running and stops the jobs, and from then on the broker
// refuses commands, even if the clock goes back.

const TICK_MS = 1_000;

export type SecurityNotice = (level: 'info' | 'warning', text: string) => void;

export interface SecurityOptions {
  host: SandboxHost;
  launch: LaunchOptions;
  env: Record<string, string | undefined>;
  engagementPath: string;
  // Told what happens to the window and the network, for the operator and the model.
  notice: SecurityNotice;
  // For tests: what the network is made with, the namespace's address to reach the host's own,
  // the resolver, and the clock.
  tools?: NetworkTools;
  address?: PastaAddress;
  resolve?: LookupAll;
  now?: () => Date;
  // Gives up a start still under way, as an interrupt does.
  signal?: AbortSignal;
  // For tests: how long the network's preparation may take, thirty seconds otherwise.
  prepareTimeoutMs?: number;
}

export interface RefreshReport {
  // Per name whose addresses changed.
  changes: { host: string; added: string[]; removed: string[] }[];
}

let units = 0;

// Checks that `pid` is the launcher that made the namespaces of the sandbox's process it reported:
// its parent, in the same network namespace, in a user namespace of its own, the host's ones
// excepted. Throws otherwise.
export const verifyLauncher = (pid: number, status: string): void => {
  let child: unknown;
  try {
    child = (JSON.parse(status) as Record<string, unknown>)['child-pid'];
  } catch {
    child = undefined;
  }
  if (typeof child !== 'number' || !Number.isInteger(child) || child <= 0) {
    throw new Error('the launcher reported no process');
  }
  const wrong = (why: string): never => {
    throw new Error(`the sandbox's namespaces are not those its launcher made: ${why}`);
  };
  try {
    const parent = /^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${child}/status`, 'utf8'))?.[1];
    if (parent !== String(pid)) wrong(`process ${child} is not a child of ${pid}`);
    const ns = (who: number | 'self', kind: string) => readlinkSync(`/proc/${who}/ns/${kind}`);
    if (ns(child, 'net') !== ns(pid, 'net')) wrong('the network namespace differs');
    const user = ns(pid, 'user');
    if (user === ns('self', 'user') || user === ns(child, 'user')) {
      wrong("the launcher's user namespace is not its own");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("the sandbox's namespaces")) throw error;
    wrong(errorMessage(error));
  }
};

const iso = (date: Date): string => date.toISOString();

// pasta reaches an address of this host as the host itself, its services listening there
// included: a scope that authorizes one, as a laboratory on this machine does, is told.
const ownAddressesWarning = (scope: Scope): string[] => {
  const own = authorizedAmong(scope, hostAddresses());
  return own.length === 0
    ? []
    : [
        `the scope authorizes addresses of this host, ${own.join(', ')}: the sandbox reaches the services of this host listening there`,
      ];
};

export class SecuritySession implements EngagementWindow {
  readonly ended: AbortSignal;
  private readonly ending = new AbortController();
  private closing: Promise<void> | null = null;
  private refreshing: Promise<unknown> = Promise.resolve();
  private reportedFailure = false;
  private readonly ticker: ReturnType<typeof setInterval>;

  private constructor(
    readonly backend: WorkerBackend,
    // The process whose namespaces the network is configured in.
    readonly pid: number,
    private readonly control: NetworkControl,
    private readonly directory: SandboxDirectory,
    private readonly engagement: Engagement,
    private resolved: ResolvedEngagement,
    private readonly options: SecurityOptions,
    // What the operator is told at the start: what the limits or the directory could not do.
    readonly warnings: string[],
  ) {
    this.ended = this.ending.signal;
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    // The watch never keeps the process alive by itself.
    this.ticker.unref?.();
  }

  // Starts the sandbox, or says why it cannot start. Nothing is left of one that did not.
  static async start(options: SecurityOptions): Promise<SecuritySession | { error: string }> {
    const now = options.now ?? (() => new Date());
    const tools = options.tools ?? networkTools();
    if (typeof tools === 'string') return { error: `the security sandbox needs ${tools}` };
    if (!atLeast(options.host.version, OVERLAY_BWRAP_VERSION)) {
      return {
        error: `the security sandbox needs Bubblewrap ${OVERLAY_BWRAP_VERSION.join('.')} or later; ${options.host.bwrap} is version ${options.host.version.join('.')}`,
      };
    }
    const read = await readEngagement(options.engagementPath);
    if (!read.ok) return { error: read.error };
    const engagement = read.value;
    const ended = (): string | null =>
      windowState(engagement, now()) === 'after' && engagement.window !== undefined
        ? `the engagement window ended at ${iso(engagement.window.until)}`
        : null;
    if (ended() !== null) return { error: ended() as string };
    const resolved = await resolveEngagement(engagement, options.resolve ?? lookupAll);
    if (!resolved.ok) return { error: resolved.error };
    // pasta's memory comes out of the sandbox's, whatever limits it: the session's budget stays
    // three quarters.
    const limits = await prepareLimits(options.env, defaultLimits(), PASTA_LIMITS.memoryBytes);
    if (limits.how !== 'cgroup' || limits.scope === undefined) {
      return {
        error: `the security sandbox needs the limits of a cgroup: ${limits.warnings.join('; ')}`,
      };
    }
    if (options.signal?.aborted === true) return { error: 'the start of the sandbox was given up' };
    const created = createSandboxDirectory(options.env);
    if ('error' in created) return created;
    const { directory } = created;
    const etc = join(directory.path, 'etc');
    let control: NetworkControl | null = null;
    let preparing: Promise<void> = Promise.resolve();
    // Given up with the start: the preparation's helpers are killed, so the undoing that waits for
    // it does not outlast the start's time by theirs.
    const abandon = new AbortController();
    // Undoes what the start made, and says what could not be undone, with why it did not start.
    const undo = async (why: string): Promise<{ error: string }> => {
      abandon.abort();
      const left: string[] = [];
      // What the preparation made is ended once it has stopped. Its failure is told unless it is
      // the reason already, or only that it was given up: it can hold one of undoing what it made.
      await preparing.catch((error: unknown) => {
        const failure = errorMessage(error);
        if (failure !== GIVEN_UP && !why.includes(failure)) left.push(failure);
      });
      await control?.dispose().catch((error: unknown) => {
        left.push(`the network did not end: ${errorMessage(error)}`);
      });
      try {
        removeWorkspaceDirectory(directory);
      } catch (error) {
        // Still listed as live: the exit handler and the next session try again.
        left.push(`the sandbox directory was not removed: ${errorMessage(error)}`);
      }
      return { error: [why, ...left].join('; ') };
    };
    try {
      mkdirSync(etc, { mode: 0o700 });
      writeFileSync(join(etc, 'hosts'), hostsFile(resolved.value), { mode: 0o644 });
    } catch (error) {
      return undo(`the hosts file of the sandbox cannot be written: ${errorMessage(error)}`);
    }
    units += 1;
    const unit = `nullrivet-pasta-${process.pid}-${units}.scope`;
    const scope = limits.scope;
    let pid = 0;
    const prepare = (launched: Launched): Promise<void> => {
      preparing = (async () => {
        verifyLauncher(launched.pid, launched.status);
        pid = launched.pid;
        control = await NetworkControl.prepare(
          tools,
          pinNamespaces(launched.pid),
          resolved.value.scope,
          {
            ...(options.address === undefined ? {} : { address: options.address }),
            pasta: {
              prefix: scope(unit, PASTA_LIMITS),
              env: limits.env,
              unit,
              limits: PASTA_LIMITS,
            },
            signal: abandon.signal,
          },
        );
        // Checked again right before the release: the start can take longer than the window.
        const gone = ended();
        if (gone !== null) throw new Error(gone);
      })();
      return preparing;
    };
    let backend: WorkerBackend;
    try {
      backend = await WorkerBackend.start({
        launch: limitedLaunch(
          securityLaunch(options.launch, { tools, hostsDirectory: etc }),
          limits as LimitedStart,
        ),
        tools: options.launch.tools,
        jobs: true,
        prepare,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.prepareTimeoutMs === undefined
          ? {}
          : { prepareTimeoutMs: options.prepareTimeoutMs }),
      });
    } catch (error) {
      return undo(`the security sandbox did not start: ${errorMessage(error)}`);
    }
    return new SecuritySession(
      backend,
      pid,
      control as unknown as NetworkControl,
      directory,
      engagement,
      resolved.value,
      options,
      [...limits.warnings, ...created.warnings, ...ownAddressesWarning(resolved.value.scope)],
    );
  }

  // The scope as lines of facts, for the operator and the system prompts, and what is in force of
  // it: nothing, once the window ended or the network stopped.
  scope(): string[] {
    const failure = this.control.failure();
    const stopped = this.ending.signal.aborted
      ? this.closed()
      : failure === null
        ? null
        : `the sandbox's network stopped: ${failure}`;
    return [
      ...describeScope(this.resolved),
      ...(stopped === null ? [] : [`None of it is in force: ${stopped}.`]),
    ];
  }

  // Why commands cannot run now; null while the window is open.
  closed(): string | null {
    const window = this.engagement.window;
    if (this.ending.signal.aborted && window !== undefined) {
      return `the engagement window ended at ${iso(window.until)}`;
    }
    if (this.closing !== null) return 'the sandbox was closed';
    switch (windowState(this.engagement, this.now())) {
      case 'before':
        return `the engagement window opens at ${iso((window as { from: Date }).from)}`;
      case 'after':
        // The watch ends it within a second; until then commands are refused all the same.
        return `the engagement window ended at ${iso((window as { until: Date }).until)}`;
      default:
        return null;
    }
  }

  // Resolves the names again and puts the new scope in force, then its hosts file. Refreshes run
  // one after another; a close goes ahead of them, and none puts anything in force after it.
  refresh(): Promise<RefreshReport | { error: string }> {
    const run = this.refreshing.then(() => this.refreshNow());
    this.refreshing = run.catch(() => undefined);
    return run;
  }

  private async refreshNow(): Promise<RefreshReport | { error: string }> {
    const stopped = (): { error: string } | null =>
      this.closing !== null || this.ending.signal.aborted
        ? { error: this.closed() ?? 'the sandbox was closed' }
        : null;
    let stop = stopped();
    if (stop !== null) return stop;
    const resolved = await resolveEngagement(this.engagement, this.options.resolve ?? lookupAll);
    stop = stopped();
    if (stop !== null) return stop;
    if (!resolved.ok) return { error: `nothing changed: ${resolved.error}` };
    const etc = join(this.directory.path, 'etc');
    try {
      writeFileSync(join(etc, 'hosts.new'), hostsFile(resolved.value), { mode: 0o644 });
    } catch (error) {
      return { error: `nothing changed: the hosts file cannot be written: ${errorMessage(error)}` };
    }
    try {
      await this.control.replace(resolved.value.scope);
    } catch (error) {
      // A replacement that fails closes the network itself.
      return { error: `the network was closed: ${errorMessage(error)}` };
    }
    stop = stopped();
    if (stop !== null) return stop;
    try {
      renameSync(join(etc, 'hosts.new'), join(etc, 'hosts'));
    } catch (error) {
      // The scope in force and the names the sandbox reads would disagree: the network closes.
      const reason = `the hosts file cannot be replaced: ${errorMessage(error)}`;
      void this.control.close(reason);
      return { error: `the network was closed: ${reason}` };
    }
    stop = stopped();
    if (stop !== null) return stop;
    const before = new Map(this.resolved.names.map(({ host, addresses }) => [host, addresses]));
    const changes = resolved.value.names.flatMap(({ host, addresses }) => {
      const old = before.get(host) ?? [];
      const added = addresses.filter((address) => !old.includes(address));
      const removed = old.filter((address) => !addresses.includes(address));
      return added.length + removed.length === 0 ? [] : [{ host, added, removed }];
    });
    this.resolved = resolved.value;
    return { changes };
  }

  // Ends everything the sandbox holds, in order: the watch, the network with pasta's scope, the
  // worker, the directory. Idempotent; the network closes at once, whatever a refresh is doing.
  close(): Promise<void> {
    if (this.closing === null) {
      clearInterval(this.ticker);
      const network = this.control.dispose();
      this.closing = (async () => {
        const failures: string[] = [];
        await network.catch((error: unknown) => failures.push(errorMessage(error)));
        await this.backend.close();
        try {
          removeWorkspaceDirectory(this.directory);
        } catch (error) {
          failures.push(errorMessage(error));
        }
        if (failures.length > 0) {
          throw new Error(`the security sandbox did not end cleanly: ${failures.join('; ')}`);
        }
      })();
    }
    return this.closing;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private tick(): void {
    if (this.closing !== null) return;
    if (!this.ending.signal.aborted && windowState(this.engagement, this.now()) === 'after') {
      void this.end().catch((error: unknown) =>
        this.options.notice(
          'warning',
          `the end of the engagement window failed: ${errorMessage(error)}`,
        ),
      );
    }
    const failure = this.control.failure();
    if (failure !== null && !this.reportedFailure && !this.ending.signal.aborted) {
      this.reportedFailure = true;
      this.options.notice('warning', `the sandbox's network stopped: ${failure}`);
    }
  }

  // The end of the window, once: the network closes for good, the commands running are cancelled
  // and the jobs stopped. The kernel already refuses packets past it.
  private async end(): Promise<void> {
    if (this.ending.signal.aborted) return;
    this.ending.abort();
    const until = iso((this.engagement.window as { until: Date }).until);
    // Each step is taken whatever the others did, and every failure is told.
    const problems: string[] = [];
    const network = this.control.close().catch((error: unknown) => {
      problems.push(errorMessage(error));
    });
    try {
      await this.backend.stopJobs();
    } catch (error) {
      problems.push(errorMessage(error));
      // Jobs that could not be confirmed ended go with the worker.
      await this.backend.close().catch((closing: unknown) => {
        problems.push(`the worker could not be closed: ${errorMessage(closing)}`);
      });
    }
    await network;
    this.options.notice(
      problems.length === 0 ? 'info' : 'warning',
      `The engagement window ended at ${until}: the network is closed, commands are refused, and the running ones were stopped.${problems.length === 0 ? '' : ` ${problems.join('; ')}`}`,
    );
  }
}
