import { isAbsolute, relative } from 'node:path';
import type { Agent } from '../agent/agent.ts';
import { errorMessage } from '../errors.ts';
import type { ResolveResult } from '../providers/resolve.ts';
import type { ProviderEffort } from '../providers/types.ts';
import type { ApplyReport, ChangeEntry } from '../sandbox/changeset/summary.ts';
import { resolvePath } from '../tools/paths.ts';
import { type ExecutionMode, isExecutionMode } from '../tools/policy.ts';
import { EFFORT_LEVELS } from './args.ts';
import { SessionFile, type SessionLink } from './session-file.ts';
import {
  confirmationCode,
  type Preview,
  sessionFileError,
  type WorkspaceSession,
} from './workspace-session.ts';

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
  // Set in a session of the workspace sandbox, whose changes the operator reviews and applies.
  workspace?: WorkspaceSession;
  // Asks the operator a question, answered by the next line submitted; null when it is cancelled.
  ask: (question: string) => Promise<string | null>;
  // Writes what the sandbox changed, or what applying it did, to the scrollback.
  show: (
    item: { kind: 'changes'; entries: ChangeEntry[] } | { kind: 'applied'; report: ApplyReport },
  ) => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  // Shown after the command name in help and as an inline hint while typing.
  usage?: string;
  // Commands that change the conversation or the model cannot run while a turn is in progress.
  idleOnly?: boolean;
  // Offered only in a session of the workspace sandbox.
  workspace?: boolean;
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

export const describeModeChange = (mode: ExecutionMode): string =>
  `Execution mode set to ${mode}; it applies from the next tool call.`;

const describeInstructions = (agent: Agent): string => {
  const files = agent.instructions();
  if (files.length === 0) return 'No AGENTS.md files are loaded.';
  return [
    'Loaded AGENTS.md files:',
    ...files.map((f) => `  ${f.path}${f.truncated ? ' (truncated)' : ''}`),
  ].join('\n');
};

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const stoppedJobs = (jobs: number): string =>
  jobs === 0 ? '' : ` and stop ${plural(jobs, 'background job', 'background jobs')}`;

const workspaceOf = (ctx: SlashContext): WorkspaceSession => {
  if (ctx.workspace === undefined) {
    throw new Error('this session does not run in the workspace sandbox');
  }
  return ctx.workspace;
};

// The entries at `path`, under it, or holding it, as a directory the sandbox created does.
const entriesAt = (entries: readonly ChangeEntry[], path: string): ChangeEntry[] =>
  entries.filter(
    (entry) =>
      path === '' ||
      entry.path === path ||
      entry.path.startsWith(`${path}/`) ||
      (entry.kind === 'directory' && path.startsWith(`${entry.path}/`)),
  );

