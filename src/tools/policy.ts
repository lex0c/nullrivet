import type { Tool } from './types.ts';

export type ExecutionMode = 'auto' | 'readonly';

export const EXECUTION_MODES: readonly ExecutionMode[] = ['auto', 'readonly'];

export const isExecutionMode = (value: string): value is ExecutionMode =>
  (EXECUTION_MODES as readonly string[]).includes(value);

// Where the tools run when not in this process. The execution mode and the profile are
// independent, and a call must be allowed by both.
export type SandboxProfile = 'inspect';

export const SANDBOX_PROFILES: readonly SandboxProfile[] = ['inspect'];

export const isSandboxProfile = (value: string): value is SandboxProfile =>
  (SANDBOX_PROFILES as readonly string[]).includes(value);

// The sandbox a session runs its tools in: the profile, and the project directory it exposes,
// with symbolic links resolved.
export interface SandboxScope {
  profile: SandboxProfile;
  root: string;
}

// Used both to filter the schemas sent to the model and again by the tool broker before every
// call, so a tool call that bypasses the model is still refused.
export const isToolAllowed = (mode: ExecutionMode, tool: Pick<Tool, 'effect'>): boolean =>
  mode === 'auto' || tool.effect === 'read';

export const toolsForMode = <T extends Pick<Tool, 'effect'>>(
  mode: ExecutionMode,
  tools: readonly T[],
): T[] => tools.filter((tool) => isToolAllowed(mode, tool));
