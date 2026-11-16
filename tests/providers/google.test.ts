import { describe, expect, test } from 'bun:test';
import { AbortError } from '../../src/agent/abortable.ts';
import { buildAssistantContent } from '../../src/agent/assistant-content.ts';
import { collectStep } from '../../src/agent/collect.ts';
import { generateWithRetry, isRetryableError, retryAfterMs } from '../../src/agent/retry.ts';
import {
  ContextOverflowError,
  INVALID_TOOL_CALL,
  ProviderRequestError,
} from '../../src/providers/errors.ts';
import { GOOGLE_CAPS } from '../../src/providers/google/capabilities.ts';
import { DEFAULT_GOOGLE_BASE_URL, GoogleHttpError } from '../../src/providers/google/http.ts';
import {
  type CreateGoogleProviderOptions,
  createGoogleProvider,
} from '../../src/providers/google/index.ts';
import {
  buildGoogleRequest,
  googleThinkingConfig,
  toGoogleContents,
} from '../../src/providers/google/messages.ts';
import {
  type RawGoogleChunk,
  SYNTHETIC_CALL_ID_PREFIX,
} from '../../src/providers/google/stream.ts';
import type {
  GenerateRequest,
  ProviderCapabilities,
  ProviderEffort,
  ProviderMessage,
  StreamEvent,
} from '../../src/providers/types.ts';

// biome-ignore lint/suspicious/noExplicitAny: the captured request body is dynamic.
type Body = Record<string, any>;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
  body: Body;
}

const sse = (chunks: RawGoogleChunk[]): string =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');

const sseResponse = (body: string | ReadableStream<Uint8Array>): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

const textChunks: RawGoogleChunk[] = [
  { responseId: 'r1', candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }] },
  {
    responseId: 'r1',
    candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  },
];

const recordingFetch = (respond: () => Response = () => sseResponse(sse(textChunks))) => {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init, body: JSON.parse(String(init?.body)) as Body });
    return respond();
  };
  return { calls, fetch: fetchImpl };
};

const caps = (model: string): ProviderCapabilities => {
  const c = GOOGLE_CAPS[model];
  if (c === undefined) throw new Error(`test setup: ${model} is not in GOOGLE_CAPS`);
  return c;
};

const make = (model: string, options: Partial<CreateGoogleProviderOptions> = {}) =>
  createGoogleProvider(model, { capabilities: caps(model), apiKey: 'g-test', ...options });

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

const errorResponse = (status: number, error: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('createGoogleProvider', () => {
  test('throws without an api key', () => {
    expect(() =>
      createGoogleProvider('gemini-3.5-flash', { capabilities: caps('gemini-3.5-flash') }),
    ).toThrow(/GEMINI_API_KEY/);
  });

  test('streams from streamGenerateContent with the key in a header', async () => {
    const f = recordingFetch();
    const p = make('gemini-3.5-flash', { fetch: f.fetch });
    expect(p.id).toBe('google/gemini-3.5-flash');
    expect(p.family).toBe('google');
    expect(p.replaysReasoning).toBe(true);
    const ev = await collect(p.generate(reqGen()));
    expect(ev).toEqual([
      { kind: 'start', message_id: 'r1' },
      { kind: 'text_delta', text: 'hi' },
      { kind: 'usage', usage: { input: 5, output: 2, cache_read: 0, cache_creation: 0 } },
      { kind: 'stop', reason: 'end_turn' },
    ]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(
      `${DEFAULT_GOOGLE_BASE_URL}/models/gemini-3.5-flash:streamGenerateContent?alt=sse`,
    );
    expect(f.calls[0]?.url).not.toContain('g-test');
    expect(f.calls[0]?.init?.method).toBe('POST');
    expect(new Headers(f.calls[0]?.init?.headers).get('x-goog-api-key')).toBe('g-test');
  });

  test('uses the configured base URL and encodes the model name', async () => {
    const f = recordingFetch();
    const p = createGoogleProvider('a/../b', {
      capabilities: caps('gemini-3.5-flash'),
      apiKey: 'g-test',
      baseURL: 'https://proxy.example/v1beta/',
      fetch: f.fetch,
    });
    await collect(p.generate(reqGen()));
    expect(f.calls[0]?.url).toBe(
      'https://proxy.example/v1beta/models/a%2F..%2Fb:streamGenerateContent?alt=sse',
    );
  });

  test('request body: system instruction, tools as JSON Schema, output cap', async () => {
    const f = recordingFetch();
    const p = make('gemini-3.5-flash', { fetch: f.fetch });
    const schema = {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    };
    await collect(
      p.generate(
        reqGen({
          systemSegments: [
            { id: 'a', text: 'one', cacheBreakpoint: true },
            { id: 'b', text: 'two' },
          ],
          system: 'one\n\ntwo',
          tools: [{ name: 'read_file', description: 'Read a file.', input_schema: schema }],
        }),
      ),
    );
    expect(f.calls[0]?.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'one\n\ntwo' }] },
      tools: [
        {
          functionDeclarations: [
            { name: 'read_file', description: 'Read a file.', parametersJsonSchema: schema },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 1_024 },
    });
  });

  test('sampling and stop sequences are sent to models that accept sampling', async () => {
    const f = recordingFetch();
    const p = make('gemini-2.5-flash-lite', { fetch: f.fetch });
    await collect(p.generate(reqGen({ temperature: 0, top_p: 0.9, stop_sequences: ['END'] })));
    expect(f.calls[0]?.body.generationConfig).toEqual({
      maxOutputTokens: 1_024,
      temperature: 0,
      topP: 0.9,
      stopSequences: ['END'],
    });
  });

  test('sampling is left at the default on Gemini 3 and later', async () => {
    const f = recordingFetch();
    const p = make('gemini-3.5-flash', { fetch: f.fetch });
    await collect(p.generate(reqGen({ temperature: 0, top_p: 0.9 })));
    expect(f.calls[0]?.body.generationConfig).toEqual({ maxOutputTokens: 1_024 });
  });
});

