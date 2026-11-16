import { describe, expect, test } from 'bun:test';
import { AbortError } from '../../src/agent/abortable.ts';
import { findCatalogEntry, MODEL_CATALOG } from '../../src/providers/catalog.ts';
import type { FetchLike } from '../../src/providers/discovery.ts';
import { DEFAULT_OLLAMA_BASE_URL } from '../../src/providers/ollama/http.ts';
import { DEFAULT_OLLAMA_NUM_CTX } from '../../src/providers/ollama/messages.ts';
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
    expect(error).toContain('supported families: anthropic, ollama, openai, openrouter');
  });

  test('a known family without an adapter is not supported yet', async () => {
    for (const family of ['google', 'xai']) {
      const error = expectError(await resolve(`${family}/some-model`));
      expect(error).toContain(`"${family}" is not supported yet`);
      expect(error).toContain('supported families: anthropic, ollama, openai, openrouter');
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

describe('resolveModel for the direct provider families', () => {
  const resolveWith = (id: string, env: Record<string, string>, over: ResolveOptions = {}) =>
    resolveModel(id, { env, discoveryCache: new Map(), ...over });

  test('catalog models of each family resolve with the family key', async () => {
    for (const [id, env] of [
      ['anthropic/claude-opus-4-8', { ANTHROPIC_API_KEY: 'sk-ant' }],
      ['openai/gpt-5.4', { OPENAI_API_KEY: 'sk-oai' }],
      ['openai/gpt-4o', { OPENAI_API_KEY: 'sk-oai' }],
    ] as const) {
      const r = expectOk(await resolveWith(id, env));
      expect(r.source).toBe('catalog');
      expect(r.provider.id).toBe(id);
      expect(r.provider.capabilities).toEqual(catalogCapabilities(id));
    }
  });

  test('a missing key is an error naming the variable of the family', async () => {
    for (const [id, variable] of [
      ['anthropic/claude-opus-4-8', 'ANTHROPIC_API_KEY'],
      ['openai/gpt-5.4', 'OPENAI_API_KEY'],
    ] as const) {
      const f = listingFetch([]);
      const error = expectError(
        await resolveWith(id, { OPENROUTER_API_KEY: 'x' }, { fetch: f.fetch }),
      );
      expect(error).toContain(variable);
      expect(f.urls).toEqual([]);
    }
  });

  test('a model outside the Anthropic or OpenAI catalog gets defaults with a warning', async () => {
    const r = expectOk(await resolveWith('anthropic/claude-future', { ANTHROPIC_API_KEY: 'k' }));
    expect(r.source).toBe('defaults');
    expect(r.warnings[0]).toContain('no discovery endpoint');
    expect(r.provider.id).toBe('anthropic/claude-future');
  });

  test('adapter warnings are returned to the caller', async () => {
    const r = expectOk(
      await resolveWith('openai/gpt-5.5', {
        OPENAI_API_KEY: 'k',
        NULLRIVET_OPENAI_PROMPT_CACHE_RETENTION: 'in_memory',
      }),
    );
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('24h');
  });

  test('a local Ollama catalog model needs no key and serves the capped window', async () => {
    const r = expectOk(await resolveWith('ollama/llama3.1:8b', {}));
    expect(r.source).toBe('catalog');
    expect(r.provider.capabilities.context_window).toBe(DEFAULT_OLLAMA_NUM_CTX);
  });

  test('an Ollama Cloud catalog model requires OLLAMA_API_KEY', async () => {
    const error = expectError(await resolveWith('ollama/glm-5.2', {}));
    expect(error).toContain('OLLAMA_API_KEY');
    expect(error).toContain('https://ollama.com');
    const r = expectOk(await resolveWith('ollama/glm-5.2', { OLLAMA_API_KEY: 'ok' }));
    expect(r.provider.capabilities.context_window).toBe(
      catalogCapabilities('ollama/glm-5.2').context_window,
    );
  });

  interface ShowCall {
    url: string;
    headers: Headers;
  }

  const showFetch = (payload: unknown, status = 200) => {
    const calls: ShowCall[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(payload), { status });
    };
    return { calls, fetch: fetchImpl };
  };

  const toolModel = {
    model_info: { 'general.architecture': 'llama', 'llama.context_length': 131_072 },
    capabilities: ['completion', 'tools', 'thinking'],
  };

  test('an Ollama model outside the catalog is discovered on the local server', async () => {
    const f = showFetch(toolModel);
    const r = expectOk(
      await resolveWith(
        'ollama/my-model:latest',
        { OLLAMA_API_KEY: 'cloud-key' },
        { fetch: f.fetch },
      ),
    );
    expect(r.source).toBe('discovery');
    expect(r.provider.capabilities).toMatchObject({
      context_window: DEFAULT_OLLAMA_NUM_CTX,
      supports_reasoning: true,
    });
    expect(f.calls.map((c) => c.url)).toEqual([`${DEFAULT_OLLAMA_BASE_URL}/api/show`]);
    // The cloud key never reaches a server that does not use it.
    expect(f.calls[0]?.headers.has('authorization')).toBe(false);
  });

  test('an Ollama model without tool support or missing on the server is an error', async () => {
    const rejected = showFetch({ ...toolModel, capabilities: ['completion'] });
    expect(expectError(await resolveWith('ollama/plain', {}, { fetch: rejected.fetch }))).toContain(
      'does not support tool calling',
    );
    const missing = showFetch({ error: 'not found' }, 404);
    expect(expectError(await resolveWith('ollama/typo', {}, { fetch: missing.fetch }))).toContain(
      'ollama pull typo',
    );
  });

  test('an unreachable Ollama server falls back to defaults with a warning', async () => {
    const r = expectOk(
      await resolveWith(
        'ollama/anything',
        {},
        {
          fetch: async () => {
            throw new TypeError('fetch failed');
          },
        },
      ),
    );
    expect(r.source).toBe('defaults');
    expect(r.warnings[0]).toContain('fetch failed');
  });

  test('NULLRIVET_OLLAMA_BASE_URL applies to every Ollama model', async () => {
    const f = showFetch(toolModel);
    expectOk(
      await resolveWith(
        'ollama/my-model',
        { NULLRIVET_OLLAMA_BASE_URL: 'http://gpu-box:11434/' },
        { fetch: f.fetch },
      ),
    );
    expect(f.calls[0]?.url).toBe('http://gpu-box:11434/api/show');
    // A cloud catalog model served by a local daemon needs no key.
    expectOk(
      await resolveWith('ollama/glm-5.2', { NULLRIVET_OLLAMA_BASE_URL: 'http://localhost:11434' }),
    );
  });

  test('discovery against Ollama Cloud sends the key', async () => {
    const f = showFetch(toolModel);
    expectOk(
      await resolveWith(
        'ollama/cloud-only',
        { NULLRIVET_OLLAMA_BASE_URL: 'https://ollama.com', OLLAMA_API_KEY: 'ok' },
        { fetch: f.fetch },
      ),
    );
    expect(f.calls[0]?.headers.get('authorization')).toBe('Bearer ok');
  });
});
