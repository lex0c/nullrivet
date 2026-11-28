import type { CallRecorder } from '../agent/tool-broker.ts';
import { errorMessage } from '../errors.ts';
import { stableStringify } from '../providers/canonical-json.ts';
import type { CapturedOutput } from '../tools/types.ts';
import { sha256 } from './evidence.ts';
import type { ReportedOutput } from './evidence-copy.ts';
import type { EvidenceStore } from './evidence-store.ts';
import type { ProxyEvent } from './network/proxy.ts';
import type { Network, Scope } from './network/ruleset.ts';
import { redactExact, redactStrings, redactText, type Secret } from './redaction.ts';

// What the security session records, as entries of its evidence log. An entry an action depends on
// is written and synced first, and the action does not happen without it: the session's start, a
// call's start. Entries that mark the state are synced too; the outcome of a call and the proxy's
// decisions are left to the system, and a loss of power shows as an operation without an outcome.

// The proxy's refusals recorded one by one in a second; past them, counted. A loop of the sandbox
// against the proxy would otherwise fill the disk.
const REFUSALS_PER_SECOND = 20;
// How long the end of the session waits for the copies under way.
const DRAIN_MS = 10_000;

const shown = (network: Network): string => `${network.address}/${network.prefix}`;

// A scope as plain values, and the SHA-256 of their canonical form, which names it in the log.
export const scopeRecord = (scope: Scope): { record: unknown; sha256: string } => {
  const record = {
    allow: scope.allow.map((entry) =>
      entry.ports === undefined
        ? { network: shown(entry.network) }
        : { network: shown(entry.network), ports: entry.ports },
    ),
    deny: scope.deny.map(shown),
    ...(scope.newConnectionsPerSecond === undefined
      ? {}
      : { newConnectionsPerSecond: scope.newConnectionsPerSecond }),
    ...(scope.window === undefined
      ? {}
      : {
          window: {
            from: scope.window.from.toISOString(),
            until: scope.window.until.toISOString(),
          },
        }),
  };
  return { record, sha256: sha256(stableStringify(record)) };
};

export interface EvidenceSummary {
  path: string;
  entries: number;
  finalHash: string;
}

export class EvidenceRecorder {
  private readonly started = new Set<string>();
  private readonly ended = new Set<string>();
  private readonly jobs = new Set<string>();
  private readonly jobsEnded = new Set<string>();
  private refusalsSecond = 0;
  private refusalsRecorded = 0;
  private refusalsOmitted = 0;
  private omittedSince: string | null = null;
  private readonly flusher: ReturnType<typeof setInterval>;
  private calls = 0;
  private closed: Promise<EvidenceSummary> | null = null;
  // Whether the session's start was written: an end alone would make a log that never started
  // read as corrupted.
  private began = false;

  constructor(
    readonly store: EvidenceStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.flusher = setInterval(() => this.flushRefusals(), 1_000);
    this.flusher.unref?.();
  }

  get path(): string {
    return this.store.path;
  }

  failed(): string | null {
    return this.store.log.failed();
  }

  // The evidence directory failed beside the log, as a copy that could not be written there.
  fail(reason: string): void {
    this.store.log.markFailed(reason);
  }

  // The session's start, written and synced before its worker may run anything.
  sessionStarted(fields: Record<string, unknown>): boolean {
    this.began = this.store.log.appendCritical({ type: 'session.started', ...fields });
    return this.began;
  }

  // A call id unique in the session, which every entry of the call holds.
  nextCallId(): string {
    this.calls += 1;
    return `c${this.calls}`;
  }

  // A call about to be dispatched: written and synced first, or it is not dispatched.
  toolStarted(callId: string, fields: Record<string, unknown>): boolean {
    const written = this.store.log.appendCritical({ type: 'tool.started', callId, ...fields });
    if (written) this.started.add(callId);
    return written;
  }

  toolFinished(callId: string, fields: Record<string, unknown>): void {
    this.ended.add(callId);
    this.store.log.append({ type: 'tool.finished', callId, ...fields });
  }

  // A call the broker did not dispatch: before its start was written, with an id of its own, or
  // after, with the id of its start.
  toolRefused(callId: string, started: boolean, fields: Record<string, unknown>): void {
    this.ended.add(callId);
    this.store.log.append({ type: 'tool.refused', callId, started, ...fields }, true);
  }

  jobStarted(jobId: string, callId: string): void {
    if (this.jobs.has(jobId)) return;
    this.jobs.add(jobId);
    this.store.log.append({ type: 'job.started', jobId, callId }, true);
  }

  jobFinished(jobId: string, fields: Record<string, unknown>): void {
    if (!this.jobs.has(jobId) || this.jobsEnded.has(jobId)) return;
    this.jobsEnded.add(jobId);
    this.store.log.append({ type: 'job.finished', jobId, ...fields });
  }

  scopeRefreshed(before: Scope, after: Scope, changes: unknown): void {
    const old = scopeRecord(before);
    const next = scopeRecord(after);
    this.store.log.append(
      {
        type: 'scope.refreshed',
        changes,
        beforeSha256: old.sha256,
        afterSha256: next.sha256,
        scope: next.record,
      },
      true,
    );
  }

  scopeRefreshFailed(error: string): void {
    this.store.log.append({ type: 'scope.refresh.failed', error }, true);
  }

  networkStopped(reason: string): void {
    this.store.log.append({ type: 'network.stopped', reason }, true);
  }

  windowEnded(until: Date): void {
    this.store.log.append({ type: 'window.ended', until: until.toISOString() }, true);
  }

