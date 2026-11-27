import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import type { CallRecorder, EngagementWindow } from '../agent/tool-broker.ts';
import { errorMessage } from '../errors.ts';
import { outputFiles } from '../tools/output-files.ts';
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
import { sha256 } from './evidence.ts';
import { COPIES_LIMIT_BYTES, preserveOutput, type ReportedOutput } from './evidence-copy.ts';
import { callRecorder, EvidenceRecorder, scopeRecord } from './evidence-recorder.ts';
import { openEvidenceStore } from './evidence-store.ts';
import { defaultLimits, type LimitedStart, limitedLaunch, prepareLimits } from './limits.ts';
import { NetworkControl } from './network/control.ts';
import { GIVEN_UP, type NetworkTools, networkTools, pinNamespaces } from './network/namespace.ts';
import { PASTA_LIMITS, type PastaAddress } from './network/pasta.ts';
import { PROXY_PORT, PROXY_USER, type ProxyEvent, type ProxyPolicy } from './network/proxy.ts';
import {
  PROXY_PROCESS_LIMITS,
  type ProxyFactory,
  proxyProcess,
  type RunningProxy,
} from './network/proxy-process.ts';
import type { Scope } from './network/ruleset.ts';
import type { JobMessage } from './protocol.ts';
import { hostSecrets } from './redaction.ts';
import { type Launched, WorkerBackend } from './worker-backend.ts';
import { sandboxedWorker } from './worker-command.ts';
import {
  createSandboxDirectory,
  processStart,
  removeWorkspaceDirectory,
  type SandboxDirectory,
} from './workspace.ts';

// A sandbox of the `security` profile: the network of the engagement's scope, within its window,
// and nothing else. One owner for all it holds, the worker, the network with pasta's scope, the
// proxy of the names reached through it, the directory of the hosts file and the watch over the
// window, so that one close ends them in order.
//
// The window is held by the kernel, which compares each packet's time with it, whatever this
// process is doing. The watch here does the rest, as soon as it can: at the end it closes the
// network for good, cancels the commands running and stops the jobs, and from then on the broker
// refuses commands, even if the clock goes back.

const TICK_MS = 1_000;

export type SecurityNotice = (level: 'info' | 'warning', text: string) => void;

// A process of the sandbox, by its id and its start, which tells it from a later one of the id.
interface SandboxProcess {
  pid: number;
  start: string;
}

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
  // For tests: how the proxy of the names reached through it is started, a process of its own in
  // a sandbox and a scope of its own otherwise.
  proxy?: ProxyFactory;
  // For tests: a smaller limit for the evidence log, which fails as a full disk would.
  evidenceMaxBytes?: number;
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

// What the sandbox's HTTP clients are given to reach the names of the proxy: its address, with the
// session's credential, and what they reach without it. These reach the worker on the protocol's
// descriptors, never on a command line.
// NO_PROXY is held to what an environment takes at ease: a scope of twenty thousand destinations
// would not fit in one variable of a command's environment.
const MAX_NO_PROXY_CHARS = 16 * 1024;

const proxyEnvironment = (
  token: string,
  resolved: ResolvedEngagement,
): { variables: Record<string, string>; warnings: string[] } => {
  const proxy = `http://${PROXY_USER}:${token}@127.0.0.1:${PROXY_PORT}`;
  // Clients match a NO_PROXY name against every name that ends with it, Python's requests with no
  // dot between: a name reached directly that ends a name of the proxy would take that one away
  // from the proxy, its only way. It is left out, and reached directly by its addresses.
  const proxiedHosts = resolved.proxied.map(({ host }) => host);
  const shadowing = resolved.names
    .map(({ host }) => host)
    .filter((host) => proxiedHosts.some((proxied) => proxied.endsWith(host)));
  const destinations = [
    ...resolved.names.flatMap(({ host, addresses }) =>
      shadowing.includes(host) ? addresses : [host, ...addresses],
    ),
    ...resolved.engagement.allow.flatMap((entry) =>
      entry.kind === 'network' ? [`${entry.network.address}/${entry.network.prefix}`] : [],
    ),
  ];
  const listed = ['localhost', '127.0.0.1', '::1'];
  let length = listed.join(',').length;
  let left = 0;
  for (const destination of destinations) {
    if (length + 1 + destination.length > MAX_NO_PROXY_CHARS) {
      left += 1;
      continue;
    }
    listed.push(destination);
    length += 1 + destination.length;
  }
  const direct = listed.join(',');
  return {
    variables: {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: direct,
      no_proxy: direct,
    },
    warnings: [
      ...(shadowing.length === 0
        ? []
        : [
            `NO_PROXY leaves out ${shadowing.join(', ')}, which names reached through the proxy end with: an HTTP client sends it to the proxy, which refuses it, unless told not to use the proxy, as curl is with --noproxy`,
          ]),
      ...(left === 0
        ? []
        : [
            `NO_PROXY leaves out ${left} of the ${destinations.length} names, addresses and networks reached directly, past ${MAX_NO_PROXY_CHARS} characters: an HTTP client sends those to the proxy, which refuses them, unless told not to use it, as curl is with --noproxy`,
          ]),
    ],
  };
};

