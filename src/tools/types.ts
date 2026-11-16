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
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ProviderToolInputSchema;
  effect: ToolEffect;
  // Input comes from the model and is untrusted; each tool validates its own arguments.
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