describe('googleThinkingConfig', () => {
  test('no thinking configuration without an effort', () => {
    expect(googleThinkingConfig(reqGen(), caps('gemini-3.5-flash'))).toBeUndefined();
    expect(googleThinkingConfig(reqGen(), caps('gemini-2.5-flash-lite'))).toBeUndefined();
  });

  test('Gemini 3 and later take a named level, with xhigh only where accepted', () => {
    const level = (model: string, effort: ProviderEffort) =>
      googleThinkingConfig(reqGen({ effort }), caps(model));
    expect(level('gemini-3.5-flash', 'low')).toEqual({ thinkingLevel: 'low' });
    expect(level('gemini-3.5-flash', 'medium')).toEqual({ thinkingLevel: 'medium' });
    expect(level('gemini-3.5-flash', 'max')).toEqual({ thinkingLevel: 'high' });
    expect(level('gemini-4-hydrogen', 'xhigh')).toEqual({ thinkingLevel: 'xhigh' });
    expect(level('gemini-4-hydrogen', 'max')).toEqual({ thinkingLevel: 'xhigh' });
  });

  test('Gemini 2.5 takes a budget from the effort ladder, below max_tokens and the model cap', () => {
    const lite = caps('gemini-2.5-flash-lite');
    expect(googleThinkingConfig(reqGen({ effort: 'low', max_tokens: 32_768 }), lite)).toEqual({
      thinkingBudget: 2_048,
    });
    expect(googleThinkingConfig(reqGen({ effort: 'high', max_tokens: 4_000 }), lite)).toEqual({
      thinkingBudget: 3_999,
    });
    const capped = { ...lite, max_thinking_budget: 10_000 };
    expect(googleThinkingConfig(reqGen({ effort: 'max', max_tokens: 32_768 }), capped)).toEqual({
      thinkingBudget: 10_000,
    });
  });

  test('a budget that cannot fit is omitted', () => {
    expect(
      googleThinkingConfig(
        reqGen({ effort: 'low', max_tokens: 100 }),
        caps('gemini-2.5-flash-lite'),
      ),
    ).toBeUndefined();
  });

  test('Gemini 2.5 thinks only when the output limit leaves room for its smallest budget', () => {
    const small = buildGoogleRequest(
      reqGen({ effort: 'high', max_tokens: 400 }),
      caps('gemini-2.5-flash-lite'),
    );
    expect(small.generationConfig.thinkingConfig).toBeUndefined();
    const large = buildGoogleRequest(
      reqGen({ effort: 'high', max_tokens: 32_768 }),
      caps('gemini-2.5-flash-lite'),
    );
    expect(large.generationConfig.thinkingConfig).toMatchObject({
      thinkingBudget: expect.any(Number),
    });
  });

  test('the thinking configuration is placed in generationConfig', () => {
    const body = buildGoogleRequest(reqGen({ effort: 'low' }), caps('gemini-3.5-flash'));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });
});

