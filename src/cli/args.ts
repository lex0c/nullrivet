import { parseArgs } from 'node:util';
import { MAX_TIME_LIMIT_MS } from '../agent/agent.ts';
import { errorMessage } from '../errors.ts';
import type { ProviderEffort } from '../providers/types.ts';
import {
  type ExecutionMode,
  isExecutionMode,
  isSandboxProfile,
  SANDBOX_PROFILE_NAMES,
  type SandboxProfile,
} from '../tools/policy.ts';

export const EFFORT_LEVELS: readonly ProviderEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface CliConfig {
  model: string | undefined;
  effort: ProviderEffort | undefined;
  mode: ExecutionMode;
  sandbox: SandboxProfile | undefined;
  // The engagement file of the security profile, as given.
  engagement: string | undefined;
  // The security profile's commands run in a virtual machine, with the host's kernel or this one.
  vm: boolean;
  vmKernel: string | undefined;
  apply: boolean;
  cwd: string;
  json: boolean;
  agentsMd: boolean;
  maxSteps: number | undefined;
  timeLimitMs: number | undefined;
  session: string | undefined;
  contextWindow: number | undefined;
  maxOutput: number | undefined;
  prompt: string;
  help: boolean;
  version: boolean;
  listModels: boolean;
  // An evidence log to check instead of running, with the final hash kept elsewhere when given.
  verifyEvidence: string | undefined;
  expectedHash: string | undefined;
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
  -m, --model <id>            Model as <family>/<model>, e.g. anthropic/claude-sonnet-5-5
  -e, --effort <level>        Reasoning effort: ${EFFORT_LEVELS.join(', ')}
  -p, --permission <mode>     auto (default) or readonly
      --sandbox <profile>     Run the tools in a sandbox (Linux, Bubblewrap): inspect;
                              workspace, where changes to the project stay in the sandbox;
                              or security, with the network of an engagement's scope
      --engagement <file>     With --sandbox security: the engagement file, which sets the
                              destinations the sandbox may reach, and when
      --vm                    With --sandbox security: run the commands in a virtual machine
                              with a kernel of its own (Linux x86-64, KVM and QEMU)
      --vm-kernel <file>      With --vm: the guest's kernel, the host's own otherwise
      --apply                 With --sandbox workspace: apply the task's changes to the
                              project if it finishes; without it they are shown and discarded
  -C, --cwd <dir>             Starting directory (does not restrict file access)
      --json                  Emit agent events as NDJSON on stdout
      --no-agents             Do not load AGENTS.md project instructions
      --max-steps <n>         Maximum model requests per task and per subagent
      --timeout <time>        Time limit per task and per subagent: 90s, 30m, 2h (seconds
                              without a unit)
      --session <file>        Save the conversation to this file, continuing it if it exists
      --context-window <n>    Override the model context window
      --max-output <n>        Override the model output token limit
      --list-models           List the models of the built-in catalog
      --verify-evidence <file>
                              Check an evidence log and the copies beside it, and print its
                              final hash: exit 0 when complete, 4 when consistent but
                              incomplete, 1 when corrupted
      --expected-hash <sha256>
                              With --verify-evidence: the final hash kept apart from the log,
                              which the log's must be
  -h, --help                  Show this help
  -v, --version               Show the version

Environment:
  NULLRIVET_MODEL, NULLRIVET_EFFORT, NULLRIVET_PERMISSION, NULLRIVET_SANDBOX,
  NULLRIVET_MAX_STEPS, NULLRIVET_TIMEOUT
  ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, OLLAMA_API_KEY,
  GEMINI_API_KEY, XAI_API_KEY
                              Credentials of each provider family`;

const DURATION_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

// A positive whole number of seconds, minutes or hours, returned in milliseconds.
export const parseDuration = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const match = /^(\d+)([smh]?)$/.exec(value.trim());
  const amount = match === null ? Number.NaN : Number(match[1]);
  const ms = amount * (DURATION_UNITS[match?.[2] || 's'] ?? Number.NaN);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new UsageError(`${name} must be a duration such as 90s, 30m or 2h, got '${value}'`);
  }
  if (ms > MAX_TIME_LIMIT_MS) {
    throw new UsageError(`${name} must be at most 596h, got '${value}'`);
  }
  return ms;
};

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

const parseSandbox = (value: string | undefined, name: string): SandboxProfile | undefined => {
  if (value === undefined || value === '') return undefined;
  if (!isSandboxProfile(value)) {
    throw new UsageError(`${name} must be ${SANDBOX_PROFILE_NAMES}, got '${value}'`);
  }
  return value;
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
        sandbox: { type: 'string' },
        engagement: { type: 'string' },
        vm: { type: 'boolean' },
        'vm-kernel': { type: 'string' },
        apply: { type: 'boolean' },
        cwd: { type: 'string', short: 'C' },
        json: { type: 'boolean' },
        'no-agents': { type: 'boolean' },
        'max-steps': { type: 'string' },
        timeout: { type: 'string' },
        session: { type: 'string' },
        'context-window': { type: 'string' },
        'max-output': { type: 'string' },
        'list-models': { type: 'boolean' },
        'verify-evidence': { type: 'string' },
        'expected-hash': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const str = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === 'string' ? value : undefined;
  };

  const sandbox =
    parseSandbox(str('sandbox'), '--sandbox') ??
    parseSandbox(env.NULLRIVET_SANDBOX, 'NULLRIVET_SANDBOX');
  // Applying is the operator's decision for each run, so it has no environment variable.
  const apply = values.apply === true;
  if (apply && sandbox !== 'workspace') {
    throw new UsageError('--apply needs --sandbox workspace, whose changes it applies');
  }
  // The scope of a network is the operator's decision for each run, so it has no environment
  // variable either.
  const engagement = str('engagement');
  // Not for a run that only prints help, the version or the models: NULLRIVET_SANDBOX can name
  // the profile for every run, and the file comes with each.
  const verifyEvidence = str('verify-evidence');
  const expectedHash = str('expected-hash');
  if (expectedHash !== undefined && verifyEvidence === undefined) {
    throw new UsageError('--expected-hash needs --verify-evidence, whose log it anchors');
  }
  if (expectedHash !== undefined && !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new UsageError('--expected-hash must be a SHA-256 in lower-case hex, 64 characters');
  }
  const runs =
    values.help !== true &&
    values.version !== true &&
    values['list-models'] !== true &&
    verifyEvidence === undefined;
  if (runs && sandbox === 'security' && engagement === undefined) {
    throw new UsageError('--sandbox security needs --engagement <file>, which sets its scope');
  }
  if (engagement !== undefined && sandbox !== 'security') {
    throw new UsageError('--engagement needs --sandbox security, whose network it scopes');
  }
  // Like the scope, the operator's decision for each run.
  const vm = values.vm === true;
  const vmKernel = str('vm-kernel');
  if (vm && sandbox !== 'security') {
    throw new UsageError(
      '--vm needs --sandbox security, whose commands it runs in a virtual machine',
    );
  }
  if (vmKernel !== undefined && !vm) {
    throw new UsageError('--vm-kernel needs --vm, whose guest it boots');
  }

  return {
    model: str('model') ?? (env.NULLRIVET_MODEL || undefined),
    effort:
      parseEffort(str('effort'), '--effort') ??
      parseEffort(env.NULLRIVET_EFFORT, 'NULLRIVET_EFFORT'),
    mode:
      parseMode(str('permission'), '--permission') ??
      parseMode(env.NULLRIVET_PERMISSION, 'NULLRIVET_PERMISSION') ??
      'auto',
    sandbox,
    engagement,
    vm,
    vmKernel,
    apply,
    cwd: str('cwd') ?? defaultCwd,
    json: values.json === true,
    agentsMd: values['no-agents'] !== true,
    maxSteps:
      positiveInteger(str('max-steps'), '--max-steps') ??
      positiveInteger(env.NULLRIVET_MAX_STEPS, 'NULLRIVET_MAX_STEPS'),
    session: str('session'),
    timeLimitMs:
      parseDuration(str('timeout'), '--timeout') ??
      parseDuration(env.NULLRIVET_TIMEOUT, 'NULLRIVET_TIMEOUT'),
    contextWindow: positiveInteger(str('context-window'), '--context-window'),
    maxOutput: positiveInteger(str('max-output'), '--max-output'),
    prompt: parsed.positionals.join(' ').trim(),
    help: values.help === true,
    version: values.version === true,
    listModels: values['list-models'] === true,
    verifyEvidence,
    expectedHash,
  };
};
