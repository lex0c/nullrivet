# Interactive interface

The interactive session renders inline, in the terminal's normal screen: there is no alternate
screen, so everything that is finished stays in the scrollback and can be scrolled, searched and
copied like any other terminal output. Only the bottom of the screen, the *live region*, is
redrawn: the task in progress, the input box and the status lines.

```
  ● Ran ls src  [22ms]                         ┐
                                               │ scrollback: written once
  The src directory contains one file.         │
                                               ┘
  Writing… (4.0s · ↓ ~59 tokens)               ┐
─────────────────────────────────────────      │
> next prompt                                  │ live region: redrawn
─────────────────────────────────────────      │
  auto mode on · esc to interrupt  model       │
  ~/projects/app                               ┘
```

## Data flow

```
keys ──> input editor ──┐
agent events ───────────┼──> reducer ──> state ──> view ──> screen.render (live region)
slash commands ─────────┘        └──> permanent items ──> screen.print (scrollback)
```

- **Reducer** (`src/tui/state.ts`): a pure function from the current state and an action (an
  edit of the input, an agent event, a command result) to the next state plus the items that
  are now final and go to the scrollback.
- **View** (`src/tui/view.ts`): composes the live region from the state: one row per subagent
  running in the background, with its current step and tool, the pending answer, one card per
  running tool, a phase indicator, the input box, the command list and the status lines.
  Subagent rows stay while no turn runs, since a subagent outlives the turn that started it.
  `src/tui/permanent.ts` formats the scrollback items. The card of an `edit_file` or
  `write_file` call shows the counts of added and removed lines in its head and, under it, the
  first changed region with line numbers. File content, command lines and messages from tools and
  providers have escape sequences, control bytes and Unicode bidirectional controls removed
  before they are drawn, so a row shows the characters it holds, in their order.
- **Screen** (`src/tui/screen.ts`): draws frames; it knows nothing about the agent.
- **Controller** (`src/cli/repl.ts`): wires the terminal, the keys, the agent and the commands
  together and schedules redraws at up to 30 frames per second.

## Screen engine

- **One logical row is one physical row.** Rows are split at embedded newlines and truncated
  to the terminal width before drawing, so the engine always knows how many rows to erase.
- **Differential drawing.** When the live region keeps its height, only the rows that changed
  are rewritten. Each frame is written with a single `write` inside synchronized-output markers,
  so terminals that support them never show a half-drawn frame.
- **Height limit.** A live region taller than the terminal cannot be erased reliably and would
  leave stray rows behind. Frames are limited to one row less than the terminal height by
  dropping rows from the top; the input box and the status lines at the bottom always stay
  visible.
- **Resizing.** After a resize the terminal re-wraps rows that were drawn at the old width; the
  engine computes how many physical rows the previous frame now occupies before erasing it.
- **Printing.** Text for the scrollback is written above the live region, which is then redrawn
  below it.

## Streaming Markdown

Answers arrive token by token, but Markdown can only be rendered correctly once a block is
complete; an unclosed code fence, for example, changes how everything after it looks.

The pending text is therefore split into a *settled* part and a *pending* part
(`src/tui/markdown-stream.ts`). A block is settled when a blank line outside a fenced code block
is followed by a line that starts a new block. Settled blocks are rendered once and written to
the scrollback; the pending block is re-rendered in the live region on every frame. An indented
line after a blank line can continue the previous block (a paragraph inside a list item), so it
does not settle it. Any remaining text is settled when a tool call starts or the turn ends.

## Input

- Key sequences are decoded by `src/tui/keys.ts`. A lone `ESC` byte is ambiguous (the Escape key
  or the start of a longer sequence split across reads), so it is resolved after 30 ms without
  further input.
- Bracketed paste delivers pasted text as one event; line breaks in it become newlines in the
  prompt instead of submitting it. Escape sequences and control characters are removed from
  anything inserted into the prompt.
