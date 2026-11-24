import { type BackgroundJobs, type JobEvent, MAX_RUNNING_JOBS } from '../tools/jobs.ts';
import { JOB_ID_PATTERN, type JobMessage } from './protocol.ts';

// Finished jobs whose events were all delivered are forgotten beyond this many.
const RETAINED_FINISHED_JOBS = 200;

interface Received {
  event: JobEvent;
  delivered: boolean;
}

interface ProjectedJob {
  ready: Received | null;
  finished: Received | null;
  // Written here when the sandbox stopped before the job ended.
  lost: Received | null;
  // Its conversation was cleared: nothing about it is reported any more.
  dropped: boolean;
}

const ended = (job: ProjectedJob): boolean => job.finished !== null || job.lost !== null;

const settled = (job: ProjectedJob): boolean =>
  ended(job) &&
  [job.ready, job.finished, job.lost].every((received) => received === null || received.delivered);

// What the host knows of the jobs a sandboxed worker runs, built from the facts the worker sends
// as they happen. The worker is the source of truth and keeps the processes and logs; this keeps
// what the agent and the interactive session read at once: which jobs run, and which events wait
// to be shown to the model. Delivery is decided here alone, so nothing is confirmed back to the
// worker: it may forget a job before its note reaches the model, since the facts are already here.
export class JobProjection implements BackgroundJobs {
  private readonly jobs = new Map<string, ProjectedJob>();
  private readonly listeners = new Set<() => void>();
  private prefix: string | null = null;
  // The sequence number of the last job started, and of the last event.
  private lastJob = 0;
  private lastSeq = 0;
  private started = 0;
  private backendLost = false;

  get startedCount(): number {
    return this.started;
  }

  // Takes a job message from the worker. Returns why it breaks the protocol, or null.
  receive(message: JobMessage): string | null {
    if (message.type === 'job.event') return this.receiveEvent(message.seq, message.event);
    const id = this.parseId(message.jobId);
    if (typeof id === 'string') return id;
    if (message.type === 'job.started') {
      // The worker numbers a job before it spawns it, so two starts that overlapped could be
      // announced out of order. They cannot today: only the main agent has the job tools, and it
      // runs its calls one after another. Running them at the same time needs this rule relaxed.
      if (id.number <= this.lastJob)
        return `job ${message.jobId} was started twice or out of order`;
      // The worker admits a job only below this limit, and sends every end before the next start,
      // so more would only grow this map for a worker that does not follow the protocol.
      if (this.running() >= MAX_RUNNING_JOBS) {
        return `job ${message.jobId} was started while ${MAX_RUNNING_JOBS} jobs were running`;
      }
      this.lastJob = id.number;
      this.jobs.set(message.jobId, { ready: null, finished: null, lost: null, dropped: false });
      this.started += 1;
      return null;
    }
    const job = this.jobs.get(message.jobId);
    if (job === undefined) {
      // Each side forgets settled jobs on its own schedule, so a show of a job no longer kept here
      // is not a violation.
      return id.number <= this.lastJob ? null : `job ${message.jobId} was shown before it started`;
    }
    this.deliverAll(job);
    return null;
  }

  pendingEvents(): JobEvent[] {
    const events: JobEvent[] = [];
    for (const job of this.jobs.values()) {
      const end = job.finished ?? job.lost;
      const endPending = end !== null && !end.delivered;
      // A job that has ended is reported by its end alone: that it became ready is no longer news.
      if (job.ready !== null && !job.ready.delivered && !endPending) events.push(job.ready.event);
      if (end !== null && endPending) events.push(end.event);
    }
    return events.sort((a, b) => a.at - b.at);
  }

  // An end also settles the job's ready event, if that one is still pending.
  markDelivered(events: readonly JobEvent[]): void {
    for (const event of events) {
      const job = this.jobs.get(event.jobId);
      if (job === undefined) continue;
      if (event.type === 'job.ready') {
        if (job.ready !== null) job.ready.delivered = true;
      } else {
        this.deliverAll(job);
      }
    }
    this.prune();
  }

  // Once the sandbox is lost, no event starts a turn of its own: every tool would be refused in it.
  // The events still go out with the next prompt.
  hasPendingEvents(): boolean {
    if (this.backendLost) return false;
    for (const job of this.jobs.values()) {
      if ([job.ready, job.finished, job.lost].some((received) => received?.delivered === false)) {
        return true;
      }
    }
    return false;
  }

  onEvent(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Only the main agent has the job tools, and the conversation is cleared between its turns:
  // every job started so far is known here, since its start arrives before the result of the call
  // that started it.
  dropEvents(): void {
    for (const job of this.jobs.values()) {
      job.dropped = true;
      this.deliverAll(job);
    }
    this.prune();
  }

  running(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (!ended(job)) count += 1;
    return count;
  }

  // The sandbox stopped: the jobs still running ended with it. They are reported as lost, without
  // the reason, which can hold text from the worker.
  lose(): void {
    if (this.backendLost) return;
    this.backendLost = true;
    const at = Date.now();
    for (const [jobId, job] of this.jobs) {
      if (ended(job)) continue;
      job.lost = { event: { type: 'job.lost', jobId, at }, delivered: job.dropped };
    }
    this.announce();
  }

  private receiveEvent(seq: number, event: JobEvent): string | null {
    if (seq !== this.lastSeq + 1) return `job event ${seq} came after ${this.lastSeq}`;
    this.lastSeq = seq;
    const job = this.jobs.get(event.jobId);
    if (job === undefined) return `an event for job ${event.jobId}, which did not start`;
    if (ended(job)) return `an event for job ${event.jobId} after it ended`;
    if (event.type === 'job.ready') {
      if (job.ready !== null) return `job ${event.jobId} became ready twice`;
      job.ready = { event, delivered: job.dropped };
    } else {
      job.finished = { event, delivered: job.dropped };
    }
    // On every ready or end, whether delivered or not, as the registry announces them: the
    // interactive session refreshes its footer on it.
    this.announce();
    this.prune();
    return null;
  }

  private parseId(jobId: string): { number: number } | string {
    const match = JOB_ID_PATTERN.exec(jobId);
    const number = Number(match?.[2]);
    if (match === null || !Number.isSafeInteger(number)) return `an invalid job id ${jobId}`;
    this.prefix ??= match[1] ?? null;
    if (match[1] !== this.prefix) return `job ${jobId} is not of this worker's registry`;
    return { number };
  }

  private deliverAll(job: ProjectedJob): void {
    for (const received of [job.ready, job.finished, job.lost]) {
      if (received !== null) received.delivered = true;
    }
  }

  private announce(): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        if (this.listeners.has(listener)) listener();
      });
    }
  }

  private prune(): void {
    const done = [...this.jobs].filter(([, job]) => settled(job));
    for (const [jobId] of done.slice(0, Math.max(0, done.length - RETAINED_FINISHED_JOBS))) {
      this.jobs.delete(jobId);
    }
  }
}
