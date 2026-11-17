# Tools

nullrivet exposes eight tools to the model. Each declares an effect, which decides whether it is
available in `readonly` mode.

| Tool | Effect | `auto` | `readonly` |
|---|---|---|---|
| `read_file` | read | yes | yes |
| `glob` | read | yes | yes |
| `grep` | read | yes | yes |
| `git` | read | yes | yes |
| `delegate` | read | yes | yes |
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
  conversation. When `bash`, `git` or `delegate` reduce a result, the complete output is saved to
  files named in the result (see [Saved output](#saved-output)).

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

## glob

Finds files by path pattern.

| Parameter | Description |
|---|---|
| `pattern` | Glob pattern: `*`, `**`, `?`, `[abc]`, `{a,b}`. |
| `path` | Directory to search (default: the starting directory). |

- A pattern without `/` matches file names at any depth (`*.ts`, `README*`), as in `.gitignore`. A
  pattern with `/` matches the path relative to `path` (`src/**/*.test.ts`). A leading `./` is
  ignored. Patterns that are absolute or contain `..` are refused; set `path` to search another
  directory.
- Results are sorted, one per line, relative to the starting directory when inside it and
  absolute otherwise, so they can be passed to `read_file` as is. At most 500 are returned, with
  a note giving the total.

## grep

Searches file contents line by line with a regular expression.

| Parameter | Description |
|---|---|
| `pattern` | Regular expression in JavaScript syntax. |
| `path` | File or directory to search (default: the starting directory). |
| `glob` | Only search files matching this pattern, with the rules of `glob`. |
| `ignore_case` | Match case-insensitively. |
| `literal` | Treat the pattern as plain text. |

- Matches come back as `path:line: text`, with 1-based line numbers. Lines are cut at 500
  characters.
- At most 200 matches or 64 KiB are returned; a note says when the search stopped early.
- Binary files and files over 10 MiB are skipped.
- The search runs inside nullrivet and needs no external program. Matching runs in a worker
  thread, because the pattern comes from the model and a regular expression with catastrophic
  backtracking never yields: an interrupt or the time limit terminates the worker, and a search
  that takes longer than 60 seconds is stopped with a `grep.timeout` error.

### Which files are searched

`glob` and `grep` list a directory the same way:

- **Inside a git repository**, the list comes from `git ls-files`, so files ignored by git are
  left out and untracked files are included. Submodules and repositories nested in the tree are
  listed in turn. git runs with the same hardening as the `git` tool, because listing untracked
  files otherwise runs the repository's fsmonitor program. A directory that holds only ignored
  files (such as a `config/` with a local key file) gives an empty list: its files are not listed.
- **In a directory git ignores** (`node_modules/lib`, `dist`), checked with `git check-ignore`,
  the directory is walked, since it was asked for by name.
- **Outside a repository**, the directory is walked too. There are no ignore rules there, so
  `node_modules` and hidden entries (`.git`, `.env`, `.ssh`, `.aws`) are skipped, as ripgrep
  does; a hidden directory is still searched when it is the `path` given. Symbolic links are
  listed but not followed.
- At most 200,000 files are listed; past that, the result says only part of the tree was searched.

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
  80 lines. A reduced stream is also saved whole, beyond the memory bound, to its own files (see
  [Saved output](#saved-output)). The result ends with the exit code, or with a note that the
  command timed out or was aborted, followed by a line naming the files of each saved stream.
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

Tests run every subcommand against a repository whose hooks create a marker file, and check that
plain git creates it and the tool does not.

### Output and limits

Output is reduced to 32 KiB, keeping the first 300 and last 50 lines; reduced output is saved
whole (see [Saved output](#saved-output)). Each call times out after
30 s. A failing git command (for example, a directory outside a repository) comes back as a
`git.failed` error with git's message. git cuts each message at 4 KiB, so a longer error output
comes from warnings before the error; it is reduced to 16 KiB, keeping the first and last 80 lines,
and saved whole.

## delegate

Hands a self-contained task to a subagent and returns its report.

| Parameter | Description |
|---|---|
| `title` | Short label shown to the user (cut at 80 characters). |
| `objective` | The task, complete on its own: the subagent cannot see the conversation. |
| `context` | Reference material: paths, findings, excerpts. It reaches the subagent as data, fenced like piped stdin, because it may hold text copied from files; requirements belong in `objective`. |
| `mode` | `readonly` (default) or `auto`. |
| `cwd` | Starting directory of the subagent (default: the starting directory). |

- **Mode.** The subagent runs in the more restrictive of the requested mode and the session's
  current mode, read again before each of its requests and tool calls. That is why the tool's
  effect is `read` and it is offered in `readonly`: there, the subagent cannot change anything
  either. Its ceiling is fixed when it starts: a subagent that started read-only stays read-only
  when the session switches to `auto`, so the limit of one `auto` subagent at a time holds.
- **Concurrency.** Adjacent `delegate` calls in one response run at the same time: up to three
  `readonly` subagents at once, and `auto` subagents one after another. Results keep the order of
  the calls.
- **Limits.** 40 steps per subagent. Before the last one, a runtime note asks the subagent to
  write its report without calling more tools, so a subagent that runs out of steps still reports
  what it found. The report is reduced to 16 KiB (about 4,096 tokens), keeping its start and end;
  a reduced report is saved whole (see [Saved output](#saved-output)).
  There is no time limit of its own: the session's `--timeout`, the stall watchdog and interrupts
  apply.
- **Result.** A status line written by the runtime (`completed`, `failed`, `cancelled` or
  `budget`, steps, tool errors, tokens, and files changed through `edit_file` and `write_file`),
  followed by the subagent's final reply. When the subagent stopped early, the status line says
  why. A failed or cancelled subagent is an error result.
- **Depth.** A subagent cannot delegate.

## Saved output

When `bash`, `git` or `delegate` reduce a result, the complete output is also written to files,
and a line at the end of the result names them. It comes last because compaction keeps the start
and the end of older results, so the line survives it. The model reads the omitted part with
`read_file` or searches it with `grep` instead of running the command again. Both are `read`
tools, so this works in `readonly` mode too.

```
[complete stdout (2.3MB) saved to `/tmp/nullrivet-Ab12Cd/3-bash-stdout.001.txt`; read it with read_file or search it with grep]
[complete output (23.4MB) saved in 3 parts, `/tmp/nullrivet-Ab12Cd/4-git.001.txt` to `/tmp/nullrivet-Ab12Cd/4-git.003.txt`; read each part with read_file, or search all of them with grep (path `/tmp/nullrivet-Ab12Cd`, glob `4-git.*.txt`)]
```

Paths are quoted with backticks, so punctuation after them is not read as part of the path. The
line names what was saved: `stdout` or `stderr` for `bash`, `output` for `git` and `stderr` for
the message of a failed `git` command, `report` for `delegate`.

- **Location.** A directory created with `mkdtemp` in the system temporary directory (`TMPDIR`,
  usually `/tmp`, resolved to an absolute path) on the first saved output, readable only by the
  user (`0700`, files `0600`), created again if something removes it during the run, and removed
  when nullrivet exits, including on SIGINT, SIGTERM and SIGHUP. File names hold a counter and a
  fixed label (`bash-stdout`, `bash-stderr`, `git`, `git-stderr`, `delegate`), never text from
  the model or a command.
- **Only reduced output is kept.** Output under the reduction limit is never written. Output over
  it is written while the command runs, because whether it will be reduced is known only at the
  end; when it is not (a failing `git` command, whose output is not shown, for example), its files
  are removed as soon as the call ends.
- **Parts.** A file holds at most 10 MiB, the largest file `read_file` and `grep` accept, so a
  larger output is split into numbered parts. Parts end at line boundaries; only a line longer
  than 64 KiB can be split between parts, and never inside a valid UTF-8 character. Concatenated in
  order, the parts are exactly the bytes received. Because `grep` matches line by line, a match is
  split between parts only in that case.
- **Limits.** 64 MiB per output and 512 MiB per process, because the temporary directory is often
  a tmpfs, which is memory. When a limit is reached, saving stops; files already written are kept
  until nullrivet exits, so a path given to the model stays valid for the whole run.
- **States.** The line starts with `complete` when every byte received was saved, with
  `truncated` and the reason when a limit or a write error stopped saving, and with `interrupted`
  when the capture ended early: the command timed out, was aborted, or left processes running that
  were killed before their output was read. A truncated output that was also interrupted says both.
  A failure to save never fails the tool; when nothing could be written, the line says `not saved`
  and why.
- **Binary output.** The bytes are preserved, but `read_file` and `grep` refuse files with a NUL
  byte in their first 8000 bytes. When a part has one, the line says so instead of suggesting those
  tools.
- **Privacy and lifetime.** Even without `--session`, tool output is written to disk for the
  duration of the run. When `TMPDIR` points to persistent storage, the files are there until
  nullrivet exits; a process killed with SIGKILL or by the OOM killer leaves its directory behind.
  A resumed session can name files of an earlier run that no longer exist; `read_file` reports them
  as not found.