  proxy(event: ProxyEvent): void {
    if (event.type === 'authorized') {
      const { host, port, address } = event;
      this.store.log.append({ type: 'proxy.authorized', host, port, address });
      return;
    }
    const second = Math.floor(this.now().getTime() / 1_000);
    if (second !== this.refusalsSecond) {
      this.refusalsSecond = second;
      this.refusalsRecorded = 0;
    }
    if (this.refusalsRecorded < REFUSALS_PER_SECOND) {
      this.refusalsRecorded += 1;
      this.store.log.append({
        type: 'proxy.refused',
        reason: event.reason,
        ...(event.direct === true ? { direct: true } : {}),
      });
      return;
    }
    this.refusalsOmitted += 1;
    this.omittedSince ??= this.now().toISOString();
  }

  // Keeps a preservation among those the end of the session waits for.
  track<T>(work: Promise<T>): Promise<T> {
    return this.store.log.track(work);
  }

  // Waits for the copies under way, those that start meanwhile included, as long as the end of a
  // session gives them; says how many did not end. Each call waits for what is pending then.
  drain(): Promise<number> {
    return this.store.log.drain(DRAIN_MS);
  }

  // Resolves once no copy is under way.
  idle(): Promise<void> {
    return this.store.log.idle();
  }

  // The end of the session: the copies under way are waited for, those that did not end are told,
  // the refusals counted are written, then the end itself, synced; nothing is written after it. The
  // store's descriptors are closed once no copy uses them, so that none reaches a descriptor
  // number opened again for something else.
  close(fields: Record<string, unknown> = {}): Promise<EvidenceSummary> {
    this.closed ??= (async () => {
      clearInterval(this.flusher);
      // Again: a result that came in since the last wait can have started a copy.
      const unfinished = await this.drain();
      if (unfinished > 0) {
        this.store.log.append({
          type: 'preservation.incomplete',
          count: unfinished,
          reason: `copies still under way ${DRAIN_MS / 1000} s after the session ended`,
        });
      }
      this.flushRefusals();
      if (this.began) {
        this.store.log.appendCritical({
          type: 'session.ended',
          ...fields,
          callsWithoutOutcome: [...this.started].filter((id) => !this.ended.has(id)),
          jobsWithoutEnd: [...this.jobs].filter((id) => !this.jobsEnded.has(id)),
        });
      }
      const summary = {
        path: this.store.path,
        entries: this.store.log.entries,
        finalHash: this.store.log.lastHash,
      };
      this.store.log.close();
      void this.store.log.idle().then(() => this.store.close());
      return summary;
    })();
    return this.closed;
  }

  private flushRefusals(): void {
    if (this.refusalsOmitted === 0) return;
    this.store.log.append({
      type: 'proxy.refused.omitted',
      count: this.refusalsOmitted,
      since: this.omittedSince,
    });
    this.refusalsOmitted = 0;
    this.omittedSince = null;
  }
}

// How a call ended, from what its result says of it, when it says it in the expected types.
const outcome = (meta: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (meta === undefined) return {};
  const picked: Record<string, unknown> = {};
  if (typeof meta.exitCode === 'number' || meta.exitCode === null) picked.exitCode = meta.exitCode;
  if (typeof meta.signal === 'string' || meta.signal === null) picked.signal = meta.signal;
  if (typeof meta.termination === 'string') picked.termination = meta.termination;
  if (typeof meta.durationMs === 'number') picked.durationMs = meta.durationMs;
  return picked;
};

export type Preserve = (
  output: ReportedOutput,
  owner: string,
  kind: 'calls' | 'jobs',
) => Promise<Record<string, unknown>>;

// What the broker records each call by: its arguments with credentials taken out, its result with
// the host's secrets taken out, and its outputs as preserved. The outcome of a call whose outputs
// are copied is written once the copies are, which the end of the session waits for.
export const callRecorder = (
  evidence: EvidenceRecorder,
  secrets: readonly Secret[],
  preserve: Preserve,
  // Told when an output could not be preserved at all.
  failed: (why: string) => void,
): CallRecorder => ({
  failed: () => evidence.failed(),
  nextCallId: () => evidence.nextCallId(),
  started: (callId, call, details) =>
    evidence.toolStarted(callId, {
      providerCallId: call.id,
      agent: details.agent,
      tool: call.name,
      arguments: redactStrings(call.input, (text) => redactText(text, secrets)),
      cwd: details.cwd,
      runsOnHost: details.runsOnHost,
    }),
  finished: (callId, call, agent, result) => {
    const base = {
      providerCallId: call.id,
      agent,
      tool: call.name,
      isError: result.isError,
      content: redactExact(result.content, secrets),
      ...outcome(result.meta),
    };
    const outputs: CapturedOutput[] = result.outputs ?? [];
    if (outputs.length === 0) {
      evidence.toolFinished(callId, base);
      return;
    }
    void evidence.track(
      Promise.all(outputs.map((output) => preserve(output, callId, 'calls'))).then(
        (records) => evidence.toolFinished(callId, { ...base, outputs: records }),
        (error: unknown) => {
          const why = `the outputs could not be preserved: ${errorMessage(error)}`;
          evidence.toolFinished(callId, { ...base, outputsNotPreserved: why });
          failed(why);
        },
      ),
    );
  },
  refused: (callId, call, agent, started, result) =>
    evidence.toolRefused(callId, started, {
      providerCallId: call.id,
      agent,
      tool: call.name,
      reason: redactExact(result.content, secrets),
    }),
});
