import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { CONTEXT_OVERFLOW, INVALID_TOOL_CALL } from '../../src/providers/errors.ts';
import { OPENAI_CAPS } from '../../src/providers/openai/capabilities.ts';
import {
  type CreateOpenAIProviderOptions,
  createOpenAIProvider,
} from '../../src/providers/openai/index.ts';
import {
  MESSAGE_PHASE_KEY,
  normalizeResponsesStream,
  type RawResponsesEvent,
} from '../../src/providers/openai/responses-stream.ts';
import type {
  GenerateRequest,
  ProviderCapabilities,
  ProviderMessage,
  StreamEvent,
} from '../../src/providers/types.ts';

const asyncIter = <T>(items: T[]): AsyncIterable<T> =>
  (async function* () {
    for (const i of items) yield i;
  })();

const normalize = async (events: RawResponsesEvent[]): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of normalizeResponsesStream(asyncIter(events))) out.push(e);
  return out;
};

describe('normalizeResponsesStream', () => {
  test('maps the Responses event sequence to canonical events', async () => {
    const out = await normalize([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"/x"}' },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', arguments: '{"path":"/x"}' },
      },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 30 },
          },
        },
      },
    ]);
    expect(out).toEqual([
      { kind: 'start', message_id: 'resp_1' },
      { kind: 'text_delta', text: 'hi' },
      { kind: 'tool_use_start', id: 'call_1', name: 'read' },
      { kind: 'tool_use_delta', id: 'call_1', partial_args: '{"path":' },
      { kind: 'tool_use_delta', id: 'call_1', partial_args: '"/x"}' },
      { kind: 'tool_use_stop', id: 'call_1', final_args: { path: '/x' } },
      { kind: 'usage', usage: { input: 70, output: 20, cache_read: 30, cache_creation: 0 } },
      { kind: 'stop', reason: 'tool_use' },
    ]);
  });

  test('tool args fall back to accumulated deltas when output_item.done omits them', async () => {
    const out = await normalize([
      { type: 'response.created', response: { id: 'r' } },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'read' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"/a"}' },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'c1' },
      },
      { type: 'response.completed', response: {} },
    ]);
    expect(out).toContainEqual({ kind: 'tool_use_stop', id: 'c1', final_args: { path: '/a' } });
  });

  test('malformed or non-object tool args are an invalid tool call without a stop', async () => {
    for (const args of ['{"path": "/a"', '[1,2]']) {
      const out = await normalize([
        { type: 'response.created', response: { id: 'r' } },
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'read' },
        },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', id: 'fc_1', call_id: 'c1', arguments: args },
        },
        { type: 'response.completed', response: {} },
      ]);
      expect(out.some((e) => e.kind === 'error' && e.code === INVALID_TOOL_CALL)).toBe(true);
      expect(out.some((e) => e.kind === 'tool_use_stop')).toBe(false);
    }
  });

  test('a text-only turn stops with end_turn', async () => {
    const out = await normalize([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_text.delta', delta: 'done' },
      { type: 'response.completed', response: {} },
    ]);
    expect(out.at(-1)).toEqual({ kind: 'stop', reason: 'end_turn' });
  });

  test('incomplete with max_output_tokens stops with max_tokens', async () => {
    const out = await normalize([
      { type: 'response.created', response: { id: 'r' } },
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' }, usage: {} },
      },
    ]);
    expect(out.at(-1)).toEqual({ kind: 'stop', reason: 'max_tokens' });
  });

  test('a failed response reports its error and no stop', async () => {
    const out = await normalize([
      { type: 'response.created', response: { id: 'r' } },
      {
        type: 'response.failed',
        response: { error: { code: 'server_error', message: 'boom' }, usage: { input_tokens: 5 } },
      },
    ]);
    expect(out).toContainEqual({
      kind: 'error',
      code: 'openai.stream_error',
      message: 'boom',
      retryable: true,
    });
    expect(out.some((e) => e.kind === 'usage')).toBe(true);
    expect(out.some((e) => e.kind === 'stop')).toBe(false);
  });

  test('a context overflow inside the stream becomes a context_overflow event', async () => {
    for (const event of [
      {
        type: 'response.failed',
        response: {
          error: {
            code: 'context_length_exceeded',
            message: 'Your input exceeds the context window of this model.',
          },
        },
      },
      { type: 'error', code: 'context_length_exceeded', message: 'too long' },
    ]) {
      const out = await normalize([{ type: 'response.created', response: { id: 'r' } }, event]);
      expect(out).toContainEqual(
        expect.objectContaining({ kind: 'error', code: CONTEXT_OVERFLOW, retryable: false }),
      );
    }
  });

  test('a reasoning output item is captured verbatim', async () => {
    const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' };
    const out = await normalize([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_item.done', item: reasoningItem } as RawResponsesEvent,
      { type: 'response.completed', response: {} },
    ]);
    expect(out).toContainEqual({ kind: 'reasoning', provider: 'openai', data: reasoningItem });
  });

  test('summary parts become thinking deltas separated by a blank line', async () => {
    const thinks = (
      await normalize([
        { type: 'response.created', response: { id: 'r' } },
        { type: 'response.reasoning_summary_part.added' },
        { type: 'response.reasoning_summary_text.delta', delta: 'part one' },
        { type: 'response.reasoning_summary_part.added' },
        { type: 'response.reasoning_summary_text.delta', delta: 'part two' },
        { type: 'response.completed', response: {} },
      ])
    ).filter((e) => e.kind === 'thinking_delta');
    expect(thinks).toEqual([
      { kind: 'thinking_delta', text: 'part one' },
      { kind: 'thinking_delta', text: '\n\n' },
      { kind: 'thinking_delta', text: 'part two' },
    ]);
  });

  test('a codex message phase travels on the reasoning channel', async () => {
    const out = await normalize([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_item.done', item: { type: 'message', phase: 'commentary' } },
      { type: 'response.completed', response: {} },
    ]);
    expect(out).toContainEqual({
      kind: 'reasoning',
      provider: 'openai',
      data: { [MESSAGE_PHASE_KEY]: 'commentary' },
    });
  });
});

