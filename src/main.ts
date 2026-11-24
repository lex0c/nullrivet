#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { WORKER_ARGUMENT } from './sandbox/protocol.ts';

// The sandbox starts this same entry point as its worker, from source and from the compiled
// binary alike. The worker must not load the CLI, which reads provider settings and installs
// signal handlers of its own, so each side is imported only when chosen.
if (process.argv[2] === WORKER_ARGUMENT) {
  const { runWorker } = await import('./sandbox/worker.ts');
  runWorker(process.argv.slice(3));
} else {
  await import('./cli/host-main.ts');
}
