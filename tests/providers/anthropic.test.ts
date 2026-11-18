import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { AbortError } from '../../src/agent/abortable.ts';
import { generateWithRetry, isRetryableError } from '../../src/agent/retry.ts';
import { ANTHROPIC_CAPS } from '../../src/providers/anthropic/capabilities.ts';
import {
  type CreateAnthropicProviderOptions,
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_BASE_URL,
} from '../../src/providers/anthropic/index.ts';
import type { RawAnthropicEvent } from '../../src/providers/anthropic/stream.ts';
import {
  CONTEXT_OVERFLOW,
  ContextOverflowError,
  ProviderRequestError,
  StaleReasoningError,
} from '../../src/providers/errors.ts';
import type {
  GenerateRequest,
  ProviderCapabilities,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
} from '../../src/providers/types.ts';

// biome-ignore lint/suspicious/noExplicitAny: the captured request body is dynamic.
type Body = Record<string, any>;

interface Captured {
  body: Body;
  options: { signal?: AbortSignal | null | undefined } | undefined;
}

const textEvents: RawAnthropicEvent[] = [
  { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 5 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];

const mockClient = (events: RawAnthropicEvent[], captured?: Captured): Anthropic =>
  ({
    messages: {
      create: async (body: Body, options?: Captured['options']) => {
        if (captured !== undefined) {
          captured.body = body;
          captured.options = options;
        }
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  }) as unknown as Anthropic;

const caps = (model: string): ProviderCapabilities => {
  const c = ANTHROPIC_CAPS[model];
  if (c === undefined) throw new Error(`test setup: ${model} is not in ANTHROPIC_CAPS`);
  return c;
};

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const TOOLS: ProviderToolDef[] = [
  { name: 'read_file', description: 'read', input_schema: { type: 'object' } },
  { name: 'grep', description: 'search', input_schema: { type: 'object' } },
];

const reqGen = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: 'claude-opus-4-8',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 4_096,
  ...over,
});

const capture = async (
  model: string,
  req: Partial<GenerateRequest> = {},
  options: Partial<CreateAnthropicProviderOptions> = {},
  signal?: AbortSignal,
): Promise<Captured> => {
  const captured: Captured = { body: {}, options: undefined };
  const p = createAnthropicProvider(model, {
    capabilities: caps(model),
    env: {},
    client: mockClient(textEvents, captured),
    ...options,
  });
  await collect(p.generate(reqGen(req), signal));
  return captured;
};

const cacheControls = (body: Body): unknown[] => {
  const out: unknown[] = [];
  for (const b of body.system ?? []) if (b.cache_control) out.push(b.cache_control);
  for (const t of body.tools ?? []) if (t.cache_control) out.push(t.cache_control);
  for (const m of body.messages as Body[]) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) if (b.cache_control) out.push(b.cache_control);
  }
  return out;
};

