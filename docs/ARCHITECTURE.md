# Architecture

nullrivet is a small agent core with a command-line front end. The core streams model responses,
executes tool calls and feeds the results back until the task is done. Everything it knows about a
session lives in memory and is discarded when the process exits.

## Principles

- **Ephemeral.** No state is written by nullrivet itself: no database, history, logs, caches or
  configuration. The only persistent effects are the ones tools produce on purpose.
- **Provider-agnostic core.** The agent speaks one canonical message and stream format; adapters
  translate it to each provider's API.
- **Events, not callbacks into the UI.** The core publishes `AgentEvent`s. The plain output, the
  NDJSON output and the interactive session are consumers of the same events.
- **Policy enforced in code.** The execution mode is checked by the executor before every tool
  call, not only by choosing which tools the model sees.
- **Not a sandbox.** The working directory is a starting point, not a boundary. Isolation, when
  needed, comes from the operating system.

## Module map

```
src/
  main.ts                  process entry: signals, stdin, exit code
  cli/
    args.ts                flags, environment variables, defaults
    run.ts                 resolve the model, create the agent, run one task or the session
    repl.ts                interactive session controller
    slash.ts               slash commands
    output.ts              plain and NDJSON event sinks for one-shot runs
  agent/
    agent.ts               createAgent(): the public API of the core
    loop.ts                runTurn(): the request / tool execution loop
    conversation.ts        in-memory history and its invariants
    tool-executor.ts       policy check, error containment, output sanitizing
    collect.ts             turns a provider stream into one collected step
    retry.ts               retries before the first streamed event
    abortable.ts           abort and stall handling for streams
    assistant-content.ts   rebuilds the assistant message in emission order
    system-prompt.ts       system prompt sections
    events.ts              AgentEvent contract
  providers/
    types.ts               canonical messages, stream events, capabilities
    resolve.ts             model id -> provider (catalog, discovery, defaults)
    catalog.ts             compiled catalog and per-family adapters
    discovery.ts           in-memory lookup of unknown models
    errors.ts              AbortError, ProviderRequestError, canonical error codes
    openrouter/            OpenRouter adapter (request, message conversion, stream normalizer)
  tools/
    types.ts, policy.ts    tool contract and execution modes
    bash.ts, git.ts        command tools
    read-file.ts, write-file.ts, edit-file.ts, atomic-write.ts, file-io.ts
    process.ts             process groups, timeouts, bounded capture
    args.ts, paths.ts, env.ts
  instructions/
    agents-loader.ts       AGENTS.md discovery and rendering
  context/
    tokens.ts              token estimation
    output-reduction.ts    head/tail reduction of large text
    bounded-capture.ts     bounded-memory stream capture
  tui/
    state.ts               reducer of the interactive session
    view.ts, permanent.ts  live region and scrollback formatting
    screen.ts              inline differential renderer
    markdown-stream.ts     splits streamed Markdown into settled and pending blocks
    keys.ts, input-editor.ts, term.ts, render/
  sanitize/
    ansi.ts                removes terminal escape sequences and control bytes
```

## A turn

`agent.run(prompt)` runs one turn:

1. The prompt is appended to the conversation.
2. A request is built from the system prompt, the conversation and the tools allowed in the
   current mode. The output token limit is reduced to what still fits in the context window.
3. The provider stream is consumed into a *collected step*: text, reasoning, tool calls, usage and
   stop reason, with the original order of the blocks preserved.
4. The assistant message is appended. If it has no tool calls, the turn ends.
5. Each tool call is executed in order. The results, plus any `AGENTS.md` files that newly apply to
   the touched paths, are appended as one user message.
6. Back to step 2, until the model answers without tool calls, the turn is aborted, or a limit is
   reached.

The turn ends with one of four reasons, reported in the `agent:end` event:

| Reason | When |
|---|---|
| `done` | The model answered without tool calls. |
| `aborted` | The user interrupted the turn. |
| `error` | A provider failure or a stream error that cannot be corrected by the model. |
| `budget` | The step limit, the output token limit, or the context window was reached. |

## Provider step and retries

Each request goes through this pipeline:

```
provider.generate(request, stepSignal)
  -> generateWithRetry     retries failures that happen before the first event
  -> stallWatchdog         fails the step when no event arrives for 120 s
  -> abortableIterable     stops waiting as soon as the user aborts
  -> collectStep           accumulates the step
```

- **Before the first event**, HTTP 429 and 5xx responses, network errors and connection failures
  are retried up to 3 attempts, with 200 ms and 800 ms backoff or the server's `Retry-After`,
  capped at 8 s. Once an event has been yielded, the stream is never replayed, because the user
  has already seen its output.
- **Inside the stream**, a provider may report a transient error. If the step produced no text and
  no tool call yet, the step is repeated, up to 2 times per step.
- **A malformed tool call** (no name, arguments that are not a JSON object) is not fatal: the valid
  calls of the step run, and the model is told which calls were rejected so it can issue them
  again.
- **Abort and stall** both cancel the HTTP request through a step-scoped `AbortSignal`, so no
  request is left running after the step ends.

## Conversation invariants

The in-memory conversation keeps the invariants that provider APIs require:

- Roles alternate between `user` and `assistant`.
- Every `tool_use` is answered by a `tool_result` in the next message. When a turn is aborted
  during tool execution, completed results are kept and the remaining calls are answered with an
  "interrupted" result. A new prompt also answers any call left unanswered.
