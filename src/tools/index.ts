import { bashTool } from './bash.ts';
import { editFileTool } from './edit-file.ts';
import { gitTool } from './git.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { readFileTool } from './read-file.ts';
import type { Tool } from './types.ts';
import { writeFileTool } from './write-file.ts';

// The order is part of the request prefix, so it stays fixed to keep the prompt cache warm.
export const BUILTIN_TOOLS: readonly Tool[] = [
  readFileTool,
  globTool,
  grepTool,
  gitTool,
  editFileTool,
  writeFileTool,
  bashTool,
];
