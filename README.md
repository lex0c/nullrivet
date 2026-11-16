# Nullrivet

Ephemeral AI agent for the terminal.

nullrivet carries out programming tasks, and security work in environments you are authorized to
test, by reading and editing files, running commands and inspecting git repositories. The
conversation lives only in memory: nullrivet writes no files of its own, and when the process exits,
nothing of the session remains except the changes the tools made on purpose.

> **Status:** early development. The interactive session and the one-shot mode work end to end,
> long conversations are compacted automatically, and Anthropic, OpenAI, Ollama and OpenRouter
> models are supported.

- **Ephemeral.** No database, history, logs, caches or configuration files. See
  [What nullrivet does not store](#what-nullrivet-does-not-store).
- **Two execution modes.** `auto` runs every tool without confirmation; `readonly` exposes only
  read tools and is enforced by the executor, not just by the prompt.
- **Not confined to a directory.** `--cwd` is only the starting point. Tools can reach any path the
  operating system allows.
- **Project instructions.** Existing `AGENTS.md` files are read and applied to the directories they
  govern.
- **Pipe-friendly.** Plain answers on stdout, diagnostics on stderr, or NDJSON events with `--json`.

## Requirements

- Linux (macOS is untested)
- `bash` and `git` on `PATH`
- To run from source only: [Bun](https://bun.sh) 1.4.4 or newer (the version CI runs on)
- An API key for one of the supported providers (Anthropic, OpenAI, OpenRouter, Ollama Cloud), or
  a local [Ollama](https://ollama.com) server

## Installation

Download the executable for your platform from the
[latest release](https://github.com/lex0c/nullrivet/releases/latest):

| Platform | File |
|---|---|
| Linux x64 | `nullrivet-linux-x64` |
| Linux arm64 | `nullrivet-linux-arm64` |
| macOS, Apple silicon (untested) | `nullrivet-darwin-arm64` |
| macOS, Intel (untested) | `nullrivet-darwin-x64` |

```bash
curl -fsSLO https://github.com/lex0c/nullrivet/releases/latest/download/nullrivet-linux-x64
curl -fsSLO https://github.com/lex0c/nullrivet/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
chmod +x nullrivet-linux-x64
mv nullrivet-linux-x64 ~/.local/bin/nullrivet
```

The executable includes the Bun runtime, so nothing else needs to be installed. It does not load
`.env` or `bunfig.toml` from the directory it runs in, so running nullrivet inside a project never
picks up that project's settings or runs its code. Credentials come from the environment you start
it in.

### From source

```bash
git clone https://github.com/lex0c/nullrivet.git
cd nullrivet
bun install
bun run build                      # dist/nullrivet, for this machine

# Or run the sources directly
ln -s "$PWD/src/main.ts" ~/.local/bin/nullrivet
```

`src/main.ts` starts Bun with `--no-env-file` and `--config=/dev/null` for the same reason.

## Quick start

```bash
export OPENROUTER_API_KEY=sk-or-...   # or ANTHROPIC_API_KEY, OPENAI_API_KEY, OLLAMA_API_KEY
export NULLRIVET_MODEL=openrouter/nvidia/nemotron-3-ultra-550b-a55b:free

# Start an interactive session in the current directory
nullrivet

# Ask about the current repository without letting the agent change anything
nullrivet --permission readonly "Summarize the last commits and what changed"

# Let it work: read code, edit files, run the tests
nullrivet "The test suite is failing. Find the cause, fix it, and make sure the tests pass."
```

From the repository, `bun run start [options] [prompt]` does the same and also loads the
repository's own `.env`, which is convenient during development.

## Usage

```
nullrivet [options] [prompt...]
```

Without a prompt, in a terminal, nullrivet starts an [interactive session](#interactive-session).
With a prompt, it runs one task and exits. The prompt is the concatenation of the positional
arguments. Text piped on stdin is sent after the prompt as material it refers to, in a fenced
block that the agent treats as data, or becomes the prompt when no argument is given:

```bash
git diff | nullrivet "Review this change for bugs"
journalctl -u app --since today | nullrivet "Why does the service restart?"
```

Large stdin input is reduced to its first and last lines. When stdin is not a terminal, nullrivet
reads it until end of file, so programs that start nullrivet without piping anything should pass
`</dev/null`.

### Options

| Option | Description |
|---|---|
| `-m, --model <id>` | Model as `<family>/<model>`, e.g. `openrouter/deepseek/deepseek-v4-flash`. Required unless `NULLRIVET_MODEL` is set. |
| `-e, --effort <level>` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`. Ignored by models without reasoning. |
| `-p, --permission <mode>` | `auto` (default) or `readonly`. |
| `-C, --cwd <dir>` | Starting directory for relative paths, commands and `AGENTS.md` lookup. It does not restrict file access. |
| `--json` | Emit agent events as NDJSON on stdout. |
| `--no-agents` | Do not load `AGENTS.md` files. |
| `--max-steps <n>` | Maximum number of model requests for the task (default 200). |
| `--timeout <time>` | Time limit for the task: `90s`, `30m`, `2h`, or seconds without a unit, at most `596h`. When it passes, the task is stopped like an interrupt and ends at a limit (exit code 3). No limit by default. |
| `--context-window <n>` | Override the model's context window, in tokens. |
| `--max-output <n>` | Override the model's output token limit. |
| `-h, --help` | Show help. |
| `-v, --version` | Show the version. |

### Environment

Flags take precedence over environment variables, which take precedence over the defaults.

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Credentials for `anthropic/*` models. |
| `OPENAI_API_KEY` | Credentials for `openai/*` models. |
| `OPENROUTER_API_KEY` | Credentials for `openrouter/*` models. |
| `OLLAMA_API_KEY` | Credentials for Ollama Cloud models (a local Ollama server needs none). |
| `NULLRIVET_MODEL` | Default model id. |
| `NULLRIVET_EFFORT` | Default reasoning effort. |
| `NULLRIVET_PERMISSION` | Default execution mode. |
| `NULLRIVET_MAX_STEPS` | Default step limit. |
| `NULLRIVET_TIMEOUT` | Default time limit per task. |
| `NULLRIVET_<FAMILY>_BASE_URL` | Endpoint of a provider family, e.g. `NULLRIVET_OPENAI_BASE_URL`. |

Provider-specific settings are listed in [docs/MODELS.md](docs/MODELS.md).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | The task finished. |
| `1` | The task failed (provider error, unrecoverable stream error). |
| `2` | Invalid usage or configuration (bad flag, unknown model, missing credentials). |
| `3` | A limit was reached: step limit, time limit, output limit, or the conversation no longer fits the context window. |
| `130` | Interrupted. |

### Interrupting

In one-shot mode, the first `Ctrl+C` aborts the task: the running command and every process it
started are terminated, and nullrivet exits with code 130. A second `Ctrl+C` exits immediately.
In an interactive session, see [Keys](#keys).

## Interactive session

`nullrivet` with no prompt opens a session in the terminal. The conversation is kept in memory
between prompts until `/clear` or until you exit. Finished output (your prompts, answers, tool
results) goes to the terminal's normal scrollback; only the task in progress, the input box and
the status line are redrawn at the bottom. Answers are rendered as Markdown while they stream.

The status line shows the execution mode, the model, how much of the context window the last
request used, and the tokens used in the session. When the conversation grows past about 70% of
the window, its older part is summarized and the recent part kept verbatim; your requests and the
files touched are always kept. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#context-management).

### Keys

| Key | Action |
|---|---|
| `Enter` | Send the prompt (or run the selected command). |
| `Shift+Enter`, `Alt+Enter`, `\` then `Enter` | Insert a newline. |
| `Esc` or `Ctrl+C` while a task runs | Interrupt the task; running commands are terminated. A second `Ctrl+C` exits if the task does not stop. |
| `Ctrl+C` on a non-empty prompt | Clear the prompt. |
| `Ctrl+C` twice on an empty prompt | Exit (code 130). |
| `Ctrl+D` on an empty prompt | Exit (code 0). |
| `Tab`, `↑`/`↓` | Complete and choose in the command list. |

`Shift+Enter` needs a terminal that reports it separately from `Enter` (xterm, kitty, WezTerm,
iTerm2 and others with the extended keyboard protocol enabled). Where it does not, use
`Alt+Enter` or `\` followed by `Enter`.

While a task runs you can type the next prompt, but it can only be sent once the task ends.

### Commands

| Command | Action |
|---|---|
| `/help` | List the commands and keys. |
| `/model [family/model]` | Show the model, or switch to another one for the next prompts. |
| `/effort [low\|medium\|high\|xhigh\|max\|off]` | Show or set the reasoning effort. |
| `/permission [auto\|readonly]` | Show or change the execution mode; it applies from the next tool call. |
| `/compact [focus]` | Summarize the older part of the conversation now; the focus guides the summary. |
| `/clear` | Discard the conversation and clear the screen. |
| `/instructions [reload]` | List the loaded `AGENTS.md` files, or read them again. |
| `/stats` | Show the token usage of the session. |
| `/exit` | Exit. |

`/model`, `/compact` and `/clear` cannot be used while a task runs. An unknown command is not sent anywhere
and stays in the input; to send text that starts with `/` as a prompt, begin it with a space. How the interface works is described in
[docs/TUI.md](docs/TUI.md).

## Models

A model id is `<family>/<model>`, for example `anthropic/claude-sonnet-5-5`, `openai/gpt-5.4`,
`ollama/qwen3-coder:480b` or `openrouter/deepseek/deepseek-v4-flash`. OpenRouter model names
contain slashes themselves, so the family is everything before the first `/`.

There is no catalog file. A model is resolved, in order, from:

1. **the compiled catalog**, which holds curated capabilities for a few models;
2. **discovery**, which asks the provider about the model (context window, output limit, tool and
   reasoning support) and keeps the answer in memory for the session; Anthropic, OpenRouter and
   Ollama support it;
3. **conservative defaults** (32,768-token window, 8,192 output tokens), with a warning.

Models without tool calling are rejected. Free OpenRouter models (`:free`) are used like any
other model. OpenRouter can withdraw a free route at any time and applies stricter rate limits to
free routes, and some free endpoints may record prompts; each model's page on OpenRouter states
its data policy.

Details: [docs/MODELS.md](docs/MODELS.md).

## Execution modes

| Mode | Tools offered to the model | Enforcement |
|---|---|---|
| `auto` (default) | `read_file`, `glob`, `grep`, `git`, `edit_file`, `write_file`, `bash`, `delegate` | None beyond operating system permissions. |
| `readonly` | `read_file`, `glob`, `grep`, `git`, `delegate` | The other tools are neither offered nor executed, even if the model calls them. Subagents run in `readonly` too. |

`auto` is **not a sandbox**. Commands run with your privileges and take effect immediately, and
content the agent reads (files, command output, `AGENTS.md`) can contain prompt injection. Run
nullrivet as an unprivileged user, and in a container or VM for risky work. How instructions and
untrusted data are kept apart: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#trust-boundaries).

`readonly` prevents changes made through nullrivet's tools. It does not prevent reading sensitive
files.

## Tools

| Tool | Effect | Purpose |
|---|---|---|
| `read_file` | read | Read a text file, paged by lines. |
| `glob` | read | Find files by path pattern, leaving out files ignored by git. |
| `grep` | read | Search file contents with a regular expression. |
| `git` | read | `status`, `diff`, `log`, `show`, `blame`, with repository-configured programs disabled. |
| `edit_file` | write | Apply exact, all-or-nothing text replacements to a file. |
| `write_file` | write | Create or replace a file atomically. |
| `bash` | exec | Run a shell command non-interactively, with a timeout and output limits. |
| `delegate` | read | Hand a self-contained task to a subagent and receive only its report. |

Building, testing and git operations that change state go through `bash`. Details,
limits and safety measures: [docs/TOOLS.md](docs/TOOLS.md).

### Subagents

With `delegate`, the agent hands a self-contained task (an investigation that would read many
files, for example) to a subagent. The subagent starts with an empty conversation, works with the
same model and tools, and returns only its report, so the main conversation grows by the report
and not by the work behind it. Several delegations in one response run at the same time, up to
three `readonly` ones at once. A subagent's mode never exceeds the session's: in `readonly`, or
after switching to it with `/permission`, subagents cannot change anything. Interrupting the task
stops its subagents and their commands. How it works:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#subagents).

## Project instructions

nullrivet reads existing `AGENTS.md` files as project instructions. The files that apply to a path
are the ones in its directory and its ancestors, up to the root of the git repository. Files that
govern the starting directory are sent at the start of the conversation; files found later, when the agent
touches another directory or project, are attached to the tool result where they first apply. A
file edit or write in a directory governed by files not seen yet is held back until the agent has
read them. A
deeper file takes precedence over its ancestors, and instructions of one project never apply to
files of another.

`AGENTS.md` content is treated as repository data: it cannot change the execution mode or override
your requests. nullrivet never creates or edits `AGENTS.md` on its own. `--no-agents` disables
loading. Rules and limits: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#project-instructions).

## Output

Without `--json`, the answer is streamed to stdout and everything else (tool activity, warnings,
errors) goes to stderr, so `nullrivet "..." > answer.md` captures only the answer.

With `--json`, stdout carries only NDJSON, one event per line, each with a `v` schema version:

```bash
nullrivet --json --permission readonly "List the TODOs in src" | jq -c 'select(.type == "tool:start")'
```

| Event | Fields |
|---|---|
| `agent:start` | — |
| `text:delta` | `text` |
| `thinking:delta` | `text` |
| `tool:start` | `id`, `name`, `args`, `step` (the model request of the turn that made the call) |
| `tool:end` | `id`, `name`, `content`, `isError`, `meta` |
| `usage` | `input`, `output`, `cacheRead`, `cacheWrite` (tokens of one model request); `compaction: true` for a summary request; `subagent` (the delegate call id) for a subagent's request |
| `context:compact:start` | `reason` (`auto`, `manual`, `overflow`) |
| `context:compact` | `reason`, `strategy` (`llm`, `fallback`), `before`, `after` (estimated tokens) |
| `subagent:start` | `id` (the delegate call id), `title`, `mode` |
| `subagent:progress` | `id`, `step`, `tool` (`name`, `args`) |
| `subagent:end` | `id`, `status` (`completed`, `failed`, `cancelled`, `budget`), `steps` |
| `warning` | `message` |
| `error` | `message` |
| `agent:end` | `reason` (`done`, `aborted`, `error`, `budget`), `message` |

Configuration errors found before the task starts, such as an unknown model or missing
credentials, are reported as an `error` event as well. Invalid options are reported on stderr.

## What nullrivet does not store

nullrivet creates no `.nullrivet` directory, database, history, log, cache or configuration file,
and it does not record prompts, messages, tool calls or token usage anywhere. Restarting it never
restores a previous session.

This covers nullrivet itself. Commands the agent runs, the shell, the operating system and the
model provider may keep their own records, and the changes the tools make are, of course, kept.

## Development

```bash
bun install
bun test             # tests
bun run typecheck    # tsc --noEmit
bun run lint         # Biome
bun run check        # all of the above
bun run build        # standalone executable in dist/
bun run start --model <id> "<prompt>"
```

The end-to-end tests in `tests/e2e` run the CLI as a separate process against a local stand-in for
the Ollama API: output delivery, interrupts and the time limit (no command left running),
`readonly` refusals, compaction, piped input, a hostile `.env`/`bunfig.toml`, and the interactive
session in a terminal. `NULLRIVET_EXECUTABLE=dist/nullrivet bun test tests/e2e` runs them against
a compiled executable, as CI does.

The architecture is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, the agent loop, retries, context limits,
  project instructions, events.
- [docs/TOOLS.md](docs/TOOLS.md): each tool's parameters, limits and safety measures.
- [docs/MODELS.md](docs/MODELS.md): model resolution, the catalog, discovery and provider settings.
- [docs/TUI.md](docs/TUI.md): the interactive interface: rendering, streaming Markdown, keys.

## License

[Apache-2.0](LICENSE). nullrivet includes code derived from
[Forja](https://github.com/lex0c/forja); see [NOTICE](NOTICE).
