import type { ProviderToolDef } from '../types.ts';

export interface OpenAIFunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

// Shared by every adapter that speaks the OpenAI Chat Completions tool shape.
export const toOpenAITools = (tools: readonly ProviderToolDef[]): OpenAIFunctionTool[] =>
  tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
