import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { contextBudget } from '../context/budget.ts';
import type { InstructionFile, InstructionsLoader } from '../instructions/agents-loader.ts';
import type { Provider, ProviderEffort } from '../providers/types.ts';
import {
  createJobTools,
  describeJobEvent,
  type JobEvent,
  JobRegistry,
  type JobSession,
} from '../tools/jobs.ts';
import type { ExecutionMode } from '../tools/policy.ts';
import { MAX_TIMER_DELAY_MS } from '../tools/process.ts';
import type { Tool } from '../tools/types.ts';
import { type CompactionOutcome, compactConversation } from './compactor.ts';
import { Conversation } from './conversation.ts';
import type { AgentEventListener, PendingEventSource } from './events.ts';
import {
  type LoopLimits,
  promptShape,
  type RuntimeNotice,
  runTurn,
  TimeLimitReached,
  type TurnResult,
} from './loop.ts';
import {
  createDelegateTool,
  describeSubagentEvent,
  REPORT_MAX_BYTES,
  type SubagentEvent,
  SubagentRegistry,
  subagentDataBytes,
} from './subagent.ts';
import { buildSystemPrompt, localDate, renderProjectContext } from './system-prompt.ts';

export const DEFAULT_MAX_STEPS = 200;
export const DEFAULT_STALL_MS = 120_000;
export const MAX_TIME_LIMIT_MS = MAX_TIMER_DELAY_MS;

export interface AgentOptions {
  provider: Provider;
  tools: readonly Tool[];
  mode: ExecutionMode;
  cwd: string;
  // Null disables AGENTS.md loading.
  instructions: InstructionsLoader | null;
  effort?: ProviderEffort;
  maxSteps?: number;
  // Offers the delegate tool, which starts subagents in the background. Off unless set to true:
  // their reports reach the model only through runOnBackgroundEvents or a later turn, so only a
  // caller that keeps the agent for more turns, such as the interactive session, should set it.
  delegation?: boolean;
  // Offers the background job tools (bash_background, bash_jobs, bash_kill) to this agent only,
  // never to its subagents, described for the kind of session: an interactive one starts turns on
  // job events (runOnBackgroundEvents), a one-shot run exits when the task ends. Off when omitted.
  backgroundJobs?: JobSession;
  // Wall-clock limit of each task; when it passes, the task is stopped like an interrupt and ends
  // at a limit.
  timeLimitMs?: number;
  stallMs?: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: AgentEventListener;
  // Material the prompt refers to, such as text piped on stdin. It is sent after the prompt as
  // data, not as further requests.
  input?: string;
}

export interface CompactOptions extends RunOptions {
  // What the summary should focus on.
  instructions?: string;
}

export interface Agent {
  run(prompt: string, options?: RunOptions): Promise<TurnResult>;
  // Runs a turn without a prompt, on the pending background events alone (jobs and subagents that
  // ended), which reach the model as runtime notes. Resolves with null, without starting a turn,
  // when none are pending.
  runOnBackgroundEvents(options?: Omit<RunOptions, 'input'>): Promise<TurnResult | null>;
  // Whether background events are waiting to be shown to the model.
  hasBackgroundEvents(): boolean;
  // Calls `listener` when a background event becomes pending; returns the unsubscribe.
  onBackgroundEvent(listener: () => void): () => void;
  // What the background subagents do (start, progress, usage, warnings, end), whichever turn
  // started them; returns the unsubscribe.
  onSubagentActivity(listener: AgentEventListener): () => void;
  // Subagents running or waiting for a slot.
  runningSubagents(): number;
  // Stops every running and queued subagent not stopped yet, and returns how many it stopped; each
  // reports that it was cancelled.
  cancelSubagents(): number;
  // How many background jobs and subagents this agent has started. A turn that leaves it unchanged
  // started no background work, so it cannot cause more background events.
  backgroundStarts(): number;
  readonly conversation: Conversation;
  readonly bootWarnings: readonly string[];
  mode: ExecutionMode;
  effort: ProviderEffort | undefined;
  provider: Provider;
  readonly running: boolean;
  // Called whenever the conversation is in a consistent state worth keeping: after each step of a
  // turn, after a compaction and when a turn ends. Set by whoever persists the conversation; it
  // must not throw. Null, the default, keeps nothing.
  checkpoint: (() => Promise<void>) | null;
  clear(): void;
  // Compacts the conversation now. Resolves with null when there is nothing to compact.
  compact(options?: CompactOptions): Promise<CompactionOutcome | null>;
  // AGENTS.md files currently known: the ones of the starting directory, sent with every request,
  // plus the ones attached to tool results of the current conversation.
  instructions(): readonly InstructionFile[];
  // Reads the AGENTS.md files of the starting directory again. Files attached to earlier tool
  // results are forgotten, so they are attached again when their paths are touched.
  reloadInstructions(): Promise<{ files: readonly InstructionFile[]; warnings: readonly string[] }>;
}

