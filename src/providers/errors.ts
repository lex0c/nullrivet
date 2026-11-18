// Has no `status` or network `code`, so the retry layer never treats an abort as retryable.
export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

// Thrown by adapters for failures their SDK reports in a shape the generic retry classification
// cannot recognize, such as a connection error without an HTTP status. The adapter knows its SDK,
// so it decides whether the failure is transient.
export class ProviderRequestError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderRequestError';
    this.retryable = options.retryable;
  }
}

// Stream error code for a tool call the model produced in a form that cannot be executed (missing
// name, arguments that are not a JSON object). The agent reports it back to the model instead of
// ending the turn.
export const INVALID_TOOL_CALL = 'tool_call.invalid';

// A response stream that ended before the provider reported how it finished.
export const STREAM_INCOMPLETE = 'stream.incomplete';

// Stream error code for a request the provider rejected because the prompt does not fit the
// context window. The agent recovers by compacting the conversation and retrying once.
export const CONTEXT_OVERFLOW = 'context_overflow';

// Thrown by adapters when the provider rejects a request before streaming because the prompt
// does not fit the context window, so the agent can compact and retry instead of failing.
export class ContextOverflowError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ContextOverflowError';
  }
}

// Wordings providers use when a prompt does not fit the context window: Anthropic ("prompt is too
// long", "exceed context limit"), xAI ("prompt is too long"), OpenAI ("context_length_exceeded",
// "exceeds the context window"), Ollama ("exceeds the context length", "exceeded max context
// length"), Gemini ("input token count ... exceeds the maximum number of tokens"), and the
// OpenAI-compatible servers whose errors OpenRouter relays ("maximum context length", "maximum
// prompt length"). Every pattern names the context, the prompt or the input token count, so an
// unrelated 400 such as an invalid parameter does not match.
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /context[_ ]length[_ ]exceeded/i,
  /maximum (context|prompt) length/i,
  /exceeds? (the )?(model'?s? )?context (window|length|limit)/i,
  /exceeded max context length/i,
  /input token count\b.*\bexceeds the maximum number of tokens/i,
];

export const isContextOverflowMessage = (text: string): boolean =>
  CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));

// Thrown by adapters when the provider rejects reasoning sent back from earlier turns, such as
// Anthropic thinking bound to a history that changed in a way the agent did not detect. The agent
// recovers by removing the reasoning from the conversation and sending the request again.
export class StaleReasoningError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StaleReasoningError';
  }
}

// Anthropic's wording for a thinking block it no longer accepts ("Invalid `signature` in
// `thinking` block").
const STALE_REASONING_PATTERN = /invalid `?signature`? in `?(redacted_)?thinking`? block/i;

export const isStaleReasoningMessage = (text: string): boolean =>
  STALE_REASONING_PATTERN.test(text);

// A rejected TLS certificate carries an OpenSSL verification code in `code`, such as
// UNABLE_TO_VERIFY_LEAF_SIGNATURE, CERT_HAS_EXPIRED or ERR_TLS_CERT_ALTNAME_INVALID. It does not
// change on a retry, and the code says more than the message, which can hold the request URL.
const CERTIFICATE_ERROR_CODE =
  /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)_|HOSTNAME_MISMATCH|INVALID_CA/;

// The SDKs wrap the fetch error in a connection error of their own and keep it as `cause`, so the
// chain is followed, a few levels deep.
export const certificateErrorCode = (error: unknown): string | undefined => {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && CERTIFICATE_ERROR_CODE.test(code)) return code;
    current = cause;
  }
  return undefined;
};

// Certificates rejected because their issuer is not trusted, which adding the issuing authority
// to NODE_EXTRA_CA_CERTS resolves; an expired certificate or a name mismatch it does not.
const UNTRUSTED_ISSUER_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

export const certificateRejection = (code: string): string =>
  UNTRUSTED_ISSUER_CODES.has(code)
    ? `its TLS certificate was rejected (${code}); if a certificate authority of your own signed it, add that authority with NODE_EXTRA_CA_CERTS`
    : `its TLS certificate was rejected (${code})`;
