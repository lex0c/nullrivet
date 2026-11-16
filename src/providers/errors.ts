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
