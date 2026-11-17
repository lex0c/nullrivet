import { errorMessage } from '../errors.ts';
import { stripAnsi } from '../sanitize/ansi.ts';
import { InvalidArgumentError } from '../tools/args.ts';
import { type ExecutionMode, isToolAllowed } from '../tools/policy.ts';
import { type Tool, type ToolResult, toolError } from '../tools/types.ts';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolExecutionContext {
  tools: ReadonlyMap<string, Tool>;
  mode: ExecutionMode;
  cwd: string;
  signal: AbortSignal;
  // Returns what the model must read before a write to the paths: AGENTS.md files that govern
  // them and that it has not seen yet, or where in the current response they were attached. Null
  // when there are none.
  newInstructions?: (paths: readonly string[]) => Promise<string | null>;
}

// Every failure becomes a structured result for the model; nothing a tool does can throw past
// this point. The policy is checked here as well as when building the request, so a call to a
// tool that was not offered (or a mode change mid-turn) is still refused.
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
  try {
    const result = await tool.execute(call.input, {
      cwd: context.cwd,
      signal: context.signal,
    });
    return { ...result, content: stripAnsi(result.content) };
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      return toolError('input.invalid', error.message);
    }
    const message = errorMessage(error);
    return toolError('tool.crashed', `${call.name} failed unexpectedly: ${message}`);
  }
};