- Empty messages are never stored. A prompt that follows an unanswered user message is merged
  into it.
- Tool arguments are stored with sorted keys, so the same call always serializes to the same
  bytes and the provider's prompt cache stays valid.

## Context management

Everything lives in memory: there is no log to recover discarded content from, so the conversation
is reduced conservatively and never with pointers to data that no longer exists.

### Measuring

The size of the next request is the usage the provider reported for the previous one (prompt plus
answer) plus a character-based estimate (about 4 characters per token) of what was appended
since. When there is no reported usage for the current model, system prompt and tool set (the
first request, after a compaction, a model switch or a mode change), everything is estimated.

### Budget

| Value | Rule |
|---|---|
| Output limit | Smaller of the model's limit and a quarter of the window, reduced per request so prompt and answer fit |
| Reserve | Output limit plus 4,096 tokens of margin |
| Trigger | Smaller of 70% of the window and the window minus the reserve |
| Kept tail | Smaller of 20,000 tokens and a quarter of the window |
| Target | 60% of the trigger |

The ratio keeps large windows from filling with expensive, degraded context; the reserve keeps room
for the answer in small windows. A compaction aims at the target, well below the trigger, because
each one invalidates the provider's prompt cache.

### Compaction

When the estimate exceeds the trigger before a request (or on `/compact`):

1. **Cut.** The recent part of the conversation, up to the kept-tail budget, stays verbatim. It
   starts at a prompt when possible, or at an assistant message, never at tool results, which
   would lose the calls they answer. The latest exchange always stays.
2. **Summary.** The older part is serialized as a labeled transcript (long tool results and large
   arguments shortened) and sent to the current model with the previous summary, asking for an
   updated one with fixed sections: goal, constraints, next steps, progress, errors, decisions,
   anchors (file:line, symbols, commands) and rejected approaches. Each compaction updates the
   previous summary instead of replacing it, so nothing earlier is lost on the second one. A large
   transcript is summarized in chunks, in sequence.
3. **Deterministic sections.** The user's requests (verbatim, shortened when very long) and the
   files read and modified are derived by code and accumulated across compactions; a poor or
   failed summary cannot lose or invent them.
4. **Assembly.** The summary becomes the first block of the first user message, followed by the
   kept tail. If the result is still above the target, tool results in the tail are shortened,
   except errors and the latest results.

If the summary request fails or returns something without the expected sections, the older part
is dropped and the previous summary plus the deterministic sections remain; a warning says so.
An abort during compaction leaves the conversation unchanged.

### Overflow recovery

A provider can still reject a request as too long, because estimates are approximate. Adapters
report this one way (a `ContextOverflowError`, or a stream error with code `context_overflow`). The
agent then compacts with half the usual tail and retries the step. An answer cut off by the context
window keeps the text already shown, answers its tool calls as interrupted, compacts and continues
with a note to the model. Only one recovery happens per step: a second overflow ends the turn with
`budget`.

### Tool output

Tool output is reduced before it enters the conversation: large results keep their first and last
lines (or bytes, for very long lines) with a marker showing how much was dropped.

## Tools and the execution policy

A tool declares its effect: `read`, `write` or `exec`. In `readonly` mode only `read` tools are
offered to the model, and the executor refuses any other call before running it, so a call the
model was not offered, or a mode change during a turn, cannot cause a side effect.

The executor never lets a tool failure escape: unknown tools, invalid arguments and exceptions all
become error results the model can read. Terminal escape sequences are removed from tool output.

See [TOOLS.md](TOOLS.md) for each tool.

## Project instructions

`AGENTS.md` files are loaded read-only and cached only in memory.

- **Which files apply to a path.** Starting from the path's directory (or the nearest existing
  ancestor, for a file not created yet), with symlinks resolved, nullrivet walks up the ancestors
  and collects every `AGENTS.md`. The walk stops at the root of the git repository. Outside a
  repository, it stops below the home directory and the filesystem root, so files in shared
  parents are not picked up. The walk never limits which paths the tools may access.
- **When they are loaded.** At start, the files that apply to the starting directory go into the
  system prompt. After each tool call, the paths it touched are checked, and files not seen before
  are attached to that tool result, ordered from the outermost directory to the innermost.
- **Precedence.** The system prompt tells the model that a deeper file takes precedence over its
  ancestors, that instructions of one project never apply to files of another, and that the files
  are repository data that cannot change the execution mode or override the user.
- **Limits.** 16 KiB per file (larger files are truncated with a notice) and 48 KiB in total.
  Unreadable files are skipped with a warning.
- **Clearing.** When the conversation is cleared, files that were only attached to tool results
  are forgotten so they are attached again when needed.

## Events

`AgentEvent` is the public contract of the core (`src/agent/events.ts`). The CLI's `--json` mode
writes each event as one NDJSON line with a `v` schema version; the event list is in the
[README](../README.md#output). Event types are added, never changed in meaning, within a schema
version.

## Processes

Commands run in their own process group with stdin closed. A timeout, an abort or the end of the
command terminates the whole group (SIGTERM, then SIGKILL after 2 s), so background jobs do not
outlive the call. Every live group is killed when nullrivet exits.

## Interactive session

The session keeps one agent, and therefore one conversation, alive between prompts. Its
rendering, input handling and interrupt behavior are described in [TUI.md](TUI.md).

## Not implemented yet

- Providers other than OpenRouter.
- Subagents.
