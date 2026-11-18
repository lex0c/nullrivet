import { describe, expect, test } from 'bun:test';
import { AbortError } from '../../src/agent/abortable.ts';
import { generateWithRetry, isRetryableError } from '../../src/agent/retry.ts';
import {
  CONTEXT_OVERFLOW,
  ContextOverflowError,
  INVALID_TOOL_CALL,
  ProviderRequestError,
} from '../../src/providers/errors.ts';
import { OLLAMA_CLOUD_CAPS, OLLAMA_LOCAL_CAPS } from '../../src/providers/ollama/capabilities.ts';
import { DEFAULT_OLLAMA_BASE_URL, OllamaHttpError } from '../../src/providers/ollama/http.ts';
import {
  type CreateOllamaProviderOptions,
  createOllamaProvider,
  isOllamaCloud,
  OLLAMA_CLOUD_BASE_URL,
} from '../../src/providers/ollama/index.ts';
import {
  DEFAULT_OLLAMA_NUM_CTX,
  ollamaThink,
  toOllamaMessages,
} from '../../src/providers/ollama/messages.ts';
import type {
  GenerateRequest,
  ProviderCapabilities,
  StreamEvent,
} from '../../src/providers/types.ts';

// biome-ignore lint/suspicious/noExplicitAny: the captured request body is dynamic.
type Body = Record<string, any>;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
  body: Body;
}

const ndjson = (...lines: unknown[]): string => lines.map((l) => `${JSON.stringify(l)}\n`).join('');

const textLines = [
  {
    model: 'm',
    created_at: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content: 'hi' },
    done: false,
  },
  {
    model: 'm',
    created_at: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 7,
    eval_count: 2,
  },
];

const okResponse = (body: string | ReadableStream<Uint8Array>): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });

const recordingFetch = (respond: () => Response = () => okResponse(ndjson(...textLines))) => {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init, body: JSON.parse(String(init?.body)) as Body });
    return respond();
  };
  return { calls, fetch: fetchImpl };
};

const allCaps = { ...OLLAMA_LOCAL_CAPS, ...OLLAMA_CLOUD_CAPS };
const caps = (model: string): ProviderCapabilities => {
  const c = allCaps[model];
  if (c === undefined) throw new Error(`test setup: ${model} is not in the Ollama catalog`);
  return c;
};

const make = (model: string, options: Partial<CreateOllamaProviderOptions> = {}) =>
  createOllamaProvider(model, { capabilities: caps(model), env: {}, ...options });

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
  model: 'x',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1_024,
  ...over,
});