describe('toGoogleContents', () => {
  test('calls from another model get the placeholder signature on the first call only', () => {
    const step = (reasoning: ProviderMessage['content']): ProviderMessage[] => [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: reasoning },
    ];
    const calls = [
      { type: 'tool_use' as const, id: 'a', name: 'glob', input: {} },
      { type: 'tool_use' as const, id: 'b', name: 'grep', input: {} },
    ];
    const unsigned = toGoogleContents(step(calls))[1]?.parts ?? [];
    expect(unsigned.map((p) => p.thoughtSignature)).toEqual([
      'skip_thought_signature_validator',
      undefined,
    ]);
    const signed = toGoogleContents(
      step([
        { type: 'reasoning', provider: 'google', data: { thoughtSignature: 'real' } },
        ...calls,
      ]),
    )[1]?.parts;
    expect(signed?.map((p) => p.thoughtSignature)).toEqual(['real', undefined]);
  });

  test('roles map to user and model; tool results answer calls by name', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Listing.' },
          { type: 'tool_use', id: `${SYNTHETIC_CALL_ID_PREFIX}1`, name: 'glob', input: { p: 1 } },
          { type: 'tool_use', id: 'fc-issued', name: 'read_file', input: { path: 'a' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `${SYNTHETIC_CALL_ID_PREFIX}1`,
            name: 'glob',
            content: 'a.ts',
          },
          {
            type: 'tool_result',
            tool_use_id: 'fc-issued',
            name: 'read_file',
            content: 'no such file',
            is_error: true,
          },
          { type: 'text', text: 'note' },
        ],
      },
    ];
    expect(toGoogleContents(messages)).toEqual([
      { role: 'user', parts: [{ text: 'go' }] },
      {
        role: 'model',
        parts: [
          { text: 'Listing.' },
          {
            functionCall: { name: 'glob', args: { p: 1 } },
            thoughtSignature: 'skip_thought_signature_validator',
          },
          { functionCall: { id: 'fc-issued', name: 'read_file', args: { path: 'a' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'glob', response: { output: 'a.ts' } } },
          {
            functionResponse: {
              id: 'fc-issued',
              name: 'read_file',
              response: { error: 'no such file' },
            },
          },
          { text: 'note' },
        ],
      },
    ]);
  });

  test('a tool result without a name takes it from the call it answers', () => {
    const contents = toGoogleContents([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'glob', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }] },
    ]);
    expect(contents[1]?.parts[0]).toEqual({
      functionResponse: { id: 'c1', name: 'glob', response: { output: 'x' } },
    });
  });

  test('a tool result that answers no known call cannot be sent', () => {
    expect(() =>
      toGoogleContents([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c9', content: 'x' }] },
      ]),
    ).toThrow(/c9/);
  });

  test('a signature is attached byte-identical to the part that follows it', () => {
    const signature = 'CiQB0e2Kb/+abc==\n';
    const contents = toGoogleContents([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Listing.' },
          { type: 'reasoning', provider: 'google', data: { thoughtSignature: signature } },
          { type: 'tool_use', id: 'c1', name: 'glob', input: {} },
          { type: 'tool_use', id: 'c2', name: 'read_file', input: {} },
        ],
      },
    ]);
    expect(contents[0]?.parts).toEqual([
      { text: 'Listing.' },
      { functionCall: { id: 'c1', name: 'glob', args: {} }, thoughtSignature: signature },
      { functionCall: { id: 'c2', name: 'read_file', args: {} } },
    ]);
  });

  test('a trailing signature goes to the last part, which cannot be an empty text part', () => {
    const contents = toGoogleContents([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'done' },
          { type: 'reasoning', provider: 'google', data: { thoughtSignature: 'sig' } },
        ],
      },
    ]);
    expect(contents[0]?.parts).toEqual([{ text: 'done', thoughtSignature: 'sig' }]);
  });

  test('reasoning from another family, or without a signature, is dropped', () => {
    const contents = toGoogleContents([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', provider: 'anthropic', data: { thinking: 't', signature: 's' } },
          { type: 'reasoning', provider: 'google', data: { thoughtSignature: '' } },
          { type: 'reasoning', provider: 'google', data: null },
          { type: 'text', text: 'answer' },
        ],
      },
    ]);
    expect(contents).toEqual([{ role: 'model', parts: [{ text: 'answer' }] }]);
  });

  test('a message left without parts is not sent', () => {
    const contents = toGoogleContents([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [{ type: 'reasoning', provider: 'openai', data: { id: 'r' } }],
      },
    ]);
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'q' }] }]);
  });
});

