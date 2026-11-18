import type { ProviderToolInputSchema } from '../providers/types.ts';

// `read` tools have no side effects and are the only ones exposed in readonly mode.
export type ToolEffect = 'read' | 'write' | 'exec';

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface ToolResult {
  // Sent to the model as the tool_result content.
  content: string;
  isError: boolean;
  // Structured details for the interface, such as an exit code. Never sent to the model.
  meta?: Record<string, unknown>;
  // Absolute paths the call read or modified (a directory for bash and git). Used to resolve the
  // AGENTS.md files that apply to them.
  touchedPaths?: string[];
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ProviderToolInputSchema;
  effect: ToolEffect;
  // Paths a call will change, known before it runs. The AGENTS.md files that govern them are
  // loaded first, so instructions the model has not seen reach it before the change, not after.
  targetPaths?(input: Record<string, unknown>, cwd: string): string[];
  // Input comes from the model and is untrusted; each tool validates its own arguments with the
  // readers in `args.ts`, whose InvalidArgumentError the tool broker reports as `input.invalid`.
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const toolError = (code: string, message: string, hint?: string): ToolResult => ({
  content:
    hint === undefined
      ? `error [${code}]: ${message}`
      : `error [${code}]: ${message}\nhint: ${hint}`,
  isError: true,
  meta: { errorCode: code },
});
