import type { Agent } from '../agent/agent.ts';
import { errorMessage } from '../errors.ts';
import type { ResolveResult } from '../providers/resolve.ts';
import type { ProviderEffort } from '../providers/types.ts';
import { resolvePath } from '../tools/paths.ts';
import { isExecutionMode } from '../tools/policy.ts';
import { EFFORT_LEVELS } from './args.ts';
import { SessionFile, type SessionLink } from './session-file.ts';

export type NoticeLevel = 'info' | 'warning' | 'error';

export interface SlashContext {
  agent: Agent;
  resolveModel: (id: string) => Promise<ResolveResult>;
  notice: (level: NoticeLevel, text: string) => void;
  clearScreen: () => void;
  exit: () => void;
  // Usage summary of the current process, rendered by the caller.
  stats: () => string;
  // Compacts the conversation, showing progress; the caller makes it interruptible.
  compact: (instructions: string | undefined) => Promise<void>;
  session: SessionLink;
  // Base for relative paths, as for the tools.
  cwd: string;
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

// Only `/word` at the very start is a command: "/etc/hosts is broken" is not one, and leading
// whitespace marks text that starts with "/" as a prompt.
export const parseSlash = (text: string): ParsedSlash | null => {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd());
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
          'Keys: Enter sends, Shift+Enter or \\+Enter inserts a newline, Shift+Tab switches between',
          'auto and readonly, Esc interrupts the task, Ctrl+C twice exits.',
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
      // The session file records the model to continue with.
      await ctx.agent.checkpoint?.();
      ctx.notice('info', `Model switched to ${resolved.provider.id}.`);
    },
  },
  {
    name: 'effort',
    description: 'Show or set the reasoning effort',
    usage: `[${EFFORT_LEVELS.join('|')}|off]`,
    async run(args, ctx) {
      if (args.length === 0) {
        ctx.notice('info', `Effort: ${ctx.agent.effort ?? 'provider default'}`);
        return;
      }
      if (args === 'off') {
        ctx.agent.effort = undefined;
        await ctx.agent.checkpoint?.();
        ctx.notice('info', 'Effort reset to the provider default.');
        return;
      }
      if (!(EFFORT_LEVELS as readonly string[]).includes(args)) {
        ctx.notice('error', `Unknown effort '${args}'; use ${EFFORT_LEVELS.join(', ')} or off.`);
        return;
      }
      ctx.agent.effort = args as ProviderEffort;
      await ctx.agent.checkpoint?.();
      ctx.notice('info', `Effort set to ${args}.`);
    },
  },
  {
    name: 'permission',
    description: 'Show or change the execution mode',
    usage: '[auto|readonly]',
    async run(args, ctx) {
      if (args.length === 0) {
        ctx.notice('info', `Execution mode: ${ctx.agent.mode}`);
        return;
      }
      if (!isExecutionMode(args)) {
        ctx.notice('error', `Unknown mode '${args}'; use auto or readonly.`);
        return;
      }
      ctx.agent.mode = args;
      await ctx.agent.checkpoint?.();
      ctx.notice('info', `Execution mode set to ${args}; it applies from the next tool call.`);
    },
  },
  {
    name: 'compact',
    description: 'Summarize the conversation now to free context',
    usage: '[focus]',
    idleOnly: true,
    async run(args, ctx) {
      await ctx.compact(args.length > 0 ? args : undefined);
    },
  },
  {
    name: 'clear',
    description: 'Discard the conversation and clear the screen',
    idleOnly: true,
    run(_args, ctx) {
      ctx.agent.clear();
      ctx.clearScreen();
      // The file keeps the conversation that was cleared: clearing never erases a saved session.
      const path = ctx.session.path;
      ctx.session.detach();
      ctx.notice(
        'info',
        path === null
          ? 'Conversation cleared.'
          : `Conversation cleared. ${path} keeps the previous conversation; /session <file> saves the new one.`,
      );
    },
  },
  {
    name: 'session',
    description: 'Show the session file, save to a new one, or stop saving',
    usage: '[file|off]',
    idleOnly: true,
    async run(args, ctx) {
      if (args.length === 0) {
        ctx.notice('info', ctx.session.status());
        return;
      }
      if (args === 'off') {
        const path = ctx.session.path;
        ctx.session.detach();
        ctx.notice(
          'info',
          path === null
            ? 'No session file is attached.'
            : `No longer saving to ${path}; the file keeps the conversation as it was.`,
        );
        return;
      }
      const opened = await SessionFile.open(resolvePath(args, ctx.cwd));
      if (!opened.ok) {
        ctx.notice('error', opened.error);
        return;
      }
      // Attaching never overwrites another conversation; continuing one is done at startup.
      if (opened.data !== null) {
        ctx.notice(
          'error',
          `${opened.file.path} already holds a session. Choose a new file, or start nullrivet with --session ${opened.file.path} to continue it.`,
        );
        return;
      }
      const previous = ctx.session.path;
      const failure = await ctx.session.switchTo(opened.file);
      if (failure !== null) {
        ctx.notice(
          'error',
          previous === null ? failure : `${failure}; the session is still saved to ${previous}.`,
        );
        return;
      }
      ctx.notice(
        'info',
        previous === null
          ? `Saving this session to ${opened.file.path}.`
          : `Saving this session to ${opened.file.path}; ${previous} keeps the conversation as it was until now.`,
      );
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
    description: 'Show the token usage since nullrivet started',
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
    ctx.notice('error', errorMessage(error));
  }
};
