import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { AbortError } from '../../src/agent/abortable.ts';
import { generateWithRetry, isRetryableError } from '../../src/agent/retry.ts';
import {
  CONTEXT_OVERFLOW,
  ContextOverflowError,
  ProviderRequestError,
} from '../../src/providers/errors.ts';
import { OPENAI_CAPS } from '../../src/providers/openai/capabilities.ts';
import {
  type CreateOpenAIProviderOptions,
  createOpenAIProvider,
  DEFAULT_OPENAI_BASE_URL,
  openaiPromptCacheKey,
} from '../../src/providers/openai/index.ts';
import type { RawOpenAIChunk } from '../../src/providers/openai/stream.ts';
import type {
  GenerateRequest,
  ProviderCapabilities,
  StreamEvent,
} from '../../src/providers/types.ts';

// biome-ignore lint/suspicious/noExplicitAny: the captured request body is dynamic.
type Body = Record<string, any>;

interface Captured {
  body: Body;
  options: { signal?: AbortSignal | null | undefined } | undefined;
}

const textChunks: RawOpenAIChunk[] = [
  { id: 'c1', choices: [{ delta: { content: 'hi' } }] },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  },
];

const chatClient = (chunks: RawOpenAIChunk[], captured?: Captured): OpenAI =>
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
  const c = OPENAI_CAPS[model];
  if (c === undefined) throw new Error(`test setup: ${model} is not in OPENAI_CAPS`);
  return c;
};

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const reqGen = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 512,
  ...over,
});

const capture = async (
  model: string,
  req: Partial<GenerateRequest>,
  options: Partial<CreateOpenAIProviderOptions> = {},
  signal?: AbortSignal,
): Promise<Captured> => {
  const captured: Captured = { body: {}, options: undefined };
  const p = createOpenAIProvider(model, {
    capabilities: caps(model),
    env: {},
    client: chatClient(textChunks, captured),
    ...options,
  });
  await collect(p.generate(reqGen(req), signal));
  return captured;
};

describe('createOpenAIProvider on Chat Completions', () => {
  test('throws without an api key or client', () => {
    expect(() => createOpenAIProvider('gpt-4o', { capabilities: caps('gpt-4o') })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  test('exposes the id, family and given capabilities', () => {
    const p = createOpenAIProvider('gpt-4o', {
      capabilities: caps('gpt-4o'),
      env: {},
      client: chatClient([]),
    });
    expect(p.id).toBe('openai/gpt-4o');
    expect(p.family).toBe('openai');
    expect(p.capabilities).toEqual(caps('gpt-4o'));
    expect(p.replaysReasoning).toBe(false);
  });

  test('request body: system first, stream, output cap, usage, cache key, sampling, stop', async () => {
    const { body } = await capture('gpt-4o', {
      system: 'sys',
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ['END'],
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
      effort: 'high',
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body.stream).toBe(true);
    expect(body.max_completion_tokens).toBe(512);
    expect('max_tokens' in body).toBe(false);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(typeof body.prompt_cache_key).toBe('string');
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(['END']);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object' } },
      },
    ]);
    for (const absent of ['reasoning_effort', 'reasoning', 'seed', 'metadata']) {
      expect(absent in body).toBe(false);
    }
  });

  test('a compatible endpoint gets max_tokens and no official-only parameters', async () => {
    const { body } = await capture('gpt-4o', {}, { baseURL: 'https://proxy.example/v1' });
    expect(body.max_tokens).toBe(512);
    expect('max_completion_tokens' in body).toBe(false);
    expect('prompt_cache_key' in body).toBe(false);
  });

  test('NULLRIVET_OPENAI_INCLUDE_USAGE=0 omits stream_options', async () => {
    const { body } = await capture('gpt-4o', {}, { env: { NULLRIVET_OPENAI_INCLUDE_USAGE: '0' } });
    expect('stream_options' in body).toBe(false);
  });

  test('tool calls and results map to the Chat Completions shape', async () => {
    const { body } = await capture('gpt-4o', {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
            { type: 'tool_use', id: 'c1', name: 'read', input: { p: 1 } },
            { type: 'reasoning', provider: 'openai', data: { encrypted_content: 'x' } },
          ],
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
        content: 'a\n\nb',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '[tool error] boom' },
      { role: 'user', content: 'next' },
    ]);
  });

  test('blocks on the wrong role are rejected', async () => {
    await expect(
      capture('gpt-4o', {
        messages: [
          { role: 'user', content: [{ type: 'tool_use', id: 'c', name: 'n', input: {} }] },
        ],
      }),
    ).rejects.toThrow(/assistant messages/);
  });

  test('the prompt cache key is stable and independent of key order in tool schemas', () => {
    const a = openaiPromptCacheKey(
      reqGen({
        system: 's',
        tools: [{ name: 't', description: 'd', input_schema: { type: 'object', properties: {} } }],
      }),
    );
    const b = openaiPromptCacheKey(
      reqGen({
        system: 's',
        messages: [{ role: 'user', content: 'other' }],
        tools: [{ input_schema: { properties: {}, type: 'object' }, description: 'd', name: 't' }],
      }),
    );
    expect(a).toBe(b);
    expect(openaiPromptCacheKey(reqGen({ system: 'other' }))).not.toBe(a);
  });

  test('passes the abort signal to the SDK request options', async () => {
    const ctrl = new AbortController();
    const { options } = await capture('gpt-4o', {}, {}, ctrl.signal);
    expect(options?.signal).toBe(ctrl.signal);
  });
});

