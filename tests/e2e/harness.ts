import { join, resolve } from 'node:path';

// End-to-end tests run the real CLI as a separate process against a local stand-in for the
// Ollama chat endpoint. They run the sources through the executable's own shebang, or, when
// NULLRIVET_EXECUTABLE is set, a compiled executable.
const MAIN = join(import.meta.dir, '../../src/main.ts');
const EXECUTABLE = process.env.NULLRIVET_EXECUTABLE;

export const MODEL = 'ollama/qwen2.5-coder:7b';

export const cliCommand = (args: readonly string[]): string[] => [
  EXECUTABLE === undefined ? MAIN : resolve(EXECUTABLE),
  ...args,
];

const shellQuote = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`;
export const cliShellCommand = (args: readonly string[]): string =>
  cliCommand(args).map(shellQuote).join(' ');

// Runs a command in a pseudo-terminal through Python's pty module, which behaves the same on Linux
// and macOS, unlike script(1). It forwards its stdin to the terminal and exits with the command's
// status.
const PTY_RUNNER =
  'import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';

// The pseudo-terminal starts without a size, so the command runs after stty gives it a common one
// and the interface lays out as it would in a real terminal.
export const inTerminal = (argv: readonly string[]): string[] => [
  'python3',
  '-c',
  PTY_RUNNER,
  'sh',
  '-c',
  'stty cols 120 rows 40 && exec "$@"',
  'sh',
  ...argv,
];

export interface ChatMessage {
  role: string;
  content: string;
  tool_name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: { function: { name: string } }[];
}

export interface Reply {
  // Sent as one text delta per element.
  text?: string | string[];
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

export type Handler = (request: ChatRequest) => Reply | Promise<Reply>;

export interface FakeOllama {
  url: string;
  requests: ChatRequest[];
  handle(handler: Handler): void;
  stop(): void;
}

export const isSummaryRequest = (request: ChatRequest): boolean =>
  request.messages[0]?.role === 'system' && request.messages[0].content.includes('working summary');

export const toolMessages = (request: ChatRequest | undefined): ChatMessage[] =>
  (request?.messages ?? []).filter((m) => m.role === 'tool');

export const startFakeOllama = (): FakeOllama => {
  let handler: Handler = () => ({ text: 'ok' });
  const requests: ChatRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname !== '/api/chat') {
        return new Response('not found', { status: 404 });
      }
      const request = (await req.json()) as ChatRequest;
      requests.push(request);
      const reply = await handler(request);
      const lines: unknown[] = [];
      const texts = reply.text === undefined ? [] : [reply.text].flat();
      for (const text of texts) lines.push({ message: { role: 'assistant', content: text } });
      if (reply.toolCalls !== undefined) {
        lines.push({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: reply.toolCalls.map((call) => ({
              function: { name: call.name, arguments: call.args },
            })),
          },
        });
      }
      lines.push({
        done: true,
        done_reason: 'stop',
        // Close to what a server would count, so the agent's size measurement stays realistic.
        prompt_eval_count: Math.ceil(JSON.stringify(request.messages).length / 4),
        eval_count: 10,
      });
      return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
        headers: { 'content-type': 'application/x-ndjson' },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    handle(next) {
      handler = next;
      requests.length = 0;
    },
    stop() {
      server.stop(true);
    },
  };
};

export const cliEnv = (
  server: FakeOllama,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NULLRIVET_OLLAMA_BASE_URL: server.url,
  NULLRIVET_MODEL: MODEL,
  ...extra,
});

export type CliEvent = Record<string, unknown> & { type: string };

export interface RunningCli {
  child: Bun.Subprocess<'pipe' | 'ignore', 'pipe', 'pipe'>;
  events: CliEvent[];
  // Resolves with the first event matching the predicate, or rejects after `ms`.
  waitFor(predicate: (event: CliEvent) => boolean, ms?: number): Promise<CliEvent>;
  // Exit code and stderr once the process ends.
  finished: Promise<{ code: number; stderr: string }>;
}

// Starts the CLI with --json and parses its stdout as NDJSON while it runs.
export const startCli = (
  args: readonly string[],
  options: { env: Record<string, string>; cwd?: string; stdin?: string },
): RunningCli => {
  const child = Bun.spawn(cliCommand(['--json', ...args]), {
    env: options.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: options.stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (options.stdin !== undefined && typeof child.stdin === 'object' && child.stdin !== null) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }
  const events: CliEvent[] = [];
  const listeners = new Set<() => void>();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) events.push(JSON.parse(line) as CliEvent);
        newline = buffer.indexOf('\n');
      }
      for (const listener of listeners) listener();
    }
  })();
  const waitFor = (predicate: (event: CliEvent) => boolean, ms = 10_000): Promise<CliEvent> =>
    new Promise((resolveEvent, reject) => {
      const check = (): boolean => {
        const found = events.find(predicate);
        if (found === undefined) return false;
        listeners.delete(onChange);
        clearTimeout(timer);
        resolveEvent(found);
        return true;
      };
      const onChange = (): void => {
        check();
      };
      const timer = setTimeout(() => {
        listeners.delete(onChange);
        reject(new Error(`no matching event within ${ms} ms`));
      }, ms);
      if (!check()) listeners.add(onChange);
    });
  const finished = (async () => {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    await reading;
    return { code, stderr };
  })();
  return { child, events, waitFor, finished };
};

// Whether a process whose command line contains `marker` is still running.
export const processRunning = (marker: string): boolean =>
  Bun.spawnSync(['pgrep', '-f', marker]).exitCode === 0;
