import OpenAI, { APIConnectionError, APIError, type ClientOptions } from 'openai';
import {
  AbortError,
  ContextOverflowError,
  isContextOverflowMessage,
  ProviderRequestError,
} from '../errors.ts';

// Shared by the adapters that speak the OpenAI API through the OpenAI SDK (OpenAI itself and xAI).

export interface CompatibleClientOptions {
  apiKey?: string;
  // Pre-built SDK client; when set, `apiKey` and `fetch` are ignored.
  client?: OpenAI;
  fetch?: ClientOptions['fetch'];
}

export interface CompatibleService {
  // Names the service in messages, such as "OpenAI" or "xAI".
  name: string;
  // Environment variable that holds the key, for the message when it is missing.
  keyEnv: string;
}

export const buildCompatibleClient = (
  options: CompatibleClientOptions,
  baseURL: string,
  service: CompatibleService,
): OpenAI => {
  if (options.client !== undefined) return options.client;
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`${service.name} API key required (set ${service.keyEnv})`);
  }
  const sdkOptions: ClientOptions = {
    apiKey,
    baseURL,
    // The SDK otherwise reads OPENAI_ORG_ID and OPENAI_PROJECT_ID from the environment and sends
    // them as headers, which would disclose account details to another service.
    organization: null,
    project: null,
    // Retries happen in generateWithRetry; SDK retries would multiply the attempts.
    maxRetries: 0,
    // The SDK logs to the console, which would write into the terminal interface.
    logLevel: 'off',
  };
  if (options.fetch !== undefined) sdkOptions.fetch = options.fetch;
  return new OpenAI(sdkOptions);
};

// Connection failures and timeouts carry no HTTP status, so the generic retry classification
// cannot tell them apart from permanent errors; they are marked transient here.
export const classifyCompatibleError = (
  error: unknown,
  signal: AbortSignal | undefined,
  service: CompatibleService,
): unknown => {
  if (signal?.aborted === true) return new AbortError();
  if (error instanceof APIConnectionError) {
    return new ProviderRequestError(`connection to ${service.name} failed: ${error.message}`, {
      retryable: true,
      cause: error,
    });
  }
  if (
    error instanceof APIError &&
    error.status === 400 &&
    (error.code === 'context_length_exceeded' || isContextOverflowMessage(error.message))
  ) {
    return new ContextOverflowError(error.message, { cause: error });
  }
  return error;
};

// Opens the stream and yields its items. A stream error that the SDK throws is handed back through
// `toItem`, so the normalizer reports it as an error event; a body `toItem` cannot represent is
// rethrown. An abort that the SDK turns into a silent end of the stream becomes AbortError, so the
// truncated turn does not look complete.
export async function* streamItems<T>(
  open: () => Promise<unknown>,
  toItem: (body: unknown) => T | undefined,
  signal: AbortSignal | undefined,
  service: CompatibleService,
): AsyncIterable<T> {
  let stream: AsyncIterable<T>;
  try {
    stream = (await open()) as AsyncIterable<T>;
  } catch (e) {
    throw classifyCompatibleError(e, signal, service);
  }
  try {
    for await (const item of stream) yield item;
  } catch (e) {
    const item =
      signal?.aborted !== true && e instanceof APIError && e.status === undefined
        ? toItem(e.error)
        : undefined;
    if (item !== undefined) {
      yield item;
      return;
    }
    throw classifyCompatibleError(e, signal, service);
  }
  if (signal?.aborted === true) throw new AbortError();
}