// Applies the changes `preview` showed, and reports what was done. `last`: the session ends.
const applyPreview = async (ctx: SlashContext, preview: Preview, last: boolean): Promise<void> => {
  const applied = await workspaceOf(ctx).apply(preview, last);
  if (applied.report !== null) ctx.show({ kind: 'applied', report: applied.report });
  if (applied.failure !== null) ctx.notice('error', applied.failure);
  for (const warning of applied.warnings) ctx.notice('warning', warning);
  if (last) return;
  if (applied.stopped === null) {
    ctx.notice('info', 'A new sandbox runs on the project as it is now.');
  } else {
    ctx.notice(
      'error',
      `No sandbox runs: ${applied.stopped}. No tool can run for the rest of the session.`,
    );
  }
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'help',
    description: 'List the available commands',
    run(_args, ctx) {
      const commands = commandsFor(ctx.workspace !== undefined);
      const heads = commands.map((c) =>
        c.usage === undefined ? `/${c.name}` : `/${c.name} ${c.usage}`,
      );
      const width = Math.max(...heads.map((h) => h.length));
      const rows = commands.map((c, i) => `  ${(heads[i] ?? '').padEnd(width)}  ${c.description}`);
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
      ctx.notice('info', describeModeChange(args));
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
      if (ctx.workspace !== undefined) {
        const refused = await sessionFileError(opened.file.path, ctx.workspace.root);
        if (refused !== null) {
          ctx.notice('error', refused);
          return;
        }
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
    name: 'changes',
    description: 'Show what the sandbox changed in the project',
    usage: '[path]',
    workspace: true,
    run(args, ctx) {
      const workspace = workspaceOf(ctx);
      const preview = workspace.preview();
      if ('error' in preview) {
        ctx.notice('error', preview.error);
        return;
      }
      if (args.length === 0) {
        ctx.show({ kind: 'changes', entries: preview.entries });
        return;
      }
      const path = relative(workspace.root, resolvePath(args, ctx.cwd));
      if (path === '..' || path.startsWith('../') || isAbsolute(path)) {
        ctx.notice('error', `${args} is outside the project.`);
        return;
      }
      const entries = entriesAt(preview.entries, path);
      if (entries.length === 0) {
        ctx.notice('info', `The sandbox changed nothing at ${args}.`);
        return;
      }
      ctx.show({ kind: 'changes', entries });
    },
  },
  {
    name: 'apply',
    description: "Apply the sandbox's changes to the project",
    workspace: true,
    async run(_args, ctx) {
      const workspace = workspaceOf(ctx);
      const preview = workspace.preview();
      if ('error' in preview) {
        ctx.notice('error', preview.error);
        return;
      }
      if (preview.entries.length > 0) ctx.show({ kind: 'changes', entries: preview.entries });
      if (preview.pending === 0) {
        ctx.notice('info', 'The sandbox holds no changes to apply.');
        return;
      }
      const code = confirmationCode();
      const answer = await ctx.ask(
        `Apply ${plural(preview.pending, 'change', 'changes')} to the project${stoppedJobs(workspace.runningJobs())}? Type apply ${code} to confirm; anything else cancels.`,
      );
      if (answer !== `apply ${code}`) {
        ctx.notice('info', 'Nothing was applied.');
        return;
      }
      await applyPreview(ctx, preview, false);
    },
  },
  {
    name: 'discard',
    description: "Discard the sandbox's changes and start it again",
    workspace: true,
    async run(_args, ctx) {
      const workspace = workspaceOf(ctx);
      if (!workspace.active) {
        ctx.notice('error', `No sandbox runs: ${workspace.failure() ?? 'it stopped'}.`);
        return;
      }
      const preview = workspace.preview();
      if ('error' in preview) {
        ctx.notice('warning', preview.error);
      } else if (preview.pending === 0) {
        ctx.notice('info', 'The sandbox holds no changes to discard.');
        return;
      } else {
        ctx.show({ kind: 'changes', entries: preview.entries });
      }
      const code = confirmationCode();
      const what =
        'error' in preview ? "the sandbox's changes" : plural(preview.pending, 'change', 'changes');
      const answer = await ctx.ask(
        `Discard ${what}${stoppedJobs(workspace.runningJobs())}? Type discard ${code} to confirm; anything else cancels.`,
      );
      if (answer !== `discard ${code}`) {
        ctx.notice('info', 'Nothing was discarded.');
        return;
      }
      const discarded = await workspace.discard('error' in preview ? null : preview);
      for (const warning of discarded.warnings) ctx.notice('warning', warning);
      if (discarded.stopped === null) {
        ctx.notice(
          'info',
          'The changes were discarded. A new sandbox runs on the project as it is.',
        );
      } else {
        ctx.notice(
          'error',
          `The changes were discarded, and no sandbox runs: ${discarded.stopped}. No tool can run for the rest of the session.`,
        );
      }
    },
  },
  {
    name: 'exit',
    description: 'Exit nullrivet',
    async run(_args, ctx) {
      const workspace = ctx.workspace;
      if (workspace?.active === true) {
        // Exiting discards the sandbox's changes: the operator decides first.
        const preview = workspace.preview();
        if ('error' in preview) {
          const answer = await ctx.ask(
            `${preview.error}. Type discard to exit and discard the sandbox's changes; anything else keeps the session.`,
          );
          if (answer !== 'discard') {
            ctx.notice('info', 'The session goes on.');
            return;
          }
        } else if (preview.pending > 0) {
          ctx.show({ kind: 'changes', entries: preview.entries });
          const code = confirmationCode();
          const answer = await ctx.ask(
            `The sandbox holds ${plural(preview.pending, 'change', 'changes')} the project does not have. Type apply ${code} to apply them and exit, or discard to discard them and exit; anything else keeps the session.`,
          );
          if (answer === `apply ${code}`) {
            await applyPreview(ctx, preview, true);
          } else if (answer !== 'discard') {
            ctx.notice('info', 'The session goes on.');
            return;
          }
        }
      }
      ctx.exit();
    },
  },
];

const commandsFor = (workspace: boolean): SlashCommand[] =>
  SLASH_COMMANDS.filter((c) => c.workspace !== true || workspace);

// `workspace`: the session runs in the workspace sandbox, which has commands of its own.
export const findCommand = (name: string, workspace = false): SlashCommand | undefined =>
  commandsFor(workspace).find((c) => c.name === name);

// Suggestions while the user is still typing the command name.
export const suggestCommands = (input: string, workspace = false): SlashCommand[] => {
  const match = /^\/([a-z]*)$/.exec(input);
  if (match === null) return [];
  const prefix = match[1] ?? '';
  return commandsFor(workspace).filter((c) => c.name.startsWith(prefix));
};

export const runSlash = async (parsed: ParsedSlash, ctx: SlashContext): Promise<void> => {
  const command = findCommand(parsed.name, ctx.workspace !== undefined);
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
