import { type ContextBudget, contextBudget } from '../context/budget.ts';
import { errorMessage } from '../errors.ts';
import type { InstructionsLoader } from '../instructions/agents-loader.ts';
import { renderInstructionFiles } from '../instructions/agents-loader.ts';
import { CONTEXT_OVERFLOW, ContextOverflowError, INVALID_TOOL_CALL } from '../providers/errors.ts';
import type {
  GenerateRequest,
  Provider,
  ProviderEffort,
  ProviderToolResultBlock,
  StreamEvent,
  UsageInfo,
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
}

export interface TurnDependencies {
  provider: Provider;
  conversation: Conversation;
  tools: ReadonlyMap<string, Tool>;
  // Read before every request and every tool call, so a mode change takes effect immediately.
  mode: () => ExecutionMode;
  cwd: string;
  systemPrompt: () => string;
  instructions: InstructionsLoader | null;
  limits: LoopLimits;
  effort?: ProviderEffort;
  emit: AgentEventListener;
  signal: AbortSignal;
}

export interface TurnResult {
  reason: AgentEndReason;
  message?: string;
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

// Growth, as a share of the window, after which an ineffective compaction is tried again.
const REGROWTH_RATIO = 0.1;

const CONTEXT_FULL = 'the conversation does not fit the context window, even after compacting it';
// After an overflow the estimate proved too low, so the compaction keeps a shorter verbatim tail.
const OVERFLOW_TAIL_FACTOR = 0.5;

export const promptShape = (
  deps: Pick<TurnDependencies, 'provider' | 'mode' | 'tools' | 'systemPrompt'>,
): PromptShape => {
  const system = deps.systemPrompt();
  const tools = toolsForMode(deps.mode(), [...deps.tools.values()]).map(toToolDefinition);
  return {
    key: `${deps.provider.id}\0${system}\0${tools.map((t) => t.name).join(',')}`,
    system,
    tools,
    countReasoning: deps.provider.replaysReasoning === true,
  };
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
): Promise<ProviderToolResultBlock[]> => {
  const { emit, signal } = deps;
  const results: ProviderToolResultBlock[] = [];
  const discover = async (paths: readonly string[]): Promise<string | null> => {
    if (deps.instructions === null || paths.length === 0) return null;
    const discovered = await deps.instructions.discover(paths);
    for (const warning of discovered.warnings) emit({ type: 'warning', message: warning });
    if (discovered.files.length === 0) return null;
    return `${DISCOVERED_INSTRUCTIONS_HEADER}\n${renderInstructionFiles(discovered.files)}`;
  };
  for (const call of calls) {
    if (signal.aborted) {
      results.push(interruptedResult({ type: 'tool_use', ...call }));
      continue;
    }
    emit({ type: 'tool:start', id: call.id, name: call.name, args: call.input });
    const result = await executeToolCall(call, {
      tools: deps.tools,
      mode: deps.mode(),
      cwd: deps.cwd,
      signal,
      newInstructions: discover,
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
    results.push({
      type: 'tool_result',
      tool_use_id: call.id,
      name: call.name,
      content,
      ...(result.isError ? { is_error: true } : {}),
    });
  }
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

// Runs one user turn: request, stream, execute tool calls, feed results back, until the model
// answers without tool calls, the turn is aborted, or a limit is reached.
export const runTurn = async (prompt: string, deps: TurnDependencies): Promise<TurnResult> => {
  const { conversation, emit, signal, limits } = deps;
  let usage = emptyUsage();
  let steps = 0;
  let streamRetries = 0;
  const end = (reason: AgentEndReason, message?: string): TurnResult => {
    emit(
      message === undefined
        ? { type: 'agent:end', reason }
        : { type: 'agent:end', reason, message },
    );
    return message === undefined ? { reason, usage, steps } : { reason, message, usage, steps };
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

  emit({ type: 'agent:start' });
  conversation.appendUser(prompt);

  while (steps < limits.maxSteps) {
    if (signal.aborted) return end('aborted');
    steps += 1;
    const shape = promptShape(deps);
    const budget = contextBudget(deps.provider.capabilities);
    let estimate = conversation.estimateTokens(shape);
    if (shouldCompact(estimate, budget)) {
      if ((await compactAuto(shape, budget)) === 'aborted') return end('aborted');
      estimate = conversation.estimateTokens(shape);
    }
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
      if (maxTokens < minOutput) return end('budget', CONTEXT_FULL);
    }
    const request: GenerateRequest = {
      model: deps.provider.id,
      system: shape.system,
      messages: [...conversation.messages()],
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
        return recovery === 'aborted' ? end('aborted') : end('budget', CONTEXT_FULL);
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
      return recovery === 'aborted' ? end('aborted') : end('budget', CONTEXT_FULL);
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

    // The answer was cut off by the context window: the text shown so far is kept, its tool calls
    // are not run, and the turn continues on a compacted conversation.
    if (collected.stop_reason === 'model_context_window_exceeded') {
      conversation.appendToolResults(conversation.unansweredToolUses().map(interruptedResult));
      if (overflowRecovered) return end('budget', CONTEXT_FULL);
      overflowRecovered = true;
      const result = await compact('overflow', shape, OVERFLOW_TAIL_FACTOR);
      if (result === 'aborted') return end('aborted');
      if (result === 'skipped') return end('budget', CONTEXT_FULL);
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
        return end('budget', 'the response reached the output token limit');
      }
      return end('done');
    }

    conversation.appendToolResults(await executeToolCalls(collected.tool_uses, deps));
    if (invalidCalls.length > 0) {
      emit({ type: 'warning', message: `invalid tool call: ${describeErrors(invalidCalls)}` });
      conversation.appendUser(invalidToolCallFeedback(invalidCalls));
    }
    if (signal.aborted) return end('aborted');
    overflowRecovered = false;
  }

  return end('budget', `stopped after reaching the limit of ${limits.maxSteps} steps`);
};
