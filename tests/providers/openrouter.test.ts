import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { AbortError } from '../../src/agent/abortable.ts';
import { generateWithRetry, isRetryableError } from '../../src/agent/retry.ts';
import { ProviderRequestError } from '../../src/providers/errors.ts';
import { OPENROUTER_CAPS } from '../../src/providers/openrouter/capabilities.ts';
import {
  type CreateOpenRouterProviderOptions,
  createOpenRouterProvider,
} from '../../src/providers/openrouter/index.ts';
import { toOpenRouterMessages } from '../../src/providers/openrouter/messages.ts';
import type { RawORChunk } from '../../src/providers/openrouter/stream.ts';
import type {
  GenerateRequest,
  ProviderCapabilities,
  ProviderMessage,
  StreamEvent,
} from '../../src/providers/types.ts';

// biome-ignore lint/suspicious/noExplicitAny: the captured request body is dynamic.
type Body = Record<string, any>;

interface Captured {
  body: Body;
  options: { signal?: AbortSignal | null | undefined } | undefined;
}

// Mock SDK client: records the request body and request options, and streams the given chunks.
const makeClient = (chunks: RawORChunk[], captured?: Captured): OpenAI =>
  ({
    chat: {
      completions: {
        create: async (body: Body, options?: Captured['options']) => {
          if (captured !== undefined) {
            captured.body = body;
            captured.options = options;
          }
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  }) as unknown as OpenAI;

const caps = (model: string): ProviderCapabilities => {
  const c = OPENROUTER_CAPS[model];
  if (c === undefined) throw new Error(`test setup: ${model} is not in OPENROUTER_CAPS`);
  return c;
};

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const reqGen = (over: Partial<GenerateRequest>): GenerateRequest => ({
  model: 'deepseek/deepseek-v4-flash',
  messages: [],
  max_tokens: 512,
  ...over,
});

const textChunks: RawORChunk[] = [
  { id: 'm1', choices: [{ delta: { content: 'hi' } }] },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  },
];

// Runs one generate call against a mock client and returns the captured request.
const capture = async (
  model: string,
  req: Partial<GenerateRequest>,
  options: Partial<CreateOpenRouterProviderOptions> = {},
  signal?: AbortSignal,
): Promise<Captured> => {
  const captured: Captured = { body: {}, options: undefined };
  const p = createOpenRouterProvider(model, {
    capabilities: caps(model),
    env: {},
    client: makeClient(textChunks, captured),
    ...options,
  });
  await collect(p.generate(reqGen(req), signal));
  return captured;
};

describe('toOpenRouterMessages text blocks', () => {
  test('separate text blocks of one message do not run together', () => {
    const out = toOpenRouterMessages(
      reqGen({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'fix the bug' },
              { type: 'text', text: 'also add tests' },
            ],
          },
        ],
      }),
      false,
      false,
    );
    expect(out.at(-1)).toEqual({ role: 'user', content: 'fix the bug\n\nalso add tests' });
  });
});

