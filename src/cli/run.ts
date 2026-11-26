import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import { createAgent } from '../agent/agent.ts';
import { IN_PROCESS_BACKEND } from '../agent/tool-broker.ts';
import { headTailSummary } from '../context/output-reduction.ts';
import { errorMessage } from '../errors.ts';
import { InstructionsLoader } from '../instructions/agents-loader.ts';
import { MODEL_CATALOG } from '../providers/catalog.ts';
import type { FetchLike } from '../providers/discovery.ts';
import { type ModelOverrides, resolveModel } from '../providers/resolve.ts';
import { sandboxProject } from '../sandbox/bwrap.ts';
import { SandboxSession } from '../sandbox/session.ts';
import { type StartedSandbox, type StartedWorkspace, startSandbox } from '../sandbox/start.ts';
import { isLiveWorkspaceDirectory, removeWorkspaceDirectory } from '../sandbox/workspace.ts';
import { BUILTIN_TOOLS } from '../tools/index.ts';
import type { JobSession } from '../tools/jobs.ts';
import { outputFiles } from '../tools/output-files.ts';
import { parseCli, USAGE, UsageError } from './args.ts';
import { EXIT_CODES } from './exit-codes.ts';
import { formatModelList } from './list-models.ts';
import { createJsonSink, createPlainSink } from './output.ts';
import { PromptHistory } from './prompt-history.ts';
import { runRepl } from './repl.ts';
import { type SessionData, SessionFile, SessionLink } from './session-file.ts';
import { finishWorkspace } from './workspace-changes.ts';
import { sessionFileError, WorkspaceSession } from './workspace-session.ts';

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
  if (config.listModels) {
    io.stdout(formatModelList(MODEL_CATALOG, io.env));
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
  const jobSession: JobSession = interactive ? 'interactive' : 'one-shot';
  if (prompt.length === 0 && !interactive) {
    return fail('no prompt given; pass the task as an argument or on stdin');
  }
  if (interactive && config.apply) {
    return fail(
      '--apply applies the changes of a task given on the command line; in the interactive session, /apply applies them',
    );
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
  // The sandbox starts before the model is resolved, so a session that cannot have one stops
  // before any request leaves the machine. Subagent reports are written by this process and read
  // by the tools, so their directory is exposed read-only.
  let sandbox: StartedSandbox | null = null;
  if (config.sandbox === 'workspace' && session !== null) {
    // Checked before anything starts.
    const project = await sandboxProject(cwd, io.env);
    const refused =
      'error' in project ? null : await sessionFileError(session.file.path, project.root);
    if (refused !== null) return fail(refused);
  }
  if (config.sandbox !== undefined) {
    let reports: string;
    try {
      reports = outputFiles.directory();
    } catch (error) {
      return fail(
        `cannot create the directory for saved output: ${errorMessage(error)}`,
        EXIT_CODES.error,
      );
    }
    const started = await startSandbox(config.sandbox, cwd, io.env, [reports], jobSession);
    if ('error' in started) return fail(started.error, EXIT_CODES.error);
    sandbox = started;
  }
  // An interactive session applies or discards the workspace's changes as it goes, and starts a
  // new sandbox each time.
  const restartable =
    interactive && sandbox?.workspace !== undefined && sandbox.relaunch !== undefined
      ? new SandboxSession(
          { backend: sandbox.backend, workspace: sandbox.workspace },
          sandbox.relaunch,
        )
      : null;
  const workCwd = sandbox?.cwd ?? cwd;
  try {
    // Overrides from the command line describe the model chosen there, not models switched to
    // later.
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
      toolBackend: restartable ?? sandbox?.backend ?? IN_PROCESS_BACKEND,
      // In a sandboxed session, the jobs run in the sandbox, which reports them to the agent.
      backgroundJobs: jobSession,
      ...(sandbox === null ? {} : { sandbox: sandbox.scope }),
      // Subagents run in the background and report when the session is free to listen; a one-shot
      // run ends with its task, so its main agent does the work itself.
      delegation: interactive,
      mode: config.mode,
      cwd: workCwd,
      instructions: config.agentsMd
        ? new InstructionsLoader(sandbox === null ? {} : { root: sandbox.scope.root })
        : null,
      ...(effort === undefined ? {} : { effort }),
      ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
      ...(config.timeLimitMs === undefined ? {} : { timeLimitMs: config.timeLimitMs }),
    });
    const warnings = [...resolved.warnings, ...agent.bootWarnings, ...(sandbox?.warnings ?? [])];
    if (resumed !== null) {
      agent.conversation.restore(resumed.conversation);
      if (resumed.mode === 'readonly' && config.mode === 'auto') {
        warnings.push(
          'this session was last run in readonly mode and continues in auto mode; pass --permission readonly to keep it read-only',
        );
      }
      if (resumed.sandbox !== undefined && config.sandbox === undefined) {
        warnings.push(
          `this session last ran its tools in the ${resumed.sandbox} sandbox and continues without one; pass --sandbox ${resumed.sandbox} to keep them in a sandbox`,
        );
      }
      if (resumed.cwd !== workCwd) {
        warnings.push(`this session was last run in ${resumed.cwd}; it continues in ${workCwd}`);
      }
    }

    const history = new PromptHistory(resumed?.history ?? []);
    if (interactive && io.terminal !== null) {
      // Awaited inside the try, so the sandbox is closed when the session ends, not when it starts.
      return await runRepl({
        agent,
        version: packageJson.version,
        cwd: workCwd,
        ...(config.sandbox === undefined ? {} : { sandbox: config.sandbox }),
        ...(restartable === null || sandbox === null
          ? {}
          : {
              workspace: new WorkspaceSession(
                sandbox.scope.root,
                restartable,
                (notice) => agent.notify(notice),
                () => agent.instructions().map((file) => file.path),
              ),
            }),
        resolveModel: (id) => resolveWith(id, {}),
        warnings,
        sessionFile: session?.file ?? null,
        resumedMessages: resumed === null ? null : resumed.conversation.messages.length,
        history,
        signal: io.signal,
        stdin: io.terminal.stdin,
        stdout: io.terminal.stdout,
        env: io.env,
      });
    }

    for (const warning of warnings) sink.notice('warning', warning);
    if (session !== null) {
      // The prompt of a one-shot run joins the history, so it can be recalled when the session is
      // continued interactively.
      history.add(config.prompt);
      new SessionLink(agent, workCwd, (message) => sink.notice('warning', message), history).attach(
        session.file,
      );
    }
    const result = await agent.run(prompt, {
      signal: io.signal,
      onEvent: (e) => sink.event(e),
      ...(input === undefined ? {} : { input }),
    });
    let code = EXIT_CODES[result.reason];
    if (sandbox?.workspace !== undefined) {
      // The worker and its jobs stop first: the changes are read once nothing writes them.
      await sandbox.backend.close();
      // An interrupt that came after the task finished, while the worker stopped, still keeps the
      // changes out of the project.
      const interrupted = config.apply && result.reason === 'done' && io.signal.aborted;
      code = finishWorkspace(sandbox.workspace, {
        apply: config.apply,
        done: result.reason === 'done',
        interrupted,
        code: interrupted ? EXIT_CODES.aborted : code,
        report: (event) => sink.changes(event),
      });
      // The application runs to its end, and an interrupt sent during it is handled only after
      // it. Handled here, before the run ends, it only aborts what is already done: the exit code
      // and the report are the application's, and nothing cuts the output short.
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
    }
    sink.finish();
    return code;
  } finally {
    // The changes of an interactive session not applied by now are discarded with its sandbox.
    await restartable?.close();
    await sandbox?.backend.close();
    const warn = (message: string) => sink.notice('warning', message);
    for (const workspace of [restartable?.workspace, sandbox?.workspace]) {
      if (workspace !== undefined && workspace !== null) removeDirectory(workspace.directory, warn);
    }
  }
};

// Removes the directory of a workspace session once its worker has stopped. The agent's writes
// are in it, so a failure is reported; the exit handler tries again, and the next workspace
// session after it.
const removeDirectory = (
  directory: StartedWorkspace['directory'],
  warn: (message: string) => void,
): void => {
  if (!isLiveWorkspaceDirectory(directory)) return;
  try {
    removeWorkspaceDirectory(directory);
  } catch (error) {
    warn(`the sandbox's changes in ${directory.path} could not be removed: ${errorMessage(error)}`);
  }
};
