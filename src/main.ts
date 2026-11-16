#!/usr/bin/env -S bun --no-env-file
import { runCli } from './cli/run.ts';
import { BoundedCapture } from './context/bounded-capture.ts';
import { killAllProcessGroups } from './tools/process.ts';

const controller = new AbortController();
let interrupts = 0;
let finished = false;

// The first interrupt aborts the running task and lets it end cleanly; a second one exits at once.
// Once the task has finished, while the output waits for a slow reader, the first one exits.
process.on('SIGINT', () => {
  interrupts += 1;
  if (interrupts === 1 && !finished) {
    controller.abort();
    return;
  }
  killAllProcessGroups();
  process.exit(130);
});
process.on('SIGTERM', () => {
  controller.abort();
  killAllProcessGroups();
  process.exit(143);
});
process.on('exit', killAllProcessGroups);

// Piped input is read in bounded memory, and an interrupt stops waiting for an input that never
// ends (a parent process that leaves stdin open).
const STDIN_CAPTURE_BYTES = 1024 * 1024;

const readStdin = (): Promise<string> =>
  new Promise((resolve) => {
    const capture = new BoundedCapture(STDIN_CAPTURE_BYTES);
    const finish = (): void => {
      controller.signal.removeEventListener('abort', onAbort);
      resolve(capture.text());
    };
    const onAbort = (): void => {
      process.stdin.destroy();
      finish();
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    process.stdin.on('data', (chunk: Buffer) => capture.push(chunk));
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });

const code = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  readStdin: process.stdin.isTTY ? null : readStdin,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  color: process.stderr.isTTY === true && process.env.NO_COLOR === undefined,
  signal: controller.signal,
  terminal:
    process.stdin.isTTY === true && process.stdout.isTTY === true
      ? { stdin: process.stdin, stdout: process.stdout }
      : null,
});

// Bun drops output still queued for a pipe when the process exits, so everything beyond the pipe
// buffer would be lost when the reader is slower than the agent. Ending the streams waits until
// the reader has taken all of it; a reader that closed early ends the wait with an error.
const endStream = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise((resolve) => {
    stream.once('error', () => resolve());
    stream.end(() => resolve());
  });
finished = true;
await Promise.all([endStream(process.stdout), endStream(process.stderr)]);

// Open sockets kept alive by the HTTP client would otherwise delay the exit.
process.exit(code);