- On xterm-compatible terminals the session enables the extended key reporting mode
  (`modifyOtherKeys`) so `Shift+Enter` arrives distinctly from `Enter`. The kitty keyboard
  protocol form (CSI u) is recognized as well. Terminals that report neither send `Shift+Enter`
  as `Enter`; `Alt+Enter` and `\` followed by `Enter` insert a newline everywhere.
- While a task runs, the next prompt can be typed, but it is sent only once the task ends.
- Submitted prompts and commands form a history (`src/cli/prompt-history.ts`) of at most 100
  entries and 1 MiB, the oldest dropped first, without blank entries or a repeat of the latest
  one. A prompt over 64 KiB, such as a large paste, is not kept. `↑` on the first line of the
  input recalls the newest entry and keeps the text being typed as a draft; while browsing, `↑`
  and `↓` walk the history wherever the cursor is, even when a recalled command opens the command
  list, and `↓` past the newest entry restores the draft. Editing a recalled entry ends browsing.
  Recalled entries are cleaned like pasted text, since a one-shot prompt kept in a session file
  can hold escape sequences. `/clear` keeps the history. It lives in memory and, when a session
  file is attached, in that file.
- `Shift+Tab` switches the execution mode between `auto` and `readonly`, also while a task runs:
  the executor reads the mode before every tool call, so the switch applies from the next one. It
  does not stop or undo a call already running: a command started in `auto` runs to its end. Each
  switch prints a line in the scrollback, the only record of which mode the tool calls around it
  ran in. The status line shows the mode, with the `Shift+Tab` hint when no task runs and the
  interrupt hint while one does, so the latter stays visible in narrow terminals. With no task
  running and subagents in the background, the hint says that `Esc` cancels them instead. With the
  command list open, `Shift+Tab` completes the selected command, like `Tab`.
- The right side of the status line starts with the background work, in green: `2 jobs` running,
  and `3 subagents`, or `4+1 subagents` when one waits for a slot. Each part appears only while
  there is such work, also between tasks, and it is the last part dropped in a narrow terminal.
  The session reads the counts again at the end of each tool call, at each background event and
  when a subagent starts or ends its run, since jobs and subagents change outside any turn.
- The editor (`src/tui/input-editor.ts`) is a pure function from the input state and a key to the
  next input state, plus signals for submit, interrupt and end of file.

## Automatic continuation

When a background job ends or becomes ready, or a subagent ends, while the session is idle, the
session starts a turn on its own: a line says "Continuing on background events.", the runtime
notes follow as info lines (for a subagent, its title and how it ended), and the turn runs like
any other. Esc and `Ctrl+C` interrupt it, the current mode applies, and the session file saves it.
Events that arrive within 250 ms of each other share one turn. The agent never reads the job's
output from the event itself: the note names the log.

- **Idle** means no task and no slash command running, an empty prompt, and no exit armed by
  `Ctrl+C`. While you type, the turn waits; a prompt you send takes the pending events with it, so
  you go first and nothing is lost.
- **Limit.** At most 5 automatic turns in a row that start background work (a job or a
  subagent); then a notice says continuation is paused, and the pending events wait for your next
  prompt. A turn that starts nothing is not counted: it only takes events of work that already
  exists, which cannot go on forever, so many subagents reporting at different times are all
  heard. The limit counts turns, not model requests: each turn keeps its own step limit and
  `--timeout`. Only a prompt you send renews it.
- **Suspension.** Continuation stops until your next prompt when you interrupt a task (automatic or
  not), when you cancel the subagents with `Esc`, and when a turn ends other than `done` (an
  error, a limit, an interrupt). Cancelling a `/compact` does not suspend it. Jobs keep running,
  and their events are delivered with your next prompt.
- **`/clear`.** Jobs started before it keep running, and `bash_jobs` still shows them, but their
  events are no longer reported: nothing in the new conversation explains them, so they neither
  reach the model nor start a turn. Subagents started before it are cancelled, and their reports
  dropped.
- Only the interactive session continues on its own; a one-shot run ends with its task.

## Interrupting and exiting

- `Esc` or `Ctrl+C` during a task aborts it. The abort reaches the HTTP request and every
  process group started by the tools; completed tool results stay in the conversation. If the
  task does not stop, a second `Ctrl+C` exits anyway. Subagents running in the background, or
  waiting for a slot, are cancelled too.
- `Esc` with no task running and subagents in the background cancels them, and a line says
  "Background subagents cancelled." Their cancellations reach the model with your next prompt;
  they do not start a turn.
- A slash command and a task never run at the same time: a prompt submitted while a command such
  as `/model` is still resolving is refused, so the agent is never changed mid-task.
- If an unexpected error reaches the session, the terminal is restored (raw mode, cursor, key
  reporting) before the error is printed and nullrivet exits with code 1.
- `Ctrl+C` on an empty prompt with no task running arms an exit; a second `Ctrl+C` within two
  seconds exits with code 0, since nothing is interrupted. Typing anything disarms it. Leaving
  while a task is still stopping, or on a signal from outside, exits with 130.
- On exit the live region is erased, the cursor is shown, raw mode, bracketed paste and the
  extended key mode are turned off, and every remaining process group is killed. The scrollback
  is left as it is.
