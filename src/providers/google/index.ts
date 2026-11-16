import type { FetchLike } from '../discovery.ts';
import type { GenerateRequest, Provider, ProviderCapabilities, StreamEvent } from '../types.ts';
import { createGoogleHttp, DEFAULT_GOOGLE_BASE_URL } from './http.ts';
import { buildGoogleRequest } from './messages.ts';
import { normalizeGoogleStream } from './stream.ts';

export interface CreateGoogleProviderOptions {
  capabilities: ProviderCapabilities;
  apiKey?: string;
  baseURL?: string;
  fetch?: FetchLike;
}

export const createGoogleProvider = (
  modelName: string,
  options: CreateGoogleProviderOptions,
): Provider => {
  const caps = options.capabilities;
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('Gemini API key required (set GEMINI_API_KEY)');
  }
  const httpOptions: Parameters<typeof createGoogleHttp>[0] = {
    baseUrl: options.baseURL ?? DEFAULT_GOOGLE_BASE_URL,
    apiKey,
  };
  if (options.fetch !== undefined) httpOptions.fetch = options.fetch;
  const http = createGoogleHttp(httpOptions);

  return {
    id: `google/${modelName}`,
    family: 'google',
    capabilities: caps,
    // Thinking models sign their function calls, and Gemini 3 and later reject a function call of
    // the current turn whose signature is not sent back, so reasoning is always replayed.
    replaysReasoning: true,
    generate: (req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> =>
      normalizeGoogleStream(
        (async function* () {
          yield* http.streamGenerateContent(modelName, buildGoogleRequest(req, caps), signal);
        })(),
      ),
  };
};
