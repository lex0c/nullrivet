import { describe, expect, test } from 'bun:test';
import { AbortError } from '../../src/agent/abortable.ts';
import { findCatalogEntry, MODEL_CATALOG } from '../../src/providers/catalog.ts';
import type { FetchLike } from '../../src/providers/discovery.ts';
import { DEFAULT_OPENROUTER_BASE_URL } from '../../src/providers/openrouter/index.ts';
import {
  DEFAULT_CAPABILITIES,
  type ResolveOptions,
  type ResolveResult,
  resolveModel,
} from '../../src/providers/resolve.ts';
import type { ProviderCapabilities } from '../../src/providers/types.ts';

const ENV = { OPENROUTER_API_KEY: 'sk-test' };
const CATALOG_ID = 'openrouter/deepseek/deepseek-v4-flash';

const catalogCapabilities = (id: string): ProviderCapabilities => {
  const entry = findCatalogEntry(id);
  if (entry === undefined) throw new Error(`test setup: ${id} is not in the catalog`);
  return entry.capabilities;
};

const listedModel = {
  id: 'vendor/listed-model',
  context_length: 64_000,
  top_provider: { max_completion_tokens: 4_000 },
  supported_parameters: ['tools', 'reasoning'],
};

interface RecordingFetch {
  fetch: FetchLike;
  urls: string[];
}

const listingFetch = (data: unknown[]): RecordingFetch => {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  };
};

const failingFetch = (): RecordingFetch => {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      throw new TypeError('fetch failed');
    },
  };
};

// Every call gets a fresh discovery cache, so no test depends on another's listing.
const resolve = (id: string, over: ResolveOptions = {}): Promise<ResolveResult> =>
  resolveModel(id, { env: ENV, discoveryCache: new Map(), ...over });

const expectOk = (r: ResolveResult): Extract<ResolveResult, { ok: true }> => {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r;
};

const expectError = (r: ResolveResult): string => {
  if (r.ok) throw new Error(`expected an error, got source ${r.source}`);
  return r.error;
};

describe('MODEL_CATALOG', () => {
  test('ids are unique and carry the family prefix of their entry', () => {
    const ids = MODEL_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of MODEL_CATALOG) {
      expect(entry.id).toBe(`${entry.family}/${entry.model}`);
      expect(entry.capabilities.context_window).toBeGreaterThan(0);
      expect(entry.capabilities.output_max_tokens).toBeGreaterThan(0);
      expect(entry.capabilities.output_max_tokens).toBeLessThanOrEqual(
        entry.capabilities.context_window,
      );
    }
  });

  test('findCatalogEntry matches the full id only', () => {
    expect(findCatalogEntry(CATALOG_ID)?.model).toBe('deepseek/deepseek-v4-flash');
    expect(findCatalogEntry('deepseek/deepseek-v4-flash')).toBeUndefined();
  });
});

