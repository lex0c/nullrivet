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
  auto · esc to interrupt     model · ctx 3%   │
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
- **View** (`src/tui/view.ts`): composes the live region from the state: the pending answer, one
  card per running tool, a phase indicator, the input box, the command list and the status
  lines. `src/tui/permanent.ts` formats the scrollback items.
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
- The editor (`src/tui/input-editor.ts`) is a pure function from the input state and a key to the
  next input state, plus signals for submit, interrupt and end of file.

## Interrupting and exiting

- `Esc` or `Ctrl+C` during a task aborts it. The abort reaches the HTTP request and every
  process group started by the tools; completed tool results stay in the conversation. If the
  task does not stop, a second `Ctrl+C` exits anyway.
- A slash command and a task never run at the same time: a prompt submitted while a command such
  as `/model` is still resolving is refused, so the agent is never changed mid-task.
- If an unexpected error reaches the session, the terminal is restored (raw mode, cursor, key
  reporting) before the error is printed and nullrivet exits with code 1.
- `Ctrl+C` on an empty prompt with no task running arms an exit; a second `Ctrl+C` within two
  seconds exits. Typing anything disarms it.
- On exit the live region is erased, the cursor is shown, raw mode, bracketed paste and the
  extended key mode are turned off, and every remaining process group is killed. The scrollback
  is left as it is.
