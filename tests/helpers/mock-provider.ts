import type {
  GenerateRequest,
  Provider,
  ProviderCapabilities,
  StreamEvent,
  UsageInfo,
} from '../../src/providers/types.ts';

export type ScriptedTurn = StreamEvent[] | Error | ((req: GenerateRequest) => StreamEvent[]);

export interface MockCall {
  req: GenerateRequest;
  signal: AbortSignal | undefined;
}

export interface MockProvider extends Provider {
  calls: MockCall[];
}

// Replays one scripted turn per `generate` call and records every request, so tests can assert
// on what the agent sent. Running out of turns is a test bug and fails loudly.
export const createMockProvider = (
  turns: ScriptedTurn[],
  capabilities: Partial<ProviderCapabilities> = {},
): MockProvider => {
  const calls: MockCall[] = [];
  return {
    id: 'mock/model',
    family: 'openrouter',
    capabilities: { context_window: 100_000, output_max_tokens: 4_096, ...capabilities },
    calls,
    async *generate(req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      calls.push({ req, signal });
      const turn = turns[calls.length - 1];
      if (turn === undefined) {
        throw new Error(`mock provider has no scripted turn for call ${calls.length}`);
      }
      if (turn instanceof Error) throw turn;
      const events = typeof turn === 'function' ? turn(req) : turn;
      for (const event of events) yield event;
    },
  };
};

const usage = (input: number, output: number): UsageInfo => ({
  input,
  output,
  cache_read: 0,
  cache_creation: 0,
});

export const textTurn = (text: string, tokens = { input: 10, output: 5 }): StreamEvent[] => [
  { kind: 'start', message_id: 'msg' },
  { kind: 'text_delta', text },
  { kind: 'usage', usage: usage(tokens.input, tokens.output) },
  { kind: 'stop', reason: 'end_turn' },
];

export const toolTurn = (
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  tokens = { input: 10, output: 5 },
): StreamEvent[] => [
  { kind: 'start', message_id: 'msg' },
  ...calls.flatMap((call): StreamEvent[] => [
    { kind: 'tool_use_start', id: call.id, name: call.name },
    { kind: 'tool_use_delta', id: call.id, partial_args: JSON.stringify(call.args) },
    { kind: 'tool_use_stop', id: call.id, final_args: call.args },
  ]),
  { kind: 'usage', usage: usage(tokens.input, tokens.output) },
  { kind: 'stop', reason: 'tool_use' },
];
