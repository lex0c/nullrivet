# Tools

nullrivet exposes five tools to the model. Each declares an effect, which decides whether it is
available in `readonly` mode.

| Tool | Effect | `auto` | `readonly` |
|---|---|---|---|
| `read_file` | read | yes | yes |
| `git` | read | yes | yes |
| `edit_file` | write | yes | no |
| `write_file` | write | yes | no |
| `bash` | exec | yes | no |

Common behavior:

- **Paths** are absolute or relative to the starting directory; `~` is expanded. Paths outside
  the starting directory, `..` and symlinks are allowed on purpose. Access is limited only by
  operating system permissions.
- **Arguments** come from the model and are validated by each tool. Invalid arguments come back as
  an `input.invalid` error result.
- **Errors** come back to the model as text of the form `error [<code>]: <message>`, followed by a
  `hint:` line when there is one. They never end the task.
- **Output** has terminal escape sequences and control bytes removed before it enters the
  conversation.

## read_file

Reads a UTF-8 text file.

| Parameter | Description |
|---|---|
| `path` | File to read. |
| `offset` | 0-based index of the first line (default 0). |
| `limit` | Maximum number of lines (default 2000). |

- Lines are returned verbatim, without line-number prefixes.
- Lines longer than 2000 characters are cut and end with `…`.
- At most 256 KiB of text is returned per call.
- When the result does not reach the end of the file, it ends with a `[read_file: …]` note giving
  the lines shown and the `offset` to continue from.
- Refused: directories, binary files (a NUL byte in the first 8000 bytes), files over 10 MiB,
  FIFOs, devices and sockets.

## write_file

Creates or replaces a file with the given content.

| Parameter | Description |
|---|---|
| `path` | File to write. Missing parent directories are created. |
| `content` | Complete new content. |

- The write is atomic: the content goes to a temporary file in the same directory, which is
  synced and renamed over the target. A failure never leaves a half-written file.
- The file mode is preserved. Writing to a symlink writes to its target.
- Refused: directories, special files and content over 10 MiB.

## edit_file

Applies text replacements to an existing file.

| Parameter | Description |
|---|---|
| `path` | File to edit. |
| `edits` | 1 to 50 edits, applied in order. Each one searches the result of the previous ones. |
| `edits[].old_string` | Exact text to replace. |
| `edits[].new_string` | Replacement. An empty string deletes `old_string`. |
| `edits[].replace_all` | Replace every occurrence instead of requiring exactly one. |

- **All or nothing.** If any edit fails, the file is left unchanged and the error names the edit
  that failed.
- **Unique match.** Without `replace_all`, `old_string` must occur exactly once. When it occurs
  several times, the error lists the lines where it matches.
- **Fallbacks.** When there is no exact match, the edit is still applied to the single region that
  matches when indentation and trailing whitespace are ignored (and, as a further step, Unicode
  normalization), with `new_string` re-indented to the file. The result tells the model so it can
  copy the text verbatim next time. When no region matches, the error points to the nearest
  candidate and suggests likely causes, such as over-escaped quotes.
- **Encoding.** A leading UTF-8 byte order mark is preserved. Files that are binary, not valid
  UTF-8 or over 10 MiB are refused rather than rewritten.
- `$` sequences in `new_string` are written literally.

## bash

Runs a command with `bash -c`.

| Parameter | Description |
|---|---|
| `command` | The command to run. |
| `cwd` | Working directory (default: the starting directory). |
| `timeout_ms` | Timeout from 100 ms to 600 s (default 120 s). |

- **Non-interactive.** stdin is closed, so commands that read it see end of file immediately
  instead of waiting forever.
- **Process group.** The command runs in its own process group. On timeout or abort, the whole
  group receives SIGTERM, then SIGKILL after 2 s. When the command finishes, processes it left in
  the background are terminated as well, so nothing outlives the call.
- **Output.** stdout and stderr are captured separately in bounded memory (the first and last
  2 MiB of each). Each stream is then reduced to 16 KiB for the model, keeping the first and last
  80 lines. The result ends with the exit code, or with a note that the command timed out or was
  aborted.
- **Exit status.** A non-zero exit code is reported but is not a tool error: a failing test run is
  information the model needs. A timeout or abort is a tool error.
- **Credentials.** The API keys nullrivet uses (`OPENROUTER_API_KEY` and the keys of the other
  supported providers) and every `NULLRIVET_*` variable are removed from the command's
  environment, so a command produced by prompt injection cannot read them. Everything else in the
  environment is inherited.
- **Command visibility.** The command text reaches bash through an environment variable that is
  removed before the command runs, instead of through argv, which any local user can read in the
  process list.
- No shell history is written.

## git

Inspects a repository without changing it. This is the only way to read git history in
`readonly` mode; git commands that change state go through `bash`.

| Subcommand | Parameters |
|---|---|
| `status` | `cwd` |
| `diff` | `cwd`, `staged` (index against HEAD), `base` and `target` (refs to compare), `paths`, `stat` |
| `log` | `cwd`, `ref`, `paths`, `max_count` (default 20, maximum 200), `oneline` |
| `show` | `cwd`, `ref` (required; `REV:path` shows a file at a revision), `path`, `stat` |
| `blame` | `cwd`, `path` (required), `ref`, `start_line`, `end_line` |

There are no free-form arguments, because git options such as `--output=<file>` write to disk.
Refs that start with `-` are rejected, and paths are passed after `--`.

### Why the tool cannot run programs

A repository's configuration (`.git/config`, `.gitattributes`) is data controlled by whoever
produced the repository, and it can make read-only git commands execute programs. For example,
plain `git diff` in a hostile repository runs its configured fsmonitor hook, external diff tool
and clean filter. The tool disables every such vector:

| Vector | Measure |
|---|---|
| fsmonitor hook | `core.fsmonitor=false` |
| pager | `--no-pager`, `core.pager=cat` |
| external diff, per-driver diff commands | `--no-ext-diff`; driver commands blanked |
| textconv | `--no-textconv`; driver commands blanked |
| clean, smudge and process filters | every configured filter blanked and made optional |
| hooks | `core.hooksPath=/dev/null` |
| signature verification programs | `log.showSignature=false` |
| fetching missing objects, transport commands | `protocol.allow=never`, `GIT_NO_LAZY_FETCH=1` |
| submodules | ignored by `status` and `diff`; submodule diffs shown as commit ids |
| system configuration | `GIT_CONFIG_NOSYSTEM=1` |
| credential prompts | `GIT_TERMINAL_PROMPT=0` |

Filter and diff driver names are found by reading the configuration, which executes nothing, and
each one is overridden with `-c`. A driver name that cannot be overridden safely makes the tool
refuse to run.

`status` would also refresh and rewrite the index; `GIT_OPTIONAL_LOCKS=0` prevents that, so the
tool writes nothing to `.git`.

The test suite runs every subcommand against a repository configured with hooks that create a
marker file. It also checks that plain git does create the marker in that repository, and that
the tool never does.

### Output and limits

Output is reduced to 32 KiB, keeping the first 300 and last 50 lines. Each call times out after
30 s. A failing git command (for example, a directory outside a repository) comes back as a
`git.failed` error with git's message.