describe('createOpenRouterProvider', () => {
  test('throws without an api key or client', () => {
    expect(() =>
      createOpenRouterProvider('deepseek/deepseek-v4-flash', {
        capabilities: caps('deepseek/deepseek-v4-flash'),
      }),
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  test('id carries two slashes and exposes the given capabilities', () => {
    const capabilities = caps('deepseek/deepseek-v4-flash');
    const p = createOpenRouterProvider('deepseek/deepseek-v4-flash', {
      capabilities,
      env: {},
      client: makeClient([]),
    });
    expect(p.id).toBe('openrouter/deepseek/deepseek-v4-flash');
    expect(p.family).toBe('openrouter');
    expect(p.capabilities).toEqual(capabilities);
  });

  test('request body: stream, max_tokens, transforms, reasoning effort, usage include', async () => {
    const { body } = await capture('x-ai/grok-4.5', {
      effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.model).toBe('x-ai/grok-4.5');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(512);
    expect(body.transforms).toEqual([]);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.usage).toEqual({ include: true });
    expect('stream_options' in body).toBe(false);
    expect('max_completion_tokens' in body).toBe(false);
    expect('seed' in body).toBe(false);
    expect('metadata' in body).toBe(false);
  });

  test('streams normalized events', async () => {
    const p = createOpenRouterProvider('x-ai/grok-4.5', {
      capabilities: caps('x-ai/grok-4.5'),
      env: {},
      client: makeClient(textChunks),
    });
    const ev = await collect(p.generate(reqGen({ messages: [{ role: 'user', content: 'hi' }] })));
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
  });

  test('max effort maps to xhigh', async () => {
    const { body } = await capture('x-ai/grok-4.5', {
      effort: 'max',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
  });

  test('reasoning is omitted when no effort is requested', async () => {
    const { body } = await capture('x-ai/grok-4.5', { messages: [{ role: 'user', content: 'x' }] });
    expect('reasoning' in body).toBe(false);
  });

  test('reasoning is omitted on a non-reasoning model even with effort', async () => {
    const { body } = await capture(
      'deepseek/deepseek-v4-flash',
      { effort: 'high', messages: [{ role: 'user', content: 'x' }] },
      { capabilities: { context_window: 131_072, output_max_tokens: 16_384 } },
    );
    expect('reasoning' in body).toBe(false);
  });

  test('a reasoning model without effort levels is switched on with reasoning.enabled', async () => {
    const { body } = await capture('minimax/minimax-m3', {
      effort: 'high',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(body.reasoning).toEqual({ enabled: true });
  });

  test('a reasoning-only assistant turn is dropped', async () => {
    const { body } = await capture('deepseek/deepseek-v4-flash', {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'reasoning', provider: 'openrouter', data: [{ text: 'r' }] }],
        },
      ],
    });
    expect((body.messages as Body[]).find((m) => m.role === 'assistant')).toBeUndefined();
  });

  test('forwards tools in the OpenAI shape', async () => {
    const { body } = await capture('deepseek/deepseek-v4-flash', {
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object' } },
      },
    ]);
  });

  test('forwards sampling and stop sequences when the model accepts sampling', async () => {
    const { body } = await capture('deepseek/deepseek-v4-flash', {
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ['END'],
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(['END']);
  });

  test('drops sampling when the model rejects it', async () => {
    const { body } = await capture(
      'deepseek/deepseek-v4-flash',
      { temperature: 0.2, top_p: 0.9, messages: [{ role: 'user', content: 'x' }] },
      { capabilities: { context_window: 1000, output_max_tokens: 100, supports_sampling: false } },
    );
    expect('temperature' in body).toBe(false);
    expect('top_p' in body).toBe(false);
  });

  test('explicit-cache model sends system blocks with cache_control on breakpoints', async () => {
    const { body } = await capture('qwen/qwen3.6-plus', {
      system: 'stable\n\nmem',
      systemSegments: [
        { id: 'stable', text: 'stable', cacheBreakpoint: true },
        { id: 'memory', text: 'mem', cacheBreakpoint: true },
      ],
      messages: [{ role: 'user', content: 'x' }],
    });
    const sys = (body.messages as Body[])[0];
    expect(sys).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: 'stable\n\n', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'mem', cache_control: { type: 'ephemeral' } },
      ],
    });
    // Concatenated block texts reproduce the canonical system string.
    const blocks = (sys?.content ?? []) as Array<{ text: string }>;
    expect(blocks.map((b) => b.text).join('')).toBe('stable\n\nmem');
  });

  test('a model without explicit caching keeps a flat system string', async () => {
    const { body } = await capture('deepseek/deepseek-v4-flash', {
      system: 'sys',
      systemSegments: [{ id: 'stable', text: 'sys', cacheBreakpoint: true }],
      messages: [{ role: 'user', content: 'x' }],
    });
    expect((body.messages as Body[])[0]).toEqual({ role: 'system', content: 'sys' });
  });

  test('tool results become tool messages ahead of user text, with errors flagged', async () => {
    const { body } = await capture('deepseek/deepseek-v4-flash', {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { p: 1 } }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'next' },
            { type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true },
          ],
        },
      ],
    });
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '[tool error] boom' },
      { role: 'user', content: 'next' },
    ]);
  });

  test('reasoning_details replay round-trips onto the assistant message', async () => {
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking done' },
          {
            type: 'reasoning',
            provider: 'openrouter',
            data: { reasoning_details: [{ type: 'reasoning.text', text: 'r' }] },
          },
        ],
      },
    ];
    const { body } = await capture('deepseek/deepseek-v4-flash', { messages });
    const assistant = (body.messages as Body[]).find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'r' }]);
  });

  test('plaintext reasoning replays through the assistant `reasoning` field', async () => {
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'reasoning', provider: 'openrouter', data: { reasoning: 'plain thoughts' } },
        ],
      },
    ];
    const { body } = await capture('deepseek/deepseek-v4-flash', { messages });
    const assistant = (body.messages as Body[]).find((m) => m.role === 'assistant');
    expect(assistant?.reasoning).toBe('plain thoughts');
    expect('reasoning_details' in (assistant ?? {})).toBe(false);
  });

  test('reasoning from another provider is not replayed', async () => {
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'reasoning', provider: 'anthropic', data: { reasoning: 'foreign' } },
        ],
      },
    ];
    const { body } = await capture('deepseek/deepseek-v4-flash', { messages });
    const assistant = (body.messages as Body[]).find((m) => m.role === 'assistant');
    expect(assistant).toEqual({ role: 'assistant', content: 'answer' });
  });

  test('NULLRIVET_OPENROUTER_REASONING_REPLAY=0 disables replay', async () => {
    const captured: Captured = { body: {}, options: undefined };
    const p = createOpenRouterProvider('deepseek/deepseek-v4-flash', {
      capabilities: caps('deepseek/deepseek-v4-flash'),
      env: { NULLRIVET_OPENROUTER_REASONING_REPLAY: '0' },
      client: makeClient(textChunks, captured),
    });
    expect(p.replaysReasoning).toBe(false);
    await collect(
      p.generate(
        reqGen({
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'x' },
                { type: 'reasoning', provider: 'openrouter', data: { reasoning: 'r' } },
              ],
            },
          ],
        }),
      ),
    );
    const assistant = (captured.body.messages as Body[]).find((m) => m.role === 'assistant');
    expect('reasoning_details' in (assistant ?? {})).toBe(false);
    expect('reasoning' in (assistant ?? {})).toBe(false);
  });

  test('replay is on by default for reasoning models and off for others', () => {
    const reasoning = createOpenRouterProvider('minimax/minimax-m3', {
      capabilities: caps('minimax/minimax-m3'),
      env: {},
      client: makeClient([]),
    });
    const plain = createOpenRouterProvider('vendor/plain', {
      capabilities: { context_window: 1000, output_max_tokens: 100 },
      env: {},
      client: makeClient([]),
    });
    expect(reasoning.replaysReasoning).toBe(true);
    expect(plain.replaysReasoning).toBe(false);
  });

  test('passes the abort signal to the SDK request options', async () => {
    const ctrl = new AbortController();
    const { options } = await capture(
      'deepseek/deepseek-v4-flash',
      { messages: [{ role: 'user', content: 'x' }] },
      {},
      ctrl.signal,
    );
    expect(options?.signal).toBe(ctrl.signal);
  });
});

