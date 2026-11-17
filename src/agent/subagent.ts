import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { contextBudget } from '../context/budget.ts';
import { headTailSummary } from '../context/output-reduction.ts';
import { errorMessage } from '../errors.ts';
import { formatTokens } from '../format.ts';
import type { InstructionsLoader } from '../instructions/agents-loader.ts';
import type { Provider, ProviderEffort } from '../providers/types.ts';
import { optionalString, requireNonEmptyString } from '../tools/args.ts';
import { fileSystemError } from '../tools/file-io.ts';
import { finishOutput, outputFiles } from '../tools/output-files.ts';
import { resolvePath } from '../tools/paths.ts';
import { type Tool, type ToolResult, toolError } from '../tools/types.ts';
import { Conversation } from './conversation.ts';
import type {
  AgentEvent,
  AgentEventListener,
  PendingEventSource,
  SubagentStatus,
} from './events.ts';
import {
  type RuntimeNotice,
  runTurn,
  TimeLimitReached,
  type TurnLimit,
  type TurnResult,
} from './loop.ts';
import { buildSystemPrompt, localDate, renderProjectContext } from './system-prompt.ts';

export const SUBAGENT_MAX_STEPS = 40;
export const MAX_RUNNING_SUBAGENTS = 3;
// Subagents waiting for a slot. Past this, delegate is refused, so the subagents waiting to run,
// and the reports they will produce, stay bounded.
export const MAX_QUEUED_SUBAGENTS = 16;
// Counted from the start of a subagent's run. Each request has its own stall watchdog, but forty
// slow requests could still hold a slot for a long time.
export const SUBAGENT_MAX_RUNTIME_MS = 5 * 60_000;
// Share of the run time after which the next step is the last, so a subagent that runs out of time
// still writes its report before the run is aborted.
const FINAL_STEP_RUNTIME_SHARE = 0.8;
// About 4096 tokens: the parent keeps only the report, not the work behind it. A batch of notices
// for a small context window can lower it further.
export const REPORT_MAX_BYTES = 16 * 1024;
const TITLE_MAX_CHARS = 80;
const FINAL_STEP_NOTE =
  'This is your last step. Do not call tools: write your report now from what you have found, and list what remains undone under open issues.';

// What a subagent reads from the parent agent when it starts. Getters, because the model and the
// effort can change between and during turns.
export interface SubagentRuntime {
  provider: () => Provider;
  effort: () => ProviderEffort | undefined;
  cwd: string;
  // The tools a subagent may use. It runs in readonly mode, so only the read ones are offered and
  // executed; it never changes files or runs commands.
  tools: readonly Tool[];
  // Null when AGENTS.md loading is disabled.
  instructions: InstructionsLoader | null;
  stallMs: number;
  isGitRepo: (cwd: string) => Promise<boolean>;
}

// Waiting callers are served in arrival order; an abort while waiting gives up the place.
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return null;
    if (this.active >= this.limit) {
      const admitted = await new Promise<boolean>((resolve) => {
        const admit = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve(true);
        };
        const onAbort = (): void => {
          const index = this.waiting.indexOf(admit);
          if (index >= 0) this.waiting.splice(index, 1);
          resolve(false);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(admit);
      });
      if (!admitted) return null;
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) this.active--;
      else next();
    };
  }
}

// Why a subagent ended without completing, named by the runtime from what it observed, never taken
// from text a model or a service produced.
export type SubagentStopReason =
  | 'cancelled'
  | 'time_limit'
  | 'step_limit'
  | 'context_full'
  | 'output_limit'
  | 'provider_error'
  | 'internal_error';

const LIMIT_REASONS: Record<TurnLimit, SubagentStopReason> = {
  time: 'time_limit',
  steps: 'step_limit',
  context: 'context_full',
  output: 'output_limit',
};

export interface SubagentEvent {
  type: 'subagent.finished';
  id: string;
  at: number;
  status: SubagentStatus;
  reason?: SubagentStopReason;
  steps: number;
  toolErrors: number;
  tokens: number;
  // Text from the model and from services. It reaches the model only as data, reduced to the room
  // of the batch it is sent in.
  title: string;
  // A message that came with the stop, possibly from an external service.
  detail?: string;
  // The subagent's final answer, whole.
  report: string;
}

