import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { AbortError } from '../../src/agent/abortable.ts';
import { generateWithRetry, isRetryableError } from '../../src/agent/retry.ts';
import {
  CONTEXT_OVERFLOW,
  ContextOverflowError,
  ProviderRequestError,
} from '../../src/providers/errors.ts';
import { openaiPromptCacheKey } from '../../src/providers/openai/index.ts';
import type {
  GenerateRequest,
  ProviderCapabilities,
  StreamEvent,
} from '../../src/providers/types.ts';
import { XAI_CAPS } from '../../src/providers/xai/capabilities.ts';
import {
  type CreateXaiProviderOptions,
  createXaiProvider,
  DEFAULT_XAI_BASE_URL,
} from '../../src/providers/xai/index.ts';
import type { RawXaiChunk } from '../../src/providers/xai/stream.ts';

// biome-ignore lint/suspicious/noExplicitAny: the captured request body is dynamic.
type Body = Record<string, any>;

interface Captured {
  body: Body;
  options:
    | { signal?: AbortSignal | null | undefined; headers?: Record<string, string> }
    | undefined;
}

const textChunks: RawXaiChunk[] = [
  { id: 'x1', choices: [{ delta: { content: 'hi' } }] },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  },
];

const makeClient = (chunks: RawXaiChunk[], captured?: Captured): OpenAI =>
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
  const c = XAI_CAPS[model];
  if (c === undefined) throw new Error(`test setup: ${model} is not in XAI_CAPS`);
  return c;
};

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const caught = async (it: AsyncIterable<StreamEvent>): Promise<unknown> => {
  try {
    await collect(it);
  } catch (e) {
    return e;
  }
  return undefined;
};

const reqGen = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: 'grok-4.5',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 512,
  ...over,
});

const capture = async (
  model: string,
  req: Partial<GenerateRequest>,
  options: Partial<CreateXaiProviderOptions> = {},
): Promise<Captured> => {
  const captured: Captured = { body: {}, options: undefined };
  const p = createXaiProvider(model, {
    capabilities: caps(model),
    client: makeClient(textChunks, captured),
    ...options,
  });
  await collect(p.generate(reqGen(req)));
  return captured;
};

