import { type SearchRequest, searchFiles } from './grep-search.ts';

declare const self: Worker;

// The pattern comes from the model, and a regular expression with catastrophic backtracking can
// run for hours without yielding. Matching here, off the main thread, keeps the agent responsive:
// an interrupt, the time limit or the search timeout terminates this worker.
self.onmessage = async (event: MessageEvent<SearchRequest>) => {
  try {
    self.postMessage({ ok: true, result: await searchFiles(event.data) });
  } catch (error) {
    self.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
