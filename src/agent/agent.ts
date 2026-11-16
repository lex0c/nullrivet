import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { InstructionFile, InstructionsLoader } from '../instructions/agents-loader.ts';
import type { Provider, ProviderEffort } from '../providers/types.ts';
import type { ExecutionMode } from '../tools/policy.ts';
import type { Tool } from '../tools/types.ts';
import { Conversation } from './conversation.ts';
import type { AgentEventListener } from './events.ts';
import { type LoopLimits, runTurn, type TurnResult } from './loop.ts';
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

export interface Agent {
  run(prompt: string, options?: RunOptions): Promise<TurnResult>;
  readonly conversation: Conversation;
  readonly bootWarnings: readonly string[];
  mode: ExecutionMode;
  effort: ProviderEffort | undefined;
  provider: Provider;
  clear(): void;
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

  const agent: Agent = {
    conversation,
    bootWarnings,
    mode: options.mode,
    effort: options.effort,
    provider: options.provider,

    clear(): void {
      conversation.clear();
      // Boot instructions live in the system prompt; the ones attached to tool results of the
      // discarded conversation must be attached again when needed.
      options.instructions?.retainOnly(new Set(bootInstructions.map((file) => file.path)));
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
          systemPrompt: () =>
            buildSystemPrompt({
              cwd: options.cwd,
              mode: agent.mode,
              platform: process.platform,
              date: localDate(),
              isGitRepo,
              instructions: bootInstructions,
            }),
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
