import { stat } from 'node:fs/promises';
import { headTailSummary } from '../context/output-reduction.ts';
import { errorMessage } from '../errors.ts';
import {
  InvalidArgumentError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireNonEmptyString,
} from './args.ts';
import { scrubAgentEnv } from './env.ts';
import { describeSavedOutput, type OutputSpool, outputFiles } from './output-files.ts';
import { resolvePath } from './paths.ts';
import { captureInterruption, type ProcessRunResult, runProcess } from './process.ts';
import { type Tool, type ToolResult, toolError } from './types.ts';

export const GIT_TIMEOUT_MS = 30_000;
const MODEL_OUTPUT_BYTES = 32 * 1024;
const LOG_DEFAULT_COUNT = 20;
const LOG_MAX_COUNT = 200;

const SUBCOMMANDS = ['status', 'diff', 'log', 'show', 'blame'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

// Repository configuration is data from the repository and can make read commands execute
// programs: fsmonitor hooks, pagers, external diff tools, textconv and clean/smudge filters,
// signature verification, lazy fetches through a transport. Each vector is disabled here so the
// tool stays free of side effects, which is what makes it safe to expose in readonly mode.
export const HARDENING_CONFIG = [
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'core.pager=cat',
  'protocol.allow=never',
  'log.showSignature=false',
  'diff.external=',
  'status.submoduleSummary=false',
  'diff.submodule=short',
];

// Flags that disable external diff drivers and textconv on commands that produce diffs. With
// them, an empty driver command from HARDENING_CONFIG is never consulted.
const NO_DRIVERS = ['--no-ext-diff', '--no-textconv'];

export const gitEnv = (): Record<string, string> => ({
  ...scrubAgentEnv(process.env, ['GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'PAGER']),
  // Without this, `status` refreshes and rewrites the index.
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
});

export const configArgs = (entries: readonly string[]): string[] =>
  entries.flatMap((e) => ['-c', e]);

const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/;
const DIFF_KEY = /^diff\.(.+)\.(textconv|command)$/;

// Driver commands live in configuration, so enumerating the configured driver names and blanking
// their commands covers every attribute that could select them. Reading configuration does not
// execute anything.
const driverOverrides = async (
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string[]> => {
  const run = await runProcess({
    file: 'git',
    args: [
      ...configArgs(HARDENING_CONFIG),
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^(filter|diff)\\.',
    ],
    cwd,
    env,
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
  });
  if (run.termination !== 'exited') throw new Error('could not read git configuration');
  const filters = new Set<string>();
  const diffs = new Set<string>();
  for (const key of run.stdout.split('\0')) {
    const name = key.trim();
    const filter = FILTER_KEY.exec(name);
    if (filter?.[1] !== undefined) filters.add(filter[1]);
    const diff = DIFF_KEY.exec(name);
    if (diff?.[1] !== undefined) diffs.add(diff[1]);
  }
  for (const driver of [...filters, ...diffs]) {
    // `-c` splits at the first '='; such a name cannot be overridden reliably, so refuse to run.
    if (driver.includes('=') || driver.includes('\n')) {
      throw new Error(`git driver name cannot be neutralized: ${JSON.stringify(driver)}`);
    }
  }
  return [
    ...[...filters].flatMap((d) => [
      `filter.${d}.clean=`,
      `filter.${d}.smudge=`,
      `filter.${d}.process=`,
      `filter.${d}.required=false`,
    ]),
    ...[...diffs].flatMap((d) => [`diff.${d}.textconv=`, `diff.${d}.command=`]),
  ];
};

// A value starting with '-' would be parsed as an option, for example `--output=<file>`, which
// writes to disk.
const requireRef = (value: string, key: string): string => {
  if (value.length === 0) throw new InvalidArgumentError(`'${key}' must not be empty`);
  if (value.startsWith('-')) throw new InvalidArgumentError(`'${key}' must not start with '-'`);
  if ([...value].some((ch) => ch.charCodeAt(0) < 0x20)) {
    throw new InvalidArgumentError(`'${key}' must not contain control characters`);
  }
  return value;
};

const optionalRef = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = optionalString(input, key);
  return value === undefined ? undefined : requireRef(value, key);
};

const requirePaths = (input: Record<string, unknown>, key: string): string[] => {
  const paths = optionalStringArray(input, key) ?? [];
  for (const path of paths) {
    if (path.length === 0 || path.includes('\0')) {
      throw new InvalidArgumentError(`'${key}' entries must be non-empty paths`);
    }
  }
  return paths;
};

interface Invocation {
  args: string[];
  paths: string[];
}

const buildInvocation = (subcommand: Subcommand, input: Record<string, unknown>): Invocation => {
  switch (subcommand) {
    case 'status':
      return { args: ['status', '--short', '--branch', '--ignore-submodules=all'], paths: [] };
    case 'diff': {
      const base = optionalRef(input, 'base');
      const target = optionalRef(input, 'target');
      if (target !== undefined && base === undefined) {
        throw new InvalidArgumentError("'target' requires 'base'");
      }
      const paths = requirePaths(input, 'paths');
      return {
        args: [
          'diff',
          ...NO_DRIVERS,
          '--ignore-submodules=all',
          ...(optionalBoolean(input, 'staged') === true ? ['--cached'] : []),
          ...(optionalBoolean(input, 'stat') === true ? ['--stat'] : []),
          ...(base === undefined ? [] : [base]),
          ...(target === undefined ? [] : [target]),
          '--',
          ...paths,
        ],
        paths,
      };
    }
    case 'log': {
      const ref = optionalRef(input, 'ref');
      const count =
        optionalInteger(input, 'max_count', { min: 1, max: LOG_MAX_COUNT }) ?? LOG_DEFAULT_COUNT;
      const paths = requirePaths(input, 'paths');
      return {
        args: [
          'log',
          ...NO_DRIVERS,
          `--max-count=${count}`,
          ...(optionalBoolean(input, 'oneline') === true ? ['--oneline'] : ['--date=iso']),
          ...(ref === undefined ? [] : [ref]),
          '--',
          ...paths,
        ],
        paths,
      };
    }
    case 'show': {
      const ref = requireRef(requireNonEmptyString(input, 'ref'), 'ref');
      const path = optionalString(input, 'path');
      return {
        args: [
          'show',
          ...NO_DRIVERS,
          ...(optionalBoolean(input, 'stat') === true ? ['--stat'] : []),
          ref,
          ...(path === undefined ? [] : ['--', path]),
        ],
        paths: path === undefined ? [] : [path],
      };
    }
    case 'blame': {
      const path = requireNonEmptyString(input, 'path');
      const ref = optionalRef(input, 'ref');
      const start = optionalInteger(input, 'start_line', { min: 1 });
      const end = optionalInteger(input, 'end_line', { min: 1 });
      if (start !== undefined && end !== undefined && end < start) {
        throw new InvalidArgumentError("'end_line' must be >= 'start_line'");
      }
      const range =
        start === undefined && end === undefined ? [] : ['-L', `${start ?? 1},${end ?? ''}`];
      return {
        args: ['blame', '--no-textconv', ...range, ...(ref === undefined ? [] : [ref]), '--', path],
        paths: [path],
      };
    }
  }
};

const isSubcommand = (value: string): value is Subcommand =>
  (SUBCOMMANDS as readonly string[]).includes(value);

const formatOutput = (
  subcommand: Subcommand,
  run: ProcessRunResult,
  spool: OutputSpool,
): string => {
  if (run.stdout.trim().length === 0) {
    return subcommand === 'diff' ? '[no changes]' : '[no output]';
  }
  const summary = headTailSummary(run.stdout, {
    maxBytes: MODEL_OUTPUT_BYTES,
    headLines: 300,
    tailLines: 50,
  });
  const interrupted = captureInterruption(run);
  const saved = spool.finish({
    keep: summary.reduced,
    ...(interrupted === undefined ? {} : { interrupted }),
  });
  return saved === null ? summary.text : `${summary.text}\n${describeSavedOutput(saved)}`;
};

export const gitTool: Tool = {
  name: 'git',
  description: [
    'Inspect a git repository without changing it: status, diff, log, show, blame.',
    'This is the only way to read git history in readonly mode.',
    'For git commands that change state (commit, checkout, merge, stash...), use bash.',
    'Parameters per subcommand:',
    'status: cwd.',
    'diff: cwd, staged (index vs HEAD), base and target (refs to compare), paths, stat.',
    `log: cwd, ref, paths, max_count (default ${LOG_DEFAULT_COUNT}, max ${LOG_MAX_COUNT}), oneline.`,
    'show: cwd, ref (required; "REV:path" shows a file at a revision), path, stat.',
    'blame: cwd, path (required), ref, start_line, end_line.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', enum: [...SUBCOMMANDS] },
      cwd: {
        type: 'string',
        description: 'Directory inside the repository. Defaults to the session directory.',
      },
      staged: { type: 'boolean' },
      base: { type: 'string' },
      target: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
      path: { type: 'string' },
      ref: { type: 'string' },
      stat: { type: 'boolean' },
      max_count: { type: 'integer' },
      oneline: { type: 'boolean' },
      start_line: { type: 'integer' },
      end_line: { type: 'integer' },
    },
    required: ['subcommand'],
  },
  effect: 'read',
  async execute(input, ctx): Promise<ToolResult> {
    const subcommand = requireNonEmptyString(input, 'subcommand');
    if (!isSubcommand(subcommand)) {
      throw new InvalidArgumentError(`'subcommand' must be one of ${SUBCOMMANDS.join(', ')}`);
    }
    const invocation = buildInvocation(subcommand, input);
    const cwdArg = optionalString(input, 'cwd');
    const cwd = cwdArg === undefined ? ctx.cwd : resolvePath(cwdArg, ctx.cwd);
    try {
      if (!(await stat(cwd)).isDirectory()) {
        return toolError('fs.not_directory', `cwd is not a directory: ${cwd}`);
      }
    } catch {
      return toolError('fs.not_found', `cwd does not exist: ${cwd}`);
    }

    const env = gitEnv();
    const spool = outputFiles.spool('git', MODEL_OUTPUT_BYTES);
    try {
      let run: ProcessRunResult;
      try {
        const overrides = await driverOverrides(cwd, env, ctx.signal);
        run = await runProcess({
          file: 'git',
          args: [
            '--no-pager',
            ...configArgs([...HARDENING_CONFIG, ...overrides]),
            ...invocation.args,
          ],
          cwd,
          env,
          timeoutMs: GIT_TIMEOUT_MS,
          signal: ctx.signal,
          onStdout: (chunk) => spool.push(chunk),
        });
      } catch (error) {
        const message = errorMessage(error);
        return toolError('git.failed', message);
      }

      const touchedPaths = [cwd, ...invocation.paths.map((p) => resolvePath(p, cwd))];
      if (run.termination !== 'exited') {
        return toolError(
          'git.failed',
          `git ${subcommand} was ${run.termination === 'timeout' ? 'timed out' : 'aborted'}`,
        );
      }
      if (run.exitCode !== 0) {
        const detail = run.stderr.trim() || `exit code ${run.exitCode}`;
        return { ...toolError('git.failed', detail), touchedPaths };
      }
      return {
        content: formatOutput(subcommand, run, spool),
        isError: false,
        meta: { subcommand, cwd, durationMs: run.durationMs, stdoutBytes: run.stdoutBytes },
        touchedPaths,
      };
    } finally {
      // The output of a failed command is not shown, so its files are discarded.
      spool.finish({ keep: false });
    }
  },
};