describe('createAnthropicProvider', () => {
  test('throws without an api key or client', () => {
    expect(() =>
      createAnthropicProvider('claude-opus-4-8', { capabilities: caps('claude-opus-4-8') }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  test('exposes the id, family and given capabilities', () => {
    const p = createAnthropicProvider('claude-opus-4-8', {
      capabilities: caps('claude-opus-4-8'),
      env: {},
      client: mockClient([]),
    });
    expect(p.id).toBe('anthropic/claude-opus-4-8');
    expect(p.family).toBe('anthropic');
    expect(p.capabilities).toEqual(caps('claude-opus-4-8'));
  });

  test('streams normalized events', async () => {
    const p = createAnthropicProvider('claude-opus-4-8', {
      capabilities: caps('claude-opus-4-8'),
      env: {},
      client: mockClient(textEvents),
    });
    const ev = await collect(p.generate(reqGen()));
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
  });

  test('request body: model, max_tokens, stream, no seed or metadata', async () => {
    const { body } = await capture('claude-sonnet-4-6', { stop_sequences: ['END'] });
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(4_096);
    expect(body.stream).toBe(true);
    expect(body.stop_sequences).toEqual(['END']);
    expect('seed' in body).toBe(false);
    expect('metadata' in body).toBe(false);
  });

  test('a string system prompt is cached along with the last tool and the conversation tail', async () => {
    const { body } = await capture('claude-opus-4-8', {
      system: 'you are an agent',
      tools: TOOLS,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    });
    expect(body.system).toEqual([
      { type: 'text', text: 'you are an agent', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0].content).toBe('first');
    expect(body.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(cacheControls(body)).toHaveLength(3);
  });

  test('a text block flagged as a stable prefix gets its own breakpoint, sent without the flag', async () => {
    const { body } = await capture('claude-opus-4-8', {
      system: 'you are an agent',
      tools: TOOLS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'project context', cacheBreakpoint: true },
            { type: 'text', text: 'first' },
          ],
        },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    });
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'project context', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'first' },
    ]);
    expect(cacheControls(body)).toHaveLength(4);
  });

  test('a flagged block is not marked when the request would exceed the breakpoint limit', async () => {
    const { body } = await capture('claude-opus-4-8', {
      systemSegments: [
        { id: 'a', text: 'rules', cacheBreakpoint: true },
        { id: 'b', text: 'more rules', cacheBreakpoint: true },
      ],
      system: 'rules\n\nmore rules',
      tools: TOOLS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'project context', cacheBreakpoint: true },
            { type: 'text', text: 'first' },
          ],
        },
      ],
    });
    expect(body.messages[0].content[0]).toEqual({ type: 'text', text: 'project context' });
    expect(cacheControls(body)).toHaveLength(4);
  });

  test('NULLRIVET_ANTHROPIC_CACHE_TTL=1h tags every breakpoint with the 1h TTL', async () => {
    const { body } = await capture(
      'claude-opus-4-8',
      { system: 'sys', tools: TOOLS },
      { env: { NULLRIVET_ANTHROPIC_CACHE_TTL: '1h' } },
    );
    const markers = cacheControls(body);
    expect(markers).toHaveLength(3);
    for (const m of markers) expect(m).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('any other TTL value keeps the 5-minute default', async () => {
    const { body } = await capture(
      'claude-opus-4-8',
      { system: 'sys' },
      { env: { NULLRIVET_ANTHROPIC_CACHE_TTL: '1H' } },
    );
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('system segments flagged as breakpoints are cached individually', async () => {
    const { body } = await capture('claude-opus-4-8', {
      system: 'stable\n\nvolatile',
      systemSegments: [
        { id: 'stable', text: 'stable', cacheBreakpoint: true },
        { id: 'volatile', text: 'volatile' },
      ],
    });
    expect(body.system).toEqual([
      { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'volatile' },
    ]);
  });

  test('more than four breakpoints are rejected before the request is sent', async () => {
    const segments = ['a', 'b', 'c'].map((id) => ({ id, text: id, cacheBreakpoint: true }));
    await expect(
      capture('claude-opus-4-8', { systemSegments: segments, tools: TOOLS }),
    ).rejects.toThrow(/at most 4/);
  });

  test('tool_result blocks lose the name field Anthropic rejects', async () => {
    const { body } = await capture('claude-opus-4-8', {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', name: 'grep', content: 'x', is_error: true },
          ],
        },
      ],
    });
    expect(body.messages[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'x',
      is_error: true,
      cache_control: { type: 'ephemeral' },
    });
  });

  test('passes the abort signal to the SDK request options', async () => {
    const ctrl = new AbortController();
    const { options } = await capture('claude-opus-4-8', {}, {}, ctrl.signal);
    expect(options?.signal).toBe(ctrl.signal);
  });
});

describe('Anthropic thinking and effort', () => {
  test('an adaptive model thinks adaptively by default, including on tool turns', async () => {
    const { body } = await capture('claude-opus-4-8', { tools: TOOLS });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect('output_config' in body).toBe(false);
  });

  test('effort rides output_config; xhigh is kept where supported and clamped elsewhere', async () => {
    expect((await capture('claude-opus-4-8', { effort: 'xhigh' })).body.output_config).toEqual({
      effort: 'xhigh',
    });
    expect((await capture('claude-sonnet-4-6', { effort: 'xhigh' })).body.output_config).toEqual({
      effort: 'high',
    });
    expect((await capture('claude-sonnet-4-6', { effort: 'max' })).body.output_config).toEqual({
      effort: 'max',
    });
  });

  test('NULLRIVET_ANTHROPIC_THINKING=0 turns adaptive thinking off and keeps sampling', async () => {
    const { body } = await capture(
      'claude-sonnet-4-6',
      { effort: 'high', temperature: 0.2 },
      { env: { NULLRIVET_ANTHROPIC_THINKING: '0' } },
    );
    expect('thinking' in body).toBe(false);
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.temperature).toBe(0.2);
  });

  test('a pinned temperature keeps adaptive thinking off', async () => {
    const { body } = await capture('claude-sonnet-4-6', { temperature: 0 });
    expect('thinking' in body).toBe(false);
    expect(body.temperature).toBe(0);
  });

  test('only temperature is sent when both sampling parameters are set', async () => {
    const { body } = await capture(
      'claude-sonnet-4-6',
      { temperature: 0.2, top_p: 0.9 },
      { env: { NULLRIVET_ANTHROPIC_THINKING: '0' } },
    );
    expect(body.temperature).toBe(0.2);
    expect('top_p' in body).toBe(false);
  });

  test('sampling is stripped on models that reject it', async () => {
    const { body } = await capture(
      'claude-opus-4-8',
      { temperature: 0.2, top_p: 0.9 },
      { env: { NULLRIVET_ANTHROPIC_THINKING: '0' } },
    );
    expect('temperature' in body).toBe(false);
    expect('top_p' in body).toBe(false);
  });

  test('a manual-budget model thinks only when an effort is requested', async () => {
    expect('thinking' in (await capture('claude-haiku-4-5')).body).toBe(false);
    const { body } = await capture('claude-haiku-4-5', { effort: 'medium', max_tokens: 16_000 });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8_192 });
    expect('output_config' in body).toBe(false);
  });

  test('the derived budget stays below max_tokens and is omitted under the API minimum', async () => {
    const clamped = await capture('claude-haiku-4-5', { effort: 'max', max_tokens: 4_096 });
    expect(clamped.body.thinking).toEqual({ type: 'enabled', budget_tokens: 4_095 });
    const tooSmall = await capture('claude-haiku-4-5', { effort: 'max', max_tokens: 1_000 });
    expect('thinking' in tooSmall.body).toBe(false);
  });

  test('a manual-budget model does not think on tool turns, where it cannot replay', async () => {
    const { body } = await capture('claude-haiku-4-5', { effort: 'high', tools: TOOLS });
    expect('thinking' in body).toBe(false);
  });

  test('an adaptive model without replay does not think on tool turns', async () => {
    const { body } = await capture(
      'claude-opus-4-8',
      { tools: TOOLS },
      { env: { NULLRIVET_ANTHROPIC_REASONING_REPLAY: '0' } },
    );
    expect('thinking' in body).toBe(false);
  });
});

