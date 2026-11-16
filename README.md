# Nullrivet

Ephemeral AI agent for the terminal.

nullrivet carries out programming tasks, and security work in environments you are authorized to
test, by reading and editing files, running commands and inspecting git repositories. The
conversation lives only in memory: nullrivet writes no files of its own, and when the process exits,
nothing of the session remains except the changes the tools made on purpose.

> **Status:** early development. One-shot mode works end to end; the interactive terminal UI is not
> available yet, and OpenRouter is the only provider so far.

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

- [Bun](https://bun.sh) 1.1.30 or newer
- Linux (macOS is untested)
- `bash` and `git` on `PATH`; `rg` (ripgrep) is recommended, since the agent searches through bash
- An [OpenRouter](https://openrouter.ai) API key

## Installation

nullrivet runs from source:

```bash
git clone https://github.com/lex0c/nullrivet.git
cd nullrivet
bun install

# Optional: put the executable on PATH
ln -s "$PWD/src/main.ts" ~/.local/bin/nullrivet
```

The executable starts Bun with automatic `.env` loading disabled, so running nullrivet inside a
project never picks up that project's `.env`. Credentials come from the environment you start it
in.

## Quick start

```bash
export OPENROUTER_API_KEY=sk-or-...
export NULLRIVET_MODEL=openrouter/nvidia/nemotron-3-ultra-550b-a55b:free

# Ask about the current repository without letting the agent change anything
nullrivet --permission readonly "Summarize the last commits and what changed"

# Let it work: read code, edit files, run the tests
nullrivet "The test suite is failing. Find the cause, fix it, and make sure the tests pass."
```

From the repository, `bun run start <options> <prompt>` does the same and also loads the
repository's own `.env`, which is convenient during development.

## Usage

```
nullrivet [options] [prompt...]
```

nullrivet runs one task and exits. The prompt is the concatenation of the positional arguments.
Text piped on stdin is appended to it inside a `<stdin>` block, or becomes the prompt when no
argument is given:

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
| `--context-window <n>` | Override the model's context window, in tokens. |
| `--max-output <n>` | Override the model's output token limit. |
| `-h, --help` | Show help. |
| `-v, --version` | Show the version. |

### Environment

Flags take precedence over environment variables, which take precedence over the defaults.

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | Credentials for `openrouter/*` models. |
| `NULLRIVET_MODEL` | Default model id. |
| `NULLRIVET_EFFORT` | Default reasoning effort. |
| `NULLRIVET_PERMISSION` | Default execution mode. |
| `NULLRIVET_MAX_STEPS` | Default step limit. |
| `NULLRIVET_OPENROUTER_BASE_URL` | OpenRouter endpoint (default `https://openrouter.ai/api/v1`). |

Provider-specific settings are listed in [docs/MODELS.md](docs/MODELS.md).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | The task finished. |
| `1` | The task failed (provider error, unrecoverable stream error). |
| `2` | Invalid usage or configuration (bad flag, unknown model, missing credentials). |
| `3` | A limit was reached: step limit, output limit, or the conversation no longer fits the context window. |
| `130` | Interrupted. |

### Interrupting

The first `Ctrl+C` aborts the task: the running command and every process it started are
terminated, and nullrivet exits with code 130. A second `Ctrl+C` exits immediately.

## Models

A model id is `<family>/<model>`. OpenRouter model names contain slashes themselves, so the family
is everything before the first `/`: `openrouter/deepseek/deepseek-v4-flash`.

There is no catalog file. A model is resolved, in order, from:

1. **the compiled catalog**, which holds curated capabilities for a few models;
2. **discovery**, which asks the provider's public model listing for the context window, output
   limit and tool support, and keeps the answer in memory for the session;
3. **conservative defaults** (32,768-token window, 8,192 output tokens), with a warning.

Models without tool calling are rejected. Free OpenRouter models (`:free`) work well for
experimenting, but they come and go and are heavily rate-limited, and some free endpoints may
record prompts; do not use them with code you cannot share.

Details: [docs/MODELS.md](docs/MODELS.md).

## Execution modes

| Mode | Tools offered to the model | Enforcement |
|---|---|---|
| `auto` (default) | `read_file`, `git`, `edit_file`, `write_file`, `bash` | None beyond operating system permissions. |
| `readonly` | `read_file`, `git` | The other tools are neither offered nor executed, even if the model calls them. |

`auto` is **not a sandbox**. Commands run with your privileges and take effect immediately, and
content the agent reads (files, command output, `AGENTS.md`) can contain prompt injection. Run
nullrivet as an unprivileged user, and in a container or VM for risky work.

`readonly` prevents changes made through nullrivet's tools. It does not prevent reading sensitive
files.

## Tools

| Tool | Effect | Purpose |
|---|---|---|
| `read_file` | read | Read a text file, paged by lines. |
| `git` | read | `status`, `diff`, `log`, `show`, `blame`, with repository-configured programs disabled. |
| `edit_file` | write | Apply exact, all-or-nothing text replacements to a file. |
| `write_file` | write | Create or replace a file atomically. |
| `bash` | exec | Run a shell command non-interactively, with a timeout and output limits. |

Searching, building, testing and git operations that change state go through `bash`. Details,
limits and safety measures: [docs/TOOLS.md](docs/TOOLS.md).

## Project instructions

nullrivet reads existing `AGENTS.md` files as project instructions. The files that apply to a path
are the ones in its directory and its ancestors, up to the root of the git repository. Files that
govern the starting directory go into the system prompt; files found later, when the agent
touches another directory or project, are attached to the tool result where they first apply. A
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
| `tool:start` | `id`, `name`, `args` |
| `tool:end` | `id`, `name`, `content`, `isError`, `meta` |
| `usage` | `input`, `output`, `cacheRead`, `cacheWrite` (tokens of one model request) |
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
bun run start --model <id> "<prompt>"
```

The architecture is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, the agent loop, retries, context limits,
  project instructions, events.
- [docs/TOOLS.md](docs/TOOLS.md): each tool's parameters, limits and safety measures.
- [docs/MODELS.md](docs/MODELS.md): model resolution, the catalog, discovery and provider settings.

## License

[Apache-2.0](LICENSE). nullrivet includes code derived from
[Forja](https://github.com/lex0c/forja); see [NOTICE](NOTICE).