// These tests drive the real SDK client through an injected fetch, so they cover headers, retries
// and cancellation of the HTTP request itself.
describe('createOpenAIProvider over the SDK transport', () => {
  const sse = (chunks: unknown[]): string =>
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

  const sseResponse = (body: string | ReadableStream<Uint8Array>): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const providerWithFetch = (
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
    model = 'gpt-4o',
  ) =>
    createOpenAIProvider(model, {
      capabilities: caps(model),
      apiKey: 'sk-test',
      env: {},
      fetch: fetchImpl as unknown as CreateOpenAIProviderOptions['fetch'],
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

  test('sends the request to the official endpoint with the key only', async () => {
    const saved = { org: process.env.OPENAI_ORG_ID, project: process.env.OPENAI_PROJECT_ID };
    process.env.OPENAI_ORG_ID = 'org-private';
    process.env.OPENAI_PROJECT_ID = 'proj-private';
    try {
      const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
      const p = providerWithFetch(async (url, init) => {
        calls.push({ url, init });
        return sseResponse(sse(textChunks));
      });
      const ev = await collect(p.generate(req));
      expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(`${DEFAULT_OPENAI_BASE_URL}/chat/completions`);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get('authorization')).toBe('Bearer sk-test');
      expect(headers.has('openai-organization')).toBe(false);
      expect(headers.has('openai-project')).toBe(false);
    } finally {
      if (saved.org === undefined) delete process.env.OPENAI_ORG_ID;
      else process.env.OPENAI_ORG_ID = saved.org;
      if (saved.project === undefined) delete process.env.OPENAI_PROJECT_ID;
      else process.env.OPENAI_PROJECT_ID = saved.project;
    }
  });

  test('the Responses route posts to /responses', async () => {
    const urls: string[] = [];
    const p = providerWithFetch(async (url) => {
      urls.push(url);
      return sseResponse(
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'r' } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`,
      );
    }, 'gpt-5.4-mini');
    const ev = await collect(p.generate(req));
    expect(ev.map((e) => e.kind)).toEqual(['start', 'stop']);
    expect(urls).toEqual([`${DEFAULT_OPENAI_BASE_URL}/responses`]);
  });

  test('the SDK does not retry, so generateWithRetry owns every attempt', async () => {
    let fetchCalls = 0;
    const p = providerWithFetch(async () => {
      fetchCalls += 1;
      return jsonResponse(503, { error: { message: 'upstream down' } });
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
              `data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'par' } }] })}\n\n`,
            ),
          );
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
    expect(events.map((e) => e.kind)).toEqual(['start', 'text_delta']);
  });

  test('a connection failure is a retryable ProviderRequestError', async () => {
    const p = providerWithFetch(async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    const error = await caught(p.generate(req));
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(isRetryableError(error)).toBe(true);
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
      'cannot use OpenAI: its TLS certificate was rejected (UNABLE_TO_VERIFY_LEAF_SIGNATURE); if a certificate authority of your own signed it, add that authority with NODE_EXTRA_CA_CERTS',
    );
  });

  test('context_length_exceeded is a ContextOverflowError on both routes', async () => {
    for (const model of ['gpt-4o', 'gpt-5.4-mini']) {
      const p = providerWithFetch(
        async () =>
          jsonResponse(400, {
            error: {
              message: "This model's maximum context length is 128000 tokens.",
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
            },
          }),
        model,
      );
      const error = await caught(p.generate(req));
      expect(error).toBeInstanceOf(ContextOverflowError);
      expect(isRetryableError(error)).toBe(false);
    }
  });

  test('an unrelated 400 is left to the caller unchanged', async () => {
    const p = providerWithFetch(async () =>
      jsonResponse(400, {
        error: { message: 'Invalid value for temperature', code: 'invalid_value' },
      }),
    );
    const error = await caught(p.generate(req));
    expect(error).not.toBeInstanceOf(ContextOverflowError);
    expect(error).toMatchObject({ status: 400 });
  });

  test('an error inside the chat stream becomes an error event', async () => {
    const p = providerWithFetch(async () =>
      sseResponse(
        sse([
          { id: 'c1', choices: [{ delta: { content: '' } }] },
          { error: { message: 'boom', type: 'server_error' } },
        ]),
      ),
    );
    const ev = await collect(p.generate(req));
    expect(ev.find((e) => e.kind === 'error')).toEqual({
      kind: 'error',
      code: 'openai.stream_error',
      message: 'boom',
      retryable: true,
    });
    expect(ev.some((e) => e.kind === 'stop')).toBe(false);
  });

  test('an overflow inside the chat stream becomes a context_overflow event', async () => {
    const p = providerWithFetch(async () =>
      sseResponse(
        sse([
          { id: 'c1', choices: [{ delta: { content: '' } }] },
          { error: { message: 'too long', code: 'context_length_exceeded' } },
        ]),
      ),
    );
    const ev = await collect(p.generate(req));
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({
      code: CONTEXT_OVERFLOW,
      retryable: false,
    });
  });
});