// biome-ignore lint/suspicious/noExplicitAny: the captured request body is dynamic.
type Body = Record<string, any>;

const completed: RawResponsesEvent[] = [
  { type: 'response.created', response: { id: 'r' } },
  { type: 'response.completed', response: {} },
];

// Routes generate through `client.responses.create` and fails if Chat Completions is used.
const responsesClient = (calls: Body[]): OpenAI =>
  ({
    responses: {
      create: async (params: Body) => {
        calls.push(params);
        return asyncIter(completed);
      },
    },
    chat: {
      completions: {
        create: () => {
          throw new Error('a reasoning model must use the Responses API');
        },
      },
    },
  }) as unknown as OpenAI;

const caps = (model: string): ProviderCapabilities => {
  const c = OPENAI_CAPS[model];
  if (c === undefined) throw new Error(`test setup: ${model} is not in OPENAI_CAPS`);
  return c;
};

const capture = async (
  model: string,
  req: Partial<GenerateRequest>,
  options: Partial<CreateOpenAIProviderOptions> = {},
): Promise<Body> => {
  const calls: Body[] = [];
  const provider = createOpenAIProvider(model, {
    capabilities: caps(model),
    client: responsesClient(calls),
    env: {},
    ...options,
  });
  for await (const _ of provider.generate({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
    ...req,
  })) {
    // drain
  }
  const body = calls[0];
  if (body === undefined) throw new Error('no request was sent');
  return body;
};

describe('createOpenAIProvider on the Responses API', () => {
  test('a reasoning model routes through the Responses API', async () => {
    const p = await capture('gpt-5.4-mini', {
      effort: 'high',
      system: 'be concise',
      temperature: 1,
    });
    expect(p.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(p.max_output_tokens).toBe(8);
    expect(p.store).toBe(false);
    expect(p.instructions).toBe('Formatting re-enabled\nbe concise');
    expect(p.input).toEqual([{ role: 'user', content: 'hi' }]);
    expect('temperature' in p).toBe(false);
    expect(typeof p.prompt_cache_key).toBe('string');
    expect('prompt_cache_retention' in p).toBe(false);
    expect('metadata' in p).toBe(false);
  });

  test('max effort maps to xhigh', async () => {
    const p = await capture('gpt-5.4-mini', { effort: 'max' });
    expect(p.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  test('extended retention is sent only for models on the extended list', async () => {
    expect((await capture('gpt-5.4', {})).prompt_cache_retention).toBe('24h');
    expect('prompt_cache_retention' in (await capture('gpt-5.4-mini', {}))).toBe(false);
  });

  test('the in_memory opt-out is sent where the model accepts it', async () => {
    const p = await capture(
      'gpt-5.4',
      {},
      { env: { NULLRIVET_OPENAI_PROMPT_CACHE_RETENTION: 'in_memory' } },
    );
    expect(p.prompt_cache_retention).toBe('in_memory');
  });

  test('the opt-out on a 24h-only model is omitted and reported as a warning', async () => {
    const warnings: string[] = [];
    const p = await capture(
      'gpt-5.5',
      {},
      {
        env: { NULLRIVET_OPENAI_PROMPT_CACHE_RETENTION: 'in_memory' },
        warn: (m) => warnings.push(m),
      },
    );
    expect('prompt_cache_retention' in p).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('24h');
  });

  test('a custom base URL drops the parameters limited to the official endpoint', async () => {
    const p = await capture('gpt-5.4', {}, { baseURL: 'https://proxy.example/v1' });
    expect('prompt_cache_key' in p).toBe(false);
    expect('prompt_cache_retention' in p).toBe(false);
    expect('include' in p).toBe(false);
  });

  test('tool results become function_call_output items ahead of user text', async () => {
    const p = await capture('gpt-5.4-mini', {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'next' },
            { type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true },
          ],
        },
      ],
      tools: [{ name: 'read', description: 'd', input_schema: { type: 'object' } }],
    });
    expect(p.input).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '[tool error] boom' },
      { role: 'user', content: 'next' },
    ]);
    expect(p.tools).toEqual([
      { type: 'function', name: 'read', description: 'd', parameters: { type: 'object' } },
    ]);
  });
});