describe('createOllamaProvider', () => {
  test('streams /api/chat as NDJSON and normalizes the events', async () => {
    const f = recordingFetch();
    const p = make('qwen2.5-coder:14b', { fetch: f.fetch });
    expect(p.id).toBe('ollama/qwen2.5-coder:14b');
    expect(p.family).toBe('ollama');
    const ev = await collect(p.generate(reqGen({ system: 'sys' })));
    expect(ev).toEqual([
      { kind: 'start', message_id: '2026-01-01T00:00:00Z' },
      { kind: 'text_delta', text: 'hi' },
      { kind: 'usage', usage: { input: 7, output: 2, cache_read: 0, cache_creation: 0 } },
      { kind: 'stop', reason: 'end_turn' },
    ]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
    expect(f.calls[0]?.init?.method).toBe('POST');
    expect(f.calls[0]?.body).toMatchObject({
      model: 'qwen2.5-coder:14b',
      stream: true,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      options: { num_ctx: 32_768, num_predict: 1_024 },
    });
    expect(new Headers(f.calls[0]?.init?.headers).has('authorization')).toBe(false);
  });

  test('forwards tools, sampling, stop sequences and keep_alive', async () => {
    const f = recordingFetch();
    const p = make('qwen2.5-coder:14b', {
      fetch: f.fetch,
      env: { NULLRIVET_OLLAMA_KEEP_ALIVE: '300' },
    });
    await collect(
      p.generate(
        reqGen({
          temperature: 0.2,
          top_p: 0.9,
          stop_sequences: ['END'],
          tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
        }),
      ),
    );
    const body = f.calls[0]?.body ?? {};
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object' } },
      },
    ]);
    expect(body.options).toEqual({
      num_ctx: 32_768,
      num_predict: 1_024,
      temperature: 0.2,
      top_p: 0.9,
      stop: ['END'],
    });
    expect(body.keep_alive).toBe(300);
    for (const absent of ['think', 'format', 'seed']) expect(absent in body).toBe(false);
  });

  test('a keep_alive duration stays a string', async () => {
    const f = recordingFetch();
    const p = make('qwen2.5-coder:14b', {
      fetch: f.fetch,
      env: { NULLRIVET_OLLAMA_KEEP_ALIVE: '30m' },
    });
    await collect(p.generate(reqGen()));
    expect(f.calls[0]?.body.keep_alive).toBe('30m');
  });

  test('effort switches thinking on, or selects a level on models that take levels', () => {
    const req = reqGen({ effort: 'xhigh' });
    expect(ollamaThink(req, caps('qwen3:8b'))).toBe(true);
    expect(ollamaThink(req, caps('gpt-oss:20b'))).toBe('high');
    expect(ollamaThink(reqGen({ effort: 'low' }), caps('gpt-oss:20b'))).toBe('low');
    expect(ollamaThink(req, caps('qwen2.5-coder:14b'))).toBeUndefined();
    expect(ollamaThink(reqGen(), caps('qwen3:8b'))).toBeUndefined();
  });

  test('a local server serves a capped window, reported as the context window', () => {
    const p = make('llama3.1:8b');
    expect(p.capabilities.context_window).toBe(DEFAULT_OLLAMA_NUM_CTX);
    expect(caps('llama3.1:8b').context_window).toBe(131_072);
  });

  test('Ollama Cloud serves the full window', async () => {
    const f = recordingFetch();
    const p = make('glm-5.2', { baseURL: OLLAMA_CLOUD_BASE_URL, apiKey: 'ok-key', fetch: f.fetch });
    expect(p.capabilities.context_window).toBe(caps('glm-5.2').context_window);
    await collect(p.generate(reqGen()));
    expect(f.calls[0]?.url).toBe(`${OLLAMA_CLOUD_BASE_URL}/api/chat`);
    expect(f.calls[0]?.body.options.num_ctx).toBe(caps('glm-5.2').context_window);
    expect(new Headers(f.calls[0]?.init?.headers).get('authorization')).toBe('Bearer ok-key');
  });

  test('NULLRIVET_OLLAMA_NUM_CTX overrides the window but never exceeds the capacity', async () => {
    const f = recordingFetch();
    const raised = make('llama3.1:8b', {
      env: { NULLRIVET_OLLAMA_NUM_CTX: '65536' },
      fetch: f.fetch,
    });
    expect(raised.capabilities.context_window).toBe(65_536);
    await collect(raised.generate(reqGen()));
    expect(f.calls[0]?.body.options.num_ctx).toBe(65_536);
    const capped = make('qwen3:8b', { env: { NULLRIVET_OLLAMA_NUM_CTX: '999999' } });
    expect(capped.capabilities.context_window).toBe(caps('qwen3:8b').context_window);
    const lowered = make('qwen3:8b', { env: { NULLRIVET_OLLAMA_NUM_CTX: '4096' } });
    expect(lowered.capabilities).toMatchObject({ context_window: 4_096, output_max_tokens: 4_096 });
  });

  test('the shared catalog entry is not mutated', () => {
    const before = structuredClone(caps('llama3.1:8b'));
    make('llama3.1:8b', { env: { NULLRIVET_OLLAMA_NUM_CTX: '8192' } });
    expect(caps('llama3.1:8b')).toEqual(before);
  });

  test('replay is on for thinking models unless disabled', () => {
    expect(make('qwen3:8b').replaysReasoning).toBe(true);
    expect(make('gpt-oss:20b').replaysReasoning).toBe(true);
    expect(make('qwen2.5-coder:14b').replaysReasoning).toBe(false);
    expect(
      make('qwen3:8b', { env: { NULLRIVET_OLLAMA_REASONING_REPLAY: '0' } }).replaysReasoning,
    ).toBe(false);
  });

  test('isOllamaCloud accepts only https://ollama.com', () => {
    expect(isOllamaCloud('https://ollama.com')).toBe(true);
    expect(isOllamaCloud('http://ollama.com')).toBe(false);
    expect(isOllamaCloud('https://ollama.com.evil.test')).toBe(false);
    expect(isOllamaCloud(DEFAULT_OLLAMA_BASE_URL)).toBe(false);
    expect(isOllamaCloud('not a url')).toBe(false);
  });
});