describe('multi-step tool use through the agent collector', () => {
  test('the signature of a step is replayed on its function call in the next request', async () => {
    const signature = 'EpQBCpEBAdHtim+/sig==';
    const step1: RawGoogleChunk[] = [
      {
        responseId: 'r1',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'glob', args: { pattern: '*.ts' } },
                  thoughtSignature: signature,
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, thoughtsTokenCount: 20 },
      },
    ];
    const responses = [sseResponse(sse(step1)), sseResponse(sse(textChunks))];
    const f = recordingFetch(() => responses.shift() as Response);
    const p = make('gemini-3.5-flash', { fetch: f.fetch });

    const first = await collectStep(
      p.generate(reqGen({ messages: [{ role: 'user', content: 'go' }] })),
    );
    expect(first.stop_reason).toBe('tool_use');
    expect(first.usage).toEqual({ input: 50, output: 25, cache_read: 0, cache_creation: 0 });
    const call = first.tool_uses[0];
    if (call === undefined) throw new Error('expected a tool call');

    const messages: ProviderMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: buildAssistantContent(first) },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: call.id, name: call.name, content: 'a.ts' }],
      },
    ];
    await collect(p.generate(reqGen({ messages })));
    expect(f.calls[1]?.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'go' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'glob', args: { pattern: '*.ts' } },
            thoughtSignature: signature,
          },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'glob', response: { output: 'a.ts' } } }],
      },
    ]);
  });
});

