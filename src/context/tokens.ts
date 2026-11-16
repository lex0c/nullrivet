import type { ProviderMessage, ProviderToolDef } from '../providers/types.ts';

// About 4 characters per token. Overestimates English by 10-25%, which errs toward compacting
// early; it is not suitable for billing.
export const charsToTokens = (chars: number): number => Math.ceil(chars / 4);

// Reasoning blocks are only sent when the provider replays them. Counting them otherwise would
// inflate the estimate and trigger compaction too early.
const charsInMessage = (m: ProviderMessage, countReasoning: boolean): number => {
  if (typeof m.content === 'string') return m.content.length;
  let chars = 0;
  for (const block of m.content) {
    if (block.type === 'text') {
      chars += block.text.length;
    } else if (block.type === 'tool_use') {
      chars += block.name.length + JSON.stringify(block.input).length;
    } else if (block.type === 'tool_result') {
      chars += block.content.length + block.tool_use_id.length;
    } else if (countReasoning) {
      chars += JSON.stringify(block.data).length;
    }
  }
  return chars;
};

const charsInTool = (t: ProviderToolDef): number =>
  t.name.length + t.description.length + JSON.stringify(t.input_schema).length;

export const estimateMessagesTokens = (
  messages: readonly ProviderMessage[],
  options: { countReasoning?: boolean } = {},
): number => {
  const countReasoning = options.countReasoning === true;
  let chars = 0;
  for (const m of messages) chars += charsInMessage(m, countReasoning);
  return charsToTokens(chars);
};

// The system prompt and tool schemas count against the context window too; leaving them out
// would let a request that is already over budget skip compaction.
export const estimatePromptTokens = (
  messages: readonly ProviderMessage[],
  options: {
    system?: string;
    tools?: readonly ProviderToolDef[];
    countReasoning?: boolean;
  } = {},
): number => {
  const countReasoning = options.countReasoning === true;
  let chars = options.system?.length ?? 0;
  for (const t of options.tools ?? []) chars += charsInTool(t);
  for (const m of messages) chars += charsInMessage(m, countReasoning);
  return charsToTokens(chars);
};