export const isInsideGitRepo = async (cwd: string): Promise<boolean> => {
  let current = cwd;
  while (true) {
    try {
      await stat(join(current, '.git'));
      return true;
    } catch {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
};

// New report data in one batch of notices, about two full reports. Each report is already reduced
// to 16 KiB, but many finishing together could pass the context window, and compaction cannot
// shorten them: the batch is the latest message, which a compaction keeps as it is.
export const REPORT_DATA_PER_BATCH_BYTES = 32 * 1024;
// A batch also takes at most a quarter of the context window, counted with few bytes per token so
// the estimate errs on the small side, and leaves the rest to the conversation and the answer.
const REPORT_WINDOW_SHARE = 0.25;
const REPORT_BYTES_PER_TOKEN = 3;
// Below this, the lines around a report (its title, stop message and the name of its saved file)
// would not fit. A context window that small cannot hold a conversation anyway.
const REPORT_DATA_MIN_BYTES = 2 * 1024;

export const reportDataBudget = (contextWindow: number): number =>
  Math.max(
    REPORT_DATA_MIN_BYTES,
    Math.min(
      REPORT_DATA_PER_BATCH_BYTES,
      Math.floor(contextWindow * REPORT_WINDOW_SHARE) * REPORT_BYTES_PER_TOKEN,
    ),
  );

interface Pending {
  at: number;
  notice: RuntimeNotice;
}

// Picks the next batch of notices from both sources and marks only those as delivered. Job notices
// carry no data and are always taken, so reports waiting for room never hold back the end of a
// job. Reports are taken oldest first while their data fits in `budget` bytes, and at least one, so
// each batch makes progress; the rest stay pending for the next request. The data of one report,
// its title and stop message included, never exceeds the budget, so neither does the batch: a
// longer report is reduced to fit, and saved whole.
export const nextNotices = (
  jobs: PendingEventSource<JobEvent> | null,
  subagents: PendingEventSource<SubagentEvent> | null,
  budget: number,
): RuntimeNotice[] => {
  const jobEvents = jobs?.pendingEvents() ?? [];
  const maxDataBytes = Math.min(REPORT_MAX_BYTES, budget);
  const reports: SubagentEvent[] = [];
  let bytes = 0;
  for (const event of subagents?.pendingEvents() ?? []) {
    const size = subagentDataBytes(event, maxDataBytes);
    if (reports.length > 0 && bytes + size > budget) break;
    reports.push(event);
    bytes += size;
  }
  jobs?.markDelivered(jobEvents);
  subagents?.markDelivered(reports);
  const picked: Pending[] = [
    ...jobEvents.map((event) => ({ at: event.at, notice: { text: describeJobEvent(event) } })),
    ...reports.map((event) => ({
      at: event.at,
      notice: describeSubagentEvent(event, maxDataBytes),
    })),
  ];
  return picked.sort((a, b) => a.at - b.at).map((item) => item.notice);
};

export const createAgent = async (options: AgentOptions): Promise<Agent> => {
  const conversation = new Conversation();
  const subagents =
    options.delegation !== true
      ? null
      : new SubagentRegistry({
          provider: () => agent.provider,
          effort: () => agent.effort,
          cwd: options.cwd,
          tools: options.tools,
          instructions: options.instructions,
          stallMs: options.stallMs ?? DEFAULT_STALL_MS,
          isGitRepo: isInsideGitRepo,
        });
  const delegate = subagents === null ? [] : [createDelegateTool(subagents)];
  let jobs: JobRegistry | null = null;
  const jobTools: Tool[] = [];
  if (options.backgroundJobs !== undefined) {
    jobs = new JobRegistry();
    jobTools.push(...createJobTools(jobs, options.backgroundJobs));
  }
  const tools = new Map(
    [...options.tools, ...delegate, ...jobTools].map((tool) => [tool.name, tool]),
  );
  const bootWarnings: string[] = [];
  let bootInstructions: InstructionFile[] = [];
  if (options.instructions !== null) {
    const discovered = await options.instructions.discover([options.cwd]);
    bootInstructions = discovered.files;
    bootWarnings.push(...discovered.warnings);
  }
  const isGitRepo = await isInsideGitRepo(options.cwd);
  let running = false;

  const systemPrompt = (): string =>
    buildSystemPrompt({
      cwd: options.cwd,
      mode: agent.mode,
      platform: process.platform,
      date: localDate(),
      isGitRepo,
      delegation: delegate.length > 0,
    });
  // Rendered when the instructions are loaded, not for every request.
  let projectContextText = renderProjectContext(bootInstructions);
  const projectContext = (): string => projectContextText;

  // One turn at a time, with or without a prompt.
  const runOneTurn = async (prompt: string | null, runOptions: RunOptions): Promise<TurnResult> => {
    if (running) throw new Error('the agent is already running a turn');
    running = true;
    const external = runOptions.signal ?? new AbortController().signal;
    const timeLimitMs =
      options.timeLimitMs === undefined
        ? undefined
        : Math.min(options.timeLimitMs, MAX_TIME_LIMIT_MS);
    const deadline = timeLimitMs === undefined ? null : new AbortController();
    const timer =
      deadline === null
        ? undefined
        : setTimeout(() => deadline.abort(new TimeLimitReached(timeLimitMs ?? 0)), timeLimitMs);
    const signal = deadline === null ? external : AbortSignal.any([external, deadline.signal]);
    try {
      const limits: LoopLimits = {
        maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
        maxOutputTokens: contextBudget(agent.provider.capabilities).maxOutput,
        stallMs: options.stallMs ?? DEFAULT_STALL_MS,
      };
      return await runTurn(
        prompt,
        {
          provider: agent.provider,
          conversation,
          tools,
          mode: () => agent.mode,
          cwd: options.cwd,
          systemPrompt,
          projectContext,
          checkpoint: async () => {
            await agent.checkpoint?.();
          },
          instructions: options.instructions,
          limits,
          ...(agent.effort === undefined ? {} : { effort: agent.effort }),
          ...(jobs === null && subagents === null
            ? {}
            : {
                notices: () =>
                  nextNotices(
                    jobs,
                    subagents,
                    reportDataBudget(agent.provider.capabilities.context_window),
                  ),
              }),
          emit: runOptions.onEvent ?? (() => undefined),
          signal,
        },
        runOptions.input,
      );
    } finally {
      clearTimeout(timer);
      running = false;
      // Also after an interrupted or failed turn: the conversation is consistent, and calls
      // left unanswered are answered before the next prompt.
      await agent.checkpoint?.();
    }
  };

  const agent: Agent = {
    conversation,
    bootWarnings,
    mode: options.mode,
    effort: options.effort,
    provider: options.provider,
    checkpoint: null,

    get running(): boolean {
      return running;
    },

    instructions(): readonly InstructionFile[] {
      return options.instructions?.list() ?? [];
    },

    async reloadInstructions() {
      if (options.instructions === null) return { files: [], warnings: [] };
      if (running) throw new Error('instructions cannot be reloaded while a turn is running');
      const discovered = await options.instructions.reload([options.cwd]);
      bootInstructions = discovered.files;
      projectContextText = renderProjectContext(bootInstructions);
      return discovered;
    },

    clear(): void {
      conversation.clear();
      // Boot instructions are sent with every request; the ones attached to tool results of the
      // discarded conversation must be attached again when needed.
      options.instructions?.retainOnly(new Set(bootInstructions.map((file) => file.path)));
      // Jobs started by the discarded conversation keep running, but their events must not reach
      // the new one, where nothing explains them, nor start turns in it.
      jobs?.dropEvents();
      // Subagents of the discarded conversation are stopped, and their reports forgotten.
      subagents?.discardAll();
    },

    async compact(compactOptions: CompactOptions = {}): Promise<CompactionOutcome | null> {
      if (running) throw new Error('the conversation cannot be compacted while a turn is running');
      running = true;
      try {
        return await compactConversation({
          provider: agent.provider,
          conversation,
          shape: promptShape({
            provider: agent.provider,
            mode: () => agent.mode,
            tools,
            systemPrompt,
            projectContext,
          }),
          reason: 'manual',
          ...(compactOptions.instructions === undefined
            ? {}
            : { instructions: compactOptions.instructions }),
          emit: compactOptions.onEvent ?? (() => undefined),
          signal: compactOptions.signal ?? new AbortController().signal,
        });
      } finally {
        running = false;
        await agent.checkpoint?.();
      }
    },

    run(prompt: string, runOptions: RunOptions = {}): Promise<TurnResult> {
      return runOneTurn(prompt, runOptions);
    },

    // The check runs before any await, so a caller that found events pending starts on them.
    async runOnBackgroundEvents(
      runOptions: Omit<RunOptions, 'input'> = {},
    ): Promise<TurnResult | null> {
      if (!agent.hasBackgroundEvents()) return null;
      return runOneTurn(null, runOptions);
    },

    hasBackgroundEvents(): boolean {
      return (jobs?.hasPendingEvents() ?? false) || (subagents?.hasPendingEvents() ?? false);
    },

    onBackgroundEvent(listener: () => void): () => void {
      const stopJobs = jobs?.onEvent(listener);
      const stopSubagents = subagents?.onEvent(listener);
      return () => {
        stopJobs?.();
        stopSubagents?.();
      };
    },

    onSubagentActivity(listener: AgentEventListener): () => void {
      return subagents?.onActivity(listener) ?? (() => undefined);
    },

    runningSubagents(): number {
      return subagents?.active() ?? 0;
    },

    cancelSubagents(): number {
      return subagents?.cancelAll() ?? 0;
    },

    backgroundStarts(): number {
      return (jobs?.startedCount ?? 0) + (subagents?.startedCount ?? 0);
    },
  };
  return agent;
};
