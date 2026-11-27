import { stat } from 'node:fs/promises';
import { HEAD_TAIL_DEFAULT_LINES, headTailSummary } from '../context/output-reduction.ts';
import { errorMessage } from '../errors.ts';
import { optionalInteger, optionalString, requireNonEmptyString } from './args.ts';
import { scrubAgentEnv } from './env.ts';
import { finishOutput, type OutputSpool, outputFiles } from './output-files.ts';
import { resolvePath } from './paths.ts';
import { captureInterruption, type ProcessRunResult, runProcess } from './process.ts';
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
const RUN_COMMAND = `eval "unset ${COMMAND_ENV_KEY}; $${COMMAND_ENV_KEY}"`;
const BASH_ARGS = ['-c', RUN_COMMAND];
// For background jobs, stderr goes to the stdout pipe before the command runs, so their single log
// keeps the order in which the two streams were written.
export const JOB_BASH_ARGS = ['-c', `exec 2>&1; ${RUN_COMMAND}`];

export const buildChildEnv = (
  base: Record<string, string | undefined>,
  command: string,
): Record<string, string> => ({
  ...scrubAgentEnv(base),
  GIT_TERMINAL_PROMPT: '0',
  [COMMAND_ENV_KEY]: command,
});

// The directory a command runs in: `cwd` resolved against the session directory, or the session
// directory itself.
export const resolveCommandCwd = async (
  cwdArg: string | undefined,
  sessionCwd: string,
): Promise<{ cwd: string } | { error: ToolResult }> => {
  const cwd = cwdArg === undefined ? sessionCwd : resolvePath(cwdArg, sessionCwd);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return { error: toolError('fs.not_directory', `cwd is not a directory: ${cwd}`) };
    }
  } catch {
    return { error: toolError('fs.not_found', `cwd does not exist: ${cwd}`) };
  }
  return { cwd };
};

// Reduces a stream for the model. The spool is finished here, once the reduction is known, so its
// files are kept only for a reduced stream; the line naming them is added to `notes`.
const reduceStream = (
  text: string,
  spool: OutputSpool,
  subject: 'stdout' | 'stderr',
  run: ProcessRunResult,
  notes: string[],
): string => {
  const summary = headTailSummary(text, {
    maxBytes: MODEL_OUTPUT_BYTES,
    headLines: HEAD_TAIL_DEFAULT_LINES,
    tailLines: HEAD_TAIL_DEFAULT_LINES,
  });
  const note = finishOutput(spool, summary.reduced, subject, captureInterruption(run));
  if (note !== null) notes.push(note);
  return summary.text;
};

// The lines naming saved files come last: compaction keeps the start and the end of an old result,
// so they survive it, and the model keeps a way to the complete output.
const formatResult = (
  run: ProcessRunResult,
  timeoutMs: number,
  spools: { stdout: OutputSpool; stderr: OutputSpool },
): string => {
  const sections: string[] = [];
  const notes: string[] = [];
  if (run.stdout.length > 0) {
    sections.push(reduceStream(run.stdout, spools.stdout, 'stdout', run, notes));
  }
  if (run.stderr.length > 0) {
    sections.push(`[stderr]\n${reduceStream(run.stderr, spools.stderr, 'stderr', run, notes)}`);
  }
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
  return [...sections, ...notes].join('\n');
};

export const bashTool: Tool = {
  name: 'bash',
  description: [
    'Run a shell command with bash and return its stdout, stderr and exit code.',
    'Use it for building, running tests, git operations that change state, and any other CLI tool. Find and search files with glob and grep instead.',
    'Commands run non-interactively: stdin is empty, so never run commands that wait for input.',
    'Background processes started by the command are terminated when the command finishes.',
    `Default timeout is ${BASH_DEFAULT_TIMEOUT_MS / 1000}s, maximum ${BASH_MAX_TIMEOUT_MS / 1000}s.`,
    'Large output is reduced to its first and last lines, and the complete output is saved to files named in the result: read or search them instead of running the command again.',
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
  startsCommands: true,
  async execute(input, ctx): Promise<ToolResult> {
    const command = requireNonEmptyString(input, 'command');
    const cwdArg = optionalString(input, 'cwd');
    const timeoutMs =
      optionalInteger(input, 'timeout_ms', {
        min: BASH_MIN_TIMEOUT_MS,
        max: BASH_MAX_TIMEOUT_MS,
      }) ?? BASH_DEFAULT_TIMEOUT_MS;
    const resolved = await resolveCommandCwd(cwdArg, ctx.cwd);
    if ('error' in resolved) return resolved.error;
    const { cwd } = resolved;

    const spools = {
      stdout: outputFiles.spool('bash-stdout', MODEL_OUTPUT_BYTES),
      stderr: outputFiles.spool('bash-stderr', MODEL_OUTPUT_BYTES),
    };
    try {
      let run: ProcessRunResult;
      try {
        run = await runProcess({
          file: 'bash',
          args: BASH_ARGS,
          cwd,
          env: buildChildEnv(process.env, command),
          timeoutMs,
          signal: ctx.signal,
          onStdout: (chunk) => spools.stdout.push(chunk),
          onStderr: (chunk) => spools.stderr.push(chunk),
        });
      } catch (error) {
        const message = errorMessage(error);
        return toolError('bash.spawn_failed', `could not start bash: ${message}`);
      }

      return {
        content: formatResult(run, timeoutMs, spools),
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
    } finally {
      // Discards whatever a path above did not keep; a finished spool ignores the call.
      spools.stdout.finish({ keep: false });
      spools.stderr.finish({ keep: false });
    }
  },
};
