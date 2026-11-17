import { stat } from 'node:fs/promises';
import { contextBudget } from '../context/budget.ts';
import { headTailSummary } from '../context/output-reduction.ts';
import { formatTokens } from '../format.ts';
import type { InstructionsLoader } from '../instructions/agents-loader.ts';
import type { Provider, ProviderEffort } from '../providers/types.ts';
import { InvalidArgumentError, optionalString, requireNonEmptyString } from '../tools/args.ts';
import { fileSystemError } from '../tools/file-io.ts';
import { finishOutput, outputFiles } from '../tools/output-files.ts';
import { displayPath, resolvePath } from '../tools/paths.ts';
import type { ExecutionMode } from '../tools/policy.ts';
import { type Tool, type ToolResult, toolError } from '../tools/types.ts';
import { Conversation } from './conversation.ts';
import type { AgentEvent, AgentEventListener, SubagentStatus } from './events.ts';
import { runTurn, type TurnResult } from './loop.ts';
import { buildSystemPrompt, localDate, renderProjectContext } from './system-prompt.ts';

export const SUBAGENT_MAX_STEPS = 40;
const MAX_READONLY_AT_ONCE = 3;
const MAX_AUTO_AT_ONCE = 1;
// About 4096 tokens: the parent keeps only the report, not the work behind it.
const REPORT_MAX_BYTES = 16 * 1024;
const TITLE_MAX_CHARS = 80;
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const FINAL_STEP_NOTE =
  'This is your last step. Do not call tools: write your report now from what you have found, and list what remains undone under open issues.';

