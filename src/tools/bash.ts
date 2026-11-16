import { stat } from 'node:fs/promises';
import { HEAD_TAIL_DEFAULT_LINES, headTailSummary } from '../context/output-reduction.ts';
import { optionalInteger, optionalString, requireNonEmptyString } from './args.ts';
import { scrubAgentEnv } from './env.ts';
import { resolvePath } from './paths.ts';
import { type ProcessRunResult, runProcess } from './process.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
const BASH_MIN_TIMEOUT_MS = 100;
// Size of each stream after reduction, which is what reaches the model.
const MODEL_OUTPUT_BYTES = 16 * 1024;

// The command reaches bash through the environment instead of argv, because argv is readable by
// every local user through /proc and commands may embed tokens. The variable is unset before the
// command runs, so neither the command nor its children can read it.
const COMMAND_ENV_KEY = '__NULLRIVET_COMMAND';
const BASH_ARGS = ['-c', `eval "unset ${COMMAND_ENV_KEY}; $${COMMAND_ENV_KEY}"`];

export const buildChildEnv = (
  base: Record<string, string | undefined>,
  command: string,
): Record<string, string> => ({
  ...scrubAgentEnv(base),
  GIT_TERMINAL_PROMPT: '0',
  [COMMAND_ENV_KEY]: command,
});

const reduceForModel = (text: string): string =>
  headTailSummary(text, {
    maxBytes: MODEL_OUTPUT_BYTES,
    headLines: HEAD_TAIL_DEFAULT_LINES,
    tailLines: HEAD_TAIL_DEFAULT_LINES,
  }).text;

const formatResult = (run: ProcessRunResult, timeoutMs: number): string => {
  const sections: string[] = [];
  if (run.stdout.length > 0) sections.push(reduceForModel(run.stdout));
  if (run.stderr.length > 0) sections.push(`[stderr]\n${reduceForModel(run.stderr)}`);
  if (sections.length === 0) sections.push('[no output]');
  if (run.termination === 'timeout') {
    sections.push(
      `[timed out after ${timeoutMs}ms; the command and its child processes were terminated]`,
    );
  } else if (run.termination === 'aborted') {
    sections.push('[aborted; the command and its child processes were terminated]');
  } else if (run.exitCode !== null) {
    sections.push(`[exit code ${run.exitCode}]`);
  } else {
    sections.push(`[terminated by ${run.signal ?? 'unknown signal'}]`);
  }
  return sections.join('\n');
};

export const bashTool: Tool = {
  name: 'bash',
  description: [
    'Run a shell command with bash and return its stdout, stderr and exit code.',
    'Use it for searching (rg, grep, find), building, running tests, git operations that change state, and any other CLI tool.',
    'Commands run non-interactively: stdin is empty, so never run commands that wait for input.',
    'Background processes started by the command are terminated when the command finishes.',
    `Default timeout is ${BASH_DEFAULT_TIMEOUT_MS / 1000}s, maximum ${BASH_MAX_TIMEOUT_MS / 1000}s.`,
    'Large output is reduced to its first and last lines.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to run.' },
      cwd: {
        type: 'string',
        description: 'Working directory for the command. Defaults to the session directory.',
      },
      timeout_ms: {
        type: 'integer',
        description: `Timeout in milliseconds (${BASH_MIN_TIMEOUT_MS}-${BASH_MAX_TIMEOUT_MS}).`,
      },
    },
    required: ['command'],
  },
  effect: 'exec',
  async execute(input, ctx): Promise<ToolResult> {
    const command = requireNonEmptyString(input, 'command');
    const cwdArg = optionalString(input, 'cwd');
    const timeoutMs =
      optionalInteger(input, 'timeout_ms', {
        min: BASH_MIN_TIMEOUT_MS,
        max: BASH_MAX_TIMEOUT_MS,
      }) ?? BASH_DEFAULT_TIMEOUT_MS;
    const cwd = cwdArg === undefined ? ctx.cwd : resolvePath(cwdArg, ctx.cwd);

    try {
      if (!(await stat(cwd)).isDirectory()) {
        return toolError('fs.not_directory', `cwd is not a directory: ${cwd}`);
      }
    } catch {
      return toolError('fs.not_found', `cwd does not exist: ${cwd}`);
    }

    let run: ProcessRunResult;
    try {
      run = await runProcess({
        file: 'bash',
        args: BASH_ARGS,
        cwd,
        env: buildChildEnv(process.env, command),
        timeoutMs,
        signal: ctx.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError('bash.spawn_failed', `could not start bash: ${message}`);
    }

    return {
      content: formatResult(run, timeoutMs),
      isError: run.termination !== 'exited',
      meta: {
        exitCode: run.exitCode,
        signal: run.signal,
        termination: run.termination,
        durationMs: run.durationMs,
        stdoutBytes: run.stdoutBytes,
        stderrBytes: run.stderrBytes,
        cwd,
      },
      touchedPaths: [cwd],
    };
  },
};
