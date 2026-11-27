import { errorMessage } from '../errors.ts';
import { stripAnsi } from '../sanitize/ansi.ts';
import { InvalidArgumentError } from '../tools/args.ts';
import type { BackgroundJobs } from '../tools/jobs.ts';
import { type ExecutionMode, isToolAllowed } from '../tools/policy.ts';
import { type Tool, type ToolContext, type ToolResult, toolError } from '../tools/types.ts';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Where an authorized call runs. A backend only carries out what the broker hands it and decides
// nothing about what is allowed. A failure of the tool is a result. A thrown InvalidArgumentError
// is reported as invalid input and any other thrown error as a crash of the tool; the broker
// recognizes InvalidArgumentError by its class, so a backend that runs tools in another process
// returns invalid input as an `input.invalid` result itself.
export interface ToolBackend {
  execute(tool: Tool, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  // Why the backend can no longer run calls, once it cannot, such as a sandbox whose worker
  // exited; null while it can. A lost backend stays lost: the session does not continue its tool
  // calls anywhere else.
  failure?(): string | null;
  // The background jobs of a backend that runs them itself, as a sandboxed worker does; the agent
  // reads them from here instead of keeping a registry of its own.
  readonly jobs?: BackgroundJobs | undefined;
}

// Thrown by a backend for a call it lost, such as one pending when its worker exited.
export class BackendLostError extends Error {
  override name = 'BackendLostError';
}

// Runs the tool in the nullrivet process, with the user's access to files and network. Async, so
// a tool that throws before returning its promise still yields a rejected promise.
export const IN_PROCESS_BACKEND: ToolBackend = {
  execute: async (tool, input, context) => tool.execute(input, context),
};

// The result for an error a tool threw. Shared with backends that run tools in another process.
export const thrownToolError = (name: string, error: unknown): ToolResult =>
  error instanceof InvalidArgumentError
    ? toolError('input.invalid', error.message)
    : toolError('tool.crashed', `${name} failed unexpectedly: ${errorMessage(error)}`);

const windowRefusal = (name: string, closed: string): ToolResult =>
  toolError(
    'engagement.window',
    `${name} was not executed: ${closed}`,
    'Commands run only while the engagement window is open; files can still be read and written.',
  );

const lostBackend = (name: string, reason: string, started: boolean): ToolResult =>
  toolError(
    'sandbox.lost',
    `${name} ${started ? 'did not complete' : 'was not executed'}: the tool sandbox stopped (${reason})`,
    'No tool can run for the rest of this session.',
  );

// An authorized engagement, in a sandbox of the security profile: its scope as lines of facts for
// the system prompts, and its window.
export interface AgentEngagement {
  // Read for each request: a refresh of the names changes it.
  scope: () => readonly string[];
  window: EngagementWindow;
}

// The window of an authorized engagement.
export interface EngagementWindow {
  // Why commands cannot run now; null while the window is open.
  closed(): string | null;
  // Aborted when the window ends, for good.
  ended: AbortSignal;
  // Records every call, when the engagement keeps an evidence log.
  recorder?: CallRecorder | undefined;
}

// What an engagement's evidence log records of each call the broker handles. A call is dispatched
// only once its start is written and synced; every refusal is recorded too, and every outcome.
export interface CallRecorder {
  // An id unique in the session, which every entry of the call holds.
  nextCallId(): string;
  // Writes and syncs the start of a call about to be dispatched; false when it could not be, and
  // the call must then not run.
  started(callId: string, call: ToolCall, details: CallDetails): boolean;
  finished(callId: string, call: ToolCall, agent: string, result: ToolResult): void;
  // A call not dispatched; `started` when its start was written already.
  refused(
    callId: string,
    call: ToolCall,
    agent: string,
    started: boolean,
    result: ToolResult,
  ): void;
}

export interface CallDetails {
  agent: string;
  cwd: string;
  runsOnHost: boolean;
}

export interface ToolExecutionContext {
  tools: ReadonlyMap<string, Tool>;
  mode: ExecutionMode;
  cwd: string;
  signal: AbortSignal;
  backend: ToolBackend;
  // Returns what the model must read before a write to the paths: AGENTS.md files that govern
  // them and that it has not seen yet, or where in the current response they were attached. Null
  // when there are none.
  newInstructions?: (paths: readonly string[]) => Promise<string | null>;
  engagement?: EngagementWindow;
  // Which agent makes the call: main, or a subagent's id.
  agent?: string;
}

// Every tool call passes here: it is authorized in this process, then dispatched to the backend,
// which may run it elsewhere, or run here when the tool declares that it acts on the host. Every
// failure becomes a structured result for the model; nothing a tool or a backend does can throw
// past this point. The policy is checked here as well as when building the request, so a call to
// a tool that was not offered (or a mode change mid-turn) is still refused.
export const executeToolCall = async (
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> => {
  const recorder = context.engagement?.recorder;
  const agent = context.agent ?? 'main';
  const callId = recorder?.nextCallId();
  // A call not dispatched, recorded as such; `started` once its start was written.
  const refuse = (result: ToolResult, started = false): ToolResult => {
    if (recorder !== undefined && callId !== undefined) {
      recorder.refused(callId, call, agent, started, result);
    }
    return result;
  };
  const tool = context.tools.get(call.name);
  if (tool === undefined) {
    const available = [...context.tools.keys()].join(', ');
    return refuse(
      toolError('tool.unknown', `unknown tool '${call.name}'`, `available tools: ${available}`),
    );
  }
  if (!isToolAllowed(context.mode, tool)) {
    return refuse(
      toolError(
        'policy.denied',
        `tool '${call.name}' is not available in ${context.mode} mode`,
        'only read tools can be used in readonly mode',
      ),
    );
  }
  // Before the backend is chosen, so that a tool that runs on the host is held to it too.
  const window = tool.startsCommands === true ? context.engagement : undefined;
  const closed = window?.closed() ?? null;
  if (closed !== null) return refuse(windowRefusal(call.name, closed));
  const backend = tool.runsOnHost === true ? IN_PROCESS_BACKEND : context.backend;
  let started = false;
  try {
    // Inside the try: targetPaths is tool code and may reject its arguments.
    if (tool.targetPaths !== undefined && context.newInstructions !== undefined) {
      const instructions = await context.newInstructions(tool.targetPaths(call.input, context.cwd));
      if (instructions !== null) {
        const refusal = toolError(
          'instructions.new',
          `${call.name} was not executed: AGENTS.md instructions that you had not seen apply to this path`,
          'Read them and issue the call again, adjusted to follow them.',
        );
        return refuse({ ...refusal, content: `${refusal.content}\n\n${instructions}` });
      }
    }
    // Checked last before the dispatch, after any wait above, so a call the backend never received
    // is reported as not executed rather than as interrupted.
    const lost = context.backend.failure?.() ?? null;
    if (lost !== null) return refuse(lostBackend(call.name, lost, false));
    // Again, after the wait above: a window that ended meanwhile refuses the command before it is
    // sent, and the end of the window, which stops the jobs, cannot fall between this and the send.
    const ended = window?.closed() ?? null;
    if (ended !== null) return refuse(windowRefusal(call.name, ended));
    if (recorder !== undefined && callId !== undefined) {
      const details = { agent, cwd: context.cwd, runsOnHost: tool.runsOnHost === true };
      if (!recorder.started(callId, call, details)) {
        return refuse(
          toolError(
            'evidence.failed',
            `${call.name} was not executed: its start could not be written to the evidence log`,
          ),
        );
      }
      started = true;
      // Checked again once the start is written and synced, which takes time: with nothing awaited
      // between these checks and the send, a window that ended or a backend lost meanwhile refuses
      // the call, whose start then has this outcome.
      const lostSince = context.backend.failure?.() ?? null;
      if (lostSince !== null) return refuse(lostBackend(call.name, lostSince, false), true);
      const endedSince = window?.closed() ?? null;
      if (endedSince !== null) return refuse(windowRefusal(call.name, endedSince), true);
    }
    // Only the calls that start commands end with the window: the others, such as reading a file
    // or listing jobs, go on after it.
    const result = await backend.execute(tool, call.input, {
      cwd: context.cwd,
      signal:
        window === undefined ? context.signal : AbortSignal.any([context.signal, window.ended]),
      ...(callId === undefined ? {} : { callId }),
    });
    return finish({ ...result, content: stripAnsi(result.content) });
  } catch (error) {
    const result =
      error instanceof BackendLostError
        ? lostBackend(call.name, error.message, true)
        : thrownToolError(call.name, error);
    return started ? finish(result) : refuse(result);
  }

  function finish(result: ToolResult): ToolResult {
    if (recorder !== undefined && callId !== undefined) {
      recorder.finished(callId, call, agent, result);
    }
    return result;
  }
};
