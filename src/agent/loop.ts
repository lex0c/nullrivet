import { type ContextBudget, contextBudget } from '../context/budget.ts';
import { errorMessage } from '../errors.ts';
import type { InstructionsLoader } from '../instructions/agents-loader.ts';
import { renderInstructionFiles } from '../instructions/agents-loader.ts';
import { CONTEXT_OVERFLOW, ContextOverflowError, INVALID_TOOL_CALL } from '../providers/errors.ts';
import {
  contentBlocks,
  type GenerateRequest,
  type Provider,
  type ProviderEffort,
  type ProviderMessage,
  type ProviderToolResultBlock,
  type StreamEvent,
  type UsageInfo,
} from '../providers/types.ts';
import { addUsage, emptyUsage } from '../providers/usage.ts';
import { type ExecutionMode, toolsForMode } from '../tools/policy.ts';
import type { Tool } from '../tools/types.ts';
import {
  AbortError,
  abortableIterable,
  abortableSleep,
  StepStallError,
  stallWatchdog,
} from './abortable.ts';
import { buildAssistantContent } from './assistant-content.ts';
import {
  type CollectedError,
  type CollectedStep,
  type CollectedToolUse,
  CollectStepError,
  collectStep,
} from './collect.ts';
import { compactConversation } from './compactor.ts';
import {
  agentNote,
  type Conversation,
  interruptedResult,
  type PromptShape,
} from './conversation.ts';
import type { AgentEndReason, AgentEventListener, CompactReason } from './events.ts';
import { generateWithRetry } from './retry.ts';
import { DISCOVERED_INSTRUCTIONS_HEADER } from './system-prompt.ts';
import { executeToolCall } from './tool-executor.ts';

export interface LoopLimits {
  maxSteps: number;
  maxOutputTokens: number;
  // A provider stream silent for this long is treated as failed.
  stallMs: number;
  // Base delay before repeating a step that failed with a transient stream error.
  streamRetryDelayMs?: number;
  // Added as a runtime note before the last step, so a turn that runs out of steps can still end
  // with an answer instead of a tool call.
  finalStepNote?: string;
  // Time (as Date.now()) from which the next step is the last one, as at maxSteps: it gets the
  // final step note and the turn ends after it. It leaves room for an answer before a hard time
  // limit that would abort the turn.
  finalStepAt?: number;
}

export interface TurnDependencies {
  provider: Provider;
  conversation: Conversation;
  tools: ReadonlyMap<string, Tool>;
  // Read before every request and every tool call, so a mode change takes effect immediately.
  mode: () => ExecutionMode;
  cwd: string;
  systemPrompt: () => string;
  // Text sent at the start of the first user message of every request, such as the project
  // instructions of the working directory; empty for none.
  projectContext: () => string;
  // Called whenever the conversation is in a consistent state worth keeping: after each step's
  // tool results and after a compaction. It must not throw.
  checkpoint?: () => Promise<void>;
  instructions: InstructionsLoader | null;
  limits: LoopLimits;
  effort?: ProviderEffort;
  // Runtime notices for the model, such as background jobs and subagents that ended. Each call
  // returns the next batch, and each notice is returned once.
  notices?: () => RuntimeNotice[];
  emit: AgentEventListener;
  signal: AbortSignal;
}

// A note from the runtime for the model. `text` holds only facts the runtime produced and is sent
// as an agent note, which the model trusts; `data` is material from elsewhere, such as a subagent's
// report, and is fenced as data after it.
export interface RuntimeNotice {
  text: string;
  data?: string;
  // Shown to the user in place of `text`, when the note as written is meant for the model only.
  display?: string;
}

// Which limit ended a turn with `budget`.
export type TurnLimit = 'steps' | 'time' | 'context' | 'output';

export interface TurnResult {
  reason: AgentEndReason;
  message?: string;
  // Set when the reason is `budget`.
  limit?: TurnLimit;
  usage: UsageInfo;
  steps: number;
}

