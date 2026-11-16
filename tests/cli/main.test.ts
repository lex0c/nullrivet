import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const MAIN = join(import.meta.dir, '../../src/main.ts');
const CHUNKS = 2_000;
const CHUNK_TEXT = 'x'.repeat(100);

// A local stand-in for the Ollama chat endpoint that streams an answer far larger than a pipe
// buffer (64 KiB on Linux).
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (new URL(req.url).pathname !== '/api/chat')
        return new Response('not found', { status: 404 });
      const lines: string[] = [];
      for (let i = 0; i < CHUNKS; i++) {
        lines.push(JSON.stringify({ message: { role: 'assistant', content: CHUNK_TEXT } }));
      }
      lines.push(
        JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 10 }),
      );
      return new Response(`${lines.join('\n')}\n`, {
        headers: { 'content-type': 'application/x-ndjson' },
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

describe('process exit', () => {
  test('a slow reader receives all of the output', async () => {
    const command = [
      'bun --no-env-file',
      JSON.stringify(MAIN),
      '--json --model ollama/qwen2.5-coder:7b hello </dev/null',
      '| (sleep 1; cat)',
    ].join(' ');
    const child = Bun.spawn(['bash', '-c', command], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NULLRIVET_OLLAMA_BASE_URL: `http://127.0.0.1:${server.port}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(0);
    const events = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string });
    const text = events
      .filter((e) => e.type === 'text:delta')
      .map((e) => e.text)
      .join('');
    expect(text.length).toBe(CHUNKS * CHUNK_TEXT.length);
    expect(events.at(-1)?.type).toBe('agent:end');
  }, 30_000);
});
