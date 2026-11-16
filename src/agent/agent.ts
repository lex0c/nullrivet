import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { InstructionFile, InstructionsLoader } from '../instructions/agents-loader.ts';
import type { Provider, ProviderEffort } from '../providers/types.ts';
import type { ExecutionMode } from '../tools/policy.ts';
import type { Tool } from '../tools/types.ts';
import { type CompactionOutcome, compactConversation } from './compactor.ts';
import { Conversation } from './conversation.ts';
import type { AgentEventListener } from './events.ts';
import { type LoopLimits, promptShape, runTurn, type TurnResult } from './loop.ts';
import { buildSystemPrompt, localDate } from './system-prompt.ts';

export const DEFAULT_MAX_STEPS = 200;
export const DEFAULT_STALL_MS = 120_000;

export interface AgentOptions {
  provider: Provider;
  tools: readonly Tool[];
  mode: ExecutionMode;
  cwd: string;
  // Null disables AGENTS.md loading.
  instructions: InstructionsLoader | null;
  effort?: ProviderEffort;
  maxSteps?: number;
  stallMs?: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: AgentEventListener;
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
  // AGENTS.md files currently known: the ones in the system prompt plus the ones attached to
  // tool results of the current conversation.
  instructions(): readonly InstructionFile[];
  // Reads the AGENTS.md files of the starting directory again. Files attached to earlier tool
  // results are forgotten, so they are attached again when their paths are touched.
  reloadInstructions(): Promise<{ files: readonly InstructionFile[]; warnings: readonly string[] }>;
}

// Keeps a quarter of the window free for the answer at most, so a model whose output limit is
// close to its window still leaves room for the prompt.
export const outputTokenLimit = (provider: Provider): number =>
  Math.min(
    provider.capabilities.output_max_tokens,
    Math.floor(provider.capabilities.context_window / 4),
  );

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
      instructions: bootInstructions,
    });

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
      return discovered;
    },

    clear(): void {
      conversation.clear();
      // Boot instructions live in the system prompt; the ones attached to tool results of the
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
      try {
        const limits: LoopLimits = {
          maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
          maxOutputTokens: outputTokenLimit(agent.provider),
          stallMs: options.stallMs ?? DEFAULT_STALL_MS,
        };
        return await runTurn(prompt, {
          provider: agent.provider,
          conversation,
          tools,
          mode: () => agent.mode,
          cwd: options.cwd,
          systemPrompt,
          instructions: options.instructions,
          limits,
          ...(agent.effort === undefined ? {} : { effort: agent.effort }),
          emit: runOptions.onEvent ?? (() => undefined),
          signal: runOptions.signal ?? new AbortController().signal,
        });
      } finally {
        running = false;
      }
    },
  };
  return agent;
};