describe('Anthropic reasoning replay', () => {
  const assistantTurn: ProviderMessage = {
    role: 'assistant',
    content: [
      { type: 'reasoning', provider: 'anthropic', data: { thinking: 'plan', signature: 'SIG' } },
      { type: 'reasoning', provider: 'anthropic', data: { redacted_thinking: 'OPAQUE' } },
      { type: 'reasoning', provider: 'openai', data: { encrypted_content: 'x' } },
      { type: 'reasoning', provider: 'anthropic', data: { thinking: 'unsigned', signature: '' } },
      { type: 'tool_use', id: 't1', name: 'grep', input: {} },
    ],
  };
  const followUp: ProviderMessage = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
  };

  test('signed and redacted thinking replay in place; foreign and unsigned blocks are dropped', async () => {
    const { body } = await capture('claude-opus-4-8', { messages: [assistantTurn, followUp] });
    expect(body.messages[0].content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'SIG' },
      { type: 'redacted_thinking', data: 'OPAQUE' },
      { type: 'tool_use', id: 't1', name: 'grep', input: {} },
    ]);
  });

  test('replay is on by default for adaptive models and off for manual-budget models', () => {
    const make = (model: string, env: Record<string, string> = {}) =>
      createAnthropicProvider(model, { capabilities: caps(model), env, client: mockClient([]) });
    expect(make('claude-opus-4-8').replaysReasoning).toBe(true);
    expect(make('claude-haiku-4-5').replaysReasoning).toBe(false);
    expect(
      make('claude-opus-4-8', { NULLRIVET_ANTHROPIC_REASONING_REPLAY: 'off' }).replaysReasoning,
    ).toBe(false);
  });

  test('NULLRIVET_ANTHROPIC_REASONING_REPLAY=0 drops every reasoning block', async () => {
    const { body } = await capture(
      'claude-opus-4-8',
      { messages: [assistantTurn, followUp] },
      { env: { NULLRIVET_ANTHROPIC_REASONING_REPLAY: '0' } },
    );
    expect(body.messages[0].content).toEqual([
      { type: 'tool_use', id: 't1', name: 'grep', input: {} },
    ]);
  });
});

