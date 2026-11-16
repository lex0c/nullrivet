import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { contextBudget } from '../context/budget.ts';
import type { InstructionFile, InstructionsLoader } from '../instructions/agents-loader.ts';
import type { Provider, ProviderEffort } from '../providers/types.ts';
import type { ExecutionMode } from '../tools/policy.ts';
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
import { buildSystemPrompt, localDate, renderProjectContext } from './system-prompt.ts';

export const DEFAULT_MAX_STEPS = 200;
export const DEFAULT_STALL_MS = 120_000;
// Timers fire at once when the delay does not fit in a signed 32-bit integer (about 24.8 days).
export const MAX_TIME_LIMIT_MS = 2_147_483_647;

export interface AgentOptions {
  provider: Provider;
  tools: readonly Tool[];
  mode: ExecutionMode;
  cwd: string;
  // Null disables AGENTS.md loading.
  instructions: InstructionsLoader | null;
  effort?: ProviderEffort;
  maxSteps?: number;
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
  readonly conversation: Conversation;
  readonly bootWarnings: readonly string[];
  mode: ExecutionMode;
  effort: ProviderEffort | undefined;
  provider: Provider;
  readonly running: boolean;
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

const isInsideGitRepo = async (cwd: string): Promise<boolean> => {
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
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
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
    });
  // Rendered when the instructions are loaded, not for every request.
  let projectContextText = renderProjectContext(bootInstructions);
  const projectContext = (): string => projectContextText;

  const agent: Agent = {
    conversation,
    bootWarnings,
    mode: options.mode,
    effort: options.effort,
    provider: options.provider,

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
      }
    },

    async run(prompt: string, runOptions: RunOptions = {}): Promise<TurnResult> {
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
            instructions: options.instructions,
            limits,
            ...(agent.effort === undefined ? {} : { effort: agent.effort }),
            emit: runOptions.onEvent ?? (() => undefined),
            signal,
          },
          runOptions.input,
        );
      } finally {
        clearTimeout(timer);
        running = false;
      }
    },
  };
  return agent;
};