export class SubagentLimitError extends Error {}

export interface SubagentSpec {
  title: string;
  objective: string;
  // Reference material from the parent, sent to the subagent as data.
  context: string | undefined;
  cwd: string;
}

export interface SubagentRegistryOptions {
  maxRunning?: number;
  maxQueued?: number;
  maxRuntimeMs?: number;
}

interface Task {
  readonly id: string;
  readonly title: string;
  readonly controller: AbortController;
  state: 'queued' | 'running' | 'finished';
  // Its conversation was cleared: it reports nothing to the model and shows nothing new.
  discarded: boolean;
  // Whether subagent:start was emitted, so subagent:end is emitted only to close it.
  shown: boolean;
  event: SubagentEvent | null;
}

interface Outcome {
  status: SubagentStatus;
  reason?: SubagentStopReason;
  // A message that came with the stop, possibly from an external service.
  detail?: string;
  steps: number;
  report: string;
}

const finalAnswer = (conversation: Conversation): string => {
  const last = conversation.messages().at(-1);
  if (last?.role !== 'assistant' || typeof last.content === 'string') return '';
  return last.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n\n');
};

// The stop reason comes from what the loop observed, never from the text of its message.
const classify = (result: TurnResult): Omit<Outcome, 'steps' | 'report'> => {
  const detail = result.message === undefined ? {} : { detail: result.message };
  switch (result.reason) {
    case 'done':
      return { status: 'completed' };
    case 'aborted':
      return { status: 'cancelled', reason: 'cancelled' };
    case 'error':
      return { status: 'failed', reason: 'provider_error', ...detail };
    case 'budget':
      return { status: 'budget', reason: LIMIT_REASONS[result.limit ?? 'context'], ...detail };
  }
};

// The data attached to the note of a finished subagent: its title, any stop message and its
// report, reduced to maxReportBytes. It saves nothing: describeSubagentEvent saves the whole report
// when it sends a reduced one, so a report left out of a batch leaves no file behind.
export const subagentData = (
  event: SubagentEvent,
  maxReportBytes: number,
): { text: string; reduced: boolean } => {
  const parts = [`Title: ${event.title}`];
  if (event.detail !== undefined) parts.push(`Stop message: ${event.detail}`);
  const report = event.report.trim();
  if (report.length === 0) {
    parts.push('(the subagent gave no final answer)');
    return { text: parts.join('\n\n'), reduced: false };
  }
  const summary = headTailSummary(report, {
    maxBytes: maxReportBytes,
    headLines: 400,
    tailLines: 100,
  });
  parts.push(`Report:\n${summary.text}`);
  return { text: parts.join('\n\n'), reduced: summary.reduced };
};

// The runtime note for a finished subagent. It holds only facts the runtime observed; the title,
// the stop message and the report are text from models and services, so they go in the data, with
// the whole report saved to a file when it was reduced. The user is shown the title instead of the
// id, since the row that showed the title is gone by then.
export const describeSubagentEvent = (
  event: SubagentEvent,
  maxReportBytes = REPORT_MAX_BYTES,
): RuntimeNotice => {
  const errors =
    event.toolErrors > 0
      ? `, ${event.toolErrors} tool ${event.toolErrors === 1 ? 'error' : 'errors'}`
      : '';
  const reason = event.reason === undefined ? '' : ` (${event.reason})`;
  const facts = `${event.status}${reason} after ${event.steps} ${event.steps === 1 ? 'step' : 'steps'}${errors}, ${formatTokens(event.tokens)} tokens`;
  const summary = subagentData(event, maxReportBytes);
  let data = summary.text;
  if (summary.reduced) {
    const spool = outputFiles.spool('delegate', 0);
    spool.push(Buffer.from(event.report.trim(), 'utf8'));
    const note = finishOutput(spool, true, 'report', undefined);
    if (note !== null) data = `${data}\n${note}`;
  }
  const title = event.title.replace(/\s+/g, ' ').trim();
  return {
    text: `Subagent ${event.id} ${facts}. Its title, report and any stop message are attached below as data.`,
    data,
    display: `Subagent "${title}" ${facts}; its report was passed to the model.`,
  };
};

