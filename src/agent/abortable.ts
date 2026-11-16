// Has no `status` or network `code`, so the retry layer never treats an abort as retryable.
export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

// Kept distinct from AbortError: a stall means the provider went silent, not that the user
// cancelled, and the loop reports the two differently.
export class StepStallError extends Error {
  constructor(public readonly stallMs: number) {
    super(`step stalled (no provider events for ${stallMs}ms)`);
    this.name = 'StepStallError';
  }
}

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// Throws StepStallError when the source yields nothing for `stallMs`. The timer runs only while
// `next()` is pending, so time the consumer spends handling a yielded value does not count, and
// the reject handle always belongs to the pull in flight when the timer fires.
// `stallMs <= 0` disables the watchdog.
export async function* stallWatchdog<T>(
  source: AsyncIterable<T>,
  stallMs: number,
): AsyncIterable<T> {
  if (stallMs <= 0) {
    yield* source;
    return;
  }
  const iter = source[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stallReject: ((e: Error) => void) | null = null;
  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  try {
    while (true) {
      disarm();
      timer = setTimeout(() => stallReject?.(new StepStallError(stallMs)), stallMs);
      const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
        stallReject = reject;
        iter.next().then(resolve, reject);
      });
      disarm();
      stallReject = null;
      if (result.done) return;
      yield result.value;
    }
  } finally {
    disarm();
    stallReject = null;
    if (typeof iter.return === 'function') {
      Promise.resolve(iter.return(undefined)).catch(() => undefined);
    }
  }
}

// Interrupts iteration as soon as the signal fires, even if the source never yields again
// (for example a hung HTTP stream). The signal is re-checked before every pull because an abort
// that lands while the consumer handles a value would otherwise hit an already-settled promise.
export async function* abortableIterable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncIterable<T> {
  if (signal.aborted) throw new AbortError();

  const iter = source[Symbol.asyncIterator]();
  let abortReject: ((e: Error) => void) | null = null;
  const onAbort = (): void => {
    abortReject?.(new AbortError());
  };
  signal.addEventListener('abort', onAbort);

  try {
    while (true) {
      if (signal.aborted) throw new AbortError();
      const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
        abortReject = reject;
        iter.next().then(resolve, reject);
      });
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    abortReject = null;
    // Not awaited: a misbehaving source must not keep the caller hanging during cleanup.
    if (typeof iter.return === 'function') {
      Promise.resolve(iter.return(undefined)).catch(() => undefined);
    }
  }
}