// Errors reported inside a stream bypass generateWithRetry, which only retries before the first
// event. A step that failed with retryable errors before producing text or a tool call can be
// repeated without duplicating anything the user has seen or the history holds.
const MAX_STREAM_ERROR_RETRIES = 2;
const DEFAULT_STREAM_RETRY_DELAY_MS = 1_000;

// The prompt estimate is approximate, so a margin is kept below the window. A request that cannot
// leave at least the floor for the answer is not sent.
const CONTEXT_SAFETY_TOKENS = 1_024;
const MIN_OUTPUT_TOKENS = 1_024;

const forwardStreamEvent =
  (emit: AgentEventListener) =>
  (event: StreamEvent): void => {
    if (event.kind === 'text_delta') emit({ type: 'text:delta', text: event.text });
    else if (event.kind === 'thinking_delta') emit({ type: 'thinking:delta', text: event.text });
  };

const toToolDefinition = (tool: Tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
});

const isTransientFailure = (step: CollectedStep): boolean =>
  step.errors.length > 0 &&
  step.errors.every((e) => e.retryable) &&
  step.text.length === 0 &&
  step.tool_uses.length === 0;

// A provider rejection because the prompt did not fit, reported inside the stream before any
// output.
const isOverflowFailure = (step: CollectedStep): boolean =>
  step.errors.some((e) => e.code === CONTEXT_OVERFLOW) &&
  step.text.length === 0 &&
  step.tool_uses.length === 0;

// Abort reason of a task stopped by its time limit.
export class TimeLimitReached extends Error {
  constructor(limitMs: number) {
    super(`time limit of ${formatDuration(limitMs)} reached`);
    this.name = 'TimeLimitReached';
  }
}