describe('createXaiProvider', () => {
  test('throws without an api key or client', () => {
    expect(() => createXaiProvider('grok-4.5', { capabilities: caps('grok-4.5') })).toThrow(
      /XAI_API_KEY/,
    );
  });

  test('exposes the id, family and given capabilities, and does not replay reasoning', () => {
    const p = createXaiProvider('grok-4.5', {
      capabilities: caps('grok-4.5'),
      client: makeClient([]),
    });
    expect(p.id).toBe('xai/grok-4.5');
    expect(p.family).toBe('xai');
    expect(p.capabilities).toEqual(caps('grok-4.5'));
    expect(p.replaysReasoning).toBe(false);
  });

  test('request body: flat system message, stream, output cap, usage and tools', async () => {
    const tools = [{ name: 't', description: 'd', input_schema: { type: 'object' as const } }];
    const { body } = await capture('grok-4.5', {
      systemSegments: [
        { id: 'a', text: 'one', cacheBreakpoint: true },
        { id: 'b', text: 'two' },
      ],
      system: 'one\n\ntwo',
      tools,
    });
    expect(body).toEqual({
      model: 'grok-4.5',
      messages: [
        { role: 'system', content: 'one\n\ntwo' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      max_completion_tokens: 512,
      stream_options: { include_usage: true },
      tools: [
        {
          type: 'function',
          function: { name: 't', description: 'd', parameters: { type: 'object' } },
        },
      ],
    });
  });

  test('streams normalized events', async () => {
    const p = createXaiProvider('grok-4.5', {
      capabilities: caps('grok-4.5'),
      client: makeClient(textChunks),
    });
    expect(await collect(p.generate(reqGen()))).toEqual([
      { kind: 'start', message_id: 'x1' },
      { kind: 'text_delta', text: 'hi' },
      { kind: 'usage', usage: { input: 5, output: 2, cache_read: 0, cache_creation: 0 } },
      { kind: 'stop', reason: 'end_turn' },
    ]);
  });

  test('effort maps to reasoning_effort, with xhigh where the model accepts it', async () => {
    for (const [model, effort, expected] of [
      ['grok-4.5', 'low', 'low'],
      ['grok-4.5', 'xhigh', 'xhigh'],
      ['grok-4.5', 'max', 'xhigh'],
      ['grok-4.3', 'medium', 'medium'],
    ] as const) {
      const { body } = await capture(model, { effort });
      expect(body.reasoning_effort).toBe(expected);
    }
  });

  test('xhigh is clamped to high on a model that does not accept it', async () => {
    const { body } = await capture(
      'grok-4.5',
      { effort: 'xhigh' },
      {
        capabilities: { ...caps('grok-4.5'), supports_effort_xhigh: false },
      },
    );
    expect(body.reasoning_effort).toBe('high');
  });

  test('no reasoning_effort without effort or on models without effort levels', async () => {
    expect((await capture('grok-4.5', {})).body).not.toHaveProperty('reasoning_effort');
    for (const model of ['grok-build-0.1', 'grok-4.20-0309-non-reasoning']) {
      const { body } = await capture(model, { effort: 'high' });
      expect(body).not.toHaveProperty('reasoning_effort');
    }
  });

  test('stop sequences are sent only to non-reasoning models, which alone accept them', async () => {
    for (const model of ['grok-4.5', 'grok-4.3', 'grok-build-0.1', 'grok-4.20-0309-reasoning']) {
      const { body } = await capture(model, { stop_sequences: ['END'] });
      expect(body).not.toHaveProperty('stop');
    }
    const { body } = await capture('grok-4.20-0309-non-reasoning', { stop_sequences: ['END'] });
    expect(body.stop).toEqual(['END']);
  });

  test('sampling is forwarded unless the model rejects it', async () => {
    const { body } = await capture('grok-4.5', { temperature: 0, top_p: 0.9 });
    expect(body.temperature).toBe(0);
    expect(body.top_p).toBe(0.9);
    const off = await capture(
      'grok-4.5',
      { temperature: 0, top_p: 0.9 },
      { capabilities: { ...caps('grok-4.5'), supports_sampling: false } },
    );
    expect(off.body).not.toHaveProperty('temperature');
    expect(off.body).not.toHaveProperty('top_p');
  });

  test('tool results become tool messages, errors are flagged, reasoning is dropped', async () => {
    const { body } = await capture('grok-4.5', {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', provider: 'google', data: { thoughtSignature: 'sig' } },
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'c1', name: 'glob', input: { pattern: '*.ts' } },
            { type: 'tool_use', id: 'c2', name: 'read_file', input: { path: 'a' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', name: 'glob', content: 'a.ts' },
            { type: 'tool_result', tool_use_id: 'c2', content: 'missing', is_error: true },
          ],
        },
      ],
    });
    expect(body.messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'glob', arguments: '{"pattern":"*.ts"}' },
          },
          {
            id: 'c2',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.ts' },
      { role: 'tool', tool_call_id: 'c2', content: '[tool error] missing' },
    ]);
  });

  test('the conversation routing header is keyed on the stable prefix', async () => {
    const req = { system: 'sys', tools: [] };
    const { options } = await capture('grok-4.5', req, { baseURL: DEFAULT_XAI_BASE_URL });
    expect(options?.headers).toEqual({ 'x-grok-conv-id': openaiPromptCacheKey(reqGen(req)) });
  });

  test('the routing header is not sent to another endpoint', async () => {
    const { options } = await capture('grok-4.5', {}, { baseURL: 'https://proxy.example/v1' });
    expect(options?.headers).toBeUndefined();
  });

  test('passes the abort signal to the SDK request options', async () => {
    const captured: Captured = { body: {}, options: undefined };
    const p = createXaiProvider('grok-4.5', {
      capabilities: caps('grok-4.5'),
      client: makeClient(textChunks, captured),
    });
    const ctrl = new AbortController();
    await collect(p.generate(reqGen(), ctrl.signal));
    expect(captured.options?.signal).toBe(ctrl.signal);
  });
});

