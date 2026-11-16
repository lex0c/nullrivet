#!/usr/bin/env -S bun --no-env-file
import { runCli } from './cli/run.ts';
import { killAllProcessGroups } from './tools/process.ts';

const controller = new AbortController();
let interrupts = 0;

// The first interrupt aborts the running task and lets it end cleanly; a second one exits at once.
process.on('SIGINT', () => {
  interrupts += 1;
  if (interrupts === 1) {
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

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const code = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  readStdin: process.stdin.isTTY ? null : readStdin,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  color: process.stderr.isTTY === true && process.env.NO_COLOR === undefined,
  signal: controller.signal,
});

// Open sockets kept alive by the HTTP client would otherwise delay the exit.
process.exit(code);
