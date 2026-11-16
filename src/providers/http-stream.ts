import { errorMessage } from '../errors.ts';
import { AbortError, ProviderRequestError } from './errors.ts';

// Messages may reach logs, so they never carry credentials or query parameters from the URL.
export const displayOrigin = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '<invalid url>';
  }
};

export interface ReadLinesOptions {
  // Names the source in error messages, such as "Ollama /api/chat".
  label: string;
  // A line this long without a newline means a runaway or hostile stream.
  maxLineChars: number;
  signal: AbortSignal | undefined;
  // Builds the error for a malformed stream; the provider's own error type keeps its handling.
  fail: (message: string) => Error;
}

// The lines of a streamed response body, without their line terminators. A read that fails is
// transient unless the request was aborted; the body is released when the caller stops reading,
// and a body cancelled by an abort ends with AbortError rather than looking complete.
export async function* readLines(res: Response, options: ReadLinesOptions): AsyncIterable<string> {
  const aborted = (): boolean => options.signal?.aborted === true;
  if (res.body === null) throw options.fail(`${options.label} returned no response body`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (aborted()) throw new AbortError();
        throw new ProviderRequestError(`${options.label} stream failed: ${errorMessage(e)}`, {
          retryable: true,
          cause: e,
        });
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        yield buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > options.maxLineChars) {
        throw options.fail(
          `${options.label} sent more than ${options.maxLineChars} characters without a newline`,
        );
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.replace(/\r$/, '');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (aborted()) throw new AbortError();
}