const proxyPolicy = (token: string, resolved: ResolvedEngagement): ProxyPolicy => {
  const { scope, engagement } = resolved;
  return {
    token,
    names: resolved.proxied.map(({ host, ports }) =>
      ports === undefined ? { host } : { host, ports },
    ),
    direct: { allow: scope.allow, deny: scope.deny },
    ...(engagement.window === undefined ? {} : { window: engagement.window }),
    ...(engagement.newConnectionsPerSecond === undefined
      ? {}
      : { newConnectionsPerSecond: engagement.newConnectionsPerSecond }),
  };
};

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
  // What the broker records each call by, with an evidence log.
  readonly recorder: CallRecorder | undefined;
  // What the session's copies may still take.
  private readonly copiesBudget = { left: COPIES_LIMIT_BYTES };
  // Why the evidence log cannot be written, once it cannot: the session goes on unrecorded no more.
  private evidenceFailure: string | null = null;
  private evidenceEnd: { level: 'info' | 'warning'; text: string } | null = null;
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
    private readonly proxy: RunningProxy | null,
    // The proxy's credential, which the variables of the worker's commands carry.
    private readonly token: string | null,
    // The evidence log, when the engagement asks for one.
    readonly evidence: EvidenceRecorder | null,
    evidenceFailure: { handle: (reason: string) => void },
    // The sandbox's first process, through whose root the copies read its /tmp.
    private readonly sandboxProcess: SandboxProcess | null,
    jobFacts: { handle: (fact: JobMessage) => void },
  ) {
    this.ended = this.ending.signal;
    evidenceFailure.handle = (reason) => this.evidenceFailed(reason);
    if (evidence !== null && sandboxProcess !== null) {
      const secrets = [
        ...hostSecrets(options.env),
        ...(token === null ? [] : [{ value: token, what: 'proxy credential' }]),
      ];
      this.recorder = callRecorder(
        evidence,
        secrets,
        (output, owner, kind) => this.preserve(output, owner, kind),
        (why) => this.options.notice('warning', `evidence: ${why}`),
      );
      jobFacts.handle = (fact) => this.jobFact(fact);
    }
    const early = evidence?.failed() ?? null;
    if (early !== null) this.evidenceFailed(early);
    // A proxy that ends by itself frees its port of the host, where pasta still forwards the
    // sandbox's: whatever listens there next would receive the sandbox's requests and its
    // credential. The network closes, as when pasta ends, and the watch tells it.
    void proxy?.ended.then((reason) => {
      if (this.closing === null && reason !== 'the proxy was stopped') {
        void this.closeNetwork(`the proxy stopped: ${reason}`);
      }
    });
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
    const proxied = resolved.value.proxied.length > 0;
    // pasta's memory, and the proxy's, come out of the sandbox's, whatever limits it: the
    // session's budget stays three quarters.
    const limits = await prepareLimits(
      options.env,
      defaultLimits(),
      PASTA_LIMITS.memoryBytes + (proxied ? PROXY_PROCESS_LIMITS.memoryBytes : 0),
    );
    if (limits.how !== 'cgroup' || limits.scope === undefined || limits.clean === undefined) {
      return {
        error: `the security sandbox needs the limits of a cgroup: ${limits.warnings.join('; ')}`,
      };
    }
    if (options.signal?.aborted === true) return { error: 'the start of the sandbox was given up' };
    // The evidence log, which the sandbox must not see, is opened before anything runs. A failure
    // to write it is the session's to handle once it exists, and the start's until then.
    const evidenceFailure: { handle: (reason: string) => void } = { handle: () => undefined };
    let evidence: EvidenceRecorder | null = null;
    if (engagement.evidence !== undefined) {
      const store = openEvidenceStore({
        dir: engagement.evidence.dir,
        // What the sandbox sees: the project, the directories bound read-only, and the worker's
        // own files, the source tree included when it runs from source.
        forbidden: [
          options.launch.root,
          ...options.launch.readOnlyDirs,
          ...sandboxedWorker(options.launch.tools).mounts.map(({ source }) => source),
        ],
        engagementBytes: engagement.source?.bytes ?? Buffer.alloc(0),
        onFailure: (reason) => evidenceFailure.handle(reason),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.evidenceMaxBytes === undefined ? {} : { maxBytes: options.evidenceMaxBytes }),
      });
      if ('error' in store) return store;
      evidence = new EvidenceRecorder(store, now);
    }
    const created = createSandboxDirectory(options.env);
    if ('error' in created) {
      await evidence?.close({ outcome: 'not started', reason: created.error });
      return created;
    }
    const { directory } = created;
    const etc = join(directory.path, 'etc');
    let control: NetworkControl | null = null;
    let proxy: RunningProxy | null = null;
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
      // The network first: pasta must not forward to the proxy's port once it is free.
      const network = control?.dispose().catch((error: unknown) => {
        left.push(`the network did not end: ${errorMessage(error)}`);
      });
      await control?.close().catch(() => undefined);
      await proxy?.stop().catch((error: unknown) => {
        left.push(`the proxy did not end: ${errorMessage(error)}`);
      });
      await network;
      try {
        removeWorkspaceDirectory(directory);
      } catch (error) {
        // Still listed as live: the exit handler and the next session try again.
        left.push(`the sandbox directory was not removed: ${errorMessage(error)}`);
      }
      const error = [why, ...left].join('; ');
      await evidence?.close({ outcome: 'not started', reason: error });
      return { error };
    };
    try {
      mkdirSync(etc, { mode: 0o700 });
      writeFileSync(join(etc, 'hosts'), hostsFile(resolved.value), { mode: 0o644 });
    } catch (error) {
      return undo(`the hosts file of the sandbox cannot be written: ${errorMessage(error)}`);
    }
    // With an evidence log, the sandbox's first process, by its id and its start: the outputs the
    // worker saves in the sandbox's /tmp are read through its root.
    const root: { process: SandboxProcess | null } = { process: null };
    const jobFacts: { handle: (fact: JobMessage) => void } = { handle: () => undefined };
    units += 1;
    const unit = `nullrivet-pasta-${process.pid}-${units}.scope`;
    const proxyUnit = `nullrivet-proxy-${process.pid}-${units}.scope`;
    const scope = limits.scope;
    const clean = limits.clean;
    const token = proxied ? randomBytes(32).toString('hex') : null;
    const environment = token === null ? null : proxyEnvironment(token, resolved.value);
    // Told once per name and address: the proxy refuses a name that came to resolve to an address
    // the scope authorizes directly, where the sandbox reaches it without the proxy.
    const told = new Set<string>();
    const report = (event: ProxyEvent): void => {
      evidence?.proxy(event);
      if (event.type !== 'refused' || event.direct !== true || told.has(event.reason)) return;
      told.add(event.reason);
      options.notice(
        'warning',
        `${event.reason}: the sandbox reaches that address without the proxy, as the scope authorizes`,
      );
    };
    const startProxy =
      options.proxy ??
      proxyProcess({
        bwrap: options.host.bwrap,
        arch: options.host.arch,
        clean,
        scope: {
          prefix: scope(proxyUnit, PROXY_PROCESS_LIMITS),
          env: limits.env,
          unit: proxyUnit,
          limits: PROXY_PROCESS_LIMITS,
        },
      });
    let pid = 0;
    const prepare = (launched: Launched): Promise<void> => {
      preparing = (async () => {
        verifyLauncher(launched.pid, launched.status);
        pid = launched.pid;
        if (evidence !== null) {
          const child = (JSON.parse(launched.status) as Record<string, number>)['child-pid'];
          const started = typeof child === 'number' ? processStart(child) : null;
          if (started === null) throw new Error("the sandbox's first process cannot be found");
          root.process = { pid: child as number, start: started };
        }
        if (token !== null) {
          proxy = await startProxy({
            policy: proxyPolicy(token, resolved.value),
            report,
            signal: abandon.signal,
          });
        }
        let proxyEnd: string | null = null;
        void proxy?.ended.then((reason) => {
          proxyEnd = reason;
        });
        const forward = proxy === null ? {} : { forward: { port: PROXY_PORT, to: proxy.port } };
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
            ...forward,
            signal: abandon.signal,
          },
        );
        // Checked again right before the release: the start can take longer than the window, and
        // the proxy can end while the network is prepared.
        const gone = ended();
        if (gone !== null) throw new Error(gone);
        if (proxyEnd !== null) throw new Error(`the proxy stopped: ${proxyEnd}`);
      })();
      return preparing;
    };
    const warnings = [
      ...limits.warnings,
      ...created.warnings,
      ...ownAddressesWarning(resolved.value.scope),
      ...(environment?.warnings ?? []),
    ];
    // Written and synced before the worker exists: it runs nothing the log has not seen start.
    if (evidence !== null) {
      const applied = scopeRecord(resolved.value.scope);
      const source = engagement.source;
      const started = evidence.sessionStarted({
        nullrivet: packageJson.version,
        profile: 'security',
        engagement: {
          path: source?.path ?? options.engagementPath,
          sha256: sha256(source?.bytes ?? Buffer.alloc(0)),
          ...(engagement.name === undefined ? {} : { name: engagement.name }),
        },
        scope: applied.record,
        scopeSha256: applied.sha256,
        names: resolved.value.names,
        proxied: resolved.value.proxied,
        warnings,
      });
      if (!started) return undo(evidence.failed() ?? 'the evidence log cannot be written');
    }
    let backend: WorkerBackend;
    try {
      backend = await WorkerBackend.start({
        launch: limitedLaunch(
          securityLaunch(options.launch, {
            tools,
            hostsDirectory: etc,
            ...(evidence === null ? {} : { hashOutputs: true }),
          }),
          limits as LimitedStart,
        ),
        tools: options.launch.tools,
        jobs: true,
        prepare,
        ...(evidence === null ? {} : { onJobFact: (fact: JobMessage) => jobFacts.handle(fact) }),
        ...(environment === null ? {} : { environment: environment.variables }),
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
      warnings,
      proxy,
      token,
      evidence,
      evidenceFailure,
      root.process,
      jobFacts,
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
    const run = this.refreshing
      .then(() => this.refreshNow())
      .then((report) => {
        if ('error' in report) this.evidence?.scopeRefreshFailed(report.error);
        return report;
      });
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
    // While the kernel takes the new scope, the proxy holds both, and refuses an address either
    // authorizes directly.
    const { scope } = resolved.value;
    try {
      await this.proxy?.setDirect({
        allow: [...this.resolved.scope.allow, ...scope.allow],
        deny: scope.deny,
      });
    } catch (error) {
      const reason = `the proxy did not take the new scope: ${errorMessage(error)}`;
      void this.closeNetwork(reason);
      return { error: `the network was closed: ${reason}` };
    }
    stop = stopped();
    if (stop !== null) return stop;
    try {
      await this.control.replace(scope);
    } catch (error) {
      // A replacement that fails closes the network itself.
      return { error: `the network was closed: ${errorMessage(error)}` };
    }
    stop = stopped();
    if (stop !== null) return stop;
    try {
      await this.proxy?.setDirect(resolved.value.scope);
    } catch (error) {
      // The proxy would hold a name to the scope before it: the network closes.
      const reason = `the proxy did not take the new scope: ${errorMessage(error)}`;
      void this.closeNetwork(reason);
      return { error: `the network was closed: ${reason}` };
    }
    stop = stopped();
    if (stop !== null) return stop;
    try {
      renameSync(join(etc, 'hosts.new'), join(etc, 'hosts'));
    } catch (error) {
      // The scope in force and the names the sandbox reads would disagree: the network closes.
      const reason = `the hosts file cannot be replaced: ${errorMessage(error)}`;
      void this.closeNetwork(reason);
      return { error: `the network was closed: ${reason}` };
    }
    stop = stopped();
    if (stop !== null) return stop;
    // NO_PROXY follows what is reached directly now, for the commands started from here on.
    if (this.token !== null) {
      const previous = proxyEnvironment(this.token, this.resolved).warnings;
      const next = proxyEnvironment(this.token, resolved.value);
      this.backend.setEnvironment(next.variables);
      for (const warning of next.warnings) {
        if (!previous.includes(warning)) this.options.notice('warning', warning);
      }
    }
    // The names of the proxy too, whose addresses it resolves again for each connection anyway.
    const named = (value: ResolvedEngagement) => [
      ...value.names,
      ...value.proxied.filter(
        (entry, index) => value.proxied.findIndex(({ host }) => host === entry.host) === index,
      ),
    ];
    const before = new Map(named(this.resolved).map(({ host, addresses }) => [host, addresses]));
    const changes = named(resolved.value).flatMap(({ host, addresses }) => {
      const old = before.get(host) ?? [];
      const added = addresses.filter((address) => !old.includes(address));
      const removed = old.filter((address) => !addresses.includes(address));
      return added.length + removed.length === 0 ? [] : [{ host, added, removed }];
    });
    this.evidence?.scopeRefreshed(this.resolved.scope, resolved.value.scope, changes);
    this.resolved = resolved.value;
    return { changes };
  }

  // Ends everything the sandbox holds, in order: the watch, the network with pasta's scope, the
  // proxy, the worker, the directory. Idempotent; the network closes at once, whatever a refresh is doing.
  close(): Promise<void> {
    if (this.closing === null) {
      clearInterval(this.ticker);
      const network = this.control.dispose();
      const proxy = this.afterNetwork(this.control.close());
      this.closing = (async () => {
        const failures: string[] = [];
        await network.catch((error: unknown) => failures.push(errorMessage(error)));
        await proxy?.catch((error: unknown) =>
          failures.push(`the proxy did not end: ${errorMessage(error)}`),
        );
        // With an evidence log, the jobs are stopped and the copies under way waited for while the
        // sandbox, whose /tmp they read, still runs: a job's end brings its log.
        if (this.evidence !== null) {
          await this.backend
            .stopJobs()
            .catch((error: unknown) =>
              failures.push(`the jobs could not be stopped: ${errorMessage(error)}`),
            );
          await this.evidence.drain();
        }
        await this.backend.close();
        // The calls the worker's end failed come back first: their outcome goes in before the end.
        await new Promise((resolve) => setImmediate(resolve));
        await this.closeEvidence();
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

  // Stops the proxy once the network is closed, pasta ended with the port it forwarded: stopped
  // before, its port of the host would be free while pasta still led the sandbox there.
  private afterNetwork(closed: Promise<void>): Promise<void> | undefined {
    const { proxy } = this;
    if (proxy === null) return undefined;
    return closed.then(
      () => proxy.stop(),
      () => proxy.stop(),
    );
  }

  // Closes the network for a failure, then the proxy, and tells what of them did not end.
  private async closeNetwork(reason: string): Promise<void> {
    await this.afterNetwork(this.control.close(reason))?.catch((error: unknown) =>
      this.options.notice('warning', `the proxy did not end: ${errorMessage(error)}`),
    );
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  // The evidence log cannot be written: the session stops by ways that do not depend on it, the
  // network closed, commands refused and the jobs stopped, and the operator is told.
  private evidenceFailed(reason: string): void {
    if (this.evidenceFailure !== null) return;
    this.evidenceFailure = reason;
    void this.closeNetwork('the evidence log cannot be written');
    void this.backend
      .stopJobs()
      .catch((error: unknown) =>
        this.options.notice('warning', `the jobs could not be stopped: ${errorMessage(error)}`),
      );
    this.options.notice(
      'warning',
      `The evidence log cannot be written, so the network is closed and commands are refused: ${reason}`,
    );
  }

  // Copies an output the worker saved into the evidence directory, and tells the operator when the
  // copy is not what the worker saved, or could not be made.
  private async preserve(
    output: ReportedOutput,
    owner: string,
    kind: 'calls' | 'jobs',
  ): Promise<Record<string, unknown>> {
    const evidence = this.evidence as EvidenceRecorder;
    // Opened for each copy, once the sandbox stands: before its release, its first process is still
    // in the host's root. Its id is checked to be the same process still, by its start.
    const sandbox = this.sandboxProcess as SandboxProcess;
    let rootFd: number;
    try {
      if (processStart(sandbox.pid) !== sandbox.start) throw new Error('the sandbox has ended');
      rootFd = openSync(`/proc/${sandbox.pid}/root`, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch (error) {
      const why = `the sandbox's files cannot be reached: ${errorMessage(error)}`;
      return { stream: output.stream, preservation: 'omitted', omitted: why, matchesSaved: null };
    }
    try {
      const { record, problem } = await preserveOutput(
        output,
        owner,
        { kind, rootFd },
        { store: evidence.store, partBytes: outputFiles.partBytes, budget: this.copiesBudget },
      );
      if (problem !== null) this.options.notice('warning', `evidence: ${problem}`);
      return record;
    } finally {
      closeSync(rootFd);
    }
  }

  // A fact of a background job, as the worker sent it: its start, and its end with its log.
  private jobFact(fact: JobMessage): void {
    const evidence = this.evidence as EvidenceRecorder;
    if (fact.type === 'job.started') {
      evidence.jobStarted(fact.jobId, fact.callId ?? 'unknown');
      return;
    }
    if (fact.type !== 'job.event' || fact.event.type !== 'job.finished') return;
    const { jobId, status, exitCode, signal, durationMs, log } = fact.event;
    const owner = `job-${jobId}`;
    const finished = (record: Record<string, unknown>): void =>
      evidence.jobFinished(jobId, { status, exitCode, signal, durationMs, log: record });
    if (log === null) {
      finished({ stream: 'log', preservation: 'omitted', omitted: 'the job kept no log' });
      return;
    }
    void evidence.track(
      this.preserve({ ...log, stream: 'log' }, owner, 'jobs').then(finished, (error: unknown) => {
        const why = `the log could not be preserved: ${errorMessage(error)}`;
        finished({ stream: 'log', preservation: 'omitted', omitted: why, matchesSaved: null });
        this.options.notice('warning', `evidence: ${why}`);
      }),
    );
  }

  // Ends the evidence log, and keeps what the operator is told of it, its final hash the anchor to
  // check it with: shown once the session is closed, where an interactive one has restored the
  // terminal.
  private async closeEvidence(): Promise<void> {
    if (this.evidence === null) return;
    const summary = await this.evidence.close({ reason: 'the session ended' });
    const failure = this.evidence.failed();
    const anchor = `the SHA-256 of the last is ${summary.finalHash}. Keep it apart from the log, to check it with --verify-evidence --expected-hash`;
    this.evidenceEnd =
      failure === null
        ? {
            level: 'info',
            text: `The evidence log ${summary.path} holds ${summary.entries} entries; ${anchor}.`,
          }
        : {
            level: 'warning',
            text: `The evidence log ${summary.path} stopped at ${summary.entries} entries, ${failure}; ${anchor}.`,
          };
  }

  // What the operator is told of the evidence log once the session is closed; null without one.
  evidenceOutcome(): { level: 'info' | 'warning'; text: string } | null {
    return this.evidenceEnd;
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
      this.evidence?.networkStopped(failure);
      this.options.notice('warning', `the sandbox's network stopped: ${failure}`);
    }
  }

  // The end of the window, once: the network closes for good, the commands running are cancelled
  // and the jobs stopped. The kernel already refuses packets past it.
  private async end(): Promise<void> {
    if (this.ending.signal.aborted) return;
    this.ending.abort();
    this.evidence?.windowEnded((this.engagement.window as { until: Date }).until);
    const until = iso((this.engagement.window as { until: Date }).until);
    // Each step is taken whatever the others did, and every failure is told.
    const problems: string[] = [];
    const closed = this.control.close();
    const network = closed.catch((error: unknown) => {
      problems.push(errorMessage(error));
    });
    const proxy = this.afterNetwork(closed)?.catch((error: unknown) => {
      problems.push(`the proxy did not end: ${errorMessage(error)}`);
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
    await proxy;
    this.options.notice(
      problems.length === 0 ? 'info' : 'warning',
      `The engagement window ended at ${until}: the network is closed, commands are refused, and the running ones were stopped.${problems.length === 0 ? '' : ` ${problems.join('; ')}`}`,
    );
  }
}
