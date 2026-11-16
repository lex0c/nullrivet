import { cappedEffortLevel, effortThinkingBudget } from '../effort.ts';
import { systemText } from '../openai/messages.ts';
import type {
  GenerateRequest,
  ProviderCapabilities,
  ProviderContentBlock,
  ProviderMessage,
  ProviderReasoningBlock,
  ProviderToolDef,
} from '../types.ts';
import { SYNTHETIC_CALL_ID_PREFIX } from './stream.ts';

export type GooglePart = (
  | { text: string }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> } }
  | {
      functionResponse: {
        id?: string;
        name: string;
        response: { output: string } | { error: string };
      };
    }
) & { thoughtSignature?: string };

export interface GoogleContent {
  role: 'user' | 'model';
  parts: GooglePart[];
}

export interface GoogleRequestBody {
  contents: GoogleContent[];
  systemInstruction?: { parts: [{ text: string }] };
  tools?: [{ functionDeclarations: GoogleFunctionDeclaration[] }];
  generationConfig: Record<string, unknown>;
}

interface GoogleFunctionDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: unknown;
}

const signatureOf = (block: ProviderReasoningBlock): string | undefined => {
  if (block.provider !== 'google') return undefined;
  const data = block.data as { thoughtSignature?: unknown } | null;
  if (data === null || typeof data !== 'object') return undefined;
  const signature = data.thoughtSignature;
  return typeof signature === 'string' && signature.length > 0 ? signature : undefined;
};

const issuedCallId = (id: string): string | undefined =>
  id.startsWith(SYNTHETIC_CALL_ID_PREFIX) ? undefined : id;

// Gemini correlates a result with its call by function name. The name is taken from the result,
// or else from the call with the same id earlier in the conversation.
const toolResultPart = (
  block: Extract<ProviderContentBlock, { type: 'tool_result' }>,
  callNames: ReadonlyMap<string, string>,
): GooglePart => {
  const name =
    block.name !== undefined && block.name.length > 0
      ? block.name
      : callNames.get(block.tool_use_id);
  if (name === undefined) {
    throw new Error(
      `tool_result ${block.tool_use_id} has no function name and answers no known call; Gemini correlates results by name`,
    );
  }
  const response = block.is_error === true ? { error: block.content } : { output: block.content };
  const id = issuedCallId(block.tool_use_id);
  return { functionResponse: id === undefined ? { name, response } : { id, name, response } };
};

// A signature belongs to the part that follows its reasoning block, as the stream normalizer
// emits it before that part. A signature with no part after it (the API may send it alone in a
// final empty text part) goes to the last part when that part has none, because an empty text
// part cannot be sent. Reasoning captured by another family is dropped.
const toParts = (m: ProviderMessage, callNames: Map<string, string>): GooglePart[] => {
  if (typeof m.content === 'string') return [{ text: m.content }];
  const parts: GooglePart[] = [];
  let pending: string | undefined;
  for (const block of m.content) {
    let part: GooglePart;
    switch (block.type) {
      case 'reasoning':
        pending = signatureOf(block) ?? pending;
        continue;
      case 'text':
        part = { text: block.text };
        break;
      case 'tool_use': {
        callNames.set(block.id, block.name);
        const id = issuedCallId(block.id);
        part = {
          functionCall:
            id === undefined
              ? { name: block.name, args: block.input }
              : { id, name: block.name, args: block.input },
        };
        break;
      }
      case 'tool_result':
        part = toolResultPart(block, callNames);
        break;
    }
    if (pending !== undefined) {
      part.thoughtSignature = pending;
      pending = undefined;
    }
    parts.push(part);
  }
  const last = parts.at(-1);
  if (pending !== undefined && last !== undefined && last.thoughtSignature === undefined) {
    last.thoughtSignature = pending;
  }
  return parts;
};

export const toGoogleContents = (messages: readonly ProviderMessage[]): GoogleContent[] => {
  const callNames = new Map<string, string>();
  const contents: GoogleContent[] = [];
  for (const m of messages) {
    const parts = toParts(m, callNames);
    // The API rejects a content without parts.
    if (parts.length === 0) continue;
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
};

// `parametersJsonSchema` takes JSON Schema as is; the older `parameters` field accepts only an
// OpenAPI subset and rejects keywords such as `additionalProperties`.
export const toGoogleTools = (
  tools: readonly ProviderToolDef[],
): [{ functionDeclarations: GoogleFunctionDeclaration[] }] => [
  {
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.input_schema,
    })),
  },
];

// Gemini 3 and later take a named level; Gemini 2.5 takes a token budget, capped by the model's
// ceiling because a larger one is rejected. Without an effort the model's default applies.
export const googleThinkingConfig = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
): Record<string, unknown> | undefined => {
  if (req.effort === undefined || caps.supports_reasoning_effort !== true) return undefined;
  if (caps.max_thinking_budget === undefined) {
    return { thinkingLevel: cappedEffortLevel(req.effort, caps.supports_effort_xhigh === true) };
  }
  const budget = effortThinkingBudget(req.effort, req.max_tokens);
  if (budget === undefined) return undefined;
  return { thinkingBudget: Math.min(budget, caps.max_thinking_budget) };
};

export const buildGoogleRequest = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
): GoogleRequestBody => {
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.max_tokens };
  if (caps.supports_sampling !== false) {
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.top_p !== undefined) generationConfig.topP = req.top_p;
  }
  if (req.stop_sequences !== undefined) generationConfig.stopSequences = req.stop_sequences;
  const thinkingConfig = googleThinkingConfig(req, caps);
  if (thinkingConfig !== undefined) generationConfig.thinkingConfig = thinkingConfig;

  const body: GoogleRequestBody = { contents: toGoogleContents(req.messages), generationConfig };
  const system = systemText(req);
  if (system !== undefined && system.length > 0) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  if (req.tools !== undefined && req.tools.length > 0) body.tools = toGoogleTools(req.tools);
  return body;
};