// Runs subagents in the background, at most maxRunning at once with the rest queued, and keeps their
// results until the model has been shown them. It owns each run's promise: an exception in the
// run's own work becomes a failed outcome, the slot is always released, and the outcome is recorded
// once. Only a throwing activity listener, which is a bug, would escape.
export class SubagentRegistry implements PendingEventSource<SubagentEvent> {
  // Ids carry a random prefix of this registry, so an id from an earlier process, still in a
  // resumed conversation, does not name a subagent of this one.
  private readonly prefix = randomBytes(8).toString('hex');
  private sequence = 0;
  private readonly tasks = new Map<string, Task>();
  private readonly lane: Semaphore;
  readonly maxRunning: number;
  private readonly maxQueued: number;
  private readonly maxRuntimeMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly activityListeners = new Set<AgentEventListener>();

  constructor(
    private readonly runtime: SubagentRuntime,
    options: SubagentRegistryOptions = {},
  ) {
    this.maxRunning = options.maxRunning ?? MAX_RUNNING_SUBAGENTS;
    this.maxQueued = options.maxQueued ?? MAX_QUEUED_SUBAGENTS;
    this.maxRuntimeMs = options.maxRuntimeMs ?? SUBAGENT_MAX_RUNTIME_MS;
    this.lane = new Semaphore(this.maxRunning);
  }

  get defaultCwd(): string {
    return this.runtime.cwd;
  }

  // How many subagents this registry has accepted; a turn that leaves it unchanged delegated nothing.
  get startedCount(): number {
    return this.sequence;
  }

  // Starts the subagent, or queues it when every slot is taken, and returns at once.
  start(spec: SubagentSpec): { id: string; queued: boolean } {
    const active = this.active();
    if (active >= this.maxRunning + this.maxQueued) {
      throw new SubagentLimitError(
        `${this.maxRunning} subagents are running and ${this.maxQueued} are waiting, the most allowed`,
      );
    }
    this.sequence += 1;
    const task: Task = {
      id: `${this.prefix}-${this.sequence}`,
      title: spec.title,
      controller: new AbortController(),
      state: 'queued',
      discarded: false,
      shown: false,
      event: null,
    };
    this.tasks.set(task.id, task);
    void this.execute(task, spec);
    return { id: task.id, queued: active >= this.maxRunning };
  }

  // Subagents running or waiting for a slot.
  active(): number {
    let count = 0;
    for (const task of this.tasks.values()) if (task.state !== 'finished') count += 1;
    return count;
  }

