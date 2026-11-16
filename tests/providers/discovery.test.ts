import { describe, expect, test } from 'bun:test';
import { AbortError } from '../../src/agent/abortable.ts';
import {
  DISCOVERED_OUTPUT_FALLBACK,
  type DiscoveryCache,
  type DiscoveryOptions,
  discoverOllamaModel,
  discoverOpenRouterModel,
  type FetchLike,
} from '../../src/providers/discovery.ts';

const BASE = 'https://openrouter.test/api/v1';

const listing = (...data: unknown[]): unknown => ({ data });

const toolModel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'vendor/model',
  context_length: 200_000,
  top_provider: { context_length: 128_000, max_completion_tokens: 16_000 },
  supported_parameters: ['tools', 'tool_choice', 'temperature', 'top_p'],
  ...over,
});

interface MockFetch {
  fetch: FetchLike;
  urls: string[];
}

const jsonFetch = (payload: unknown, status = 200): MockFetch => {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
};

// Never answers; rejects only when the request signal aborts, like a real stalled connection.
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });

const discover = (model: string, fetchImpl: FetchLike, over: Partial<DiscoveryOptions> = {}) =>
  discoverOpenRouterModel(model, { baseUrl: BASE, fetch: fetchImpl, cache: new Map(), ...over });

describe('discoverOpenRouterModel', () => {
  test('uses the smaller of the listed and the served context window', async () => {
    const m = jsonFetch(listing(toolModel()));
    const result = await discover('vendor/model', m.fetch);
    expect(result).toEqual({
      ok: true,
      capabilities: { context_window: 128_000, output_max_tokens: 16_000 },
    });
    expect(m.urls).toEqual([`${BASE}/models`]);
  });

  test('falls back to the listed context window when the served one is absent', async () => {
    const m = jsonFetch(listing(toolModel({ top_provider: { max_completion_tokens: 16_000 } })));
    const result = await discover('vendor/model', m.fetch);
    expect(result).toEqual({
      ok: true,
      capabilities: { context_window: 200_000, output_max_tokens: 16_000 },
    });
  });

  test('a trailing slash on the base URL is not doubled', async () => {
    const m = jsonFetch(listing(toolModel()));
    await discover('vendor/model', m.fetch, { baseUrl: `${BASE}/` });
    expect(m.urls).toEqual([`${BASE}/models`]);
  });

  test('`reasoning` marks reasoning support without inferring effort levels', async () => {
    const m = jsonFetch(
      listing(
        toolModel({
          supported_parameters: ['tools', 'reasoning', 'reasoning_effort', 'temperature'],
        }),
      ),
    );
    const result = await discover('vendor/model', m.fetch);
    expect(result).toEqual({
      ok: true,
      capabilities: {
        context_window: 128_000,
        output_max_tokens: 16_000,
        supports_reasoning: true,
      },
    });
  });

  test('a model without `temperature` is marked as rejecting sampling', async () => {
    const m = jsonFetch(listing(toolModel({ supported_parameters: ['tools'] })));
    const result = await discover('vendor/model', m.fetch);
    expect(result.ok && result.capabilities.supports_sampling).toBe(false);
  });

  test('a missing completion limit falls back to the default output cap', async () => {
    const m = jsonFetch(listing(toolModel({ top_provider: { max_completion_tokens: null } })));
    const result = await discover('vendor/model', m.fetch);
    expect(result.ok && result.capabilities.output_max_tokens).toBe(DISCOVERED_OUTPUT_FALLBACK);
  });

  test('the output cap never exceeds the context window', async () => {
    const m = jsonFetch(
      listing(
        toolModel({ context_length: 4_096, top_provider: { max_completion_tokens: 65_536 } }),
      ),
    );
    const result = await discover('vendor/model', m.fetch);
    expect(result.ok && result.capabilities.output_max_tokens).toBe(4_096);
  });

  test('a model without tool support is rejected', async () => {
    const m = jsonFetch(listing(toolModel({ supported_parameters: ['temperature'] })));
    const result = await discover('vendor/model', m.fetch);
    expect(result).toMatchObject({ ok: false, kind: 'rejected' });
    expect(!result.ok && result.error).toContain('does not support tool calling');
  });

  test('a model absent from the listing is not_found', async () => {
    const m = jsonFetch(listing(toolModel()));
    const result = await discover('vendor/other', m.fetch);
    expect(result).toMatchObject({ ok: false, kind: 'not_found' });
  });

  test('malformed entries are skipped without invalidating the listing', async () => {
    const m = jsonFetch(
      listing(null, 42, 'x', [], { id: 7 }, { id: '' }, { context_length: 1 }, toolModel()),
    );
    const result = await discover('vendor/model', m.fetch);
    expect(result.ok).toBe(true);
  });

  test('wrongly typed fields of the requested model make discovery unavailable', async () => {
    for (const over of [
      { context_length: '200000' },
      { context_length: -1 },
      { context_length: 1.5 },
      { supported_parameters: 'tools' },
    ]) {
      const m = jsonFetch(listing(toolModel(over)));
      const result = await discover('vendor/model', m.fetch);
      expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
    }
  });

  test('non-string supported_parameters entries are ignored', async () => {
    const m = jsonFetch(listing(toolModel({ supported_parameters: [1, null, 'tools'] })));
    const result = await discover('vendor/model', m.fetch);
    expect(result.ok).toBe(true);
  });

  test('payloads without a data array are unavailable', async () => {
    for (const payload of [null, [], { data: 'x' }, { models: [] }, 'not json']) {
      const m = jsonFetch(payload);
      const result = await discover('vendor/model', m.fetch);
      expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
    }
  });

  test('an HTTP error status is unavailable', async () => {
    const m = jsonFetch({ error: 'nope' }, 503);
    const result = await discover('vendor/model', m.fetch);
    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(!result.ok && result.error).toContain('HTTP 503');
  });

  test('a network failure is unavailable', async () => {
    const result = await discover('vendor/model', async () => {
      throw new TypeError('fetch failed');
    });
    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(!result.ok && result.error).toContain('fetch failed');
  });

  test('a stalled request times out as unavailable', async () => {
    const result = await discover('vendor/model', hangingFetch, { timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(!result.ok && result.error).toContain('timed out after 20 ms');
  });

  test('an abort from the caller throws AbortError', async () => {
    const ctrl = new AbortController();
    const pending = discover('vendor/model', hangingFetch, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  test('error messages never include credentials or query strings from the base URL', async () => {
    const m = jsonFetch({}, 500);
    const result = await discover('vendor/model', m.fetch, {
      baseUrl: 'https://user:secret@proxy.test/v1?token=abc',
    });
    expect(!result.ok && result.error).not.toContain('secret');
    expect(!result.ok && result.error).not.toContain('abc');
  });

  test('a successful listing is cached per base URL', async () => {
    const cache: DiscoveryCache = new Map();
    const m = jsonFetch(listing(toolModel(), toolModel({ id: 'vendor/second' })));
    await discover('vendor/model', m.fetch, { cache });
    await discover('vendor/second', m.fetch, { cache });
    await discover('vendor/missing', m.fetch, { cache });
    expect(m.urls).toHaveLength(1);
    await discover('vendor/model', m.fetch, { cache, baseUrl: 'https://other.test/v1' });
    expect(m.urls).toHaveLength(2);
  });

  test('a failed listing is not cached', async () => {
    const cache: DiscoveryCache = new Map();
    const failing = jsonFetch({}, 500);
    await discover('vendor/model', failing.fetch, { cache });
    const working = jsonFetch(listing(toolModel()));
    const result = await discover('vendor/model', working.fetch, { cache });
    expect(result.ok).toBe(true);
  });
});

const OLLAMA = 'http://localhost:11434';

const showPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  details: { family: 'llama' },
  model_info: { 'general.architecture': 'llama', 'llama.context_length': 131_072 },
  capabilities: ['completion', 'tools'],
  ...over,
});

interface ShowCall {
  url: string;
  init: RequestInit | undefined;
}

const showFetch = (payload: unknown, status = 200) => {
  const calls: ShowCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch: fetchImpl };
};

const discoverOllama = (
  model: string,
  fetchImpl: FetchLike,
  over: Partial<DiscoveryOptions> = {},
) => discoverOllamaModel(model, { baseUrl: OLLAMA, fetch: fetchImpl, cache: new Map(), ...over });

describe('discoverOllamaModel', () => {
  test('reads the context length and tool support from POST /api/show', async () => {
    const m = showFetch(showPayload());
    const result = await discoverOllama('llama3.1:8b', m.fetch);
    expect(result).toEqual({
      ok: true,
      capabilities: { context_window: 131_072, output_max_tokens: DISCOVERED_OUTPUT_FALLBACK },
    });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.url).toBe(`${OLLAMA}/api/show`);
    expect(m.calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(m.calls[0]?.init?.body))).toEqual({ model: 'llama3.1:8b' });
    expect(new Headers(m.calls[0]?.init?.headers).has('authorization')).toBe(false);
  });

  test('`thinking` marks reasoning support', async () => {
    const m = showFetch(showPayload({ capabilities: ['completion', 'tools', 'thinking'] }));
    const result = await discoverOllama('qwen3:8b', m.fetch);
    expect(result.ok && result.capabilities.supports_reasoning).toBe(true);
  });

  test('the output cap never exceeds a small context window', async () => {
    const m = showFetch(
      showPayload({ model_info: { 'general.architecture': 'x', 'x.context_length': 4_096 } }),
    );
    const result = await discoverOllama('tiny', m.fetch);
    expect(result.ok && result.capabilities.output_max_tokens).toBe(4_096);
  });

  test('a model whose capabilities lack tools is rejected', async () => {
    const m = showFetch(showPayload({ capabilities: ['completion'] }));
    const result = await discoverOllama('gemma:2b', m.fetch);
    expect(result).toMatchObject({ ok: false, kind: 'rejected' });
    expect(!result.ok && result.error).toContain('does not support tool calling');
  });

  test('a server that reports no capabilities does not reject the model', async () => {
    const m = showFetch(showPayload({ capabilities: undefined }));
    const result = await discoverOllama('old', m.fetch);
    expect(result.ok).toBe(true);
  });

  test('an unambiguous context length is found without the architecture key', async () => {
    const m = showFetch(showPayload({ model_info: { 'qwen2.context_length': 32_768 } }));
    const result = await discoverOllama('qwen', m.fetch);
    expect(result.ok && result.capabilities.context_window).toBe(32_768);
  });

  test('a missing, malformed or ambiguous context length is unavailable', async () => {
    for (const modelInfo of [
      undefined,
      'x',
      {},
      { 'general.architecture': 'llama', 'llama.context_length': '8192' },
      { 'general.architecture': 'llama', 'llama.context_length': -1 },
      { 'a.context_length': 8_192, 'b.context_length': 4_096 },
    ]) {
      const m = showFetch(showPayload({ model_info: modelInfo }));
      const result = await discoverOllama('m', m.fetch);
      expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
    }
  });

  test('a payload that is not an object, or not JSON, is unavailable', async () => {
    for (const payload of [null, [], 'not json', 42]) {
      const m = showFetch(payload);
      const result = await discoverOllama('m', m.fetch);
      expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
    }
  });

  test('non-string capability entries are ignored', async () => {
    const m = showFetch(showPayload({ capabilities: [1, null, 'tools'] }));
    expect((await discoverOllama('m', m.fetch)).ok).toBe(true);
  });

  test('a 404 means the server does not have the model', async () => {
    const m = showFetch({ error: "model 'm' not found" }, 404);
    const result = await discoverOllama('m', m.fetch);
    expect(result).toMatchObject({ ok: false, kind: 'not_found' });
    expect(!result.ok && result.error).toContain('ollama pull m');
  });

  test('other HTTP errors, network failures and timeouts are unavailable', async () => {
    expect(await discoverOllama('m', showFetch({}, 500).fetch)).toMatchObject({
      ok: false,
      kind: 'unavailable',
    });
    const failed = await discoverOllama('m', async () => {
      throw new TypeError('fetch failed');
    });
    expect(failed).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(!failed.ok && failed.error).toContain('fetch failed');
    const stalled = await discoverOllama('m', hangingFetch, { timeoutMs: 20 });
    expect(!stalled.ok && stalled.error).toContain('timed out after 20 ms');
  });

  test('an abort from the caller throws AbortError', async () => {
    const ctrl = new AbortController();
    const pending = discoverOllama('m', hangingFetch, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  test('the API key is sent as a bearer token when given', async () => {
    const m = showFetch(showPayload());
    await discoverOllama('m', m.fetch, { baseUrl: 'https://ollama.com', apiKey: 'ok-key' });
    expect(new Headers(m.calls[0]?.init?.headers).get('authorization')).toBe('Bearer ok-key');
  });

  test('successful answers are cached per base URL and model; failures are not', async () => {
    const cache: DiscoveryCache = new Map();
    const m = showFetch(showPayload());
    await discoverOllama('a', m.fetch, { cache });
    await discoverOllama('a', m.fetch, { cache });
    await discoverOllama('b', m.fetch, { cache });
    expect(m.calls).toHaveLength(2);
    expect((await discoverOllama('a', m.fetch, { cache })).ok).toBe(true);
    expect(m.calls).toHaveLength(2);

    const missing = showFetch({ error: 'not found' }, 404);
    await discoverOllama('c', missing.fetch, { cache });
    await discoverOllama('c', missing.fetch, { cache });
    expect(missing.calls).toHaveLength(2);
  });
});
