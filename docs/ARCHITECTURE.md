# Architecture

nullrivet is a small agent core with a command-line front end. The core streams model responses,
executes tool calls and feeds the results back until the task is done. Everything it knows about a
session lives in memory and is discarded when the process exits, unless the user names a session
file.

## Principles

- **Ephemeral.** No state is written by nullrivet itself: no database, history, logs, caches or
  configuration. The only persistent effects are the ones tools produce on purpose, and a session
  file when the user names one. The complete output of reduced tool results is the one exception:
  it is kept in private temporary files for the duration of the run and removed when it ends.
- **Provider-agnostic core.** The agent speaks one canonical message and stream format; adapters
  translate it to each provider's API.
- **Events, not callbacks into the UI.** The core publishes `AgentEvent`s. The plain output, the
  NDJSON output and the interactive session are consumers of the same events.
- **Policy enforced in code.** The execution mode is checked by the tool broker before every tool
  call, not only by choosing which tools the model sees.
- **Not a sandbox by default.** The working directory is a starting point, not a boundary.
  Isolation, when needed, comes from the operating system: `--sandbox inspect` runs the tools in
  Bubblewrap ([SANDBOX.md](SANDBOX.md)).

## Module map

```
src/
  main.ts                  process entry: the CLI, or the sandbox worker when started as one
  cli/
    host-main.ts           the CLI process: signals, stdin, exit code
    args.ts                flags, environment variables, defaults
    run.ts                 resolve the model, create the agent, run one task or the session
    repl.ts                interactive session controller
    auto-continue.ts       when an idle session starts a turn on background events
    slash.ts               slash commands
    session-file.ts        session files: loading, validation, atomic saves, attaching
    prompt-history.ts      prompts recalled with the arrow keys
    output.ts              plain and NDJSON event sinks for one-shot runs
    list-models.ts         the model catalog as a table, for --list-models
  agent/
    agent.ts               createAgent(): the public API of the core
    loop.ts                runTurn(): the request / tool execution loop
    compactor.ts           summary requests of a compaction, in chunks
    conversation.ts        in-memory history and its invariants
    snapshot.ts            the conversation as data: snapshot format and its validation
    subagent.ts            the delegate tool and the registry of background subagents
    tool-broker.ts         authorization, dispatch to a backend, error containment, sanitizing
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
    http-stream.ts         streamed response lines and error origins for the HTTP adapters
    anthropic/, openai/,   adapters: request building, message conversion, stream normalizers
    google/, xai/,
    ollama/, openrouter/
  tools/
    types.ts, policy.ts    tool contract and execution modes
    bash.ts, git.ts        command tools
    read-file.ts, write-file.ts, edit-file.ts, atomic-write.ts, file-io.ts
    line-diff.ts           line diff of an edit or write, shown by the interface only
    glob.ts, grep.ts       file search; grep-search.ts runs in grep-worker.ts
    file-walk.ts           directory listing shared by glob and grep
    process.ts             process groups, timeouts, bounded capture
    jobs.ts                background jobs: registry, events, and their three tools
    output-files.ts        complete output of reduced results, saved in parts to temporary files
    args.ts, paths.ts, env.ts
  sandbox/
    start.ts               starts the session's sandbox, or says why it cannot
    bwrap.ts               the inspect profile: project root, mounts, environment, Bubblewrap
    seccomp.ts             the seccomp program installed in the sandbox
    worker.ts              the worker process: runs tools for the host over the protocol
    worker-backend.ts      the host side: a tool backend that validates every worker message
    worker-command.ts      how the worker is started, from source or from the binary
    protocol.ts, lines.ts  the JSON lines protocol and its line framing
  instructions/
    agents-loader.ts       AGENTS.md discovery and rendering
  context/
    budget.ts              output limit, compaction trigger, kept tail and target
    compaction.ts          cut, transcript, summary sections and assembly
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
    display.ts             cleans text for the terminal, bidirectional controls included
    fence.ts               fences around untrusted text embedded in prompts
```

## A turn

`agent.run(prompt)` runs one turn:

