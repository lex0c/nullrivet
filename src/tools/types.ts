import type { ProviderToolInputSchema } from '../providers/types.ts';

// `read` tools have no side effects and are the only ones exposed in readonly mode.
export type ToolEffect = 'read' | 'write' | 'exec';

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  // The call's id in the session's evidence log, when it keeps one: a sandboxed worker's backend
  // uses it as the call's id, so that what the worker reports of the call names it.
  callId?: string;
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
  // What the call's command wrote, as captured: for the evidence log, never sent to the model.
  outputs?: CapturedOutput[];
}

// One output stream of a command that the result shows, as the capture saw it: how many bytes came
// and their SHA-256, and how many were saved to parts and theirs. Not necessarily all the command
// wrote: a capture cut short, as by a timeout, ends before. Without parts and without a stop
// reason, the result holds the output whole.
export interface CapturedOutput {
  stream: 'stdout' | 'stderr';
  receivedBytes: number;
  receivedSha256: string;
  savedBytes: number;
  savedSha256: string;
  parts: string[];
  stopReason?: string;
  interrupted?: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ProviderToolInputSchema;
  effect: ToolEffect;
  // The tool acts on the agent rather than on files, commands or the network, such as delegate,
  // which starts a subagent. It runs in the nullrivet process whatever backend the session uses;
  // every other tool runs on the session's backend.
  runsOnHost?: boolean;
  // The tool starts commands the model or the project chooses, which an engagement authorizes
  // against its targets only within its window: outside it the broker refuses the tool, and a call
  // still running at its end is cancelled.
  startsCommands?: boolean;
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
