// Message of an unknown thrown value, for reporting. Falls back to the error name when the
// message is empty, as some SDK errors have no message.
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);