export const formatDuration = (ms: number): string => {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.ceil(ms / 1_000)}s`;
};

// Growth, as a share of the window, after which an ineffective compaction is tried again.
const REGROWTH_RATIO = 0.1;

const CONTEXT_FULL = 'the conversation does not fit the context window, even after compacting it';
// After an overflow the estimate proved too low, so the compaction keeps a shorter verbatim tail.
const OVERFLOW_TAIL_FACTOR = 0.5;

export const modeChangeNote = (from: ExecutionMode, to: ExecutionMode): string =>
  `The user switched the execution mode from ${from} to ${to}. It applies from now on: what earlier messages say about working in ${from} mode no longer holds, and the system prompt describes ${to} mode.`;

export const promptShape = (
  deps: Pick<TurnDependencies, 'provider' | 'mode' | 'tools' | 'systemPrompt' | 'projectContext'>,
): PromptShape => {
  const system = deps.systemPrompt();
  const context = deps.projectContext();
  const tools = toolsForMode(deps.mode(), [...deps.tools.values()]).map(toToolDefinition);
  return {
    key: `${deps.provider.id}\0${system}\0${context}\0${tools.map((t) => t.name).join(',')}`,
    system,
    context,
    tools,
    countReasoning: deps.provider.replaysReasoning === true,
  };
};

// The context is added when the request is built instead of being stored in the conversation, so
// compaction and clearing never drop it and it always reflects the current instructions.
const withProjectContext = (
  messages: readonly ProviderMessage[],
  context: string,
): ProviderMessage[] => {
  const [first, ...rest] = messages;
  if (context.length === 0 || first === undefined || first.role !== 'user') return [...messages];
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: context, cacheBreakpoint: true },
        ...contentBlocks(first.content),
      ],
    },
    ...rest,
  ];
};

const describeErrors = (errors: readonly CollectedError[]): string =>
  errors.map((e) => `${e.code}: ${e.message}`).join('; ');

// The output limit shrinks with the conversation, so prompt and answer always fit the window.
const outputBudget = (promptTokens: number, provider: Provider, limit: number): number =>
  Math.min(limit, provider.capabilities.context_window - promptTokens - CONTEXT_SAFETY_TOKENS);

// A step-scoped controller lets a stall cancel the HTTP request, not only stop waiting for it;
// it also follows the turn signal so a user abort cancels the request too.
const runProviderStep = async (
  deps: TurnDependencies,
  request: GenerateRequest,
): Promise<CollectedStep> => {
  const step = new AbortController();
  const forwardAbort = (): void => step.abort();
  deps.signal.addEventListener('abort', forwardAbort, { once: true });
  try {
    return await collectStep(
      abortableIterable(
        stallWatchdog(generateWithRetry(deps.provider, request, step.signal), deps.limits.stallMs),
        deps.signal,
      ),
      forwardStreamEvent(deps.emit),
    );
  } finally {
    deps.signal.removeEventListener('abort', forwardAbort);
    step.abort();
  }
};

const executeToolCalls = async (
  calls: readonly CollectedToolUse[],
  deps: TurnDependencies,
  step: number,
): Promise<ProviderToolResultBlock[]> => {
  const { emit, signal } = deps;
  const results: ProviderToolResultBlock[] = [];
  // Instructions attached to a result of this batch reach the model only with the next request,
  // so calls later in the batch were written without them.
  const attachedInBatch = new Set<string>();
  const discover = async (paths: readonly string[]): Promise<string | null> => {
    if (deps.instructions === null || paths.length === 0) return null;
    const discovered = await deps.instructions.discover(paths);
    for (const warning of discovered.warnings) emit({ type: 'warning', message: warning });
    if (discovered.files.length === 0) return null;
    for (const file of discovered.files) attachedInBatch.add(file.path);
    return `${DISCOVERED_INSTRUCTIONS_HEADER}\n${renderInstructionFiles(discovered.files)}`;
  };
  const unseenBeforeWrite = async (paths: readonly string[]): Promise<string | null> => {
    const fresh = await discover(paths);
    if (fresh !== null || deps.instructions === null || attachedInBatch.size === 0) return fresh;
    const pending = (await deps.instructions.governing(paths)).filter((p) =>
      attachedInBatch.has(p),
    );
    if (pending.length === 0) return null;
    return `The AGENTS.md files that govern this path are attached to an earlier tool result of this response: ${pending.join(', ')}`;
  };
  const runCall = async (call: CollectedToolUse): Promise<ProviderToolResultBlock> => {
    if (signal.aborted) return interruptedResult({ type: 'tool_use', ...call });
    emit({ type: 'tool:start', id: call.id, name: call.name, args: call.input, step });
    const result = await executeToolCall(call, {
      tools: deps.tools,
      mode: deps.mode(),
      cwd: deps.cwd,
      signal,
      newInstructions: unseenBeforeWrite,
    });
    let content = result.content;
    const attached = await discover(result.touchedPaths ?? []);
    if (attached !== null) content += `\n\n${attached}`;
    emit({
      type: 'tool:end',
      id: call.id,
      name: call.name,
      content,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    });
    return {
      type: 'tool_result',
      tool_use_id: call.id,
      name: call.name,
      content,
      ...(result.isError ? { is_error: true } : {}),
    };
  };
  for (const call of calls) results.push(await runCall(call));
  return results;
};

const invalidToolCallFeedback = (errors: readonly CollectedError[]): string =>
  agentNote(
    [
      'Some tool calls in your previous response were rejected and not executed:',
      ...errors.map((e) => `- ${e.message}`),
      'Issue them again with a valid tool name and a JSON object as arguments.',
    ].join('\n'),
  );

// Runs one turn: request, stream, execute tool calls, feed results back, until the model answers
// without tool calls, the turn is aborted, or a limit is reached. A null prompt starts a turn on
// the pending runtime notices alone, such as background jobs that ended while the session was idle.
// `input` is material the prompt refers to, such as piped stdin; it is sent as data.
export const runTurn = async (
  prompt: string | null,
  deps: TurnDependencies,
  input?: string,
): Promise<TurnResult> => {
  const { conversation, emit, signal, limits } = deps;
  let usage = emptyUsage();
  let steps = 0;
  let streamRetries = 0;
  const end = (
    endReason: AgentEndReason,
    endMessage?: string,
    endLimit?: TurnLimit,
  ): TurnResult => {
    // A task stopped by its time limit ends at a limit, like the step limit, not as an interrupt.
    const timedOut = endReason === 'aborted' && signal.reason instanceof TimeLimitReached;
    const reason = timedOut ? 'budget' : endReason;
    const message = timedOut ? (signal.reason as TimeLimitReached).message : endMessage;
    const limit = timedOut ? 'time' : endLimit;
    emit(
      message === undefined
        ? { type: 'agent:end', reason }
        : { type: 'agent:end', reason, message },
    );
    return {
      reason,
      ...(message === undefined ? {} : { message }),
      ...(limit === undefined ? {} : { limit }),
      usage,
      steps,
    };
  };

  // At most one compaction for an overflow per step, so a prompt that cannot fit even after
  // compacting ends the turn instead of looping.
  let overflowRecovered = false;

  const compact = async (
    reason: CompactReason,
    shape: PromptShape,
    tailFactor?: number,
  ): Promise<'done' | 'skipped' | 'aborted'> => {
    try {
      const outcome = await compactConversation({
        provider: deps.provider,
        conversation,
        shape,
        reason,
        ...(tailFactor === undefined ? {} : { tailFactor }),
        stallMs: limits.stallMs,
        emit,
        signal,
      });
      if (outcome === null) return 'skipped';
      usage = addUsage(usage, outcome.usage);
      await deps.checkpoint?.();
      return 'done';
    } catch (error) {
      if (signal.aborted || error instanceof AbortError) return 'aborted';
      emit({ type: 'warning', message: `compaction failed: ${errorMessage(error)}` });
      return 'skipped';
    }
  };

  // When a compaction cannot bring the conversation below the trigger (the latest exchange alone
  // is too large), compacting again on every step would only repeat the summary request and
  // invalidate the prompt cache. Auto-compaction then waits until the conversation has grown.
  let ineffectiveAt: number | null = null;

  const shouldCompact = (estimate: number, budget: ContextBudget): boolean =>
    estimate > budget.trigger &&
    (ineffectiveAt === null || estimate > ineffectiveAt + budget.window * REGROWTH_RATIO);

  const compactAuto = async (
    shape: PromptShape,
    budget: ContextBudget,
  ): Promise<'done' | 'skipped' | 'aborted'> => {
    const result = await compact('auto', shape);
    const after = conversation.estimateTokens(shape);
    ineffectiveAt = after > budget.trigger ? after : null;
    return result;
  };

  const recoverFromOverflow = async (shape: PromptShape): Promise<'retry' | 'full' | 'aborted'> => {
    if (overflowRecovered) return 'full';
    overflowRecovered = true;
    const result = await compact('overflow', shape, OVERFLOW_TAIL_FACTOR);
    if (result === 'aborted') return 'aborted';
    return result === 'done' ? 'retry' : 'full';
  };

  // At most one batch of notices per request: set when a batch is added, cleared when the model
  // answers. The first request of a turn without a prompt and a retried request take no other, so
  // the limit the agent puts on a batch holds for each request.
  let batchPending = false;
  // Adds the next batch of runtime notices to the latest message, shows them, and returns how many.
  const addNotices = (): number => {
    if (batchPending) return 0;
    const notices = deps.notices?.() ?? [];
    for (const notice of notices) {
      conversation.appendUser(agentNote(notice.text), notice.data);
      emit({ type: 'notice', text: notice.display ?? notice.text });
    }
    if (notices.length > 0) batchPending = true;
    return notices.length;
  };

  emit({ type: 'agent:start' });
  if (prompt !== null) {
    conversation.appendUser(prompt, input);
  } else if (addNotices() === 0) {
    // Nothing to answer: the turn ends before any compaction or request reaches the provider.
    return end('done');
  }

  // Lowered to the step in progress once finalStepAt has passed, so that step is the last one with
  // the same rules as at maxSteps: a repeated step stays the last, and none follows it.
  let maxSteps = limits.maxSteps;
  while (steps < maxSteps) {
    if (signal.aborted) return end('aborted');
    steps += 1;
    if (limits.finalStepAt !== undefined && Date.now() >= limits.finalStepAt) maxSteps = steps;
    if (steps === maxSteps && steps > 1 && limits.finalStepNote !== undefined) {
      conversation.appendUser(agentNote(limits.finalStepNote));
    }
    // The system prompt states the current mode, but answers given under the previous one stay
    // in the history, and models tend to follow what they said before. A switch is therefore also
    // announced where the model reads it last.
    const mode = deps.mode();
    const previousMode = conversation.requestMode;
    if (previousMode !== null && previousMode !== mode) {
      conversation.appendUser(agentNote(modeChangeNote(previousMode, mode)));
    }
    conversation.setRequestMode(mode);
    const shape = promptShape(deps);
    const budget = contextBudget(deps.provider.capabilities);
    let estimate = conversation.estimateTokens(shape);
    if (shouldCompact(estimate, budget)) {
      if ((await compactAuto(shape, budget)) === 'aborted') return end('aborted');
      estimate = conversation.estimateTokens(shape);
    }
    // Notices go into the latest message, as text. A compaction keeps that message in its tail and
    // shortens only tool results there, so no compaction of this step can fold a notice into its
    // summary: the request carries each one as written.
    if (addNotices() > 0) estimate = conversation.estimateTokens(shape);
    const minOutput = Math.min(MIN_OUTPUT_TOKENS, limits.maxOutputTokens);
    let maxTokens = outputBudget(estimate, deps.provider, limits.maxOutputTokens);
    if (maxTokens < minOutput) {
      // The answer has no room left: compact once before giving up.
      if ((await compact('auto', shape)) === 'aborted') return end('aborted');
      maxTokens = outputBudget(
        conversation.estimateTokens(shape),
        deps.provider,
        limits.maxOutputTokens,
      );
      if (maxTokens < minOutput) return end('budget', CONTEXT_FULL, 'context');
    }
    const request: GenerateRequest = {
      model: deps.provider.id,
      system: shape.system,
      messages: withProjectContext(conversation.messages(), shape.context),
      tools: [...shape.tools],
      max_tokens: maxTokens,
      ...(deps.effort === undefined ? {} : { effort: deps.effort }),
    };

    let collected: CollectedStep;
    try {
      collected = await runProviderStep(deps, request);
    } catch (error) {
      const partial = error instanceof CollectStepError ? error.partial : undefined;
      const cause = error instanceof CollectStepError ? error.cause : error;
      if (partial?.usageSeen === true) usage = addUsage(usage, partial.usage);
      if (signal.aborted || cause instanceof AbortError) {
        // Text already shown to the user stays in the history so the next prompt has context.
        // Tool calls of an unfinished response are dropped because their arguments may be partial.
        if (partial !== undefined && partial.text.length > 0) {
          conversation.appendAssistant([{ type: 'text', text: partial.text }]);
        }
        return end('aborted');
      }
      if (cause instanceof ContextOverflowError) {
        const recovery = await recoverFromOverflow(shape);
        if (recovery === 'retry') {
          steps -= 1;
          continue;
        }
        return recovery === 'aborted' ? end('aborted') : end('budget', CONTEXT_FULL, 'context');
      }
      const message =
        cause instanceof StepStallError
          ? `the provider stopped responding (${cause.message})`
          : `provider request failed: ${errorMessage(cause)}`;
      emit({ type: 'error', message });
      return end('error', message);
    }

    if (collected.usageSeen) {
      usage = addUsage(usage, collected.usage);
      emit({
        type: 'usage',
        input: collected.usage.input,
        output: collected.usage.output,
        cacheRead: collected.usage.cache_read,
        cacheWrite: collected.usage.cache_creation,
      });
    }

    if (isOverflowFailure(collected)) {
      const recovery = await recoverFromOverflow(shape);
      if (recovery === 'retry') {
        steps -= 1;
        continue;
      }
      return recovery === 'aborted' ? end('aborted') : end('budget', CONTEXT_FULL, 'context');
    }

    if (isTransientFailure(collected)) {
      if (streamRetries < MAX_STREAM_ERROR_RETRIES) {
        streamRetries += 1;
        steps -= 1;
        emit({
          type: 'warning',
          message: `${describeErrors(collected.errors)}; retrying (${streamRetries}/${MAX_STREAM_ERROR_RETRIES})`,
        });
        try {
          await abortableSleep(
            (limits.streamRetryDelayMs ?? DEFAULT_STREAM_RETRY_DELAY_MS) * streamRetries,
            signal,
          );
        } catch {
          return end('aborted');
        }
        continue;
      }
    } else {
      // The budget covers consecutive failures of one step, not the whole turn.
      streamRetries = 0;
    }

    if (collected.usageSeen) {
      const u = collected.usage;
      conversation.recordPromptUsage(u.input + u.cache_read + u.cache_creation, shape);
    }
    conversation.appendAssistant(buildAssistantContent(collected));
    batchPending = false;

    // The answer was cut off by the context window: the text shown so far is kept, its tool calls
    // are not run, and the turn continues on a compacted conversation.
    if (collected.stop_reason === 'model_context_window_exceeded') {
      conversation.appendToolResults(conversation.unansweredToolUses().map(interruptedResult));
      if (overflowRecovered) return end('budget', CONTEXT_FULL, 'context');
      overflowRecovered = true;
      const result = await compact('overflow', shape, OVERFLOW_TAIL_FACTOR);
      if (result === 'aborted') return end('aborted');
      if (result === 'skipped') return end('budget', CONTEXT_FULL, 'context');
      conversation.appendUser(
        agentNote(
          'Your previous response was cut off by the context window limit. The conversation was compacted; continue where you left off.',
        ),
      );
      continue;
    }

    // A malformed tool call is a model mistake the model can correct, so it is reported back
    // instead of ending the turn.
    const invalidCalls = collected.errors.filter((e) => e.code === INVALID_TOOL_CALL);
    const fatal = collected.errors.filter((e) => e.code !== INVALID_TOOL_CALL);
    if (fatal.length > 0) {
      conversation.appendToolResults(conversation.unansweredToolUses().map(interruptedResult));
      const message = describeErrors(fatal);
      emit({ type: 'error', message });
      return end('error', message);
    }

    if (collected.tool_uses.length === 0 && invalidCalls.length === 0) {
      if (collected.stop_reason === 'max_tokens') {
        return end('budget', 'the response reached the output token limit', 'output');
      }
      return end('done');
    }

    conversation.appendToolResults(await executeToolCalls(collected.tool_uses, deps, steps));
    if (invalidCalls.length > 0) {
      emit({ type: 'warning', message: `invalid tool call: ${describeErrors(invalidCalls)}` });
      conversation.appendUser(invalidToolCallFeedback(invalidCalls));
    }
    await deps.checkpoint?.();
    if (signal.aborted) return end('aborted');
    overflowRecovered = false;
  }

  return maxSteps === limits.maxSteps
    ? end('budget', `stopped after reaching the limit of ${limits.maxSteps} steps`, 'steps')
    : end('budget', 'stopped at the time set for its last step', 'time');
};
