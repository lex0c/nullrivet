import type { Agent } from '../agent/agent.ts';
import type { ResolveResult } from '../providers/resolve.ts';
import type { ProviderEffort } from '../providers/types.ts';
import { isExecutionMode } from '../tools/policy.ts';
import { EFFORT_LEVELS } from './args.ts';

export type NoticeLevel = 'info' | 'warning' | 'error';

export interface SlashContext {
  agent: Agent;
  resolveModel: (id: string) => Promise<ResolveResult>;
  notice: (level: NoticeLevel, text: string) => void;
  clearScreen: () => void;
  exit: () => void;
  // Usage summary of the current process, rendered by the caller.
  stats: () => string;
}

export interface SlashCommand {
  name: string;
  description: string;
  // Shown after the command name in help and as an inline hint while typing.
  usage?: string;
  // Commands that change the conversation or the model cannot run while a turn is in progress.
  idleOnly?: boolean;
  run(args: string, ctx: SlashContext): Promise<void> | void;
}

export interface ParsedSlash {
  name: string;
  args: string;
}

// Only `/word` at the start is a command, so a prompt such as "/etc/hosts is broken" is sent to
// the model as text.
export const parseSlash = (text: string): ParsedSlash | null => {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return null;
  return { name: match[1] ?? '', args: (match[2] ?? '').trim() };
};

const describeInstructions = (agent: Agent): string => {
  const files = agent.instructions();
  if (files.length === 0) return 'No AGENTS.md files are loaded.';
  return [
    'Loaded AGENTS.md files:',
    ...files.map((f) => `  ${f.path}${f.truncated ? ' (truncated)' : ''}`),
  ].join('\n');
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'help',
    description: 'List the available commands',
    run(_args, ctx) {
      const heads = SLASH_COMMANDS.map((c) =>
        c.usage === undefined ? `/${c.name}` : `/${c.name} ${c.usage}`,
      );
      const width = Math.max(...heads.map((h) => h.length));
      const rows = SLASH_COMMANDS.map(
        (c, i) => `  ${(heads[i] ?? '').padEnd(width)}  ${c.description}`,
      );
      ctx.notice(
        'info',
        [
          'Commands:',
          ...rows,
          '',
          'Keys: Enter sends, Shift+Enter or \\+Enter inserts a newline, Esc interrupts the task,',
          'Ctrl+C twice exits.',
        ].join('\n'),
      );
    },
  },
  {
    name: 'model',
    description: 'Show or switch the model',
    usage: '[family/model]',
    idleOnly: true,
    async run(args, ctx) {
      if (args.length === 0) {
        const caps = ctx.agent.provider.capabilities;
        ctx.notice(
          'info',
          `Model: ${ctx.agent.provider.id} (context window ${caps.context_window}, output limit ${caps.output_max_tokens})`,
        );
        return;
      }
      const resolved = await ctx.resolveModel(args);
      if (!resolved.ok) {
        ctx.notice('error', resolved.error);
        return;
      }
      for (const warning of resolved.warnings) ctx.notice('warning', warning);
      ctx.agent.provider = resolved.provider;
      ctx.notice('info', `Model switched to ${resolved.provider.id}.`);
    },
  },
  {
    name: 'effort',
    description: 'Show or set the reasoning effort',
    usage: `[${EFFORT_LEVELS.join('|')}|off]`,
    run(args, ctx) {
      if (args.length === 0) {
        ctx.notice('info', `Effort: ${ctx.agent.effort ?? 'provider default'}`);
        return;
      }
      if (args === 'off') {
        ctx.agent.effort = undefined;
        ctx.notice('info', 'Effort reset to the provider default.');
        return;
      }
      if (!(EFFORT_LEVELS as readonly string[]).includes(args)) {
        ctx.notice('error', `Unknown effort '${args}'; use ${EFFORT_LEVELS.join(', ')} or off.`);
        return;
      }
      ctx.agent.effort = args as ProviderEffort;
      ctx.notice('info', `Effort set to ${args}.`);
    },
  },
  {
    name: 'permission',
    description: 'Show or change the execution mode',
    usage: '[auto|readonly]',
    run(args, ctx) {
      if (args.length === 0) {
        ctx.notice('info', `Execution mode: ${ctx.agent.mode}`);
        return;
      }
      if (!isExecutionMode(args)) {
        ctx.notice('error', `Unknown mode '${args}'; use auto or readonly.`);
        return;
      }
      ctx.agent.mode = args;
      ctx.notice('info', `Execution mode set to ${args}; it applies from the next tool call.`);
    },
  },
  {
    name: 'clear',
    description: 'Discard the conversation and clear the screen',
    idleOnly: true,
    run(_args, ctx) {
      ctx.agent.clear();
      ctx.clearScreen();
      ctx.notice('info', 'Conversation cleared.');
    },
  },
  {
    name: 'instructions',
    description: 'List the loaded AGENTS.md files, or reload them',
    usage: '[reload]',
    async run(args, ctx) {
      if (args.length === 0) {
        ctx.notice('info', describeInstructions(ctx.agent));
        return;
      }
      if (args !== 'reload') {
        ctx.notice(
          'error',
          `Unknown argument '${args}'; use /instructions or /instructions reload.`,
        );
        return;
      }
      if (ctx.agent.running) {
        ctx.notice('error', 'Instructions cannot be reloaded while a task is running.');
        return;
      }
      const result = await ctx.agent.reloadInstructions();
      for (const warning of result.warnings) ctx.notice('warning', warning);
      ctx.notice('info', describeInstructions(ctx.agent));
    },
  },
  {
    name: 'stats',
    description: 'Show the token usage of this session',
    run(_args, ctx) {
      ctx.notice('info', ctx.stats());
    },
  },
  {
    name: 'exit',
    description: 'Exit nullrivet',
    run(_args, ctx) {
      ctx.exit();
    },
  },
];

export const findCommand = (name: string): SlashCommand | undefined =>
  SLASH_COMMANDS.find((c) => c.name === name);

// Suggestions while the user is still typing the command name.
export const suggestCommands = (input: string): SlashCommand[] => {
  const match = /^\/([a-z]*)$/.exec(input);
  if (match === null) return [];
  const prefix = match[1] ?? '';
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
};

export const runSlash = async (parsed: ParsedSlash, ctx: SlashContext): Promise<void> => {
  const command = findCommand(parsed.name);
  if (command === undefined) {
    ctx.notice('error', `Unknown command /${parsed.name}; type /help for the list.`);
    return;
  }
  if (command.idleOnly === true && ctx.agent.running) {
    ctx.notice('error', `/${command.name} cannot be used while a task is running.`);
    return;
  }
  try {
    await command.run(parsed.args, ctx);
  } catch (error) {
    ctx.notice('error', error instanceof Error ? error.message : String(error));
  }
};
