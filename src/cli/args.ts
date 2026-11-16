import { parseArgs } from 'node:util';
import type { ProviderEffort } from '../providers/types.ts';
import { type ExecutionMode, isExecutionMode } from '../tools/policy.ts';

export const EFFORT_LEVELS: readonly ProviderEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface CliConfig {
  model: string | undefined;
  effort: ProviderEffort | undefined;
  mode: ExecutionMode;
  cwd: string;
  json: boolean;
  agentsMd: boolean;
  maxSteps: number | undefined;
  contextWindow: number | undefined;
  maxOutput: number | undefined;
  prompt: string;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `Usage: nullrivet [options] [prompt...]

Runs one task and exits. Text piped on stdin is appended to the prompt.

Options:
  -m, --model <id>            Model as <family>/<model>, e.g. openrouter/deepseek/deepseek-v4-flash
  -e, --effort <level>        Reasoning effort: ${EFFORT_LEVELS.join(', ')}
  -p, --permission <mode>     auto (default) or readonly
  -C, --cwd <dir>             Starting directory (does not restrict file access)
      --json                  Emit agent events as NDJSON on stdout
      --no-agents             Do not load AGENTS.md project instructions
      --max-steps <n>         Maximum model requests per task
      --context-window <n>    Override the model context window
      --max-output <n>        Override the model output token limit
  -h, --help                  Show this help
  -v, --version               Show the version

Environment:
  NULLRIVET_MODEL, NULLRIVET_EFFORT, NULLRIVET_PERMISSION, NULLRIVET_MAX_STEPS
  OPENROUTER_API_KEY          Credentials for openrouter/* models`;

const positiveInteger = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new UsageError(`${name} must be a positive integer, got '${value}'`);
  }
  return n;
};

const parseEffort = (value: string | undefined, name: string): ProviderEffort | undefined => {
  if (value === undefined || value === '') return undefined;
  if (!(EFFORT_LEVELS as readonly string[]).includes(value)) {
    throw new UsageError(`${name} must be one of ${EFFORT_LEVELS.join(', ')}, got '${value}'`);
  }
  return value as ProviderEffort;
};

const parseMode = (value: string | undefined, name: string): ExecutionMode | undefined => {
  if (value === undefined || value === '') return undefined;
  if (!isExecutionMode(value))
    throw new UsageError(`${name} must be auto or readonly, got '${value}'`);
  return value;
};

// Precedence: command-line flag, then environment variable, then built-in default.
export const parseCli = (
  argv: readonly string[],
  env: Record<string, string | undefined>,
  defaultCwd: string,
): CliConfig => {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        model: { type: 'string', short: 'm' },
        effort: { type: 'string', short: 'e' },
        permission: { type: 'string', short: 'p' },
        cwd: { type: 'string', short: 'C' },
        json: { type: 'boolean' },
        'no-agents': { type: 'boolean' },
        'max-steps': { type: 'string' },
        'context-window': { type: 'string' },
        'max-output': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const str = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === 'string' ? value : undefined;
  };

  return {
    model: str('model') ?? (env.NULLRIVET_MODEL || undefined),
    effort:
      parseEffort(str('effort'), '--effort') ??
      parseEffort(env.NULLRIVET_EFFORT, 'NULLRIVET_EFFORT'),
    mode:
      parseMode(str('permission'), '--permission') ??
      parseMode(env.NULLRIVET_PERMISSION, 'NULLRIVET_PERMISSION') ??
      'auto',
    cwd: str('cwd') ?? defaultCwd,
    json: values.json === true,
    agentsMd: values['no-agents'] !== true,
    maxSteps:
      positiveInteger(str('max-steps'), '--max-steps') ??
      positiveInteger(env.NULLRIVET_MAX_STEPS, 'NULLRIVET_MAX_STEPS'),
    contextWindow: positiveInteger(str('context-window'), '--context-window'),
    maxOutput: positiveInteger(str('max-output'), '--max-output'),
    prompt: parsed.positionals.join(' ').trim(),
    help: values.help === true,
    version: values.version === true,
  };
};
