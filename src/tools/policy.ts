import type { Tool } from './types.ts';

export type ExecutionMode = 'auto' | 'readonly';

export const EXECUTION_MODES: readonly ExecutionMode[] = ['auto', 'readonly'];

export const isExecutionMode = (value: string): value is ExecutionMode =>
  (EXECUTION_MODES as readonly string[]).includes(value);

// Used both to filter the schemas sent to the model and again by the tool broker before every
// call, so a tool call that bypasses the model is still refused.
export const isToolAllowed = (mode: ExecutionMode, tool: Pick<Tool, 'effect'>): boolean =>
  mode === 'auto' || tool.effect === 'read';

export const toolsForMode = <T extends Pick<Tool, 'effect'>>(
  mode: ExecutionMode,
  tools: readonly T[],
): T[] => tools.filter((tool) => isToolAllowed(mode, tool));