describe('toOllamaMessages', () => {
  test('tool calls carry object arguments and results name the function they answer', () => {
    const out = toOllamaMessages(
      reqGen({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'reading' },
              { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'next' },
              { type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true },
              { type: 'tool_result', tool_use_id: 'zz', name: 'grep', content: 'ok' },
            ],
          },
        ],
      }),
      false,
    );
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'reading',
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }],
      },
      { role: 'tool', content: '[tool error] boom', tool_name: 'read_file' },
      { role: 'tool', content: 'ok', tool_name: 'grep' },
      { role: 'user', content: 'next' },
    ]);
  });

  test('flattens system segments and keeps separate text blocks apart', () => {
    const out = toOllamaMessages(
      reqGen({
        systemSegments: [
          { id: 'a', text: 'one' },
          { id: 'b', text: 'two' },
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'x' },
              { type: 'text', text: 'y' },
            ],
          },
        ],
      }),
      false,
    );
    expect(out).toEqual([
      { role: 'system', content: 'one\n\ntwo' },
      { role: 'user', content: 'x\n\ny' },
    ]);
  });

  test('thinking is replayed only for Ollama reasoning blocks with replay on', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'reasoning' as const, provider: 'ollama' as const, data: { thinking: 'plan' } },
          { type: 'reasoning' as const, provider: 'openai' as const, data: { thinking: 'no' } },
          { type: 'tool_use' as const, id: 'c1', name: 'grep', input: {} },
        ],
      },
    ];
    expect(toOllamaMessages(reqGen({ messages }), true)[0]?.thinking).toBe('plan');
    expect('thinking' in (toOllamaMessages(reqGen({ messages }), false)[0] ?? {})).toBe(false);
  });
});

describe('Ollama stream content', () => {
  const run = async (...lines: unknown[]): Promise<StreamEvent[]> => {
    const p = make('qwen3:8b', { fetch: async () => okResponse(ndjson(...lines)) });
    return collect(p.generate(reqGen()));
  };

  test('thinking is emitted as deltas and as a replayable reasoning block before tool calls', async () => {
    const ev = await run(
      { created_at: 't', message: { role: 'assistant', content: '', thinking: 'plan' } },
      {
        created_at: 't',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'grep', arguments: { q: 'x' } } }],
        },
        done: true,
      },
    );
    expect(ev.map((e) => e.kind)).toEqual([
      'start',
      'thinking_delta',
      'reasoning',
      'tool_use_start',
      'tool_use_stop',
      'usage',
      'stop',
    ]);
    expect(ev[2]).toEqual({ kind: 'reasoning', provider: 'ollama', data: { thinking: 'plan' } });
    expect(ev.at(-1)).toEqual({ kind: 'stop', reason: 'tool_use' });
  });

  test('tool calls without a name or with non-object arguments are invalid tool calls', async () => {
    const ev = await run({
      created_at: 't',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { arguments: {} } },
          { function: { name: 'grep', arguments: ['x'] } },
          { function: { name: 'read', arguments: { path: 'a' } } },
        ],
      },
      done: true,
    });
    expect(ev.filter((e) => e.kind === 'error').map((e) => e.code)).toEqual([
      INVALID_TOOL_CALL,
      INVALID_TOOL_CALL,
    ]);
    expect(ev.filter((e) => e.kind === 'tool_use_stop')).toHaveLength(1);
  });

  test('an error line becomes an error event without a stop', async () => {
    const ev = await run(textLines[0], { error: 'model runner crashed' });
    expect(ev.at(-1)).toEqual({
      kind: 'error',
      code: 'ollama.stream_error',
      message: 'Ollama /api/chat stream error: model runner crashed',
      retryable: false,
    });
  });

  test('an overflow error line becomes a context_overflow event', async () => {
    const ev = await run({ error: 'the input length exceeds the context length' });
    expect(ev.at(-1)).toMatchObject({ kind: 'error', code: CONTEXT_OVERFLOW, retryable: false });
  });
});