describe('createGoogleProvider over HTTP', () => {
  test('events split across reads and framed with CRLF are reassembled', async () => {
    const text = sse(textChunks);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < text.length; i += 7)
          controller.enqueue(encoder.encode(text.slice(i, i + 7)));
        controller.close();
      },
    });
    const f = recordingFetch(() => sseResponse(body));
    const ev = await collect(make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen()));
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
  });

  test('a final event without a trailing blank line is still read', async () => {
    const f = recordingFetch(() =>
      sseResponse(
        `data: ${JSON.stringify(textChunks[0])}\n\ndata: ${JSON.stringify(textChunks[1])}`,
      ),
    );
    const ev = await collect(make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen()));
    expect(ev.map((e) => e.kind)).toEqual(['start', 'text_delta', 'usage', 'stop']);
  });

  test('an event that is not a JSON object fails the stream', async () => {
    const f = recordingFetch(() => sseResponse('data: [1]\n\n'));
    const e = await caught(make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen()));
    expect(e).toBeInstanceOf(GoogleHttpError);
  });

  test('a quota error carries the retry delay the server advises', async () => {
    const f = recordingFetch(() =>
      errorResponse(429, {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'Quota exceeded',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7.5s' }],
      }),
    );
    const e = await caught(make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen()));
    expect(e).toBeInstanceOf(GoogleHttpError);
    expect(isRetryableError(e)).toBe(true);
    expect(retryAfterMs(e)).toBe(7_500);
  });

  test('an abort while the error body is read is reported as an abort', async () => {
    const controller = new AbortController();
    const f = recordingFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"error":'));
          controller.signal.addEventListener('abort', () => stream.error(new Error('aborted')));
        },
      });
      setTimeout(() => controller.abort(), 10);
      return new Response(body, { status: 503 });
    });
    const e = await caught(
      make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen(), controller.signal),
    );
    expect(e).toBeInstanceOf(AbortError);
  });

  test('a prompt over the context window is a ContextOverflowError', async () => {
    const f = recordingFetch(() =>
      errorResponse(400, {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message:
          'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      }),
    );
    const e = await caught(make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen()));
    expect(e).toBeInstanceOf(ContextOverflowError);
    expect(isRetryableError(e)).toBe(false);
  });

  test('other rejections keep their status and message, and only 429 and 5xx are retried', async () => {
    for (const [status, name, retryable] of [
      [400, 'INVALID_ARGUMENT', false],
      [402, 'RESOURCE_EXHAUSTED', false],
      [403, 'PERMISSION_DENIED', false],
      [429, 'RESOURCE_EXHAUSTED', true],
      [500, 'INTERNAL', true],
      [503, 'UNAVAILABLE', true],
    ] as const) {
      const f = recordingFetch(() =>
        errorResponse(status, { code: status, status: name, message: `problem ${status}` }),
      );
      const e = await caught(make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen()));
      expect(e).toBeInstanceOf(GoogleHttpError);
      expect(e).toMatchObject({ status });
      expect((e as Error).message).toContain(`HTTP ${status} ${name}: problem ${status}`);
      expect((e as Error).message).not.toContain('g-test');
      expect(isRetryableError(e)).toBe(retryable);
    }
  });

  test('an error body in an array or as an event is read too', async () => {
    for (const body of [
      JSON.stringify([{ error: { code: 400, message: 'listed', status: 'INVALID_ARGUMENT' } }]),
      `data: ${JSON.stringify({ error: { code: 400, message: 'framed' } })}`,
    ]) {
      const f = recordingFetch(() => new Response(body, { status: 400 }));
      const e = await caught(make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen()));
      expect((e as Error).message).toMatch(/listed|framed/);
    }
  });

  test('generateWithRetry repeats a 503 and stops at the attempt limit', async () => {
    const f = recordingFetch(() => errorResponse(503, { code: 503, message: 'overloaded' }));
    const p = make('gemini-3.5-flash', { fetch: f.fetch });
    await expect(
      collect(
        generateWithRetry(p, reqGen(), undefined, {
          maxAttempts: 3,
          baseDelayMs: 1,
          sleep: () => Promise.resolve(),
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(3);
  });

  test('a connection failure is a retryable ProviderRequestError', async () => {
    const p = make('gemini-3.5-flash', {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const e = await caught(p.generate(reqGen()));
    expect(e).toBeInstanceOf(ProviderRequestError);
    expect(isRetryableError(e)).toBe(true);
  });

  test('a stream that breaks while reading is a retryable ProviderRequestError', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunks[0])}\n\n`));
        controller.error(new Error('connection reset'));
      },
    });
    const events: StreamEvent[] = [];
    let error: unknown;
    try {
      const p = make('gemini-3.5-flash', { fetch: async () => sseResponse(body) });
      for await (const ev of p.generate(reqGen())) events.push(ev);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(isRetryableError(error)).toBe(true);
  });

  test('a pre-aborted signal throws AbortError without sending a request', async () => {
    const f = recordingFetch();
    const ctrl = new AbortController();
    ctrl.abort();
    const e = await caught(
      make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen(), ctrl.signal),
    );
    expect(e).toBeInstanceOf(AbortError);
    expect(f.calls).toHaveLength(0);
  });

  test('aborting mid-stream cancels the request and reports no clean stop', async () => {
    const encoder = new TextEncoder();
    let fetchSignal: AbortSignal | undefined;
    const p = make('gemini-3.5-flash', {
      fetch: async (_url, init) => {
        fetchSignal = init?.signal ?? undefined;
        const signal = fetchSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunks[0])}\n\n`));
            signal?.addEventListener('abort', () => controller.error(signal.reason), {
              once: true,
            });
          },
        });
        return sseResponse(body);
      },
    });
    const ctrl = new AbortController();
    const events: StreamEvent[] = [];
    let error: unknown;
    try {
      for await (const ev of p.generate(reqGen(), ctrl.signal)) {
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

  test('an invalid function call from the API becomes an invalid tool call event', async () => {
    const f = recordingFetch(() =>
      sseResponse(sse([{ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }])),
    );
    const ev = await collect(make('gemini-3.5-flash', { fetch: f.fetch }).generate(reqGen()));
    expect(ev.find((e) => e.kind === 'error')).toMatchObject({ code: INVALID_TOOL_CALL });
  });
});