describe('OpenAI reasoning replay', () => {
  const reasoningItem = { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC' };
  const toolTurn: ProviderMessage = {
    role: 'assistant',
    content: [
      { type: 'reasoning', provider: 'openai', data: reasoningItem },
      { type: 'text', text: 'let me read it' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { p: '/x' } },
      { type: 'reasoning', provider: 'anthropic', data: { thinking: 't' } },
    ],
  };
  const followUp: ProviderMessage = { role: 'user', content: 'go' };

  test('replaysReasoning is true only on the Responses route of the official endpoint', () => {
    const make = (model: string, baseURL?: string) =>
      createOpenAIProvider(model, {
        capabilities: caps(model),
        apiKey: 'sk-test',
        env: {},
        ...(baseURL === undefined ? {} : { baseURL }),
      });
    expect(make('gpt-5.4-mini').replaysReasoning).toBe(true);
    expect(make('gpt-4o').replaysReasoning).toBe(false);
    expect(make('gpt-5.4-mini', 'https://proxy.example/v1').replaysReasoning).toBe(false);
  });

  test('NULLRIVET_OPENAI_REASONING_REPLAY=0 keeps reasoning out of the input', async () => {
    const p = await capture(
      'gpt-5.4-mini',
      { messages: [toolTurn, followUp] },
      { env: { NULLRIVET_OPENAI_REASONING_REPLAY: '0' } },
    );
    expect('include' in p).toBe(false);
    expect((p.input as Body[]).some((i) => i.type === 'reasoning')).toBe(false);
  });

  test('a captured item is replayed verbatim ahead of the message and the call it produced', async () => {
    const p = await capture('gpt-5.4-mini', { messages: [toolTurn, followUp] });
    expect(p.include).toEqual(['reasoning.encrypted_content']);
    const input = p.input as Body[];
    expect(input.filter((i) => i.type === 'reasoning')).toEqual([reasoningItem]);
    const reasoningIdx = input.findIndex((i) => i.type === 'reasoning');
    const messageIdx = input.findIndex((i) => i.role === 'assistant');
    const callIdx = input.findIndex((i) => i.type === 'function_call');
    expect(reasoningIdx).toBeLessThan(messageIdx);
    expect(messageIdx).toBeLessThan(callIdx);
  });

  test('interleaved reasoning items and calls keep their order', async () => {
    const p = await capture('gpt-5.4-mini', {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              provider: 'openai',
              data: { type: 'reasoning', id: 'rs1', encrypted_content: 'E1' },
            },
            { type: 'tool_use', id: 'call_1', name: 'read', input: { p: '/a' } },
            {
              type: 'reasoning',
              provider: 'openai',
              data: { type: 'reasoning', id: 'rs2', encrypted_content: 'E2' },
            },
            { type: 'tool_use', id: 'call_2', name: 'read', input: { p: '/b' } },
          ],
        },
        followUp,
      ],
    });
    const seq = (p.input as Body[])
      .filter((i) => i.type === 'reasoning' || i.type === 'function_call')
      .map((i) => (i.type === 'reasoning' ? i.id : i.call_id));
    expect(seq).toEqual(['rs1', 'call_1', 'rs2', 'call_2']);
  });

  test('reasoning of a text-only turn, or without encrypted content, is dropped', async () => {
    for (const content of [
      [
        { type: 'reasoning' as const, provider: 'openai' as const, data: reasoningItem },
        { type: 'text' as const, text: 'the answer' },
      ],
      [
        {
          type: 'reasoning' as const,
          provider: 'openai' as const,
          data: { type: 'reasoning', id: 'rs_x' },
        },
        { type: 'tool_use' as const, id: 'call_1', name: 'read', input: {} },
      ],
    ]) {
      const p = await capture('gpt-5.4-mini', {
        messages: [{ role: 'assistant', content }, followUp],
      });
      expect((p.input as Body[]).some((i) => i.type === 'reasoning')).toBe(false);
    }
  });

  test('a codex message phase is stamped back on the assistant message', async () => {
    const p = await capture('gpt-5.4-mini', {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              provider: 'openai',
              data: { [MESSAGE_PHASE_KEY]: 'final_answer' },
            },
            { type: 'text', text: 'done' },
          ],
        },
        followUp,
      ],
    });
    const input = p.input as Body[];
    expect(input.find((i) => i.role === 'assistant')?.phase).toBe('final_answer');
    expect(input.some((i) => i.type === 'reasoning')).toBe(false);
  });
});