// These tests drive the real SDK client through an injected fetch, so they cover headers, retries
// and cancellation of the HTTP request itself.
describe('createAnthropicProvider over the SDK transport', () => {
  const sse = (events: RawAnthropicEvent[]): string =>
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

  const sseResponse = (body: string | ReadableStream<Uint8Array>): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const providerWithFetch = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) =>
    createAnthropicProvider('claude-opus-4-8', {
      capabilities: caps('claude-opus-4-8'),
      apiKey: 'sk-ant-test',
      baseURL: DEFAULT_ANTHROPIC_BASE_URL,
      env: {},
      fetch: fetchImpl as unknown as CreateAnthropicProviderOptions['fetch'],
    });

  const req = reqGen();

  const caught = async (it: AsyncIterable<StreamEvent>): Promise<unknown> => {
    try {
      await collect(it);
    } catch (e) {
      return e;
    }
    return undefined;
  };

  test('sends the request with the API key and no other credential', async () => {
    const saved = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-private';
    try {
      const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
      const p = providerWithFetch(async (url, init) => {
        calls.push({ url, init });
        return sseResponse(sse(textEvents));
      });
      const ev = await collect(p.generate(req));
      expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(`${DEFAULT_ANTHROPIC_BASE_URL}/v1/messages`);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get('x-api-key')).toBe('sk-ant-test');
      expect(headers.has('authorization')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = saved;
    }
  });

  test('the SDK does not retry, so generateWithRetry owns every attempt', async () => {
    let fetchCalls = 0;
    const p = providerWithFetch(async () => {
      fetchCalls += 1;
      return jsonResponse(529, {
        type: 'error',
        error: { type: 'overloaded_error', message: 'x' },
      });
    });
    expect(await caught(p.generate(req))).toMatchObject({ status: 529 });
    expect(fetchCalls).toBe(1);

    fetchCalls = 0;
    await expect(
      collect(
        generateWithRetry(p, req, undefined, {
          maxAttempts: 3,
          baseDelayMs: 1,
          sleep: () => Promise.resolve(),
        }),
      ),
    ).rejects.toMatchObject({ status: 529 });
    expect(fetchCalls).toBe(3);
  });

  test('a pre-aborted signal throws AbortError without sending a request', async () => {
    let fetchCalls = 0;
    const p = providerWithFetch(async () => {
      fetchCalls += 1;
      return sseResponse(sse(textEvents));
    });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await caught(p.generate(req, ctrl.signal))).toBeInstanceOf(AbortError);
    expect(fetchCalls).toBe(0);
  });

  test('aborting mid-stream cancels the HTTP request and reports no clean stop', async () => {
    const encoder = new TextEncoder();
    let fetchSignal: AbortSignal | undefined;
    const p = providerWithFetch(async (_url, init) => {
      fetchSignal = init?.signal ?? undefined;
      const signal = fetchSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sse(textEvents.slice(0, 3))));
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return sseResponse(body);
    });
    const ctrl = new AbortController();
    const events: StreamEvent[] = [];
    let error: unknown;
    try {
      for await (const ev of p.generate(req, ctrl.signal)) {
        events.push(ev);
        if (ev.kind === 'text_delta') ctrl.abort();
      }
    } catch (e) {
      error = e;
    }
    expect(fetchSignal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(AbortError);
    expect(events.some((e) => e.kind === 'stop')).toBe(false);
  });

  test('a connection failure is a retryable ProviderRequestError', async () => {
    const p = providerWithFetch(async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const error = await caught(p.generate(req));
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(isRetryableError(error)).toBe(true);
  });

  test('a prompt-too-long 400 is a ContextOverflowError', async () => {
    const p = providerWithFetch(async () =>
      jsonResponse(400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 215000 tokens > 200000 maximum',
        },
      }),
    );
    const error = await caught(p.generate(req));
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(isRetryableError(error)).toBe(false);
  });

  test('a 400 rejecting replayed thinking is a StaleReasoningError', async () => {
    const p = providerWithFetch(async () =>
      jsonResponse(400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
        },
      }),
    );
    const error = await caught(p.generate(req));
    expect(error).toBeInstanceOf(StaleReasoningError);
    expect(isRetryableError(error)).toBe(false);
  });

  test('an unrelated 400 is left to the caller unchanged', async () => {
    const p = providerWithFetch(async () =>
      jsonResponse(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'temperature: range is 0 to 1' },
      }),
    );
    const error = await caught(p.generate(req));
    expect(error).not.toBeInstanceOf(ContextOverflowError);
    expect(error).toMatchObject({ status: 400 });
  });

  test('an error event inside the stream becomes an error event with usage', async () => {
    const p = providerWithFetch(async () =>
      sseResponse(
        `${sse(textEvents.slice(0, 1))}event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        })}\n\n`,
      ),
    );
    const ev = await collect(p.generate(req));
    expect(ev).toEqual([
      { kind: 'start', message_id: 'msg_1' },
      { kind: 'error', code: 'anthropic.stream_error', message: 'Overloaded', retryable: true },
      { kind: 'usage', usage: { input: 5, output: 0, cache_read: 0, cache_creation: 0 } },
    ]);
  });

  test('an overflow inside the stream becomes a context_overflow event', async () => {
    const p = providerWithFetch(async () =>
      sseResponse(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'prompt is too long: 3 > 2' },
        })}\n\n`,
      ),
    );
    const ev = await collect(p.generate(req));
    expect(ev).toEqual([
      {
        kind: 'error',
        code: CONTEXT_OVERFLOW,
        message: 'prompt is too long: 3 > 2',
        retryable: false,
      },
    ]);
  });
});
