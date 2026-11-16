import { estimatePromptTokens } from '../context/tokens.ts';
import type { InstructionsLoader } from '../instructions/agents-loader.ts';
import { renderInstructionFiles } from '../instructions/agents-loader.ts';
import { INVALID_TOOL_CALL } from '../providers/errors.ts';
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
import { type Conversation, interruptedResult } from './conversation.ts';
import type { AgentEndReason, AgentEventListener } from './events.ts';
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

const describeErrors = (errors: readonly CollectedError[]): string =>
  errors.map((e) => `${e.code}: ${e.message}`).join('; ');

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

// The output limit shrinks as the conversation grows, so prompt plus answer always fit the window.
const outputBudget = (request: GenerateRequest, provider: Provider, limit: number): number => {
  const prompt = estimatePromptTokens(request.messages, {
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    countReasoning: provider.replaysReasoning === true,
  });
  return Math.min(limit, provider.capabilities.context_window - prompt - CONTEXT_SAFETY_TOKENS);
};

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
    });
    let content = result.content;
    if (deps.instructions !== null && result.touchedPaths !== undefined) {
      const discovered = await deps.instructions.discover(result.touchedPaths);
      for (const warning of discovered.warnings) emit({ type: 'warning', message: warning });
      if (discovered.files.length > 0) {
        content += `\n\n${DISCOVERED_INSTRUCTIONS_HEADER}\n${renderInstructionFiles(discovered.files)}`;
      }
    }
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
  [
    'Some tool calls in your previous response were rejected and not executed:',
    ...errors.map((e) => `- ${e.message}`),
    'Issue them again with a valid tool name and a JSON object as arguments.',
  ].join('\n');

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

  emit({ type: 'agent:start' });
  conversation.appendUser(prompt);

  while (steps < limits.maxSteps) {
    if (signal.aborted) return end('aborted');
    steps += 1;
    const offered = toolsForMode(deps.mode(), [...deps.tools.values()]);
    const request: GenerateRequest = {
      model: deps.provider.id,
      system: deps.systemPrompt(),
      messages: [...conversation.messages()],
      tools: offered.map(toToolDefinition),
      max_tokens: limits.maxOutputTokens,
      ...(deps.effort === undefined ? {} : { effort: deps.effort }),
    };
    request.max_tokens = outputBudget(request, deps.provider, limits.maxOutputTokens);
    if (request.max_tokens < Math.min(MIN_OUTPUT_TOKENS, limits.maxOutputTokens)) {
      return end('budget', 'the conversation no longer fits the context window');
    }

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

    conversation.appendAssistant(buildAssistantContent(collected));

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
      if (collected.stop_reason === 'model_context_window_exceeded') {
        return end('budget', 'the context window is full');
      }
      return end('done');
    }

    conversation.appendToolResults(await executeToolCalls(collected.tool_uses, deps));
    if (invalidCalls.length > 0) {
      emit({ type: 'warning', message: `invalid tool call: ${describeErrors(invalidCalls)}` });
      conversation.appendUser(invalidToolCallFeedback(invalidCalls));
    }
    if (signal.aborted) return end('aborted');
  }

  return end('budget', `stopped after reaching the limit of ${limits.maxSteps} steps`);
};