// These tests drive the real SDK client through an injected fetch, so they cover what the mock
// client cannot: headers, retries and cancellation of the HTTP request itself.
describe('createOpenRouterProvider over the SDK transport', () => {
  interface FetchCall {
    url: string;
    init: RequestInit | undefined;
  }

  const sse = (chunks: RawORChunk[]): string =>
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

  const sseResponse = (body: string | ReadableStream<Uint8Array>): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  const providerWithFetch = (
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
    env: Record<string, string> = {},
  ) =>
    createOpenRouterProvider('deepseek/deepseek-v4-flash', {
      capabilities: caps('deepseek/deepseek-v4-flash'),
      apiKey: 'sk-test',
      baseURL: 'https://openrouter.test/api/v1',
      env,
      fetch: fetchImpl as unknown as CreateOpenRouterProviderOptions['fetch'],
    });

  const req = reqGen({ messages: [{ role: 'user', content: 'hi' }] });

  test('sends the request to the base URL with key and attribution headers only', async () => {
    const calls: FetchCall[] = [];
    const p = providerWithFetch(async (url, init) => {
      calls.push({ url, init });
      return sseResponse(sse(textChunks));
    });
    const ev = await collect(p.generate(req));
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://openrouter.test/api/v1/chat/completions');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-test');
    expect(headers.get('x-title')).toBe('nullrivet');
    expect(headers.has('http-referer')).toBe(false);
  });

  test('OpenAI account variables from the environment are not sent to OpenRouter', async () => {
    const saved = { org: process.env.OPENAI_ORG_ID, project: process.env.OPENAI_PROJECT_ID };
    process.env.OPENAI_ORG_ID = 'org-private';
    process.env.OPENAI_PROJECT_ID = 'proj-private';
    try {
      const calls: FetchCall[] = [];
      const p = providerWithFetch(async (url, init) => {
        calls.push({ url, init });
        return sseResponse(sse(textChunks));
      });
      await collect(p.generate(req));
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.has('openai-organization')).toBe(false);
      expect(headers.has('openai-project')).toBe(false);
    } finally {
      if (saved.org === undefined) delete process.env.OPENAI_ORG_ID;
      else process.env.OPENAI_ORG_ID = saved.org;
      if (saved.project === undefined) delete process.env.OPENAI_PROJECT_ID;
      else process.env.OPENAI_PROJECT_ID = saved.project;
    }
  });

  test('attribution headers come only from explicit configuration', async () => {
    const calls: FetchCall[] = [];
    const p = providerWithFetch(
      async (url, init) => {
        calls.push({ url, init });
        return sseResponse(sse(textChunks));
      },
      { NULLRIVET_OPENROUTER_TITLE: 'my-title', NULLRIVET_OPENROUTER_REFERER: 'https://x.test' },
    );
    await collect(p.generate(req));
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('x-title')).toBe('my-title');
    expect(headers.get('http-referer')).toBe('https://x.test');
  });

  test('the SDK does not retry, so generateWithRetry owns every attempt', async () => {
    let fetchCalls = 0;
    const p = providerWithFetch(async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'upstream down' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });
    let caught: unknown;
    try {
      await collect(p.generate(req));
    } catch (e) {
      caught = e;
    }
    expect((caught as { status?: unknown }).status).toBe(503);
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
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchCalls).toBe(3);
  });

  test('a pre-aborted signal throws AbortError without sending a request', async () => {
    let fetchCalls = 0;
    const p = providerWithFetch(async () => {
      fetchCalls += 1;
      return sseResponse(sse(textChunks));
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(collect(p.generate(req, ctrl.signal))).rejects.toBeInstanceOf(AbortError);
    expect(fetchCalls).toBe(0);
  });

  test('aborting mid-stream cancels the HTTP request and reports no clean stop', async () => {
    const encoder = new TextEncoder();
    let fetchSignal: AbortSignal | undefined;
    const p = providerWithFetch(async (_url, init) => {
      fetchSignal = init?.signal ?? undefined;
      const signal = fetchSignal;
      // Emits one chunk, then stays open until the request is aborted, as a real body would.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id: 'm1', choices: [{ delta: { content: 'par' } }] })}\n\n`,
            ),
          );
          signal?.addEventListener('abort', () => controller.error(signal.reason), {
            once: true,
          });
        },
      });
      return sseResponse(body);
    });

    const ctrl = new AbortController();
    const events: StreamEvent[] = [];
    let caught: unknown;
    try {
      for await (const ev of p.generate(req, ctrl.signal)) {
        events.push(ev);
        if (ev.kind === 'text_delta') ctrl.abort();
      }
    } catch (e) {
      caught = e;
    }
    expect(fetchSignal?.aborted).toBe(true);
    expect(caught).toBeInstanceOf(AbortError);
    expect(events.map((e) => e.kind)).toEqual(['start', 'text_delta']);
  });
  test('an error reported inside the stream becomes a retryable error event', async () => {
    const p = providerWithFetch(async () =>
      sseResponse(
        sse([
          { id: 'm1', choices: [{ delta: { content: '' } }] },
          { error: { code: 502, message: 'upstream provider failed' } },
        ]),
      ),
    );
    const ev = await collect(p.generate(req));
    const error = ev.find((e) => e.kind === 'error');
    expect(error).toMatchObject({ kind: 'error', retryable: true });
    expect(ev.some((e) => e.kind === 'stop')).toBe(false);
  });

  test('a connection failure is classified as retryable', async () => {
    const p = providerWithFetch(async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    let caught: unknown;
    try {
      await collect(p.generate(req));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect(isRetryableError(caught)).toBe(true);
  });
});