// What the delegate tool reads from the parent agent when a subagent starts. Getters, because the
// model, the effort, the mode and the event listener can change between and during turns.
export interface SubagentRuntime {
  provider: () => Provider;
  effort: () => ProviderEffort | undefined;
  parentMode: () => ExecutionMode;
  cwd: string;
  // The tools a subagent gets: the parent's, without delegate, so it cannot delegate further.
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

const STATUS: Record<TurnResult['reason'], SubagentStatus> = {
  done: 'completed',
  error: 'failed',
  aborted: 'cancelled',
  budget: 'budget',
};

interface Outcome {
  status: SubagentStatus;
  steps: number;
  toolErrors: number;
  filesModified: string[];
  tokens: number;
  message: string | undefined;
  report: string;
}

const summaryLine = (o: Outcome): string => {
  const parts = [
    `${o.status}`,
    `${o.steps} ${o.steps === 1 ? 'step' : 'steps'}`,
    ...(o.toolErrors > 0
      ? [`${o.toolErrors} tool ${o.toolErrors === 1 ? 'error' : 'errors'}`]
      : []),
    `${formatTokens(o.tokens)} tokens`,
  ];
  const modified = o.filesModified.length > 0 ? `; modified: ${o.filesModified.join(', ')}` : '';
  // The reason a subagent stopped early is shown to the user too, not only to the model.
  const reason = o.status !== 'completed' && o.message !== undefined ? `: ${o.message}` : '';
  return `${parts.join(', ')}${modified}${reason}`;
};

// The report is the subagent's final answer. The status line is written by the runtime, so the
// parent can rely on it even when the answer is missing or wrong.
const resultContent = (o: Outcome): string => {
  const head = `[subagent ${summaryLine(o)}]`;
  const report = o.report.trim();
  if (report.length === 0) return `${head}\n\n(the subagent gave no final answer)`;
  const summary = headTailSummary(report, {
    maxBytes: REPORT_MAX_BYTES,
    headLines: 400,
    tailLines: 100,
  });
  if (!summary.reduced) return `${head}\n\n${summary.text}`;
  const spool = outputFiles.spool('delegate', 0);
  spool.push(Buffer.from(report, 'utf8'));
  const note = finishOutput(spool, true, 'report', undefined);
  return `${head}\n\n${summary.text}${note === null ? '' : `\n${note}`}`;
};

const finalAnswer = (conversation: Conversation): string => {
  const last = conversation.messages().at(-1);
  if (last?.role !== 'assistant' || typeof last.content === 'string') return '';
  return last.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n\n');
};

const parseMode = (input: Record<string, unknown>): ExecutionMode => {
  const mode = optionalString(input, 'mode') ?? 'readonly';
  if (mode !== 'readonly' && mode !== 'auto') {
    throw new InvalidArgumentError("'mode' must be readonly or auto");
  }
  return mode;
};

export const createDelegateTool = (runtime: SubagentRuntime): Tool => {
  const readonlyLane = new Semaphore(MAX_READONLY_AT_ONCE);
  const autoLane = new Semaphore(MAX_AUTO_AT_ONCE);

  const run = async (
    id: string,
    title: string,
    prompt: string,
    input: string | undefined,
    ceiling: ExecutionMode,
    cwd: string,
    signal: AbortSignal,
    emit: AgentEventListener,
  ): Promise<Outcome> => {
    // The parent's mode is read again before every request and tool call of the subagent, so
    // switching the session to readonly takes effect inside running subagents too. Switching it
    // to auto never lifts the subagent above the mode it started with.
    const mode = (): ExecutionMode =>
      ceiling === 'auto' && runtime.parentMode() === 'auto' ? 'auto' : 'readonly';
    const provider = runtime.provider();
    const effort = runtime.effort();
    const instructions = runtime.instructions?.fork() ?? null;
    const boot = instructions === null ? null : await instructions.discover([cwd]);
    for (const warning of boot?.warnings ?? []) {
      emit({ type: 'warning', message: `subagent "${title}": ${warning}` });
    }
    const projectContext = renderProjectContext(boot?.files ?? []);
    const isGitRepo = await runtime.isGitRepo(cwd);

    let tokens = 0;
    let toolErrors = 0;
    const filesModified = new Set<string>();
    const pendingPaths = new Map<string, string>();
    const onEvent = (event: AgentEvent): void => {
      switch (event.type) {
        case 'usage':
          tokens += event.input + event.output + event.cacheRead + event.cacheWrite;
          emit({ ...event, subagent: id });
          return;
        case 'tool:start': {
          const path = event.args.path;
          if (WRITE_TOOLS.has(event.name) && typeof path === 'string') {
            // Reported relative to the parent's directory, which may differ from the subagent's.
            pendingPaths.set(event.id, displayPath(resolvePath(path, cwd), runtime.cwd));
          }
          emit({
            type: 'subagent:progress',
            id,
            step: event.step,
            tool: { name: event.name, args: event.args },
          });
          return;
        }
        case 'tool:end': {
          const path = pendingPaths.get(event.id);
          pendingPaths.delete(event.id);
          if (event.isError) toolErrors++;
          else if (path !== undefined) filesModified.add(path);
          return;
        }
        case 'warning':
          emit({ type: 'warning', message: `subagent "${title}": ${event.message}` });
          return;
        default:
          return;
      }
    };

    const conversation = new Conversation();
    const result = await runTurn(
      prompt,
      {
        provider,
        conversation,
        tools: new Map(runtime.tools.map((tool) => [tool.name, tool])),
        mode,
        cwd,
        systemPrompt: () =>
          buildSystemPrompt({
            cwd,
            mode: mode(),
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
        },
        ...(effort === undefined ? {} : { effort }),
        emit: onEvent,
        signal,
      },
      input,
    );
    return {
      status: STATUS[result.reason],
      steps: result.steps,
      toolErrors,
      filesModified: [...filesModified],
      tokens,
      message: result.message,
      report: finalAnswer(conversation),
    };
  };

  return {
    name: 'delegate',
    description: [
      'Delegate a self-contained task to a subagent and wait for its report.',
      'The subagent starts with an empty conversation: it sees only `objective` and `context`, never this conversation, so include every path, constraint and decision it needs. Requirements go in `objective`; `context` reaches the subagent as data.',
      'It works in its own context window and returns only a status line and its final report (result, evidence, open issues), which keeps this conversation small.',
      'Use it for investigations that would read many files or produce long output.',
      '`mode` is readonly by default; auto lets the subagent modify files and run commands, and applies only while this session is in auto mode.',
      `Several delegate calls in one response run at the same time: readonly ones up to ${MAX_READONLY_AT_ONCE} at once, auto ones one after another.`,
      `A subagent has at most ${SUBAGENT_MAX_STEPS} steps and cannot delegate further.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label shown to the user.' },
        objective: {
          type: 'string',
          description:
            'The task, complete on its own: what to find out or do, the constraints to respect, and what to report.',
        },
        context: {
          type: 'string',
          description:
            'Reference material from this conversation: paths, findings, excerpts. It reaches the subagent as data, so put requirements and constraints in objective.',
        },
        mode: { type: 'string', enum: ['readonly', 'auto'] },
        cwd: {
          type: 'string',
          description: 'Starting directory of the subagent. Defaults to the session directory.',
        },
      },
      required: ['title', 'objective'],
    },
    // The subagent's mode never exceeds the session's, so delegating is allowed in readonly mode.
    effect: 'read',
    concurrent: true,
    async execute(input, ctx): Promise<ToolResult> {
      const title = requireNonEmptyString(input, 'title').slice(0, TITLE_MAX_CHARS);
      const objective = requireNonEmptyString(input, 'objective');
      const context = optionalString(input, 'context');
      const requested = parseMode(input);
      const cwdArg = optionalString(input, 'cwd');
      const cwd = cwdArg === undefined ? runtime.cwd : resolvePath(cwdArg, ctx.cwd);
      try {
        if (!(await stat(cwd)).isDirectory()) {
          return toolError('fs.not_directory', `cwd is not a directory: ${cwd}`);
        }
      } catch (error) {
        return fileSystemError(error, 'read', cwd);
      }
      // The objective is the task; the context is reference material the parent may have copied
      // from files or command output, so it reaches the subagent fenced as data.
      const material = context === undefined || context.trim().length === 0 ? undefined : context;

      const id = ctx.callId ?? crypto.randomUUID();
      // The most the subagent may do is fixed with its lane: a subagent in the readonly lane must
      // stay read-only, or a switch of the session to auto would let several of them write at
      // once, past the limit of one auto subagent.
      const ceiling: ExecutionMode =
        requested === 'auto' && runtime.parentMode() === 'auto' ? 'auto' : 'readonly';
      const lane = ceiling === 'auto' ? autoLane : readonlyLane;
      const release = await lane.acquire(ctx.signal);
      if (release === null) return toolError('tool.aborted', 'delegate was aborted');
      const emit = ctx.emit ?? (() => undefined);
      emit({
        type: 'subagent:start',
        id,
        title,
        mode: lane === autoLane ? 'auto' : 'readonly',
      });
      let outcome: Outcome | undefined;
      try {
        outcome = await run(id, title, objective, material, ceiling, cwd, ctx.signal, emit);
      } finally {
        release();
        emit({
          type: 'subagent:end',
          id,
          status: outcome?.status ?? 'failed',
          steps: outcome?.steps ?? 0,
        });
      }
      const content = resultContent(outcome);
      const meta = {
        summary: `subagent ${summaryLine(outcome)}`,
        status: outcome.status,
        steps: outcome.steps,
      };
      return outcome.status === 'failed' || outcome.status === 'cancelled'
        ? { content, isError: true, meta: { ...meta, errorCode: `subagent.${outcome.status}` } }
        : { content, isError: false, meta };
    },
  };
};