describe('resolveModel', () => {
  test('a catalog hit is used as-is and discovery is not consulted', async () => {
    const f = listingFetch([listedModel]);
    const r = expectOk(await resolve(CATALOG_ID, { fetch: f.fetch }));
    expect(r.source).toBe('catalog');
    expect(r.warnings).toEqual([]);
    expect(r.provider.id).toBe(CATALOG_ID);
    expect(r.provider.capabilities).toEqual(catalogCapabilities(CATALOG_ID));
    expect(f.urls).toEqual([]);
  });

  test('the catalog entry is not mutated by overrides', async () => {
    const before = structuredClone(catalogCapabilities(CATALOG_ID));
    await resolve(CATALOG_ID, { overrides: { contextWindow: 10, maxOutput: 5 } });
    expect(catalogCapabilities(CATALOG_ID)).toEqual(before);
  });

  test('a model missing from the catalog is discovered', async () => {
    const f = listingFetch([listedModel]);
    const r = expectOk(await resolve('openrouter/vendor/listed-model', { fetch: f.fetch }));
    expect(r.source).toBe('discovery');
    expect(r.warnings).toEqual([]);
    expect(r.provider.id).toBe('openrouter/vendor/listed-model');
    expect(r.provider.capabilities).toEqual({
      context_window: 64_000,
      output_max_tokens: 4_000,
      supports_reasoning: true,
      supports_sampling: false,
    });
    expect(f.urls).toEqual([`${DEFAULT_OPENROUTER_BASE_URL}/models`]);
  });

  test('discovery uses the configured base URL', async () => {
    const f = listingFetch([listedModel]);
    expectOk(
      await resolve('openrouter/vendor/listed-model', {
        fetch: f.fetch,
        env: { ...ENV, NULLRIVET_OPENROUTER_BASE_URL: 'https://proxy.test/v1/' },
      }),
    );
    expect(f.urls).toEqual(['https://proxy.test/v1/models']);
  });

  test('a discovered model without tool support is an error', async () => {
    const f = listingFetch([{ ...listedModel, supported_parameters: ['temperature'] }]);
    const error = expectError(await resolve('openrouter/vendor/listed-model', { fetch: f.fetch }));
    expect(error).toContain('openrouter/vendor/listed-model');
    expect(error).toContain('does not support tool calling');
  });

  test('a model the listing does not contain is an error', async () => {
    const f = listingFetch([listedModel]);
    const error = expectError(await resolve('openrouter/vendor/typo', { fetch: f.fetch }));
    expect(error).toContain('does not list model "vendor/typo"');
  });

  test('falls back to defaults with a warning when discovery fails', async () => {
    const f = failingFetch();
    const r = expectOk(await resolve('openrouter/vendor/unlisted', { fetch: f.fetch }));
    expect(r.source).toBe('defaults');
    expect(r.provider.capabilities).toEqual({
      context_window: 32_768,
      output_max_tokens: 8_192,
      supports_sampling: false,
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('openrouter/vendor/unlisted');
    expect(r.warnings[0]).toContain('fetch failed');
    expect(f.urls).toHaveLength(1);
  });

  test('the defaults object is not shared with the provider', async () => {
    const r = expectOk(
      await resolve('openrouter/vendor/unlisted', { fetch: failingFetch().fetch }),
    );
    expect(r.provider.capabilities).not.toBe(DEFAULT_CAPABILITIES);
  });

  test('overrides apply over every source', async () => {
    const overrides = { contextWindow: 100_000, maxOutput: 2_000 };
    const catalog = expectOk(await resolve(CATALOG_ID, { overrides }));
    const discovered = expectOk(
      await resolve('openrouter/vendor/listed-model', {
        overrides,
        fetch: listingFetch([listedModel]).fetch,
      }),
    );
    const defaults = expectOk(
      await resolve('openrouter/vendor/unlisted', { overrides, fetch: failingFetch().fetch }),
    );
    for (const r of [catalog, discovered, defaults]) {
      expect(r.provider.capabilities.context_window).toBe(100_000);
      expect(r.provider.capabilities.output_max_tokens).toBe(2_000);
    }
    expect(discovered.provider.capabilities.supports_reasoning).toBe(true);
  });

  test('a single override leaves the other field from the source', async () => {
    const r = expectOk(await resolve(CATALOG_ID, { overrides: { maxOutput: 1_000 } }));
    expect(r.provider.capabilities.output_max_tokens).toBe(1_000);
    expect(r.provider.capabilities.context_window).toBe(
      catalogCapabilities(CATALOG_ID).context_window,
    );
  });

  test('invalid overrides are rejected', async () => {
    for (const overrides of [{ contextWindow: 0 }, { maxOutput: -1 }, { contextWindow: 1.5 }]) {
      expect(expectError(await resolve(CATALOG_ID, { overrides }))).toContain(
        'expected a positive integer',
      );
    }
  });

  test('a missing API key is an error naming the variable', async () => {
    for (const env of [{}, { OPENROUTER_API_KEY: '' }]) {
      const f = listingFetch([listedModel]);
      const error = expectError(await resolve(CATALOG_ID, { env, fetch: f.fetch }));
      expect(error).toContain('OPENROUTER_API_KEY');
      expect(f.urls).toEqual([]);
    }
  });

  test('an invalid base URL is an error that does not echo the value', async () => {
    for (const value of ['not a url', 'ftp://host/v1', 'file:///etc/passwd']) {
      const error = expectError(
        await resolve(CATALOG_ID, { env: { ...ENV, NULLRIVET_OPENROUTER_BASE_URL: value } }),
      );
      expect(error).toContain('NULLRIVET_OPENROUTER_BASE_URL');
      expect(error).not.toContain(value);
    }
  });

  test('an unknown family is an error listing the supported families', async () => {
    const error = expectError(await resolve('foo/bar'));
    expect(error).toContain('unknown provider family "foo"');
    expect(error).toContain('supported families: openrouter');
  });

  test('a known family without an adapter is not supported yet', async () => {
    for (const family of ['anthropic', 'openai', 'ollama', 'google', 'xai']) {
      const error = expectError(await resolve(`${family}/some-model`));
      expect(error).toContain(`"${family}" is not supported yet`);
      expect(error).toContain('supported families: openrouter');
    }
  });

  test('ids without a family or a model are rejected', async () => {
    for (const id of ['', 'openrouter', 'openrouter/', '/model']) {
      expect(expectError(await resolve(id))).toContain('expected <family>/<model>');
    }
  });

  test('the family is split at the first slash only', async () => {
    const f = listingFetch([{ ...listedModel, id: 'a/b/c' }]);
    const r = expectOk(await resolve('openrouter/a/b/c', { fetch: f.fetch }));
    expect(r.provider.id).toBe('openrouter/a/b/c');
  });

  test('an abort during discovery throws AbortError', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      resolve('openrouter/vendor/listed-model', {
        signal: ctrl.signal,
        fetch: listingFetch([listedModel]).fetch,
      }),
    ).rejects.toBeInstanceOf(AbortError);
  });

  test('the provider reads adapter settings from the injected env', async () => {
    const r = expectOk(
      await resolve(CATALOG_ID, {
        env: { ...ENV, NULLRIVET_OPENROUTER_REASONING_REPLAY: 'off' },
      }),
    );
    expect(r.provider.replaysReasoning).toBe(false);
  });
});
