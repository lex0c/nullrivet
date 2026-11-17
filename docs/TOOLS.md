# Tools

nullrivet exposes eleven tools to the model. Each declares an effect, which decides whether it is
available in `readonly` mode. `delegate` is offered only in the interactive session.

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
| `bash_background` | exec | yes | no |
| `bash_jobs` | exec | yes | no |
| `bash_kill` | exec | yes | no |

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

Starts a subagent in the background on a self-contained investigation and returns at once. The
subagent's report reaches the model later, as data.

| Parameter | Description |
|---|---|
| `title` | Short label shown to the user (cut at 80 characters). |
| `objective` | The task, complete on its own: the subagent cannot see the conversation. |
| `context` | Reference material: paths, findings, excerpts. It reaches the subagent as data, fenced like piped stdin, because it may hold text copied from files; requirements belong in `objective`. |
| `cwd` | Starting directory of the subagent (default: the starting directory). |

- **Read only.** The subagent runs in `readonly` and is offered only the `read` tools, whatever
  the session's mode: only the main agent changes files or runs commands. That is why the tool's
  effect is `read` and it is offered in `readonly` too.
- **Interactive session only.** A one-shot run ends with its task, so there is nobody to receive a
  report that arrives later; the main agent does the work itself.
- **Result.** `Started subagent <id>.`, or `Queued subagent <id>: ...` when every slot is taken.
  The model can keep working meanwhile.