describe('createXaiProvider over the SDK transport', () => {
  interface FetchCall {
    url: string;
    init: RequestInit | undefined;
  }

  const sse = (chunks: unknown[]): string =>
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

  const sseResponse = (body: string | ReadableStream<Uint8Array>): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  const providerWithFetch = (
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
    baseURL = 'https://xai.test/v1',
  ) =>
    createXaiProvider('grok-4.5', {
      capabilities: caps('grok-4.5'),
      apiKey: 'xai-test',
      baseURL,
      fetch: fetchImpl as unknown as CreateXaiProviderOptions['fetch'],
    });

  // xAI error bodies carry the message as a string in `error`.
  const rejectWith = (status: number, message: string) =>
    providerWithFetch(
      async () =>
        new Response(JSON.stringify({ code: 'invalid-argument', error: message }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );

  const req = reqGen();

  test('sends the request to the base URL with the key and no OpenAI account headers', async () => {
    const saved = process.env.OPENAI_ORG_ID;
    process.env.OPENAI_ORG_ID = 'org-private';
    try {
      const calls: FetchCall[] = [];
      const p = providerWithFetch(async (url, init) => {
        calls.push({ url, init });
        return sseResponse(sse(textChunks));
      });
      const ev = await collect(p.generate(req));
      expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://xai.test/v1/chat/completions');
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get('authorization')).toBe('Bearer xai-test');
      expect(headers.has('openai-organization')).toBe(false);
      expect(headers.has('x-grok-conv-id')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_ORG_ID;
      else process.env.OPENAI_ORG_ID = saved;
    }
  });

  test('the official endpoint receives the conversation routing header', async () => {
    const calls: FetchCall[] = [];
    const p = providerWithFetch(async (url, init) => {
      calls.push({ url, init });
      return sseResponse(sse(textChunks));
    }, DEFAULT_XAI_BASE_URL);
    await collect(p.generate(req));
    expect(new Headers(calls[0]?.init?.headers).get('x-grok-conv-id')).toBe(
      openaiPromptCacheKey(req),
    );
  });

  test('the SDK does not retry, so generateWithRetry owns every attempt', async () => {
    let fetchCalls = 0;
    const p = providerWithFetch(async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ code: 'unavailable', error: 'busy' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });
    expect(await caught(p.generate(req))).toMatchObject({ status: 503 });
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

  test('a rate limit is retryable', async () => {
    const e = await caught(rejectWith(429, 'too many requests').generate(req));
    expect(isRetryableError(e)).toBe(true);
  });

  test('a prompt that does not fit the window is a ContextOverflowError', async () => {
    const e = await caught(
      rejectWith(
        400,
        "Failed to start sampling: [input_too_large] The prompt is too long for this model's context window (300188 tokens > 256000 tokens)",
      ).generate(req),
    );
    expect(e).toBeInstanceOf(ContextOverflowError);
    expect(isRetryableError(e)).toBe(false);
  });

  test('other rejections keep their status and are not retried', async () => {
    const e = await caught(
      rejectWith(400, 'Model grok-4.5 does not support parameter stop.').generate(req),
    );
    expect(e).not.toBeInstanceOf(ContextOverflowError);
    expect(e).toMatchObject({ status: 400 });
    expect(isRetryableError(e)).toBe(false);
    expect((e as Error).message).toContain('does not support parameter stop');
  });

  test('an error reported inside the stream becomes an error event', async () => {
    const p = providerWithFetch(async () =>
      sseResponse(sse([{ id: 'x1', choices: [{ delta: { content: '' } }] }, { error: 'boom' }])),
    );
    const ev = await collect(p.generate(req));
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({
      code: 'xai.stream_error',
      message: 'boom',
    });
    expect(ev.some((e) => e.kind === 'stop')).toBe(false);
  });

  test('an overflow reported inside the stream becomes a context_overflow event', async () => {
    const p = providerWithFetch(async () =>
      sseResponse(
        sse([
          { id: 'x1', choices: [{ delta: { content: '' } }] },
          { error: { code: 400, message: 'The prompt is too long for this model' } },
        ]),
      ),
    );
    const ev = await collect(p.generate(req));
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: CONTEXT_OVERFLOW });
  });

  test('a connection failure is classified as retryable', async () => {
    const p = providerWithFetch(async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const e = await caught(p.generate(req));
    expect(e).toBeInstanceOf(ProviderRequestError);
    expect(isRetryableError(e)).toBe(true);
  });

  test('a rejected certificate is reported as such and not retryable', async () => {
    const p = providerWithFetch(async () => {
      throw Object.assign(new TypeError('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      });
    });
    const error = await caught(p.generate(req));
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(isRetryableError(error)).toBe(false);
    expect((error as Error).message).toBe(
      'cannot use xAI: its TLS certificate was rejected (UNABLE_TO_VERIFY_LEAF_SIGNATURE); if a certificate authority of your own signed it, add that authority with NODE_EXTRA_CA_CERTS',
    );
  });

  test('a pre-aborted signal throws AbortError without sending a request', async () => {
    let fetchCalls = 0;
    const p = providerWithFetch(async () => {
      fetchCalls += 1;
      return sseResponse(sse(textChunks));
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
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id: 'x1', choices: [{ delta: { content: 'par' } }] })}\n\n`,
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
    expect(events.map((e) => e.kind)).toEqual(['start', 'text_delta']);
  });
});
