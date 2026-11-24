import { errorMessage } from '../errors.ts';
import { stripAnsi } from '../sanitize/ansi.ts';
import { InvalidArgumentError } from '../tools/args.ts';
import { type ExecutionMode, isToolAllowed } from '../tools/policy.ts';
import { type Tool, type ToolContext, type ToolResult, toolError } from '../tools/types.ts';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Where an authorized call runs. A backend only carries out what the broker hands it and decides
// nothing about what is allowed. A failure of the tool is a result. A thrown InvalidArgumentError
// is reported as invalid input and any other thrown error as a crash of the tool; the broker
// recognizes InvalidArgumentError by its class, so a backend that runs tools in another process
// returns invalid input as an `input.invalid` result itself.
export interface ToolBackend {
  execute(tool: Tool, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  // Why the backend can no longer run calls, once it cannot, such as a sandbox whose worker
  // exited; null while it can. A lost backend stays lost: the session does not continue its tool
  // calls anywhere else.
  failure?(): string | null;
}

// Thrown by a backend for a call it lost, such as one pending when its worker exited.
export class BackendLostError extends Error {
  override name = 'BackendLostError';
}

// Runs the tool in the nullrivet process, with the user's access to files and network. Async, so
// a tool that throws before returning its promise still yields a rejected promise.
export const IN_PROCESS_BACKEND: ToolBackend = {
  execute: async (tool, input, context) => tool.execute(input, context),
};

// The result for an error a tool threw. Shared with backends that run tools in another process.
export const thrownToolError = (name: string, error: unknown): ToolResult =>
  error instanceof InvalidArgumentError
    ? toolError('input.invalid', error.message)
    : toolError('tool.crashed', `${name} failed unexpectedly: ${errorMessage(error)}`);

const lostBackend = (name: string, reason: string, started: boolean): ToolResult =>
  toolError(
    'sandbox.lost',
    `${name} ${started ? 'did not complete' : 'was not executed'}: the tool sandbox stopped (${reason})`,
    'No tool can run for the rest of this session.',
  );

export interface ToolExecutionContext {
  tools: ReadonlyMap<string, Tool>;
  mode: ExecutionMode;
  cwd: string;
  signal: AbortSignal;
  backend: ToolBackend;
  // Returns what the model must read before a write to the paths: AGENTS.md files that govern
  // them and that it has not seen yet, or where in the current response they were attached. Null
  // when there are none.
  newInstructions?: (paths: readonly string[]) => Promise<string | null>;
}

// Every tool call passes here: it is authorized in this process, then dispatched to the backend,
// which may run it elsewhere, or run here when the tool declares that it acts on the host. Every
// failure becomes a structured result for the model; nothing a tool or a backend does can throw
// past this point. The policy is checked here as well as when building the request, so a call to
// a tool that was not offered (or a mode change mid-turn) is still refused.
export const executeToolCall = async (
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> => {
  const tool = context.tools.get(call.name);
  if (tool === undefined) {
    const available = [...context.tools.keys()].join(', ');
    return toolError(
      'tool.unknown',
      `unknown tool '${call.name}'`,
      `available tools: ${available}`,
    );
  }
  if (!isToolAllowed(context.mode, tool)) {
    return toolError(
      'policy.denied',
      `tool '${call.name}' is not available in ${context.mode} mode`,
      'only read tools can be used in readonly mode',
    );
  }
  const backend = tool.runsOnHost === true ? IN_PROCESS_BACKEND : context.backend;
  try {
    // Inside the try: targetPaths is tool code and may reject its arguments.
    if (tool.targetPaths !== undefined && context.newInstructions !== undefined) {
      const instructions = await context.newInstructions(tool.targetPaths(call.input, context.cwd));
      if (instructions !== null) {
        const refusal = toolError(
          'instructions.new',
          `${call.name} was not executed: AGENTS.md instructions that you had not seen apply to this path`,
          'Read them and issue the call again, adjusted to follow them.',
        );
        return { ...refusal, content: `${refusal.content}\n\n${instructions}` };
      }
    }
    // Checked last before the dispatch, after any wait above, so a call the backend never received
    // is reported as not executed rather than as interrupted.
    const lost = context.backend.failure?.() ?? null;
    if (lost !== null) return lostBackend(call.name, lost, false);
    const result = await backend.execute(tool, call.input, {
      cwd: context.cwd,
      signal: context.signal,
    });
    return { ...result, content: stripAnsi(result.content) };
  } catch (error) {
    if (error instanceof BackendLostError) return lostBackend(call.name, error.message, true);
    return thrownToolError(call.name, error);
  }
};