- **Report.** When the subagent ends, a runtime note (`<agent-note>`) is added before the next
  request, as for [background jobs](#background-jobs). The note holds only what the runtime
  observed: the id, the status (`completed`, `failed`, `cancelled` or `budget`), the reason when it
  stopped early (`cancelled`, `time_limit`, `step_limit`, `context_full`, `output_limit`,
  `provider_error`, `internal_error`), the steps, tool errors and tokens. The title, any message
  that came with the stop and the report follow as data, fenced like piped stdin: they are text
  from models and services, not from the runtime. The session shows a line with the subagent's
  title and the same facts. While the session is idle, a report starts a turn of its own. Files
  may have changed since the subagent read them.
- **Batches.** Each request carries new report data up to a quarter of the context window
  (at least 2 KiB) and at most 32 KiB, and always at least one report; the others wait for the
  next step or turn. The data of one report stays within that budget with everything it holds: the
  stop message is cut to 1 KiB, and a report that does not fit is reduced to the room left and
  saved whole, so a small context window is never filled by reports. Job notices never wait for
  reports. Notes in one request are in the order the events happened.
- **Concurrency.** Up to four subagents run at once; up to 16 more wait for a slot, in order.
  Beyond that, `delegate` is refused with `subagent.limit`.
- **Limits.** Each subagent has the session's limits for a task: `--max-steps` steps (200 by
  default) and the `--timeout` time limit, counted from when it starts running;
  `NULLRIVET_MAX_STEPS` and `NULLRIVET_TIMEOUT` set them too. Without a `--timeout`, a subagent
  gets 30 minutes, so it cannot hold its slot, and the queue behind it, without end; the main
  agent keeps no time limit. Before the last step, a runtime note asks the subagent to write its
  report without calling more tools. Once four fifths of its time have passed, the next step is the
  last one, so a subagent that runs out of steps or of time still reports what it found; at the
  limit it is stopped. The report is reduced to 16 KiB (about 4,096 tokens) together with its
  title and stop message, keeping its start and end; a reduced report is saved whole (see
  [Saved output](#saved-output)).
- **Cancellation.** Interrupting a turn (`Esc`, `Ctrl+C`) cancels every subagent, running or
  waiting; so does `Esc` on an idle session. Each reports that it was cancelled, with the next
  prompt. `/clear` cancels them and drops their reports. Exiting cancels them. A turn that ends on
  its own, at a limit or `--timeout` included, leaves them running.
- **Depth.** A subagent cannot delegate, and it has no background jobs.

## Background jobs

`bash_background`, `bash_jobs` and `bash_kill` run commands that keep going while the model works
on something else: a dev server, a watcher, a long build or test run. Only the main agent has them,
since subagents only read.

### bash_background

| Parameter | Description |
|---|---|
| `command` | The bash command to run. |
| `cwd` | Working directory (default: the starting directory). |
| `max_runtime_ms` | Stop the job after this long, at most 2,147,483,647 (the longest timer delay). Without it, the job runs until it ends or is stopped. |
| `ready_pattern` | Literal text, 1 to 256 bytes, whose first appearance in the output marks the job as ready. Not a regular expression. It is matched in the output without terminal escape sequences, as the model sees it, so color codes between its words do not prevent a match. |

It returns once the process exists and its log has been created, with the job id, the pid and the
log path. A job runs like `bash`: its own process group, stdin closed, the same environment without
the agent's credentials, and the command passed through an environment variable. Unlike `bash`, it
is not tied to the task: an interrupt or the `--timeout` of a task do not stop it.

### bash_jobs

| Parameter | Description |
|---|---|
| `id` | Job to show. Without it, every job is listed with its state. |
| `wait_ms` | Wait up to this long, 0 to 600,000 ms, for the job. Requires `id`. |
| `until` | `exit` (default) waits for the end; `ready` waits for readiness or the end, for a job started with `ready_pattern`. Requires `wait_ms`. |

A job is shown with its state, exit code or signal, duration, readiness, log, and up to 40 last
lines of output, at most 8 KiB, kept in memory. A wait that runs out of time, or that an interrupt
ends, leaves the job running.

### bash_kill

| Parameter | Description |
|---|---|
| `id` | Job to stop. |

The job's process group receives SIGTERM, then SIGKILL after 2 s. The tool waits for the end, at
most 10 s, and returns the final state; an interrupt ends the wait, and the signals are sent anyway.
The limit covers a process the kernel cannot kill, such as one stuck on a hung network mount. A job
that had already ended is left as it was.

### Behavior

- **Ids.** `<prefix>-<n>`: 64 random bits drawn by each process and a counter. An id from an
  earlier run, still in a resumed session, does not name a job of this one; it is reported as
  `job.unknown`.
- **States.** `running`, then `completed` (exit code 0), `failed` (another exit code, or a signal
  nobody asked for), `stopped` (`bash_kill`) or `timed_out` (`max_runtime_ms`). The first ending is
  final: a stop or a time limit that arrives after the job ended on its own does not change it.
- **Log.** stdout and stderr go to one file, in the order they were written, saved like
  [saved output](#saved-output) in parts of up to 10 MiB. The limits are 64 MiB per job and 256 MiB
  for all jobs, apart from the limits of tool output; when a job reaches its limit, saving stops and
  the job keeps running. Logs are kept until nullrivet exits, so once the 256 MiB are used, later
  jobs still start but save nothing; their last lines remain available through `bash_jobs`. The log
  is written in whole lines, so an incomplete last line appears when its newline does, while
  `bash_jobs` already shows it. The log of a running job is never described as complete.
- **Notices.** When a job ends or becomes ready, a runtime note (`<agent-note>`) is added before the
  next request: at the next step of a running task, or with the next prompt. It holds the id, what
  happened, the duration and the log files, never output or the command: runtime notes are trusted,
  and command output is not. It points to the log, which `read_file` and `grep` read in either mode.
  Each event is reported once: one already shown by `bash_jobs` for that job, or by `bash_kill`,
  gets no note; a listing, which has no log details, does not count. The notes are also shown to
  the user, as `notice` events.
- **Automatic continuation.** In the interactive session, an event that arrives while the session
  is idle starts a turn of its own, without a prompt: its first message is the runtime note. See
  [TUI.md](TUI.md#automatic-continuation) for when it starts and stops. In one-shot mode nothing
  starts on its own: the run ends with the task, so the description of `bash_background` tells the
  model to wait with `bash_jobs` for any result it still needs.
- **Limits.** At most 8 jobs run at once. Finished jobs whose events were reported are forgotten
  beyond the 50 most recent.
- **Errors.** `job.limit` when 8 jobs are running, `job.unknown` for an id this run does not have,
  `job.start_failed` when bash cannot start, and `job.log_failed` when the log cannot be created, in
  which case the job is not started.
- **Lifetime.** Jobs are stopped when nullrivet exits, including on SIGINT, SIGTERM and SIGHUP. In
  one-shot mode that is when the task ends; to keep a server running across tasks, use the
  interactive session. `/clear` does not stop jobs, but the events of the jobs that exist when it
  runs are no longer reported.
- **readonly.** The job tools are `exec`, so they are not offered in `readonly`. Jobs started
  before a switch keep running and their notices still arrive, but checking or stopping them needs
  `auto`.

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
- **Long lines.** `read_file` shows at most 2000 characters of a line and `grep` 500, so the middle
  of a very long line (minified code, a JSON document on one line) is saved but cannot be read with
  them. In `auto` mode, `bash` can extract any range of it (`cut -c`, `dd`).
- **Searching a directory.** Inside a git repository, `grep` on a directory follows git's ignore
  rules. With `TMPDIR` inside a repository whose rules ignore the part names (`*.txt`) but not the
  directory, a search of the directory finds nothing; searching each part by its path works.
- **Limits.** 64 MiB per output and 512 MiB per process, because the temporary directory is often
  a tmpfs, which is memory. When a limit is reached, saving stops; files already written are kept
  until nullrivet exits, so a path given to the model stays valid for the whole run.
- **States.** The line starts with `complete` when every byte received was saved, with
  `truncated` and the reason when a limit or a write error stopped saving, and with `interrupted`
  when the capture ended early: the command timed out, was aborted, or left processes running that
  were killed before their output was read. A truncated output that was also interrupted says both.
  The state describes the saving, not the command: the output of a command that failed is complete
  when every byte of it was saved. A failure to save never fails the tool; when nothing could be
  written, the line says `not saved` and why.
- **Binary output.** The bytes are preserved, but `read_file` and `grep` refuse files with a NUL
  byte in their first 8000 bytes. When a part has one, the line says so instead of suggesting those
  tools.
- **Privacy and lifetime.** Even without `--session`, tool output is written to disk for the
  duration of the run. When `TMPDIR` points to persistent storage, the files are there until
  nullrivet exits; a process killed with SIGKILL or by the OOM killer leaves its directory behind.
  A resumed session can name files of an earlier run that no longer exist; `read_file` reports them
  as not found.