describe('Ollama HTTP transport', () => {
  const req = reqGen();

  test('a line split across reads and a final line without a newline are parsed', async () => {
    const encoder = new TextEncoder();
    const text = ndjson(...textLines).trimEnd();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, 20)));
        controller.enqueue(encoder.encode(text.slice(20)));
        controller.close();
      },
    });
    const p = make('qwen2.5-coder:14b', { fetch: async () => okResponse(body) });
    const ev = await collect(p.generate(req));
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
  });

  test('a line that is not a JSON object fails the stream', async () => {
    for (const line of ['not json', 'null', '[1]']) {
      const p = make('qwen2.5-coder:14b', { fetch: async () => okResponse(`${line}\n`) });
      expect(await caught(p.generate(req))).toBeInstanceOf(OllamaHttpError);
    }
  });

  test('a missing model is a 404 with a pull hint and is not retried', async () => {
    const p = make('qwen2.5-coder:14b', {
      fetch: async () =>
        new Response(JSON.stringify({ error: "model 'x' not found" }), { status: 404 }),
    });
    const error = await caught(p.generate(req));
    expect(error).toBeInstanceOf(OllamaHttpError);
    expect((error as OllamaHttpError).status).toBe(404);
    expect((error as Error).message).toContain('ollama pull qwen2.5-coder:14b');
    expect(isRetryableError(error)).toBe(false);
  });

  test('one fetch per attempt: a 5xx is retried by generateWithRetry only', async () => {
    let fetchCalls = 0;
    const p = make('qwen2.5-coder:14b', {
      fetch: async () => {
        fetchCalls += 1;
        return new Response('{"error":"busy"}', { status: 503 });
      },
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

  test('an overflow rejection is a ContextOverflowError', async () => {
    const p = make('qwen2.5-coder:14b', {
      fetch: async () =>
        new Response(
          JSON.stringify({ error: 'prompt too long; exceeded max context length by 42 tokens' }),
          {
            status: 400,
          },
        ),
    });
    const error = await caught(p.generate(req));
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(isRetryableError(error)).toBe(false);
  });

  test('an unreachable server is a retryable ProviderRequestError without credentials', async () => {
    const p = make('qwen2.5-coder:14b', {
      baseURL: 'http://user:secret@localhost:11434',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = await caught(p.generate(req));
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(isRetryableError(error)).toBe(true);
    expect((error as Error).message).not.toContain('secret');
  });

  // What Bun's fetch throws for a certificate it rejects.
  const certificateError = (code: string, message: string) =>
    Object.assign(new TypeError(message), { code });

  test('a rejected certificate is reported as such and not retried', async () => {
    let fetchCalls = 0;
    const p = make('qwen2.5-coder:14b', {
      baseURL: 'https://user:secret@ollama.internal:11434',
      fetch: async () => {
        fetchCalls += 1;
        throw certificateError(
          'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          'unable to verify the first certificate',
        );
      },
    });
    const error = await caught(
      generateWithRetry(p, req, undefined, {
        maxAttempts: 3,
        baseDelayMs: 1,
        sleep: () => Promise.resolve(),
      }),
    );
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(fetchCalls).toBe(1);
    expect((error as Error).message).toBe(
      'cannot use Ollama at https://ollama.internal:11434: its TLS certificate was rejected (UNABLE_TO_VERIFY_LEAF_SIGNATURE); if a certificate authority of your own signed it, add that authority with NODE_EXTRA_CA_CERTS',
    );
  });

  test('an expired certificate or a name mismatch gets no NODE_EXTRA_CA_CERTS hint', async () => {
    for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      const p = make('qwen2.5-coder:14b', {
        baseURL: 'https://user:secret@ollama.internal:11434',
        fetch: async () => {
          throw certificateError(code, `${code} fetching "https://user:secret@ollama.internal"`);
        },
      });
      const message = ((await caught(p.generate(req))) as Error).message;
      expect(message).toContain(`its TLS certificate was rejected (${code})`);
      expect(message).not.toContain('NODE_EXTRA_CA_CERTS');
      expect(message).not.toContain('secret');
    }
  });

  test('a pre-aborted signal throws AbortError without sending a request', async () => {
    const f = recordingFetch();
    const p = make('qwen2.5-coder:14b', { fetch: f.fetch });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await caught(p.generate(req, ctrl.signal))).toBeInstanceOf(AbortError);
    expect(f.calls).toHaveLength(0);
  });

  test('aborting mid-stream cancels the HTTP request and reports no clean stop', async () => {
    const encoder = new TextEncoder();
    let fetchSignal: AbortSignal | null | undefined;
    const p = make('qwen2.5-coder:14b', {
      fetch: async (_url, init) => {
        fetchSignal = init?.signal;
        const signal = fetchSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(ndjson(textLines[0])));
            signal?.addEventListener('abort', () => controller.error(signal.reason), {
              once: true,
            });
          },
        });
        return okResponse(body);
      },
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
