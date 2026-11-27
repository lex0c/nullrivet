# Nullrivet

Ephemeral AI agent for the terminal. It carries out programming tasks, and security work in
environments you are authorized to test, by reading and editing files, running commands and
inspecting git repositories.

- **Ephemeral.** The conversation lives in memory. nullrivet writes no database, history, logs,
  caches or configuration; a conversation is saved only to a file you name with
  [`--session`](#sessions). The one exception is the complete output of tool results reduced for
  the model, kept in private temporary files while nullrivet runs and removed when it exits
  ([saved output](docs/TOOLS.md#saved-output)). Commands the agent runs and the model provider may
  keep their own records.
- **Two execution modes.** `auto` runs every tool without confirmation; `readonly` exposes only
  read tools and is enforced by the tool broker, not just by the prompt.
- **Not confined to a directory.** `--cwd` is only the starting point. Tools can reach any path the
  operating system allows, unless they run in the [sandbox](#sandbox).
- **Project instructions.** Existing `AGENTS.md` files are read and applied to the directories they
  govern.
- **Pipe-friendly.** Plain answers on stdout, diagnostics on stderr, or NDJSON events with `--json`.

## Requirements

- Linux or macOS
- `bash` and `git` on `PATH`
- An API key for a [supported provider](#models), or a local [Ollama](https://ollama.com) server
- [Bun](https://bun.sh) 1.4.4 or newer, to run from source

## Installation

Download the executable for your platform from the
[latest release](https://github.com/lex0c/nullrivet/releases/latest):

| Platform | File |
|---|---|
| Linux x64 | `nullrivet-linux-x64` |
| Linux arm64 | `nullrivet-linux-arm64` |
| macOS, Apple silicon | `nullrivet-darwin-arm64` |
| macOS, Intel | `nullrivet-darwin-x64` |

```bash
curl -fsSLO https://github.com/lex0c/nullrivet/releases/latest/download/nullrivet-linux-x64
curl -fsSLO https://github.com/lex0c/nullrivet/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
chmod +x nullrivet-linux-x64
mv nullrivet-linux-x64 ~/.local/bin/nullrivet
```

From source:

```bash
git clone https://github.com/lex0c/nullrivet.git
cd nullrivet
bun install
bun run build                      # dist/nullrivet, for this machine
ln -s "$PWD/src/main.ts" ~/.local/bin/nullrivet   # or run the sources directly
```

The executable includes the Bun runtime. Neither it nor the sources load `.env` or `bunfig.toml`
from the directory nullrivet runs in, so a project cannot configure it or run code in it.
Credentials come from the environment.

## Quick start

```bash
export OPENROUTER_API_KEY=sk-or-...   # or ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, OLLAMA_API_KEY
export NULLRIVET_MODEL=openrouter/nvidia/nemotron-3-ultra-550b-a55b:free

# Start an interactive session in the current directory
nullrivet

# Ask about the current repository without letting the agent change anything
nullrivet --permission readonly "Summarize the last commits and what changed"

# Let it work: read code, edit files, run the tests
nullrivet "The test suite is failing. Find the cause, fix it, and make sure the tests pass."
```

## Usage

```
nullrivet [options] [prompt...]
```

Without a prompt, in a terminal, nullrivet starts an [interactive session](#interactive-session).
With a prompt, it runs one task and exits. Piped stdin is attached to the prompt as data, or
becomes the prompt when no argument is given:

```bash
git diff | nullrivet "Review this change for bugs"
journalctl -u app --since today | nullrivet "Why does the service restart?"
```

Large input is reduced to its first and last lines. When stdin is not a terminal, nullrivet reads
it until end of file, so programs that start nullrivet without piping anything should pass
`</dev/null`.

### Options

| Option | Description |
|---|---|
| `-m, --model <id>` | Model as `<family>/<model>`, e.g. `openrouter/deepseek/deepseek-v4-flash`. Required unless `NULLRIVET_MODEL` is set. |
| `-e, --effort <level>` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`. Ignored by models without reasoning. |
| `-p, --permission <mode>` | `auto` (default) or `readonly`. |
| `--sandbox <profile>` | Run the tools in a sandbox. Linux with Bubblewrap installed in a system directory; the profile is `inspect` (Bubblewrap 0.8 or later) or `workspace` (0.10 or later). See [Sandbox](#sandbox). |
| `--apply` | With `--sandbox workspace` and a task: apply the task's changes to the project if the task finishes. Without it, they are shown and discarded. The interactive session uses `/apply` instead. |
| `-C, --cwd <dir>` | Starting directory for relative paths, commands and `AGENTS.md` lookup. It does not restrict file access. |
| `--json` | Emit agent events as NDJSON on stdout. |
| `--no-agents` | Do not load `AGENTS.md` files. |
| `--max-steps <n>` | Maximum number of model requests for the task, and for each subagent (default 200). |
| `--timeout <time>` | Time limit for the task, and for each subagent from when it starts running: `90s`, `30m`, `2h`, or seconds without a unit, at most `596h`. Exit code 3 when reached. By default, no limit for the task and 30 minutes for each subagent. |
| `--session <file>` | Save the conversation to this file and continue it if the file already holds one. See [Sessions](#sessions). |
| `--context-window <n>` | Override the model's context window, in tokens. |
| `--max-output <n>` | Override the model's output token limit. |
| `--list-models` | List the models of the built-in catalog and exit. See [Models](#models). |
| `-h, --help` | Show help. |
| `-v, --version` | Show the version. |

### Environment

Flags take precedence over environment variables, which take precedence over the defaults.

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Credentials for `anthropic/*` models. |
| `OPENAI_API_KEY` | Credentials for `openai/*` models. |
| `GEMINI_API_KEY` | Credentials for `google/*` models. |
| `XAI_API_KEY` | Credentials for `xai/*` models. |
| `OPENROUTER_API_KEY` | Credentials for `openrouter/*` models. |
| `OLLAMA_API_KEY` | Credentials for Ollama Cloud models (a local Ollama server needs none). |
| `NULLRIVET_MODEL` | Default model id. |
| `NULLRIVET_EFFORT` | Default reasoning effort. |
| `NULLRIVET_PERMISSION` | Default execution mode. |
| `NULLRIVET_SANDBOX` | Default sandbox profile. |
| `NULLRIVET_MAX_STEPS` | Default step limit, per task and per subagent. |
| `NULLRIVET_TIMEOUT` | Default time limit per task and per subagent (without it, 30 minutes per subagent). |
| `NULLRIVET_<FAMILY>_BASE_URL` | Endpoint of a provider family, e.g. `NULLRIVET_OPENAI_BASE_URL`. |

Provider-specific settings are listed in [docs/MODELS.md](docs/MODELS.md).

### Proxy

Requests to the model providers go through the HTTP proxy named by the standard variables, which
the Bun runtime reads when nullrivet starts:

| Variable | Description |
|---|---|
| `HTTPS_PROXY` | Proxy for `https://` endpoints, e.g. `http://user:password@proxy.example:8080`. |
| `HTTP_PROXY` | Proxy for `http://` endpoints, such as a local Ollama server. |
| `NO_PROXY` | Comma-separated hosts reached directly, e.g. `localhost,127.0.0.1`. |

- Every provider and the model discovery use them, streaming included. Credentials in the proxy
  URL are sent to the proxy and do not appear in error messages.
- Local addresses are not excluded on their own: with `HTTP_PROXY` set, requests to a local Ollama
  server go to the proxy unless `NO_PROXY` lists its host.
- Commands the agent runs inherit these variables with the rest of the environment, so tools such
  as `git`, `curl` and `npm` use the same proxy.
- A proxy that inspects TLS signs certificates with its own CA. Add that CA with
  `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`; `NODE_TLS_REJECT_UNAUTHORIZED=0` would turn off certificate
  validation for every connection, the provider APIs included.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | The task finished. |
| `1` | The task failed (provider error, unrecoverable stream error). |
| `2` | Invalid usage or configuration (bad flag, unknown model, missing credentials). |
| `3` | A limit was reached: step limit, time limit, output limit, or the conversation no longer fits the context window. |
| `4` | With `--sandbox workspace --apply`: the task finished, and some or all of its changes were not applied (a conflict with a change made on the host during the task, a refusal, or changes that could not be read); the project holds those reported as applied. |
| `5` | With `--sandbox workspace --apply`: applying the changes stopped part-way, on a failure or on a change made on the host during the application itself; the project holds those reported as applied. |
| `130` | Interrupted. |

In one-shot mode, `Ctrl+C` aborts the task, terminates every process it started and exits with
code 130; a second `Ctrl+C` exits immediately.

## Interactive session

`nullrivet` without a prompt keeps one conversation between prompts until `/clear` or exit; to
keep it longer, see [Sessions](#sessions). Finished output stays in the terminal's scrollback, and
the status line shows the execution mode, the model, the share of the context window in use and
the tokens spent. The older part of a long conversation is summarized automatically
([context management](docs/ARCHITECTURE.md#context-management)). The interface is described in
[docs/TUI.md](docs/TUI.md).

### Keys

| Key | Action |
|---|---|
| `Enter` | Send the prompt (or run the selected command). |
| `Shift+Enter`, `Alt+Enter`, `\` then `Enter` | Insert a newline (`Shift+Enter` only in terminals that report it). |
| `Shift+Tab` | Switch between `auto` and `readonly`, also while a task runs; it applies from the next tool call and does not stop one already running. |
| `Esc` or `Ctrl+C` while a task runs | Interrupt the task; running commands are terminated. A second `Ctrl+C` exits if the task does not stop. |
| `Ctrl+C` on a non-empty prompt | Clear the prompt. |
| `Ctrl+C` twice on an empty prompt | Exit (code 0). With `--sandbox workspace`, the changes not applied are discarded; the first press says how many. |
| `Ctrl+D` on an empty prompt | Exit (code 0), as `/exit` does. |
| `↑`/`↓` | Recall earlier prompts and commands: `↑` from the first line of the input, then `↑`/`↓` walk the history; `↓` past the newest brings back what you were typing. |
| `Tab`, `↑`/`↓` with the command list open | Complete and choose a command. |

### Commands

| Command | Action |
|---|---|
| `/help` | List the commands and keys. |
| `/model [family/model]` | Show the model, or switch to another one for the next prompts. |
| `/effort [low\|medium\|high\|xhigh\|max\|off]` | Show or set the reasoning effort. |
| `/permission [auto\|readonly]` | Show or change the execution mode, like `Shift+Tab`; it applies from the next tool call. |
| `/compact [focus]` | Summarize the older part of the conversation now; the focus guides the summary. |
| `/clear` | Discard the conversation and clear the screen. A session file stops being saved and keeps the cleared conversation. |
| `/instructions [reload]` | List the loaded `AGENTS.md` files, or read them again. |
| `/stats` | Show the token usage since nullrivet started. |
| `/session [file\|off]` | Show the session file, start saving to a new file, or stop saving. See [Sessions](#sessions). |
| `/exit` | Exit. With `--sandbox workspace` and changes not applied, it asks first whether to apply or discard them. |
| `/changes [path]` | With `--sandbox workspace`: show what the sandbox changed, or the changes at a path. |
| `/apply` | With `--sandbox workspace`: show the changes and apply them once you type the code the question shows. |
| `/discard` | With `--sandbox workspace`: discard the changes, after the same kind of confirmation. |

`/model`, `/compact`, `/clear` and `/session` cannot be used while a task runs. An unknown command
is not sent; to send a prompt that starts with `/`, begin it with a space.

## Models

A model id is `<family>/<model>`: `anthropic/claude-sonnet-5-5`, `openai/gpt-5.4`,
`google/gemini-3.5-flash`, `xai/grok-4.5`, `ollama/glm-5.3`,
`openrouter/deepseek/deepseek-v4-flash`. The family is everything before the first `/`.

Capabilities come from a compiled catalog, from the provider (Anthropic, OpenRouter, Ollama) or,
with a warning, from conservative defaults. Models without tool calling are rejected. OpenRouter
`:free` models are used like any other; their routes can be withdrawn, are rate-limited more
strictly, and some record prompts. `nullrivet --list-models` prints the catalog; a model missing
from it can still be used. Details: [docs/MODELS.md](docs/MODELS.md).

## Execution modes

| Mode | Tools offered to the model | Enforcement |
|---|---|---|
| `auto` (default) | `read_file`, `glob`, `grep`, `git`, `edit_file`, `write_file`, `bash`, `bash_background`, `bash_jobs`, `bash_kill`, `delegate` | None beyond operating system permissions. |
| `readonly` | `read_file`, `glob`, `grep`, `git`, `delegate` | The other tools are neither offered nor executed, even if the model calls them. |

`delegate` is offered only in the interactive session. Subagents always run in `readonly`, in both
modes: only the main agent changes files or runs commands.

`auto` is **not a sandbox**: commands run with your privileges, and anything the agent reads (files,
command output, `AGENTS.md`) can carry prompt injection. Run nullrivet as an unprivileged user, and
in a container or VM for risky work ([trust boundaries](docs/ARCHITECTURE.md#trust-boundaries)), or
use the [sandbox](#sandbox). `readonly` prevents changes made through nullrivet's tools, not the
reading of sensitive files.

### Sandbox

`--sandbox inspect` runs the tools that touch files, commands and the network in a worker process
inside [Bubblewrap](https://github.com/containers/bubblewrap), on Linux, for work on code you do
not trust, such as reviewing an unknown repository:

- The project (the repository around the working directory, or the directory itself) and the
  system directories are read-only. The home directory and `/tmp` are temporary and empty of your
  files; nothing written there reaches your machine.
- No network, no host processes, no host environment: provider keys and other variables stay
  outside, and the tools see a minimal environment.
- Sockets other than IP (Unix, vsock and the rest) and the kernel keyrings are out of reach, and
  processes left behind end with the session.

The execution mode still applies inside: `readonly` with `inspect` only reads. Background jobs run
inside the sandbox too, with their logs in its `/tmp`. Its resources are limited, so that a command
that exhausts them leaves your machine usable: with systemd's user manager, the sandbox runs in a
cgroup of its own, with at most 4096 processes and threads, three quarters of the memory and no
swap, and a lower CPU priority; without it, only the number of processes is limited, and a warning
says so. A sandbox that cannot start stops the session with the reason; nullrivet never falls back
to running the tools without it.

`--sandbox workspace` is the same sandbox with the project writable through an overlay: the agent
edits, builds and tests as usual, and nothing reaches the project while it works. With a task on the
command line, when the task ends, the changes are listed on stderr (files added, modified and
removed, lines changed, modes, links), with files that run without being invoked, such as `.envrc`
or CI workflows, marked. Without `--apply` they are then discarded; with it, they are applied if the
task finished, each file whole or not at all, and a file you changed during the task is left as you
made it and reported (exit code 4). `.git` is never changed. `Ctrl+C` after the task finished and
before the changes are applied discards them; once applying has started, it runs to its end. The
overlay lives in your runtime directory (`$XDG_RUNTIME_DIR`), which the profile requires on a tmpfs.

In an interactive session, `/changes` shows the changes so far, `/apply` applies them after you
type the code its question shows, and `/discard` throws them away; either one starts a new sandbox
on the project as it is then, and stops the background jobs. Exiting asks what to do with changes
not applied.

```sh
nullrivet --sandbox workspace "fix the failing test"            # shows the changes, discards them
nullrivet --sandbox workspace --apply "fix the failing test"    # applies them if the task finishes
nullrivet --sandbox workspace                                   # interactive: /changes, /apply, /discard
```

Details and the profiles planned next: [docs/SANDBOX.md](docs/SANDBOX.md).

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
| `bash_background` | exec | Start a command that keeps running in the background (a dev server, a watcher), with its output in a log file. |
| `bash_jobs` | exec | List background jobs, show one, or wait for it to end or become ready. |
| `bash_kill` | exec | Stop a background job and its process group. |
| `delegate` | read | Start a read-only subagent in the background on a self-contained investigation; only its report enters the conversation. |

Building, testing and git operations that change state go through `bash`. Background jobs run
until they end, are stopped, or nullrivet exits, and the model is told when one ends or becomes
ready. A subagent starts with an empty conversation, the same model and the read tools only. It
runs in the background, up to four at once, while the main agent keeps working, and its report
reaches the model as data when it ends. Details: [docs/TOOLS.md](docs/TOOLS.md), [subagents](docs/ARCHITECTURE.md#subagents).

## Project instructions

The `AGENTS.md` files in a path's directory and its ancestors, up to the git repository root,
apply to it; a deeper file takes precedence, and one project's files never apply to another. Each
file reaches the model when it first applies, and always before an `edit_file` or `write_file` it
governs. Its content is
repository data: it cannot change the execution mode or override your requests. nullrivet never
edits `AGENTS.md` on its own; `--no-agents` disables loading. Details:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#project-instructions).

## Output

Without `--json`, the answer is streamed to stdout and everything else (tool activity, warnings,
errors) goes to stderr, so `nullrivet "..." > answer.md` captures only the answer. Both have
terminal escape sequences, carriage returns and Unicode bidirectional controls removed.

With `--json`, stdout carries only NDJSON, one event per line, each with a `v` schema version:

```bash
nullrivet --json --permission readonly "List the TODOs in src" | jq -c 'select(.type == "tool:start")'
```

| Event | Fields |
|---|---|
| `agent:start` | — |
| `text:delta` | `text`; separate text blocks of one response are joined by a blank line |
| `thinking:delta` | `text` |
| `tool:start` | `id`, `name`, `args`, `step` (the model request of the turn that made the call) |
| `tool:end` | `id`, `name`, `content`, `isError`, `meta`; for `edit_file` and `write_file`, `meta.diff` holds the counts of lines `added` and `removed`, without the lines themselves (see [docs/TOOLS.md](docs/TOOLS.md#edit_file)) |
| `usage` | `input`, `output`, `cacheRead`, `cacheWrite` (tokens of one model request); `compaction: true` for a summary request |
| `context:compact:start` | `reason` (`auto`, `manual`, `overflow`) |
| `context:compact` | `reason`, `strategy` (`llm`, `fallback`), `before`, `after` (estimated tokens) |
| `notice` | `text`: a runtime note added for the model, such as a background job that ended |
| `warning` | `message` |
| `error` | `message` |
| `agent:end` | `reason` (`done`, `aborted`, `error`, `budget`), `message` |

Configuration errors found before the task starts, such as an unknown model or missing
credentials, are reported as an `error` event as well. Invalid options are reported on stderr.

## Sessions

Nothing outlives the process unless you name a session file:

```bash
nullrivet --session work.json                # interactive; continues work.json if it exists
nullrivet --session ci.json "Run the tests and list the failures"
nullrivet --session ci.json "Fix the first failure"   # same conversation, next step
```

- The file is written atomically after each step, compaction and task, and when you leave the
  interactive session; a crash loses at most the step in progress.
- Continuing uses the session's last model and effort unless the invocation sets them. The
  execution mode and the sandbox always come from the invocation: pass `--permission readonly` or
  `--sandbox inspect` again to keep them. Continuing without them prints a warning.
- `/session <file>` saves to a new file from then on, and the previous file keeps the conversation
  so far; `/session off` stops saving; `/session` shows the state. `/clear` stops saving too.
- The file also keeps the prompt history, one-shot prompts included, so `↑` recalls them when the
  session continues.
- A file changed by something else while nullrivet runs is no longer written, with a warning.

The file holds your prompts and the tools' output, which can include secrets, and is created
readable by you only (mode 0600); keep it out of repositories. Its history carries the authority
of your own messages, so continue only sessions you created; invalid files are refused and left
untouched. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#sessions).

## Development

```bash
bun install
bun test             # unit and end-to-end tests
bun run typecheck    # tsc --noEmit
bun run lint         # Biome
bun run check        # all of the above
bun run build        # standalone executable in dist/
bun run start --model <id> "<prompt>"   # the sources, with the repository's .env
```

The end-to-end tests run the CLI against a local stand-in for the Ollama API;
`NULLRIVET_EXECUTABLE=dist/nullrivet bun test tests/e2e` runs them against the compiled executable,
as CI does. Evaluations against real models: [docs/EVALS.md](docs/EVALS.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, the agent loop, retries, context limits,
  project instructions, trust boundaries, subagents, sessions, events.
- [docs/TOOLS.md](docs/TOOLS.md): each tool's parameters, limits and safety measures.
- [docs/MODELS.md](docs/MODELS.md): model resolution, the catalog, discovery and provider settings.
- [docs/TUI.md](docs/TUI.md): the interactive interface: rendering, streaming Markdown, keys.
- [docs/EVALS.md](docs/EVALS.md): evaluations against real models.
- [docs/SANDBOX.md](docs/SANDBOX.md): the `inspect` and `workspace` sandboxes, the ChangeSet,
  and the design of the profiles and the network scope planned for authorized security work.

## License

[Apache-2.0](LICENSE). nullrivet includes code derived from
[Forja](https://github.com/lex0c/forja); see [NOTICE](NOTICE).
