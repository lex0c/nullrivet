import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import { createAgent } from '../agent/agent.ts';
import type { AgentEndReason } from '../agent/events.ts';
import { headTailSummary } from '../context/output-reduction.ts';
import { InstructionsLoader } from '../instructions/agents-loader.ts';
import type { FetchLike } from '../providers/discovery.ts';
import { type ModelOverrides, resolveModel } from '../providers/resolve.ts';
import { BUILTIN_TOOLS } from '../tools/index.ts';
import { parseCli, USAGE, UsageError } from './args.ts';
import { createJsonSink, createPlainSink } from './output.ts';
import { runRepl } from './repl.ts';
import { type SessionData, SessionFile, SessionLink } from './session-file.ts';

export const EXIT_CODES: Record<AgentEndReason | 'usage', number> = {
  done: 0,
  error: 1,
  usage: 2,
  budget: 3,
  aborted: 130,
};

// Piped input can be arbitrarily large; it is reduced like tool output before entering the prompt.
const STDIN_MAX_BYTES = 128 * 1024;

export interface CliIO {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  cwd: string;
  // Null when stdin is a terminal, so nothing is read from it.
  readStdin: (() => Promise<string>) | null;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  signal: AbortSignal;
  // Present when both stdin and stdout are terminals, which enables the interactive mode.
  terminal: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } | null;
  fetch?: FetchLike;
}

// Without a prompt, piped text is the task itself. With a prompt, it is the material the prompt
// is about (a diff, a log), sent as data rather than as further requests.
export const composePrompt = (
  prompt: string,
  piped: string,
): { prompt: string; input?: string } => {
  const reduced = headTailSummary(piped, {
    maxBytes: STDIN_MAX_BYTES,
    headLines: 400,
    tailLines: 400,
  }).text;
  if (reduced.trim().length === 0) return { prompt };
  if (prompt.length === 0) return { prompt: reduced };
  return { prompt, input: reduced };
};

export const runCli = async (io: CliIO): Promise<number> => {
  let config: ReturnType<typeof parseCli>;
  try {
    config = parseCli(io.argv, io.env, io.cwd);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`error: ${error.message}\n\n${USAGE}\n`);
    return EXIT_CODES.usage;
  }
  if (config.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (config.version) {
    io.stdout(`nullrivet ${packageJson.version}\n`);
    return 0;
  }

  const sink = config.json
    ? createJsonSink(io.stdout)
    : createPlainSink({ stdout: io.stdout, stderr: io.stderr, color: io.color });
  const fail = (message: string, code: number = EXIT_CODES.usage): number => {
    sink.notice('error', message);
    sink.finish();
    return code;
  };

  const { prompt, input } =
    io.readStdin === null
      ? { prompt: config.prompt, input: undefined }
      : composePrompt(config.prompt, await io.readStdin());
  if (io.signal.aborted) return fail('aborted while reading stdin', EXIT_CODES.aborted);
  const interactive = prompt.length === 0 && io.terminal !== null && !config.json;
  if (prompt.length === 0 && !interactive) {
    return fail('no prompt given; pass the task as an argument or on stdin');
  }

  const cwd = resolve(io.cwd, config.cwd);
  try {
    if (!(await stat(cwd)).isDirectory()) return fail(`--cwd is not a directory: ${cwd}`);
  } catch {
    return fail(`--cwd does not exist: ${cwd}`);
  }

  // Relative to where nullrivet was started, like any other path given on the command line.
  let session: { file: SessionFile; data: SessionData | null } | null = null;
  if (config.session !== undefined) {
    const opened = await SessionFile.open(resolve(io.cwd, config.session));
    if (!opened.ok) return fail(opened.error);
    session = { file: opened.file, data: opened.data };
  }
  const resumed = session?.data ?? null;

  // A resumed session keeps its model unless one is chosen; the execution mode always comes from
  // this invocation, never from the file.
  const model = config.model ?? resumed?.model;
  if (model === undefined) {
    return fail('no model selected; pass --model <family>/<model> or set NULLRIVET_MODEL');
  }
  const effort = config.effort ?? resumed?.effort;
  // Overrides from the command line describe the model chosen there, not models switched to later.
  const resolveWith = (id: string, overrides: ModelOverrides) =>
    resolveModel(id, {
      env: io.env,
      overrides,
      signal: io.signal,
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    });
  const resolved = await resolveWith(model, {
    ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
    ...(config.maxOutput === undefined ? {} : { maxOutput: config.maxOutput }),
  }).catch((error: unknown) => {
    if (io.signal.aborted) return null;
    throw error;
  });
  if (resolved === null) return fail('aborted', EXIT_CODES.aborted);
  if (!resolved.ok) return fail(resolved.error);

  const agent = await createAgent({
    provider: resolved.provider,
    tools: BUILTIN_TOOLS,
    mode: config.mode,
    cwd,
    instructions: config.agentsMd ? new InstructionsLoader() : null,
    ...(effort === undefined ? {} : { effort }),
    ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
    ...(config.timeLimitMs === undefined ? {} : { timeLimitMs: config.timeLimitMs }),
  });
  const warnings = [...resolved.warnings, ...agent.bootWarnings];
  if (resumed !== null) {
    agent.conversation.restore(resumed.conversation);
    if (resumed.mode === 'readonly' && config.mode === 'auto') {
      warnings.push(
        'this session was last run in readonly mode and continues in auto mode; pass --permission readonly to keep it read-only',
      );
    }
    if (resumed.cwd !== cwd) {
      warnings.push(`this session was last run in ${resumed.cwd}; it continues in ${cwd}`);
    }
  }
  const link = new SessionLink(agent, cwd, (message) => sink.notice('warning', message));
  if (session !== null) link.attach(session.file);

  if (interactive && io.terminal !== null) {
    return runRepl({
      agent,
      version: packageJson.version,
      cwd,
      resolveModel: (id) => resolveWith(id, {}),
      warnings,
      session: link,
      resumedMessages: resumed === null ? null : resumed.conversation.messages.length,
      signal: io.signal,
      stdin: io.terminal.stdin,
      stdout: io.terminal.stdout,
      env: io.env,
    });
  }

  for (const warning of warnings) sink.notice('warning', warning);
  const result = await agent.run(prompt, {
    signal: io.signal,
    onEvent: (e) => sink.event(e),
    ...(input === undefined ? {} : { input }),
  });
  sink.finish();
  return EXIT_CODES[result.reason];
};
