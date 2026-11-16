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
// long", "exceed context limit"), OpenAI ("context_length_exceeded", "exceeds the context
// window"), Ollama ("exceeds the context length", "exceeded max context length"), and the
// OpenAI-compatible servers whose errors OpenRouter relays ("maximum context length", "maximum
// prompt length"). Every pattern names the context or prompt length, so an unrelated 400 such as
// an invalid parameter does not match.
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /context[_ ]length[_ ]exceeded/i,
  /maximum (context|prompt) length/i,
  /exceeds? (the )?(model'?s? )?context (window|length|limit)/i,
  /exceeded max context length/i,
  /input token count .* exceeds the maximum number of tokens/i,
];

export const isContextOverflowMessage = (text: string): boolean =>
  CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