1. The prompt is appended to the conversation.
2. A request is built from the system prompt, the conversation and the tools allowed in the
   current mode, with the project instructions of the starting directory at the start of the
   first user message. Runtime notices, such as a background job or a subagent that ended, are
   appended as `<agent-note>`s first, after any automatic compaction; a subagent's report follows
   its note as a fenced data block. A request takes at most one batch of notices. The output
   token limit is reduced to what still fits in the context window.
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
| `budget` | The step limit, the time limit, the output token limit, or the context window was reached. A time limit stops the task like an interrupt (running commands are terminated) before ending it here. |

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
  are retried up to 3 attempts, with 200 ms and 800 ms backoff or the server's advice
  (`Retry-After`, or the retry delay in a Gemini quota error), capped at 8 s. Once an event has
  been yielded, the stream is never replayed, because the user has already seen its output.
- **Inside the stream**, a provider may report a transient error. If the step produced no text and
  no tool call yet, the step is repeated, up to 2 times per step.
- **A stream cut short** (a dropped connection, a proxy closing it) must not pass for a complete
  answer. Adapters emit a stop only when the provider reports how the response finished, and the
  step collector turns a missing stop into a transient `stream.incomplete` error: the step is
  repeated when nothing came through, and the turn ends with an error otherwise. A finish reason
  an adapter does not know (Gemini's `OTHER`, for example) is an error too, not a clean finish.
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

Everything lives in memory, apart from the saved output of reduced tool results, which lasts
until the process exits. There is no log to recover discarded content from, so the conversation is
reduced conservatively and never with pointers to data that no longer exists.

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
2. **Summary.** The older part is encoded as a JSON transcript, one entry per block: user text,
   attached input, assistant text, tool call, tool result or runtime note (long text and large
   arguments shortened). It is sent to the current model with the previous summary, asking for an
   updated one with fixed sections: goal, constraints, next steps, progress, errors, decisions,
   anchors (file:line, symbols, commands) and rejected approaches. Each compaction updates the
   previous summary instead of replacing it, so nothing earlier is lost on the second one. A large
   transcript is summarized in chunks, in sequence; a chunk ends between entries, so a tool call
   and its result can fall in consecutive requests.
3. **Deterministic sections.** The user's requests (verbatim, shortened when very long) and the
   files read and modified are derived by code and accumulated across compactions; a poor or
   failed summary cannot lose or invent them. Files are tracked from the `read_file`, `edit_file`
   and `write_file` calls; files read or changed through `bash` are not listed. A section the
   updated summary leaves out entirely is carried over from the previous summary, marked as such,
   so an omitted heading does not erase what earlier compactions recorded; a section kept as
   "(none)" is the model's decision.
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

When `bash`, `git` or `delegate` reduce a result, the complete output is also written to private
temporary files, split into parts no larger than what `read_file` and `grep` accept, and a line
below the reduced text names them. Reduction then affects what the model sees first, not what it
can recover: it reads the omitted part with the read tools, in either mode, instead of running the
command again. The files are removed when nullrivet exits and never before, so a path in the
conversation stays valid for the whole run. Limits and states are described in
[TOOLS.md](TOOLS.md#saved-output).

## Tools and the execution policy

A tool declares its effect: `read`, `write` or `exec`. In `readonly` mode only `read` tools are
offered to the model, and the tool broker refuses any other call before running it, so a call the
model was not offered, or a mode change during a turn, cannot cause a side effect.

The conversation records the mode of its last request. When the next request is made in another
mode, an `<agent-note>` saying so is added to the last user message, after the prompt or the tool
results. The system prompt already states the current mode, but answers given under the previous
one stay in the history, and models tend to follow what they said before.

Every tool call, a subagent's included, is authorized by the tool broker and only then handed to
a tool backend, which runs it and decides nothing about what is allowed. The one backend today
runs the tool in the nullrivet process; the sandbox planned in [SANDBOX.md](SANDBOX.md) adds one
that runs it in an isolated worker.

The broker never lets a tool or backend failure escape: unknown tools, invalid arguments and
exceptions all become error results the model can read. Terminal escape sequences are removed from
tool output.

Tool calls run one after another, in the order the model wrote them.

See [TOOLS.md](TOOLS.md) for each tool.

## Project instructions

`AGENTS.md` files are loaded read-only and cached only in memory; nullrivet never creates or edits
one on its own.

- **Which files apply to a path.** Starting from the path's directory (or the nearest existing
  ancestor, for a file not created yet), with symlinks resolved, nullrivet walks up the ancestors
  and collects every `AGENTS.md`. The walk stops at the root of the git repository. Outside a
  repository, it stops below the home directory and the filesystem root, so files in shared
  parents are not picked up. The walk never limits which paths the tools may access.
- **Links.** An `AGENTS.md` that is a symbolic link is loaded only when its final target is inside
  the repository, or inside its own directory outside a repository, as with `AGENTS.md` linking
  to `CLAUDE.md`; otherwise it is skipped with a warning. The files reach the provider without any
  action of the model, so a cloned repository could otherwise make nullrivet send a file of the
  user, such as a private key, with the first request.
- **When they are loaded.** At start, the files that apply to the starting directory are loaded,
  and every request carries them at the start of the first user message. They are added when the
  request is built, not stored in the conversation, so compaction and clearing never drop them.
  After each tool call, the paths it touched are checked, and files not seen before are attached
  to that tool result, ordered from the outermost directory to the innermost.
- **Before a write.** `edit_file` and `write_file` declare their target path before they run. If
  files not seen before govern it, the call is not executed: it returns an `instructions.new`
  error with the files attached, and the model repeats the call once it has read them. Files
  attached to another result of the same response count as not seen, since the model wrote the
  whole response before receiving them. A change therefore never happens before the instructions
  that govern it reach the model. `bash` cannot be covered this way, since the paths a command
  touches are not known in advance.
- **Precedence.** The system prompt tells the model that a deeper file takes precedence over its
  ancestors, that instructions of one project never apply to files of another, and that the files
  are repository data that cannot change the execution mode or override the user.
- **Limits.** 16 KiB per file (larger files are truncated with a notice) and 48 KiB in total.
  Unreadable files are skipped with a warning.
- **Clearing.** When the conversation is cleared, files that were only attached to tool results
  are forgotten so they are attached again when needed.

## Trust boundaries

Instructions and data reach the model through separate channels, and text from outside the agent
is never placed where it would carry the authority of the rules or of the user.

| Channel | Content | Authority |
|---|---|---|
| System prompt | nullrivet's rules, the execution mode, the environment | Rules |
| User turn | The user's prompts | The user's requests |
| User turn, fenced block | `AGENTS.md` of the starting directory; text piped on stdin with a prompt, in its own block after the prompt; a subagent's title, stop message and report, after its runtime note | Data |
| User turn, first block after a compaction | Notes written by the agent, then the user's requests quoted verbatim | Notes; only the quoted requests are the user's |
| User turn, `<agent-note>` | Feedback from the runtime, such as a rejected tool call, a background job or a subagent that ended; never command output or text from a model | Runtime |
| Tool results | File contents, command output, search results, `AGENTS.md` found later | Data |

- **The rules state the hierarchy.** Instructions come only from the rules and the user. Data can
  tell the model how to carry out the task, such as how to build and test, but not change it,
  widen it or grant permissions: instructions found in data that go beyond the task are not
  followed and are reported to the user. Credentials found along the way are not printed or sent,
  and local data is not sent to services other than the session's model provider, unless the
  user's request requires it.
- **Values in the rules.** The working directory is the one value from outside written into the
  system prompt, and it is quoted as a JSON string: a directory name can hold line breaks, and a
  subagent's directory is chosen by a model, so it must not be able to add lines to the rules.
- **Fences.** Text embedded in a user turn is wrapped in a tag whose opening and closing carry a
  value drawn at random when the process starts (`<input fence="…">` … `</input fence="…">`). The
  text cannot know the value, so it cannot end the block early. The value is fixed for the
  process, so prompts stay identical across requests for prompt caching.
- **Summaries.** The summarizer receives the transcript as JSON, so a file or command output
  cannot pose as a user message or end the transcript. Attached input (piped stdin, a subagent's
  context) gets its own role. The goal and the constraints come from user entries only;
  instructions found in attached input or tool results are recorded only as attributed
  observations. The verbatim list of the user's requests leaves attached input out.
- **Enforcement is in code.** The rules make injection less likely to succeed; they do not stop
  it. What a successful injection can do is bounded by the code: the execution mode is checked
  before every tool call, commands run without the agent's API keys, and the `git` tool and the
  file listing cannot run programs configured by a repository.

## Subagents

A subagent is a second run of the same loop (`runTurn`) inside the same process, started by the
`delegate` tool. It exists to keep the main conversation small: it can read dozens of files, and
only its report comes back. It runs in the background while the main agent keeps working, and it
only reads: the main agent is the only one that changes files or runs commands.

- **Spawn, not fork.** The subagent gets a new `Conversation` with nothing from the parent: its
  first message is the delegate call's objective, followed by its context fenced as data, since
  the parent may have copied that text from files. It has its own `InstructionsLoader`
  (a fork of the parent's settings with nothing loaded), so the `AGENTS.md` files of its starting
  directory reach it even when the parent already has them.
- **Same model, read tools.** It uses the parent's current model and effort and runs in
  `readonly`, so it is offered only the `read` tools of the session. It never gets `delegate` or
  the background job tools, so delegation is one level deep. Its system prompt adds a section that
  names the delegating agent as its user and asks for a report: result, evidence, open issues.
- **Interactive session only.** A report arrives after the call that started it; a one-shot run
  ends with its task, so it does not offer `delegate`. `createAgent` offers it only when asked
  (`delegation: true`), since only a caller that runs more turns receives the reports.
- **Registry.** `SubagentRegistry` owns the runs, as `JobRegistry` owns the jobs; the agent only
  combines the two. `delegate` registers a run and returns its id at once. Ids are a random
  prefix of the registry and a counter, so an id in a resumed conversation never names a run of
  another process. Four runs make progress at once; up to 16 more wait for a slot in order, and
  beyond that `delegate` is refused. The registry owns each run's promise, which never rejects: an
  exception becomes a `failed` outcome, the slot is always released, and the outcome is recorded
  once. An activity listener that throws is reported apart, as an uncaught error, so it changes
  neither the outcome nor the bookkeeping. A run cancelled just as a slot is handed to it gives
  the slot back without starting.
- **Limits.** The session's limits for a task, `--max-steps` and `--timeout`, apply to each run,
  the time counted from when it starts running. Without a `--timeout`, a run gets 30 minutes
  (`SUBAGENT_DEFAULT_TIME_LIMIT_MS`): the main agent can go without a time limit because the user
  watches it, but a run without one could hold its slot, and the queue behind it, without end. The
  deadline aborts with the same reason as `--timeout`, so the loop reports a limit, not a
  cancellation. Before its last step, a runtime note asks for the report without more tool calls.
  After four fifths of the time limit, the loop makes the step in progress the last one
  (`finalStepAt`), so a run that is about to time out still writes its report. The loop returns
  which limit ended a turn (`limit` in the result), and the reason in the note comes from it,
  never from the text of the loop's message.
- **Cancellation.** Each run has its own signal, independent of the turn that started it.
  Interrupting a turn, `Esc` on an idle session and exiting cancel every run, running or
  waiting. `/clear` also discards them: a discarded run reports nothing to the model, and from
  then on only its `usage` and `subagent:end` events reach the interface, so nothing it does later
  shows it again.
- **Report.** When a run ends, the registry announces a pending event, like a job that ended. The
  runtime note holds only facts the runtime observed: id, status, a reason it chose itself when
  the run stopped early (`cancelled`, `time_limit`, `step_limit`, `context_full`, `output_limit`,
  `provider_error`, `sandbox_lost`, `internal_error`), steps, tool errors and tokens. The title,
  any message that came with the stop (possibly from a provider) and the report follow as fenced
  data: a model's text never gets the authority of a note. The user is shown the title and the
  same facts instead of the note (`display` of a runtime notice).
- **Batches.** The job and subagent registries expose their pending events without consuming
  them, and the agent marks as delivered only those it selects for a batch. A batch takes every
  job event and the reports in the order they ended, while their data fits a budget of a quarter
  of the context window and at most 32 KiB, and always at least one report; the rest stay pending
  for the next request. The registry keeps each report whole, and its data is built when it is
  sent, within the budget and never above 16 KiB, with everything it holds: the stop message, which
  may come from a provider at any length, is cut first, the report gets the room left after the
  title and the name of the file that saves it whole, and the budget has a floor of 2 KiB so that
  room exists. Since one report never exceeds the budget, the rule of at least one report per batch
  never does either. Compaction cannot shorten text in the latest message, so the budget is what
  keeps a batch from filling a small window. The batch is in time order. The loop takes at most one
  batch per request, so a retried request does not take a second one, and earlier reports can be
  compacted once they leave the latest message.
- **Events.** The subagent's own events are not forwarded: text from two agents would mix. The
  registry emits `subagent:start`, `subagent:progress` (step and current tool) and `subagent:end`
  with the subagent's id, and forwards its `usage` events tagged with that id, so token totals
  include subagents while the context gauge reflects the main conversation only. These events go
  to a listener of the agent (`onSubagentActivity`), not of a turn, since a run outlives the turn
  that started it. Nothing of the subagent is kept once its report is delivered.

## Sessions

The core stays free of session I/O. It offers two things:

- **Snapshots.** `Conversation.snapshot()` returns the history, the compaction state and the mode
  of the last request as plain data, and `restore()` puts them back, so a session continued in
  another mode is announced like a switch. `parseConversationSnapshot()` checks data read from
  outside the process against the invariants the conversation keeps in memory: the history starts
  with the user, roles alternate, tool calls are in assistant messages and results in user
  messages, every call is answered by the next message (except calls of the last message, which
  the conversation answers before the next prompt), and a summary state comes with the summary
  block at the head. Blocks are rebuilt from their known fields. Anything else is refused, never
  repaired.
- **A checkpoint.** `Agent.checkpoint`, null by default, is called whenever the conversation is
  consistent and worth keeping: after each step's tool results, after a compaction, and when a
  turn ends, also when it was interrupted. The core does not know what it does.

The CLI edge does the rest:

- **`SessionFile`** loads a file, refusing symbolic links, files over 64 MiB and anything that is
  not a valid session. It saves the whole state atomically with mode 0600, after checking that
  the file is as this process last left it (inode, size, modification time); otherwise it throws
  instead of overwriting another writer's change. A state larger than loading accepts is not
  written.
- **`SessionLink`** attaches a file to the agent through the checkpoint. It runs saves one at a
  time, skips a save when the conversation's revision, model, effort and mode are unchanged, and
  detaches the file with one warning when a save fails. It backs `--session` and `/session`.
- **Switching files.** A new file is attached only after its first write succeeds; the previous
  file keeps the conversation as it was, so switching forks the session. `/session <file>`
  refuses a file that already holds a session: continuing one is done only at startup. `/clear`
  detaches the file rather than saving an empty conversation over it.
- **Exit.** The interactive session saves once more on the way out, since a turn interrupted then
  may not reach its own checkpoint.
- **Continuing.** The file records the model, effort, mode and sandbox profile it was last run
  with. The model and effort are used when the invocation does not choose them; the mode and the
  sandbox only produce a warning, when a session continues in `auto` after `readonly` or without
  the sandbox it ran in, because permissions come from the invocation alone. `AGENTS.md` files are not stored, since
  they are added when each request is built, so a continued session reads them again from disk.
- **Prompt history.** The file also holds the prompt history of the interactive session, with the
  prompt of each one-shot run added, so a continued session recalls them. A new entry alone is
  enough to save the file again.

## Events

`AgentEvent` is the public contract of the core (`src/agent/events.ts`). The CLI's `--json` mode
writes each event as one NDJSON line with a `v` schema version; the event list is in the
[README](../README.md#output). Event types are added, never changed in meaning, within a schema
version.

## Processes

Commands run in their own process group with stdin closed. A timeout, an abort or the end of the
command terminates the whole group (SIGTERM, then SIGKILL after 2 s), so background jobs do not
outlive the call. Every live group is killed when nullrivet exits, including on SIGTERM and on
SIGHUP (a closed terminal or a lost SSH connection), whose default action would skip it.

Background jobs (`bash_background`) start the same way, but are not tied to a turn: no abort
signal, and no timeout unless `max_runtime_ms` is given. Their groups are in the same set, so they
are killed with the rest when nullrivet exits. A registry owned by the main agent tracks them and
records each event (ready, finished) once; the loop turns the events not yet shown into runtime
notes. See [TOOLS.md](TOOLS.md#background-jobs).

## Interactive session

The session keeps one agent, and therefore one conversation, alive between prompts, and saves it
to a session file when one is attached (see [Sessions](#sessions)). Its rendering, input handling
and interrupt behavior are described in [TUI.md](TUI.md).

Turns start from two sources: the user's prompts and background events, from jobs and from
subagents that ended. The registries only announce that an event is pending; they never hand the
event to the session. A small scheduler (`cli/auto-continue.ts`) decides when an idle session
starts a turn without a prompt (`agent.runOnBackgroundEvents`), with a limit of 5 automatic
turns per prompt and a suspension after an interrupt or a turn that did not end with `done`. Only
automatic turns that start background work count toward the limit (`agent.backgroundStarts`
before and after): the others only take events of work that already exists, which are finite. The
turn's loop alone takes the events and adds them as runtime notes, so an event reaches the model
exactly once, whichever turn takes it. A turn without a prompt that finds no event ends before any
compaction or request. Clearing the conversation drops the events of the jobs it started, which
keep running, and cancels and discards its subagents: nothing in the new conversation would
explain them.
