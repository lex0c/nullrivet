import { describe, expect, test } from 'bun:test';
import { AbortError } from '../../src/agent/abortable.ts';
import {
  DISCOVERED_OUTPUT_FALLBACK,
  type DiscoveryCache,
  type DiscoveryOptions,
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
  test('maps context_length, max_completion_tokens and sampling support', async () => {
    const m = jsonFetch(listing(toolModel()));
    const result = await discover('vendor/model', m.fetch);
    expect(result).toEqual({
      ok: true,
      capabilities: { context_window: 200_000, output_max_tokens: 16_000 },
    });
    expect(m.urls).toEqual([`${BASE}/models`]);
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
        context_window: 200_000,
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