  // Stops every running and queued subagent not stopped yet, and returns how many it stopped; each
  // reports that it was cancelled.
  cancelAll(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.state === 'finished' || task.controller.signal.aborted) continue;
      task.controller.abort();
      count += 1;
    }
    return count;
  }

  // Stops every subagent and forgets their results, because the conversation that started them was
  // cleared. A run that ends afterwards still reports its tokens and closes its row in the
  // interface, and nothing else.
  discardAll(): void {
    for (const task of [...this.tasks.values()]) {
      task.discarded = true;
      if (task.state === 'finished') this.tasks.delete(task.id);
      else task.controller.abort();
    }
  }

  // Calls `listener` when a result becomes pending, in a microtask of its own and only while it
  // is still subscribed. It carries no event: the agent takes results with pendingEvents.
  onEvent(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Receives what the subagents do (start, progress, usage, warnings, end) for as long as the
  // registry lives, independently of the turn that delegated them.
  onActivity(listener: AgentEventListener): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  hasPendingEvents(): boolean {
    for (const task of this.tasks.values()) if (task.event !== null) return true;
    return false;
  }

  pendingEvents(): SubagentEvent[] {
    const events: SubagentEvent[] = [];
    for (const task of this.tasks.values()) if (task.event !== null) events.push(task.event);
    return events.sort((a, b) => a.at - b.at);
  }

  // A result shown to the model is forgotten: nothing can ask for it again.
  markDelivered(events: readonly SubagentEvent[]): void {
    for (const event of events) this.tasks.delete(event.id);
  }

  // The discarded flag is read here, when the event is dispatched, so nothing a discarded run
  // produces later reaches the interface, apart from its tokens and the end of its row.
  private emit(task: Task, event: AgentEvent): void {
    if (task.discarded && event.type !== 'usage' && event.type !== 'subagent:end') return;
    for (const listener of this.activityListeners) listener(event);
  }

  private announce(): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        if (this.listeners.has(listener)) listener();
      });
    }
  }

  private async execute(task: Task, spec: SubagentSpec): Promise<void> {
    const stats = { tokens: 0, toolErrors: 0 };
    let outcome: Outcome;
    let release: (() => void) | null = null;
    try {
      release = await this.lane.acquire(task.controller.signal);
      // A slot handed over just as the task was cancelled is given back at once.
      if (release === null || task.controller.signal.aborted) {
        outcome = { status: 'cancelled', reason: 'cancelled', steps: 0, report: '' };
      } else {
        task.state = 'running';
        if (!task.discarded) {
          task.shown = true;
          this.emit(task, {
            type: 'subagent:start',
            id: task.id,
            title: task.title,
          });
        }
        outcome = await this.run(task, spec, stats);
      }
    } catch (error) {
      outcome = {
        status: 'failed',
        reason: 'internal_error',
        detail: errorMessage(error),
        steps: 0,
        report: '',
      };
    } finally {
      release?.();
    }
    task.state = 'finished';
    if (task.shown) {
      this.emit(task, {
        type: 'subagent:end',
        id: task.id,
        status: outcome.status,
        steps: outcome.steps,
      });
    }
    if (task.discarded) {
      this.tasks.delete(task.id);
      return;
    }
    task.event = {
      type: 'subagent.finished',
      id: task.id,
      at: Date.now(),
      status: outcome.status,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      steps: outcome.steps,
      toolErrors: stats.toolErrors,
      tokens: stats.tokens,
      title: task.title,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      report: outcome.report,
    };
    this.announce();
  }

  private async run(
    task: Task,
    spec: SubagentSpec,
    stats: { tokens: number; toolErrors: number },
  ): Promise<Outcome> {
    // The same reason as the session's --timeout, which runTurn reports as a limit, not as a
    // cancellation.
    const deadline = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(
      () => deadline.abort(new TimeLimitReached(this.maxRuntimeMs)),
      this.maxRuntimeMs,
    );
    const signal = AbortSignal.any([task.controller.signal, deadline.signal]);
    try {
      const { runtime } = this;
      const provider = runtime.provider();
      const effort = runtime.effort();
      const instructions = runtime.instructions?.fork() ?? null;
      const boot = instructions === null ? null : await instructions.discover([spec.cwd]);
      for (const warning of boot?.warnings ?? []) {
        this.emit(task, { type: 'warning', message: `subagent "${task.title}": ${warning}` });
      }
      const projectContext = renderProjectContext(boot?.files ?? []);
      const isGitRepo = await runtime.isGitRepo(spec.cwd);
      const onEvent = (event: AgentEvent): void => {
        switch (event.type) {
          case 'usage':
            stats.tokens += event.input + event.output + event.cacheRead + event.cacheWrite;
            this.emit(task, { ...event, subagent: task.id });
            return;
          case 'tool:start':
            this.emit(task, {
              type: 'subagent:progress',
              id: task.id,
              step: event.step,
              tool: { name: event.name, args: event.args },
            });
            return;
          case 'tool:end':
            if (event.isError) stats.toolErrors += 1;
            return;
          case 'warning':
            this.emit(task, {
              type: 'warning',
              message: `subagent "${task.title}": ${event.message}`,
            });
            return;
          default:
            return;
        }
      };
      const conversation = new Conversation();
      const result = await runTurn(
        spec.objective,
        {
          provider,
          conversation,
          tools: new Map(runtime.tools.map((tool) => [tool.name, tool])),
          mode: () => 'readonly',
          cwd: spec.cwd,
          systemPrompt: () =>
            buildSystemPrompt({
              cwd: spec.cwd,
              mode: 'readonly',
              platform: process.platform,
              date: localDate(),
              isGitRepo,
              role: 'subagent',
            }),
          projectContext: () => projectContext,
          instructions,
          limits: {
            maxSteps: SUBAGENT_MAX_STEPS,
            maxOutputTokens: contextBudget(provider.capabilities).maxOutput,
            stallMs: runtime.stallMs,
            finalStepNote: FINAL_STEP_NOTE,
            finalStepAt: startedAt + this.maxRuntimeMs * FINAL_STEP_RUNTIME_SHARE,
          },
          ...(effort === undefined ? {} : { effort }),
          emit: onEvent,
          signal,
        },
        spec.context,
      );
      return {
        ...classify(result),
        steps: result.steps,
        report: finalAnswer(conversation),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const createDelegateTool = (registry: SubagentRegistry): Tool => ({
  name: 'delegate',
  description: [
    'Start a subagent in the background on a self-contained investigation, and return at once with its id: continue with other work meanwhile.',
    'The subagent starts with an empty conversation: it sees only `objective` and `context`, never this conversation, so include every path, constraint and decision it needs. Requirements go in `objective`; `context` reaches the subagent as data.',
    'It only reads: it reads and searches files and inspects git history, but never changes files or runs commands.',
    'Its report reaches you as a runtime note with the report attached as data: at your next step, or by a new turn of your own once you have finished. Files may have changed since it read them.',
    `Up to ${MAX_RUNNING_SUBAGENTS} subagents run at once and up to ${MAX_QUEUED_SUBAGENTS} more wait for a slot. A subagent has at most ${SUBAGENT_MAX_STEPS} steps and ${SUBAGENT_MAX_RUNTIME_MS / 60_000} minutes, and cannot delegate further.`,
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short label shown to the user.' },
      objective: {
        type: 'string',
        description:
          'The task, complete on its own: what to find out, the constraints to respect, and what to report.',
      },
      context: {
        type: 'string',
        description:
          'Reference material from this conversation: paths, findings, excerpts. It reaches the subagent as data, so put requirements and constraints in objective.',
      },
      cwd: {
        type: 'string',
        description: 'Starting directory of the subagent. Defaults to the session directory.',
      },
    },
    required: ['title', 'objective'],
  },
  // The subagent only reads, so delegating is allowed in readonly mode.
  effect: 'read',
  async execute(input, ctx): Promise<ToolResult> {
    const title = requireNonEmptyString(input, 'title').slice(0, TITLE_MAX_CHARS);
    const objective = requireNonEmptyString(input, 'objective');
    const context = optionalString(input, 'context');
    const cwdArg = optionalString(input, 'cwd');
    const cwd = cwdArg === undefined ? registry.defaultCwd : resolvePath(cwdArg, ctx.cwd);
    try {
      if (!(await stat(cwd)).isDirectory()) {
        return toolError('fs.not_directory', `cwd is not a directory: ${cwd}`);
      }
    } catch (error) {
      return fileSystemError(error, 'read', cwd);
    }
    // An interrupt while the directory was checked has already cancelled the subagents; one
    // registered now would escape it.
    if (ctx.signal.aborted) {
      return toolError(
        'subagent.interrupted',
        'the task was interrupted before the subagent started',
      );
    }
    // The objective is the task; the context is reference material the parent may have copied
    // from files or command output, so it reaches the subagent fenced as data.
    const material = context === undefined || context.trim().length === 0 ? undefined : context;
    let started: { id: string; queued: boolean };
    try {
      started = registry.start({ title, objective, context: material, cwd });
    } catch (error) {
      if (!(error instanceof SubagentLimitError)) throw error;
      return toolError(
        'subagent.limit',
        error.message,
        'Wait for a report before delegating more.',
      );
    }
    const how = started.queued
      ? `Queued subagent ${started.id}: ${registry.maxRunning} are running, so it starts when one of them ends.`
      : `Started subagent ${started.id}.`;
    return {
      content: `${how} Its report reaches you as a runtime note when it ends.`,
      isError: false,
      meta: { subagentId: started.id, queued: started.queued },
    };
  },
});
