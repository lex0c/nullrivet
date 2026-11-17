import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { contextBudget } from '../context/budget.ts';
import type { InstructionFile, InstructionsLoader } from '../instructions/agents-loader.ts';
import type { Provider, ProviderEffort } from '../providers/types.ts';
import { createJobTools, describeJobEvent, JobRegistry, type JobSession } from '../tools/jobs.ts';
import type { ExecutionMode } from '../tools/policy.ts';
import { MAX_TIMER_DELAY_MS } from '../tools/process.ts';
import type { Tool } from '../tools/types.ts';
import { type CompactionOutcome, compactConversation } from './compactor.ts';
import { Conversation } from './conversation.ts';
import type { AgentEventListener } from './events.ts';
import {
  type LoopLimits,
  promptShape,
  runTurn,
  TimeLimitReached,
  type TurnResult,
} from './loop.ts';
import { createDelegateTool } from './subagent.ts';
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
  // Offers the delegate tool, which starts subagents; on unless set to false.
  delegation?: boolean;
  // Offers the background job tools (bash_background, bash_jobs, bash_kill) to this agent only,
  // never to its subagents, described for the kind of session: an interactive one starts turns on
  // job events (runOnJobEvents), a one-shot run exits when the task ends. Off when omitted.
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
  // Runs a turn without a prompt, on the pending background job events alone, which reach the
  // model as runtime notes. Resolves with null, without starting a turn, when none are pending.
  runOnJobEvents(options?: Omit<RunOptions, 'input'>): Promise<TurnResult | null>;
  // Whether background job events are waiting to be shown to the model.
  hasJobEvents(): boolean;
  // Calls `listener` when a background job event becomes pending; returns the unsubscribe.
  onJobEvent(listener: () => void): () => void;
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

export const createAgent = async (options: AgentOptions): Promise<Agent> => {
  const conversation = new Conversation();
  const delegate =
    options.delegation === false
      ? []
      : [
          createDelegateTool({
            provider: () => agent.provider,
            effort: () => agent.effort,
            parentMode: () => agent.mode,
            cwd: options.cwd,
            tools: options.tools,
            instructions: options.instructions,
            stallMs: options.stallMs ?? DEFAULT_STALL_MS,
            isGitRepo: isInsideGitRepo,
          }),
        ];
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
          ...(jobs === null ? {} : { notices: () => jobs.drainEvents().map(describeJobEvent) }),
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
    async runOnJobEvents(runOptions: Omit<RunOptions, 'input'> = {}): Promise<TurnResult | null> {
      if (jobs === null || !jobs.hasPendingEvents()) return null;
      return runOneTurn(null, runOptions);
    },

    hasJobEvents(): boolean {
      return jobs?.hasPendingEvents() ?? false;
    },

    onJobEvent(listener: () => void): () => void {
      return jobs?.onEvent(listener) ?? (() => undefined);
    },
  };
  return agent;
};
