# Sandbox and engagement scope

Status: phases 1 to 5 are implemented: the ToolBroker; the worker with the `inspect` profile,
background jobs included; the `workspace` profile with its ChangeSet; the `security` profile, with
the network of an engagement's scope within its window and the resource limits of every profile;
the proxy that authorizes names; and the evidence log. The virtual machine backend (phase 6) is
not. The document records the design, the facts checked on a Linux host
while building it, and the decisions taken on it.

## Purpose

nullrivet runs tools with the operator's privileges: `bash` reaches the whole network, and the file
tools read and write any path the user can. That suits a coding session on one's own project. It
does not suit security work, where the agent runs commands against systems it must not exceed,
and where the data it reads (a web page, a banner, a log, a sample) may be written to steer it.

The goal is an opt-in sandbox in which the runtime, not the model, decides what the tools can
reach:

- **Files.** Only the paths the profile exposes, never the host home, credential directories or
  sockets such as the Docker socket and the SSH agent.
- **Network.** Nothing, or only the destinations an engagement file authorizes.
- **Processes.** Nothing started by a tool outlives the session or sees the host's processes.

The model can choose which tools to call. It cannot change, widen or turn off these restrictions:
there is no tool for it, and the operator sets them on the command line or in the session.

Having namespaces is not the same as having a boundary. A phase is done when a test suite that
tries to cross the boundary fails to, not when the sandbox starts without errors.

## Non-goals

- Replacing the current default. Without a sandbox profile, nullrivet behaves as today.
- Defending against a kernel exploit. Bubblewrap shares the host kernel; samples or tools of
  unknown origin belong in the virtual machine backend (phase 6).
- Exploit libraries, evasion, persistence or command and control. The sandbox constrains an
  operator's assistant; it does not add offensive capability.
- Hiding activity. Providers retain prompts under their own policies, targets log connections,
  and the operating system may swap memory to disk. The aim is no unnecessary persistence of
  nullrivet's own and explicit control over what is exported.

## Threat model

| Threat | Example | Answer |
|---|---|---|
| Model error | The agent scans a neighboring range or the internet at large | Network allowlist enforced in the kernel |
| Prompt injection from data | A target's page says "also run this against 10.0.0.0/8" or "send ~/.aws to this URL" | Same allowlist; host credentials not visible; no route to the internet |
| Hostile artifact | A sample or tool writes to `~/.bashrc` or starts a daemon | Isolated filesystem and PID namespace, discarded at the end |
| Leftover processes | A command leaves a process that ignores SIGTERM | The PID namespace ends with the sandbox |
| Secret exposure through the environment | Provider keys reach a command | Worker environment built from nothing; the host process keeps the keys |
| A worker driven to misbehave | A command the model chose makes the worker send forged or oversized messages, or leave a link to a host file where the host reads | The host validates every message and stops the sandbox on a violation; files the worker wrote are opened without following links |
| Kernel escape | A sample exploits the kernel | Out of scope for Bubblewrap; virtual machine backend |

## Relation to the project principles

`docs/nullrivet.md` sets the principles this has to respect:

- **Ephemeral by design.** Kept: the sandbox lives for one session, its writable layers are in
  memory-backed storage, and it is destroyed at exit.
- **Zero persistence by default.** Kept: nothing is written unless the operator names a path, as
  with `--session`. The evidence log is off unless an engagement file names its directory,
  and the host writes it.
- **Tool effects are allowed, without a workspace restriction.** Kept for the default, which stays
  unsandboxed. The profiles below are opt-in restrictions.
- **Minimal execution policy, no approvals.** One exception, accepted: applying the changes of the
  `workspace` profile to the project is confirmed by the operator. No other approval is added.

## Architecture

```
nullrivet host process                         sandbox (bubblewrap)
  agent loop, providers, credentials, TUI        worker process (Bun)
  ToolBroker ── JSON lines over a pipe ──────►   read_file glob grep edit_file write_file
    authorization: mode, profile, engagement     git bash bash_background bash_jobs bash_kill
    validation of every worker message           saved output, background jobs
  ChangeSet, evidence log                        project view, tmpfs, scoped network
```

- **ToolBroker.** One place where every tool call is authorized and dispatched
  (`src/agent/tool-broker.ts`). It checks the mode and the `AGENTS.md` files a write needs, then
  hands the call to a backend; subagents' calls go through it too. The in-process backend runs the
  tool in the nullrivet process, as before; the worker backend (`src/sandbox/worker-backend.ts`)
  runs it in the sandbox. A tool that acts on the agent rather than on files, commands or the
  network declares it (`delegate`) and runs in process whatever the backend: the broker decides,
  not the backend, since a worker receives only a tool's name. Later phases add the engagement
  window to the checks.
- **Worker.** A Bun process started inside the sandbox once per session: nullrivet's own entry
  point with a reserved argument, from source or from the compiled binary. It hosts the same tool
  implementations and loads only those the profile allows. The file tools must run there too: a
  sandbox around `bash` alone would leave `read_file` and `grep` reading the host.
- **What stays on the host.** The agent loop, the providers and their keys, the TUI, the session
  file, the policy, the ChangeSet and the evidence log. The worker never holds a provider key and
  never decides what is allowed: authorization happens on the host, and the worker only carries
  out calls within the limits the sandbox imposes on it. The instructions loader also stays on the
  host and reads the host's project: an `AGENTS.md` written inside the sandbox does not change the
  loaded instructions, including on reload, until the ChangeSet applies it to the project. In
  `security`, where nothing is applied, it never does.
- **Instruction discovery under a profile.** The loader reads host files for paths that reach it
  from the model (the target of a write) and from the worker (the paths a call touched). Under a
  profile, it considers only paths inside the project as the sandbox exposes it, and ignores any
  other; the saved output directory is never one of them. A forged path therefore cannot make the
  host read an `AGENTS.md` the sandbox does not show. Without a profile, the loader already
  refuses an `AGENTS.md` that links outside its repository.

The worker starts with `--no-env-file --config=/dev/null`. Checked: with `--clearenv`, a plain
`bun` started in a project directory loaded that project's `.env` and put the provider keys in its
own environment, from where every command inherits them.

## Execution mode and sandbox profile

The execution mode (`auto`, `readonly`) and the sandbox profile are independent settings, and the
effective policy is the intersection of both: a profile never grants what the mode withholds, and
the mode never lifts a restriction of the profile.

| Profile | Files | Network | Use |
|---|---|---|---|
| none (default) | Host, as today | Host, as today | Coding on one's own project |
| `inspect` | Project read-only; system directories read-only; tmpfs home and `/tmp` | None | Code review, analysis of untrusted repositories |
| `workspace` | Project through an overlay; changes held aside until applied | None | Coding without touching the project until confirmed |
| `security` | Project through an overlay kept in memory and discarded at exit; system read-only; tmpfs home | Only the engagement scope, within its window | Authorized testing, laboratories |

| Mode | Profile | Result |
|---|---|---|
| `readonly` | `inspect` | Reading only, no network |
| `auto` | `inspect` | Reading and commands, on a read-only project, no network |
| `auto` | `workspace` | Writes held in the overlay, reviewable before they reach the project |
| `readonly` | `security` | Local investigation of the working directory, without commands |
| `auto` | `security` | Every tool, with the network limited to the scope |

A profile is chosen with `--sandbox <profile>` and shown in the status line. A sandbox that cannot
be set up stops the session with the reason: no profile falls back to running unsandboxed.

## Worker protocol

One JSON object per line in each direction, over descriptors 3 (host to worker) and 4 (worker to
host). The worker's stdin and stdout are `/dev/null`, and its stderr is shown only to explain a
start that failed. Bubblewrap's init process, PID 1 of the sandbox, keeps the sandbox's standard
streams open: with the protocol on stdout, `echo ... > /proc/1/fd/1` from a command reached the
host's pipe. Checked with the descriptors: the init process holds only `/dev/null`, its stderr
socket (which `/proc` cannot open) and an eventfd.

The worker's first action is `prctl(PR_SET_DUMPABLE, 0)`, through `bun:ffi`. Commands run as the
same user in the same namespaces, and a dumpable worker would let them read its environment and
descriptors through `/proc/2` and write to the protocol. Checked: `/proc/2/fd` and
`/proc/2/environ` refuse a command with "Permission denied". A worker that cannot make the call
does not start.

```ts
type HostToWorker =
  | { type: 'tool.execute'; id: string; name: string; input: Record<string, unknown>; cwd: string }
  | { type: 'tool.cancel'; id: string }
  | { type: 'jobs.stop' }
  | { type: 'worker.shutdown' }
  | { type: 'worker.environment'; variables: Record<string, string> };

type WorkerToHost =
  | { type: 'worker.ready'; protocol: 3; tools: string[] }
  | { type: 'tool.result'; id: string; result: ToolResult }
  | { type: 'worker.error'; message: string }
  | { type: 'job.started'; jobId: string; callId?: string }
  | { type: 'job.event'; seq: number; event: JobEvent }
  | { type: 'job.shown'; jobId: string }
  | { type: 'jobs.stopped'; running: number };
```

- **Correlation.** The host generates the ids, unique per session. Each `tool.execute` gets exactly
  one `tool.result`.
- **Untrusted input.** The worker executes commands the model chose, so everything it sends is
  data to validate, not a statement to trust. The host checks each message against its type, with
  no field missing or added, and bounds what a result may carry: `meta` up to 64 KiB, at most 64
  touched paths, each absolute, normalized and without NUL. The worker holds its own results to
  these bounds before sending them, since a tool can exceed them (git reports every path it was
  given): it leaves out a larger `meta` and keeps the first 64 valid paths. A line over 8 MiB, a
  malformed message, a result for an unknown or already answered id, a message of an unknown type
  or a `worker.error` stops the sandbox. A call to a tool the worker does not run is refused on the
  host without stopping it.
- **Readiness.** The host sends nothing before `worker.ready`, whose tool list must match what the
  profile allows, within 10 s of the start.
- **Environment.** `worker.environment`, sent once the worker is ready and before any call, and
  again after a `/scope refresh` for the commands started from then on, sets
  variables its commands inherit: those of the proxy of the `security` profile alone, which carry
  its credential. A launcher's arguments are readable by every user of the host, and Bubblewrap
  takes the sandbox's environment as arguments (`--setenv`), held for the whole session: the
  credential goes on the protocol's descriptors instead. Any other name, or a value over 64 KiB,
  stops the worker; the host checks the variables the same way before it starts one.
- **Cancellation.** `tool.cancel` aborts the call's signal in the worker, which still answers with
  the interrupted result. A cancelled command gets SIGTERM, SIGKILL after the 2 s kill grace, and up
  to the same grace for its output to close, so the host waits twice the grace plus 3 s (7 s).
  A call that does not answer in that time stops the sandbox.
- **Background jobs.** The jobs live in the worker, which sends each fact as it happens, on the
  same descriptor as the results: `job.started` before the result of the call that started the
  job, `job.event` when a job becomes ready or ends, before anything waiting on it resumes, and
  `job.shown` when `bash_jobs` or `bash_kill` showed a job to the model. So every fact reaches the
  host before the result it led to. The host keeps a projection of the jobs (see Background jobs
  below). Event numbers start at 1 and follow each other; a job id is the registry's prefix, fixed
  by the first start, and a number above the previous job's; a second ready or end, an event of a
  job that did not start, or a start while 8 jobs run stops the sandbox.
- **Disconnection.** If the worker exits or its pipe closes, pending calls fail with the reason,
  jobs are reported as lost, and the session stops using tools: a session whose boundary failed
  does not continue on another one. The same holds after a protocol violation. The backend then
  stays in a terminal state that the broker checks before every call: each later call is refused
  with `sandbox.lost`, not as a crash of the tool, and is never sent to the in-process backend.
  The turn ends with an error after the batch, and a subagent's report says `sandbox_lost`. A tool
  that fails, times out or rejects its arguments is a result, and changes nothing in the
  backend's state.
- **Signals.** Commands run as the same user and can see the worker by name: `pkill bun`, meant
  for a dev server, reaches it too. The host never signals the worker, so the worker ignores
  SIGINT, SIGTERM, SIGHUP and SIGQUIT. SIGKILL cannot be ignored: a command that sends it ends the
  worker, and the sandbox is lost.
- **Shutdown.** `worker.shutdown` at exit; the sandbox is torn down whether or not the worker
  answers. Bubblewrap runs in a process group of its own, which the exit handler kills with the
  command groups, and `--die-with-parent` ends the sandbox when nullrivet is killed outright.

## Background jobs

The worker runs the jobs in a registry of its own, with hooks that hand each fact to the protocol
as it happens: the start when the job is registered, readiness and the end before anything waiting
on them resumes, and a show when a tool reports the job. Handing a fact over counts as its
delivery in the worker, which then forgets finished jobs as the registry always has; it can forget
a job before its note reaches the model, since the host already has the facts. Delivery to the
model is decided on the host alone, so nothing is confirmed back to the worker.

| Step | Meaning |
|---|---|
| A fact handed over in the worker | produced and put on the protocol descriptor |
| `job.event` on the host | received by the projection |
| delivery on the host | its note reached the agent loop |
| `job.shown` | a tool showed the job and every earlier event of it |

The host's projection (`src/sandbox/job-projection.ts`) answers what the agent and the interactive
session read at once: the pending events, oldest first, with an end hiding a pending ready event;
how many jobs run; how many were started. Its listeners run on every ready or end, delivered or
not, so the footer stays current. `/clear` marks the known jobs as dropped on the host: only the
main agent has the job tools, and the conversation is cleared between its turns, after the start
of every job it launched has arrived.

The fields of an event become text of a runtime note, which the model trusts, so the host checks or
reduces them: log parts must be log files of the sandbox's `/tmp`, at most 15, the most the output
code makes within its 64 MiB limit; sizes, times and exit codes are bounded integers; a signal must
be one the system knows; a stop reason or an interruption keeps only its kind, without the system
message after it, and unknown text becomes a generic kind. Text a correct worker can produce when a
command interferes, such as a log directory made again or a full disk, never stops the sandbox.

When the sandbox is lost, each job still running gets a `job.lost` note, written by the host
without the reason of the loss. From then on no event starts a turn of its own, since every tool
would be refused in it; the notes go out with the next prompt.

## Files

- Bound read-only: `/usr`, and `/bin`, `/sbin`, `/lib`, `/lib64`, `/lib32` as links or
  directories as on the host; `/etc/ld.so.cache` and `/etc/alternatives` when present; and the
  worker's own files: the binary, or bun and the `src` directory. Not the package root above it,
  which may hold a `.env` with keys. They are bound under `/.nullrivet-worker`, not at their host
  paths, so the tools, the worker's command line and the home directory do not show where
  nullrivet is installed. The install path is not secret all the same: `/proc/self/mountinfo`
  names the source of every bind. Hiding it would mean copying the runtime, about 100 MB, into
  memory for every session.
- Generated: `/etc/passwd` and `/etc/group` with only root and the user, since the host's list
  every account; `/etc/hosts` with only `localhost`; `/etc/nsswitch.conf` naming files only; and
  `/etc/localtime` as a link to the host's zone.
- The project at its real path, so paths in tool results and in the conversation are the same
  inside and outside: read-only in `inspect`, an overlay in `workspace` and `security`.
- In phase 2a the worker's saved output stays in the sandbox's own `/tmp`, and the directory where
  the host saves subagent reports is bound read-only at its path. No writable directory is
  shared with the host: the evidence log reads the outputs the worker saves in the sandbox's own
  `/tmp`, through the root of the sandbox's processes, as described under Evidence log.
- Those subagent reports are a known limitation: they are written in the host's temporary
  directory, which may be on disk. They are removed at exit, but an end without the exit handler,
  such as SIGKILL, leaves them there. Memory-backed storage (phase 3) covers them.
- New `/proc`, with `/proc/keys` and `/proc/key-users` masked; minimal `/dev`; tmpfs `/tmp`
  (1 GiB) and home (256 MiB); and the root remounted read-only last, since Bubblewrap's own root
  is otherwise writable. `/sys` is not bound from the host. Checked: with the host root bound,
  `/sys/class/net` listed the host's interfaces from inside a sandbox with its own network
  namespace.
- Never bound: the host home, `~/.ssh`, `~/.aws` and other credential directories, the Docker
  socket, `SSH_AUTH_SOCK`, `/run`, and the saved output of other sessions.

The project root is the nearest ancestor of the working directory with a `.git` entry, or the
working directory itself, with symbolic links resolved. It is refused when it is `/`, the home
directory or one of its ancestors, or when it contains `/tmp`, `/run`, `$XDG_RUNTIME_DIR`, the
directory of `SSH_AUTH_SOCK` or the Docker socket: a project inside `/tmp` is accepted, `/tmp`
itself is not. A `.git` that is a file, as in a worktree or a submodule, is not followed, because
a repository could point it anywhere; git inside the sandbox then cannot find the repository.

The environment is built from nothing: a fixed `PATH` of system directories, since a relative
entry of the host's would run a program planted in the project, then `HOME`, `TMPDIR`, `USER`,
`LOGNAME`, `LANG`, `TZ` and `LC_*`. Bubblewrap is started with the same environment, not only told
to clear it: its init process keeps the environment it was started with, readable from inside
through `/proc/1/environ`.

### Seccomp

Bubblewrap installs a seccomp program (`src/sandbox/seccomp.ts`) before the worker starts, and
every command inherits it. It denies with EPERM:

- `keyctl`, `add_key` and `request_key`: the kernel keyrings are shared with the host, and can
  hold credentials such as Kerberos tickets;
- `socket` of any family but `AF_INET`, `AF_INET6` and `AF_NETLINK` with `NETLINK_ROUTE`, which the
  network namespace isolates, and of `AF_INET` or `AF_INET6` with the type `SOCK_PACKET`, under
  which the kernel makes a packet socket, as `AF_PACKET` does; the type is read without its flags.
  Others are not all isolated by it: with `AF_UNIX`, a read-only bind does not stop a connection to
  a host socket inside the project, including one created after the start; `AF_VSOCK` can reach the
  hypervisor or other machines when vsock namespaces are global, the kernel's default. Families are
  allowed by name, so one the kernel adds later is denied. `socketpair` stays allowed, since it only
  makes a pair connected to itself.
- `io_uring_setup`, `io_uring_enter` and `io_uring_register`: an io_uring operation creates a
  socket without the `socket` call, so the rule above would not hold. Checked: a command in the
  sandbox created a Unix socket through io_uring and connected to a host socket in the project
  until these calls were denied.
- on x86_64, any call of the x32 ABI, which shares the architecture value and would otherwise
  reach the same calls under other numbers.

A call through another architecture's ABI, such as i386 through `int 0x80`, gets ENOSYS. The
supported architectures are x86_64 and arm64. Checked in Bubblewrap 0.13 with the program: Bun,
its process spawning, worker threads and git run; `socket` with `AF_UNIX`, `AF_VSOCK`, `AF_ALG`
or the uevent netlink protocol, `io_uring_setup`, `keyctl` and `keyctl` with the x32 bit get
EPERM, while IPv4, IPv6 and netlink routing sockets are created.

### Memory-backed storage

From phase 3, writable layers live in `$XDG_RUNTIME_DIR`, a per-user tmpfs on systems with systemd,
so an abnormal exit leaves no files on disk, and what remains is removed when the user's last
session ends or at reboot. A tmpfs is memory, and the system can move it to swap like any other
memory: a swap partition or file on disk can then hold pages of it. Keeping those pages off the disk
is the system's to set, with encrypted swap, no swap, or the `noswap` mount option of tmpfs (Linux
6.4); nullrivet does not check for it, as with the rest of its memory. The variable's value is not
taken on trust: the host checks with `statfs` that the directory is a tmpfs, and that it belongs to
the user and no one else can write to it. Checked: `statfs` in Bun reported tmpfs (`0x1021994`) for
the runtime directory and another type for `/home`. Without a directory that passes, the profiles
that need one refuse to start; there is no option to accept a directory on disk.

### Files the worker writes

Phase 2a shares no writable directory with the worker; this applies once a phase does. The worker
can create any entry in such a directory, including a symbolic link to a host file it cannot see. A
host that followed it would read that file with its own access, on the worker's behalf, and could
copy it into the evidence log. So the host:

- never opens a path as a worker message gives it: a path is accepted only when it names an entry
  directly inside the directory the host created, in the fixed pattern of the output code
  (`<sequence>-<label>.<part>.txt`);
- opens it with `O_NOFOLLOW` and `O_NONBLOCK`, and reads it only if `fstat` on the descriptor shows
  a regular file no larger than a part may be;
- reads the content as data, like any tool output.

Only the last component needs this, because the components above it are host paths the sandbox
does not see. Checked in Bun: `O_NOFOLLOW` refused a symbolic link with `ELOOP`, and `O_NONBLOCK`
opened a FIFO without blocking, with `fstat` reporting that it is not a regular file. The ChangeSet
reads a whole tree the worker wrote, and resolves every component instead.

## The workspace ChangeSet

Applying the overlay to the project is a security operation, handled by a host component of its
own, the ChangeSet. The worker never names the host paths to write: the ChangeSet reads the
overlay's upper layer itself and decides. The worker wrote that layer, so it is untrusted input,
and it is read only when no process can change it.

- **Reference time.** Right before the overlay is mounted, the host creates a probe file and takes
  its change time. Any change to an entry sets its change time to the present, and no call sets it
  back, so an entry of the project whose change time is not earlier than the probe's changed on
  the host during the session. The ChangeSet records the times it leaves on each entry it writes,
  so its own writes, several additions to one directory included, are not conflicts. Timestamps
  are signs of change, not a record of content: the host's processes are trusted, the worker is
  not. The kernel stamps a change with the time of its last clock tick, so a change made just
  before the probe, such as the application of an earlier sandbox's changes in an interactive
  session, can carry the probe's time: the reference is taken once the clock has moved past the
  moment it is asked for, and every change made before then comes before it. A change made within
  the same tick as the reference counts as changed: a false conflict, never a missed one. The
  probe is in the session's directory, on another filesystem than the project, with the same
  clock. A project on a filesystem with coarser times, as exFAT keeps steps of 10 ms and FAT of
  2 s, would stamp a change made later within one step with an earlier time: the step is taken
  from the project root's change time, the largest power of ten that divides it, two seconds for
  whole seconds, and the reference is the start of a step, which can take up to one step to wait
  for. Modification times are not compared, since a file can carry a future one without any
  change.
- **Stopping the sandbox.** Applying starts by ending the sandbox, with its commands and background
  jobs, which the confirmation lists. The broker holds tool calls until the application ends, and
  the next call starts a new sandbox over the updated project, with a new upper layer: the old one
  is never mounted again, and the entries it holds that were not applied are listed and
  discarded. With no process left that can write the upper layer, it cannot change between
  validation and writing. overlayfs requires the stop as well: changing a lower layer while the
  overlay is mounted has undefined behavior.
- **Snapshot.** The ChangeSet walks the upper layer once, without following its symbolic links,
  and records each entry: type, mode and, for a regular file, its SHA-256. Regular files are
  additions or modifications; whiteouts, a character device 0/0 or a file with the whiteout
  marker, are deletions; an opaque directory replaces the one below. Overlay features the reader
  does not handle (`metacopy`, `redirect`) stop it. A marker the agent sets is not one: the kernel
  stores it escaped, as `user.overlay.overlay.*`. A rename appears as a deletion and an addition,
  and is applied as such. Each file is checked against its hash again when written, so what is
  written is what was shown.
- **Bounds of the reading.** The reading runs on the host, synchronously, over what the sandbox
  wrote, so its work is bounded by what the sandbox's storage holds. The walk stops past 200,000
  entries; a directory more than 64 levels deep is refused unread, since every change's path is
  opened and checked from the project's root; a file larger than 1 GiB, and a sparse file, whose
  size the storage does not hold, are refused unread. A file is read up to the size its descriptor
  showed, never to its end: one that grows or shrinks while it is read is refused. The names of one
  inode are read once, and the files' sizes, counted for each name, stay within the storage's size,
  since the application writes each name as a file of its own: past it, the reading stops. The
  summary's lines come from the bytes this reading hashed, kept for files up to 1 MiB and 32 MiB in
  all, never from a second reading: a sandbox still running cannot show one content and have another
  applied.
- **Classification.** Each entry is compared with what the project holds at its path. An entry
  whose content and mode are unchanged is no change, whatever its times. Modes are kept, and the
  set-user-ID and set-group-ID bits never added; a bit the project's entry already has is kept.
  `.git` is never changed, at any depth, and a directory holding one, or a mount point, is never
  removed. `.git` is recognized by its name only: a gitfile naming a git directory inside the
  project under another name, as `git init --separate-git-dir=meta` makes, leaves that directory,
  its hooks included, as open to changes as any other. Creating a device, FIFO or socket is refused; removing one the project has is applied,
  since a removal only takes away a name. Two names of one inode, a hard link, reach the project
  as two separate files. A mode belongs to the inode, shared by every name, and a name outside the
  project can be made up to the moment the mode is set, so a file whose mode changes gets a new
  inode with the new mode; only a directory's mode is changed in place. An entry that replaces
  another is a removal and a creation, applied together; a refused or conflicting entry leaves the
  project's one in place.
- **Symbolic links.** A link is applied only when it resolves inside the project, or under `/usr`
  with no `..` component, as a Python virtual environment's interpreter link does; a target under
  `/usr` must stay under it once resolved on the host, since links there can lead elsewhere, as
  Debian's `/usr/lib/ssl/certs` does to `/etc`. It is resolved over the tree the project would have,
  following every link on the way, up to 40, since a link inside the project can lead out of it; a
  part of the project that cannot be read refuses the link. Only the last part of the path may be
  absent or other than a directory: past an absent part, the rest would be decided by whatever is
  made there later, as a link `missing/../etc/passwd` becomes a way out once another application
  makes `missing` a link to `/usr/`. The links of one check take at most a million lookups in all;
  the rest are refused. Links are created last, each checked again over the project as it then is,
  since an entry a link leads through may not have been applied, and in the order of their ways: a
  link that leads through another link to be created comes after it, so that, the creation stopping
  at the first failure, a link is never made without the links it was checked with; one that leads
  through a link refused is refused too.
- **Resolution.** Every target path is resolved from a descriptor of the project directory, one
  component at a time, beneath it and without following a symbolic link or crossing a mount
  (`openat2` with `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`, `RESOLVE_NO_MAGICLINKS` and
  `RESOLVE_NO_XDEV`), so a path cannot lead elsewhere between the check and the write, and paths
  longer than the system's limit are reached. What would follow the last component (open, write,
  chmod) is done on a descriptor; only what never follows it (unlink, rmdir, mkdir, symlink,
  lstat) goes by name, relative to a directory descriptor. A target that is a symbolic link in the
  project and a directory in the snapshot is replaced, not followed. Checked: through `bun:ffi`,
  `openat2` refused a component that is a symbolic link with `ELOOP` and a path that leaves the
  directory with `EXDEV`. The file API Bun provides opens by path only, so these calls go through
  `bun:ffi`.
- **Conflicts, before anything is written.** Every entry is checked against the reference time
  first. An entry in conflict is shown and not applied, with everything beneath it or replacing
  it; the rest is applied. The check prevents accidental overwrites; it does not detect every
  concurrent change.
- **Application.** Stopping the sandbox ends the worker's processes, not the host's: an editor or a
  build can still change a file during the application, so each entry is checked again as it is
  written. An entry that is replaced, by a new version of a file or by an entry of another type,
  is made first under a temporary name in its directory and exchanged with the project's
  (`renameat2` with `RENAME_EXCHANGE`): the path holds one or the other at every moment, and a
  failure while the new entry is made leaves the project's in place. Making it can take long, so
  the project's entry is checked against the reference time again right before the exchange. The
  entry moved out must be the one checked, with the same modification time, mode, owner and group,
  and the same size for a file or the same content for a directory, or the exchange is undone;
  moving an entry sets its change time, so a change to its extended attributes alone in the
  moment between that last check and the exchange is not seen. An addition goes in only where
  nothing is (`RENAME_NOREPLACE`), in a directory that did not change. A removal first moves the
  entry to a hidden name in its directory, checks what it moved, and deletes it, or moves it back.
  Before each write, the directory is opened again to confirm it was not moved. The application
  is atomic per entry, not across the project: a failure, a new conflict or an interruption of
  the process stops it, leaving what was applied before. It reports what was applied and what was
  not; when an entry was taken from its path but could not be deleted, the report gives the
  hidden name it is left under. Killed at any point, by a signal or a power loss, the application
  leaves each path as it was or as the change makes it, and can leave an entry under a hidden name
  starting with `.nullrivet-` in its directory: a new entry not yet moved in, or the project's
  entry not yet deleted, whole or in part. There is no journal to finish or undo the rest.
- **Discarding** removes the upper layer.

Editing the project on the host during a `workspace` session is not supported. The kernel leaves
undefined what the overlay shows after its lower layer changes, so the worker's view of a file the
operator edits is not reliable. The ChangeSet finds such edits as conflicts on the paths it
changes; it does not make the views coherent.

### A one-shot task

With a task on the command line, `--sandbox workspace` runs it once with the project behind the
overlay, and the operator decides before the task starts: without `--apply`, the changes are shown and discarded; with it, they are applied if the
task finishes (`done`), and discarded if it does not, whatever the agent says. `--apply` has no
environment variable, so the decision is made for each run, and it is a usage error without the
`workspace` profile.

- **Where the changes live.** The upper and work directories are in
  `$XDG_RUNTIME_DIR/nullrivet-<pid>-<start>/`, the user's runtime tmpfs, created with mode 0700.
  The runtime directory must be the user's own, writable by no one else, under directories that
  belong to root or the user and that others cannot change (sticky when others can write to
  them, as `/dev/shm` is), and on a tmpfs, so that what a process killed with SIGKILL leaves is
  not kept in files on disk (swap aside, as described under memory-backed storage); without one,
  as under cron, the profile refuses to start rather than use `/tmp`, which can be shared or on
  disk. The
  overlay keeps its markers in `user.*` extended attributes, which tmpfs holds from Linux 6.6 on:
  the start checks for them and says so. What the agent writes counts against that tmpfs, which
  other programs of the session use as well.
- **Removal.** The session removes its directory when it ends, after its worker has stopped, and
  the exit handler removes it when the process ends on a signal; a removal that fails is reported.
  A process killed with SIGKILL leaves it: the next session removes every such directory of the
  user that is not in use. A session holds an `flock` lock on a file in its directory while it
  lives, and the directory gets its name only once the lock is held: the lock shows a session of
  another PID namespace sharing the runtime directory, as a container can, whose process id means
  nothing here. A directory without a lock is judged by its process id and start time, since an
  id alone can be reused, and only once it was left alone for a minute: it can be one a session
  of another PID namespace is making. The removal goes by descriptor and without recursion, moving each
  directory it finds up to the top before emptying it, through directories without permissions,
  as the overlay's work directory is, at any depth.
- **Refused projects.** A project on NFS, SMB/CIFS, FUSE, 9P or Ceph: another machine or a
  process outside this kernel can change a file without the change time the conflicts rely on. A
  session file inside the project, given with `--session` or, in an interactive session, with
  `/session`: saving it would change the lower layer while the overlay is mounted. Bubblewrap
  older than 0.10.0, which has no overlay options.
- **End of the task.** The worker and its background jobs stop, then the ChangeSet reads the upper
  layer, classifies and validates it, and the summary goes to stderr: every path with what
  changes, the lines added and removed for text files, mode changes, link targets and what a
  removed directory held. What a new directory holds is counted under it. The comparison runs on
  the host, over as many files as the sandbox wrote, so it is bounded: once 32 MiB have been read
  or 20 million comparison steps taken, no other file is compared, and the comparison under way
  gets only the steps left. A file whose comparison does not finish within its limits, its own or
  those left, shows its size only, marked as not compared, never counts that are only an upper
  bound; the summary says how many. Files that run or steer an agent without being invoked
  (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.claude/` and `.cursor/` settings, `.envrc`, CI
  workflows, editor tasks, development containers, git hook directories) are marked, listed even
  inside a new directory. The modes of additions that others than the owner can write, or that are
  sticky, are shown, and so is what a directory replaced by a file or a link held. Names are shown
  with control characters, every default-ignorable code point and the line and paragraph
  separators escaped, so two names never look the same.
  With `--json`, `changes:preview`, then `changes:discarded`, `changes:applied` or
  `changes:failed`, carry the same lists with line counts and no file content.
- **Exit codes.** With `--apply` and a finished task: 0 when everything was applied, 4 when some
  or all of it was not (conflicts found before writing, refusals, or changes that could not be
  read, when none is applied), and 5 when the application stopped part-way, on a failure or a
  change made on the host during the application. The refusal of the project's own `.git` does
  not count: git commands in the sandbox change it in nearly every session, and it is never
  applied. A `.git` deeper in the project does: it belongs to a repository the task made or
  changed, whose files would reach the project without it. Without `--apply`, a finished task
  whose changes cannot be read exits with 1: the run did not show what it changed. Otherwise the
  code is the task's own.
- **Interrupts.** `Ctrl+C` after the task finished and before the application starts, while the
  worker stops, discards the changes and exits with 130. Once started, the application is
  synchronous and runs to its end: an interrupt sent during it only aborts what is already done,
  and the exit code and the report are the application's. SIGTERM ends the process when it is
  handled, after the application if it arrives during it, and the report can then be cut short;
  SIGKILL ends it at once, with the result described above.

### The interactive session

Without a task, `--sandbox workspace` starts an interactive session whose changes the operator
reviews and applies while it goes on. `--apply` is a usage error there.

- **Commands.** `/changes [path]` shows the summary, or the entries at a path, under it, or the new
  directory that holds it. `/apply` shows the summary and asks for a confirmation; `/discard` does
  the same before throwing the changes away. Both can be used while a task runs: the tool call
  under way is cut short with an ordinary tool error (`sandbox.restarted`), and the calls made
  meanwhile, by the task or by subagents, wait for the new sandbox; a call interrupted while it
  waits is not executed. Refusals, such as those of `.git`, are never applied and do not count as
  changes to apply or discard.
- **Confirmation.** The question carries a code of four hexadecimal digits drawn when it is asked:
  `Apply 3 changes to the project and stop 1 background job? Type apply 7F2C to confirm; anything
  else cancels.` Only that line, surrounding spaces aside, confirms; any other answer, an empty
  one, `Esc` or `Ctrl+C` cancels. Nothing typed before the question appeared can hold the code, so
  a line typed ahead never confirms. Answers are not kept in the prompt history.
- **What is applied.** The summary is read while the sandbox runs, without changing anything in
  the upper layer: an entry without read permission is listed as refused, and one removed or
  replaced by a link while it is read is passed over; a sandbox that rewrites its files faster than
  they are read stops the reading past its storage's size. Its lines come from the bytes that were
  hashed. Once confirmed, the sandbox stops and the changes are read again; each is
  named by everything it applies, a file by the hash of its content. Only those the operator was
  shown are applied: one made or changed after the summary is a conflict (`it changed after the
  changes were shown`), and so is what depends on it, such as the content of a new directory whose
  mode changed; the removal of a replacement stays with its new entry. The rest of the application
  is the one-shot task's, conflicts with the host included.
- **A new sandbox each time.** Applying or discarding stops the sandbox and its background jobs,
  removes its directory and starts a new one, on a new overlay over the project as it is then, in a
  directory of its own (`nullrivet-<pid>-<start>-<n>`). What was not applied is discarded with the
  old one, which is never mounted again: once the project under it changed, what the overlay shows
  of it is undefined. The jobs of the stopped sandbox are reported to the model as lost with the
  next prompt, without starting a turn. A new sandbox that does not start ends the session's tools
  for good, as a sandbox that fails on its own does; the changes of a sandbox that failed can still
  be applied, and no new one starts.
- **The model.** After an application or a discard, the model gets a note with the next request: how
  many changes were applied and not applied, or discarded, and that the sandbox started again, with
  the paths and reasons fenced as data, since the sandbox chose the names. The system prompt says
  that the sandbox starts again when the user applies or discards its changes. An application that
  may have changed an `AGENTS.md` file, writing or removing one, changing a file a loaded one links
  to, or removing a directory, reads the instructions again from the project as soon as neither a
  task nor a command runs.
- **Leaving.** `/exit` and `Ctrl+D` with changes to apply show the summary and ask: `apply <code>`
  applies them and exits, `discard` discards them and exits, and any other answer keeps the
  session. When the changes cannot be read, `discard` exits and any other answer stays. `Ctrl+C`
  twice on an empty prompt discards them: the first press counts them, and the footer says how many
  the second discards. While the sandbox is being replaced, `Ctrl+C` does not arm the exit. An
  interrupt from outside the terminal, SIGINT or SIGTERM, discards them without asking: if it
  comes while the sandbox stops for an application, the application does not start, and if it
  comes once it ran, the session waits for it and reports it on stderr.

`security` uses the same overlay with its upper layer kept in memory (`--tmp-overlay`): its writes
are not meant to be applied anywhere, and they are discarded at exit. What outlasts the session is
the evidence log, when the engagement file enables it.

## Network scope

### Setup order

The namespaces are configured by helper processes the host starts for that purpose; the host
process never joins them, so the agent loop and the providers keep the host's network.

1. The host makes a user and a network namespace, with the user's id mapped to their root
   (`unshare --user --map-root-user --net`), and runs Bubblewrap in them with `--share-net`, all
   in the sandbox's scope (see Resources). Bubblewrap puts the sandbox in a user namespace of its
   own, nested in the first, as the user's id, with every capability dropped (`--cap-drop ALL`)
   and `--disable-userns`, reports the process it made on `--json-status-fd`, and waits on
   `--block-fd` before starting the worker. systemd-run and unshare run what follows in place of
   themselves, so the process the host started is Bubblewrap's; the host does not take that on
   trust. It checks, before any helper runs, that the process Bubblewrap reported on the host's
   own descriptor has the started process for parent and shares its network namespace, and that
   the started process's user namespace is neither the host's nor the sandbox's. Then it opens
   the two namespaces, and checks that the namespace opened is the one named.
2. Helpers enter the two namespaces from outside, through the host's descriptors
   (`nsenter --user=/proc/<host>/fd/N --net=/proc/<host>/fd/M --preserve-credentials`), which
   name them whatever happens to the process they were taken from and to its id; the host keeps
   them open until no helper can run. pasta refuses such a path, so it is given the process's
   own, checked against the descriptor right before it starts, while the process is the host's
   child and its id cannot go to another; once pasta is ready, the routes are read through the
   descriptor, so the namespace pasta configured is the one pinned. The helpers, in order:
   install a ruleset that authorizes nothing, while the namespace has only its loopback; set the
   ping group range, so ICMP echo works without raw sockets; start pasta, which gives the
   namespace its way out, still closed; install the scope's ruleset, which takes effect in one
   transaction, and check that the kernel holds exactly what was written: what it lists, without
   handles, must equal what a namespace that holds nothing else lists once the same transactions
   ran in it, every table, chain, set, element and rule included, the elements the traffic adds to
   the rate limit's sets aside. The text goes to nft in files of a directory only the user can
   read, in memory (the user's runtime directory or `/dev/shm`) when one is a tmpfs, since they
   name the targets: an argument is limited to 128 KiB, and nftables 1.0.9 cannot read a script
   from a pipe. The folder is named by the process and its start, and removed after the
   transactions; one that a process killed meanwhile left in the runtime directory is removed by
   the next session that starts, a minute later at the earliest.
3. Only then is the worker released, by writing to the block descriptor, after the window was
   checked once more. A step that fails, or that takes more than thirty seconds, ends the sandbox
   unreleased. Bubblewrap goes on at the end of the block descriptor as on data, so closing it is
   a release too: the host kills the process group, which holds the blocked processes until
   then, and closes the descriptor only once the launcher has exited and the group is empty. A
   group that cannot be confirmed empty keeps its descriptor open for as long as the host lives.
   A host that dies has its descriptors closed by the kernel before the sandbox gets the signal
   of `--die-with-parent`, so the worker may start for a moment: it runs only what the host
   sends, which is nothing, and the namespace has at most the ruleset that authorizes nothing,
   which goes in first. A `worker.ready` before the release is a violation, and loses the
   worker.

The host, as the namespaces' owner, holds every capability over them, from its own namespace;
nothing in the sandbox does, being in a namespace nested below them. Checked: from inside,
`nft flush ruleset` and writing a network sysctl fail, and so does making a user namespace. The
helper must enter the namespace that owns the network namespace: entering the one of the
sandbox's process gives capabilities there only, and `nft` fails with "Operation not permitted".
The helper is the namespaces' root, the user's id being mapped to it, so its exec keeps their
capabilities, as it would not for another id. A mapped root is what lets the host set the ping group range: the network
namespace's sysctls belong to it, and a namespace Bubblewrap makes without one leaves them out of
reach, and ICMP with them. The range names the namespace's own ids, `0 0`, the user's group.

The ruleset is installed by a program already on the host, with no network needed. Checked: a
sidecar container sharing the locked namespace could not download nftables to apply new rules.

### Ruleset

- One `inet` table, so IPv4 and IPv6 share the same policy, drop, for output and input. An address
  family without authorized destinations has no way out.
- Every outgoing packet, not only the first of a connection, is matched against the authorized
  destinations with their ports and protocols. An incoming packet is accepted only when it belongs
  to a tracked connection and comes from an authorized destination. Loopback is accepted. No rule
  accepts a packet only because its connection is established.
- Out-of-scope packets are rejected (TCP reset, ICMP administratively prohibited) rather than
  dropped, so a tool reports the refusal at once instead of waiting for its own timeout.
- The rate limit counts new connections per destination: `ct state new` matched against a meter
  keyed by destination address, `limit rate over N/second burst N packets`, so that N pass at once
  and N in each second after. A plain `limit rate` counts packets, which is not what the
  engagement file promises. Only what the scope authorizes reaches the meter, in a chain of its
  own: a destination out of scope never takes a place in its sets, which hold 65,536 addresses. A
  set full makes nft's update do nothing, and the rule would not match: the next rule refuses a new
  connection to an address the meter does not hold. Tested: 70,000 datagrams to destinations out
  of scope, then ten connections to one in scope at two a second: two or three passed. Without
  this, the refused flood filled the meter and the limit held no more, as a review measured. A
  flow is counted once: conntrack keeps a UDP flow nothing answered new for each of its datagrams,
  so the first one the meter lets through marks the flow (`ct mark`), which the sandbox cannot set,
  and the rest of it passes the meter. Tested on real packets: one flow sent its ten datagrams,
  and ten flows two of theirs, at two a second.
- A packet with an IPv6 routing header is refused in both directions, before anything else but
  the loopback and the window: it goes on to addresses past the one the rules match. Tested on a
  real packet with a segment routing header, which an unprivileged process can set.

### Revoking a destination

The scope's installations run one after another, two transactions being each atomic but not
ordered, and each replaces the scope's table alone. Closing waits for none of them, nor for a
helper: pasta ends at once, which leaves the namespace without a way out, and beside it a table of
its own goes in that stops all but the loopback, at a priority before the scope's. A packet must
pass every base chain of its hook, and no installation of a scope touches that table. An
installation that fails, or that the kernel does not hold as written, closes the network. Tested
with a client connecting every 50 ms: nothing passed from the moment of the close, while an nft
slowed down landed its installation after it, and while an nft hung installing the closing table;
an nft that installs something else than it was given, and one that cannot list the ruleset, both
close the network; traffic that fills the rate limit's sets does not.

The destinations are elements of interval sets, a network with a port for TCP and UDP, so the
rules stay few whatever the scope's size; networks inside others are left out, since an interval
set refuses overlaps. A transaction is limited by the host's socket buffer (`wmem_max`, 208 KiB
by default), which a user namespace cannot raise, so a scope is installed into a table of its
own, one of two that take turns: its sets are filled in as many transactions as they need, a
thousand elements each, while it has no chain on a hook and decides nothing; a last transaction,
small whatever the scope's size, adds its chains and deletes the table in force. A scope takes
effect whole or not at all: until that transaction, the one before is in force, entire. Tested
with three thousand networks, and with a failure in a transaction that adds elements and in the
one that puts the scope in force: at the failure, the namespace held the old scope alone, and the
network closed after it. The rate limit's counts start anew with each scope, in its new table.

The scope can shrink during a session: `/scope refresh` drops an address a name no longer resolves
to, and the window ends. A connection opened earlier must not outlive its authorization, as it
would under a rule that accepts established connections.

- A new scope takes effect in one nft transaction, which applies in full or not at all, however
  many transactions staged it.
- Since every packet is matched, a connection to a revoked destination is refused at its next
  packet, and the process gets a reset or an error, as for any destination out of scope. No
  process is killed for it, and the boundary does not depend on removing conntrack entries.
- The window is in the ruleset: `meta time < "<from>"` and `meta time >= "<until>"`, written in
  UTC with nft and the reference listed under `TZ=UTC`, rounded inward to the second nft keeps,
  refuse every packet outside it, in both directions, right after the loopback and before
  anything else, neighbour discovery included. The kernel compares with its wall clock, which the
  host's check reads too: a clock set back moves the end for both, though a session that saw the
  end stays ended. The kernel holds the end, whatever the host's process is doing: tested with the
  host's event loop held across the end, as when it is suspended or starved, nothing passed
  after it. No packet the sandbox sends after the end crosses the policy; bytes it wrote before,
  which pasta or the host's buffers hold, may still reach the target. Tested: every byte a
  connection wrote and the target received was written before the end, and no datagram of a
  flow opened before the end came in after it.
- The rest follows as soon as the host sees the end, within a second: the network closes for
  good (the closing table and pasta's end), the calls of tools that start commands are
  cancelled, and the jobs stopped, confirmed by the worker, which first waits for the jobs whose
  start it received before the stop; a worker that does not confirm within fifteen seconds is
  lost, with its jobs. The operator is told when it happens, and the model with its next
  request. From then on the session holds it as
  ended, even if the clock goes back. The broker refuses `bash` and `bash_background` outside
  the window, before any backend, for subagents too; glob, grep and git run fixed programs (git
  with every program a repository configures disabled) and stay available, as do reading,
  writing and `bash_jobs`. A process a command left behind loses the network with the rest: tested
  with one started with `setsid`, probing every 50 ms, a refresh racing the end, and an nft
  hanging on the closing table. The sandbox stays, so the files written in it can still be read.
- Before the window, the scope is installed whole and the kernel refuses everything; commands are
  refused. A window that ended before the start stops the session.

### Profiles without network

In `inspect` and `workspace`, the sandbox has its own network namespace with only the loopback
interface. Checked: a connection from inside fails at once with "Network is unreachable".

### User-mode networking

In `security`, passt's `pasta` connects the namespace to the host network once the rules are in
place. Without it the profile does not start. It runs in the namespaces' user namespace, by the
name `pasta`, which chooses its mode, with nothing forwarded in either direction or protocol
(`-t none -u none -T none -U none`) but the proxy's port when the scope has names reached through
it, as described below, without DHCP, and without mapping the gateway's address to
the host's loopback (`--no-map-gw`). What else pasta offers stays off by default and is not
turned on: forwarding DNS (`--dns-forward`), mapping a guest address to the host's
(`--map-guest-addr`), and a control socket (`-c`); DHCPv6 is off as well. What stays on: answering
neighbour discovery and router solicitations itself, and relaying ICMP echo. With `--netns`,
pasta joins the given namespace and makes no user namespace of its own to isolate itself in. A
pasta that ends leaves the namespace without a way out, and is not started again, nor taken for
ready when it ends right after configuring the namespace.

pasta reaches every address of the host but the one it copies into the namespace as the host
itself, the services listening there included: through docker0, a VPN or a second address. A
scope that authorizes such an address, as a laboratory on this machine does, reaches them, and the
session says so at the start with the addresses; a name that resolves to one is held to the rule
of internal addresses, below.
It relays ICMP echo with echo sockets of the host, which the host's ping group range must allow
the user: without it, TCP and UDP pass and echo requests get no reply. Tests with real
namespaces, and servers on the host's own address
(`tests/sandbox/network.test.ts`), establish:

- that TCP, UDP and ICMP echo to an authorized destination pass, and to any other are refused at
  once, the cloud metadata address and IPv6 included; IPv6 to an authorized destination is not
  tested yet, on hosts without an IPv6 route;
- that the host's loopback services are not reachable, through the host's address or the
  gateway's, even with the gateway authorized: without `--no-map-gw`, a service listening on the
  host's loopback answered through the gateway;
- that nothing of the namespace is forwarded to the host;
- that a TCP connection kept open stops at its next packet when its destination is revoked, and a
  new one is refused;
- that the sandbox's command never runs when the ruleset or pasta fails, or when the sandbox
  ends before it is released, and that a pasta that ends is reported and leaves the network
  closed.

### Names and DNS

The ruleset matches addresses, so the scope's host names are resolved by the host process when
the session starts, and the sandbox gets an `/etc/hosts` with them and no resolver. Without a
resolver, DNS cannot carry data out. Checked: Docker's embedded resolver answered any name from a
container whose output was otherwise blocked, which would leave that channel open.

An authorized address is not an authorized host name. A name that resolves to a shared address (a
CDN) authorizes every site served from that address, and the session shows at start the addresses
each name authorized. When the engagement requires the distinction, the address allowlist does not
provide it; the proxy does, as described below. A name handled by the proxy gets no rule of its
own, since a tool could otherwise reach the address without the proxy.

`/scope refresh` resolves the names again and replaces the ruleset, for targets whose addresses
change, as one logical step: every name is resolved and checked first, and a failure changes
nothing; then the new hosts file is written beside the old one; then the scope is put in force,
and only then the hosts file replaced by a rename, so a name never points at an address not yet
authorized. A rename that fails closes the network. Refreshes run one after another; a close does
not wait for them, and none puts anything in force after it. The sandbox's `/etc/hosts` is a link
into a directory of the host bound read-only, `/etc/nullrivet`, since a file bound by itself would
keep the one it was bound to after a rename; a new lookup reads the new one, and a program that
caches answers keeps its own, which the ruleset still holds to the scope.

### Names reached through the proxy

An entry of the engagement file marked `"via": "proxy"` authorizes a host name rather than its
addresses. The proxy runs on the host side and checks, for each connection, the name the
connection opens with:

- `CONNECT name:port`, then a TLS ClientHello whose server name is the same name: one host name in
  the server name extension, without Encrypted Client Hello (its code, those of its drafts, and that
  of the encrypted server name before it), which would hide the real name behind a front, and
  without a repeated extension. The ClientHello must arrive whole in the first record; clients send
  it so. Checked with curl 8.22: `CONNECT app.example:443`, then a ClientHello of 1571 bytes in one
  record, with the name and without ECH. Chromium sends an ECH extension of no use (GREASE) when a
  server has no ECH configuration, which the proxy cannot tell from one in use: a browser reaches a
  name of the proxy with ECH turned off, as Chromium is with
  `--disable-features=EncryptedClientHello`. A tunnel that does not start with TLS is refused: plain
  HTTP goes as a request to the proxy.
- a plain HTTP request in absolute form, `GET http://name[:port]/...`, with `Host` equal to the
  URL's host and port. The proxy sends the target one request on its connection, rebuilt: in origin
  form, with the client's fields but the hop-by-hop ones, then the `Host` and the `Content-Length`
  it validated and `Connection: close`. The body is exactly the bytes declared, counted inside each
  chunk; what follows, a pipelined request included, never reaches the target, and the client is
  not read further. What two parsers could read two ways is refused before anything is sent: lines
  not ending in CRLF, a folded field, two `Host` or two `Content-Length`, a length of more than ten
  digits or 1 GiB, `Transfer-Encoding`, `Upgrade`, an `Expect` other than `100-continue`, and a
  `Connection` naming anything but `close` and `keep-alive`, since dropping a field it names, as
  `Content-Length` or `Host`, would change how the target frames or routes what the proxy checked.
  `Expect: 100-continue` is passed on, and the answer relayed from the start, so the target's
  `100 Continue` reaches the client.

Then the proxy resolves the name with the host's resolver, and every address of the answer must be
on the public internet (the same ranges as for a name reached directly, and the addresses of this
host, read again each time), not denied, and not authorized directly on the port; one that is not
refuses the connection. It connects to the address it checked, never to the name, within ten
seconds, and only then answers `200`. No byte of the client's reaches the target before the
ClientHello or the request was checked. A refusal answers `403`, or `407` without the credential,
with the reason in the body, as `nullrivet proxy: other.example is not reached through the proxy`,
so that the model reads why.

**What it guarantees:** an entry through the proxy creates no direct authorization; every connection
through it is held to the name, the port and each address the name resolves to; and it goes to the
address checked. **What it guarantees on a condition:** a name of the proxy has no direct way while
no direct authorization of the scope in force covers its addresses. The start and every `/scope
refresh` refuse such an overlap, with the name's addresses of that moment, whether a cidr or a name
reached directly makes it: a name reached directly that moves onto the address of a name of the
proxy stops the refresh, and nothing changes. While a refresh puts a new scope in force, the proxy
holds the old one and the new one together, and refuses an address either authorizes directly; the
refresh reports the addresses the names of the proxy moved to as well. The proxy refuses a
connection to such an address, and the session warns once per name and address. What nothing
prevents: when the name of the proxy itself comes to resolve to an address the scope authorizes
directly, that address stays reached directly, as the operator authorized it. **What it does not
guarantee:** that every request inside a TLS tunnel is for the name. The proxy sees the name a
tunnel opens with, not the requests inside: HTTP/2 can send requests for another authority the
certificate covers on the same connection, and a server that routes by the inner `Host` serves
another site. Past the ClientHello, a tunnel is not inspected; intercepting TLS would need a
certificate authority in the sandbox and would alter the evidence. Nor does it guarantee that a
front behind the name does not route a plain request by a field of the client's: `Forwarded`,
`X-Forwarded-Host` and the like pass as the client sent them, since testing an application sends
them on purpose.

**How the sandbox reaches it.** The proxy listens on the host's loopback, on a port the system
chooses, and pasta forwards port 3128 of the sandbox's loopback to it (`-T 3128:<port>`). pasta
forwards to the host's loopback at the address the connection was for: measured, `127.0.0.2:3128`
and `[::1]:3128` in the sandbox reached a service of the host on `127.0.0.2` and `::1` at that port,
and the whole of 127.0.0.0/8 is local without configuration. pasta refuses a target address for
`-T`, so the ruleset holds the port: ahead of the loopback's accept, a packet to port 3128 that is
IPv6 or for another address than 127.0.0.1 is refused, and so is any outside the window. Tested on a
real namespace with pasta: the proxy is reached at 127.0.0.1 alone, no other service of the host on
its port, and nothing before the window. The sandbox's HTTP clients find it in `HTTP_PROXY`,
`HTTPS_PROXY` and their lower-case forms, `http://nullrivet:<credential>@127.0.0.1:3128`; `NO_PROXY`
lists the loopback, the names reached directly with their addresses, and the networks reached
directly, up to 16 KiB, past which the session warns of what it leaves out: an HTTP client sends
those to the proxy, which refuses them, unless told not to use it. Clients match a `NO_PROXY` name
against every name that ends with it, Python's requests with no dot between: a name reached directly
that a name of the proxy ends with, as `acme.example` for `api.acme.example`, is left out, its
addresses kept, and the session says so. A refresh gives the worker `NO_PROXY` anew, for the
commands started after it; those running keep the one they started with. The names of the proxy are
in neither the ruleset nor `/etc/hosts`, so the proxy is their only way.

**Its credential.** Every process of every user of the host reaches the host's loopback, so the
proxy takes only the credential the sandbox was given: 32 random bytes in hexadecimal, compared in
constant time, removed before anything is sent on. It reaches the sandbox's commands on the worker's
protocol (`worker.environment`), and the proxy on its standard input; it is in no command line
nullrivet makes, and in no environment but those of the sandbox's commands. Tested: with a session
running, no `/proc/*/cmdline` of the user's processes holds it, and no `/proc/*/environ` outside the
sandbox's PID namespace. A command that passes it as an argument, as a tool given `--proxy
"$HTTPS_PROXY"`, shows it in its own command line, which every user of the host can read where
`/proc` is mounted without `hidepid`: such a user could use the proxy, within the scope, until the
session ends. Every user of the host also reaches the proxy's port, and its 256 connections count
before the credential is checked: a local user who holds them blocks the proxy, ten seconds at a
time.

**Its process.** The proxy handles what the sandbox sends, so it runs apart from the host's process,
which holds the provider keys: the same program, started with `--nullrivet-network-proxy`, in a
Bubblewrap of its own and a scope of its own. The Bubblewrap shares the host's network, to resolve
and connect, and nothing else: `/usr` and its links, the files the resolver reads
(`/etc/resolv.conf` and its target, `hosts`, `nsswitch.conf`, `gai.conf`, `host.conf`,
`ld.so.cache`, `localtime`), its own program, `/proc`, `/dev` and an empty `/tmp`; no capability, no
user namespace, a session of its own. It is started through `env -i` with `PATH` and `TZ` alone. The
network namespace it shares holds the host's abstract Unix sockets too, the X server's among them,
which takes any local client: the sandbox's seccomp program applies, which refuses Unix sockets, and
the resolver does without them. Measured, under that program: it resolves as the host does, the same
answers for the same names, it reads the interfaces and connects over TCP, the X server's socket is
out of its reach, and its root holds neither the home directory nor the project. Its scope takes
`TasksMax=256` (the runtime starts threads by the number of processors: twenty at rest on twelve),
`MemoryMax` of 256 MiB, no swap, `CPUWeight=20` and `CPUQuota=50%`, a bound whatever else runs; its
memory comes out of the sandbox's three quarters, as pasta's does. The host checks that the process
it follows is Bubblewrap, in that scope, holding those limits, as for pasta; its stop ends its
input, which closes every connection, kills it after two seconds, and waits for the scope to be
empty. The host makes the proxy's listening socket and holds it, close-on-exec, for the whole
session; the proxy listens on a copy it is given. Owned by the proxy, the port would be freed by its
end while pasta still forwards the sandbox's connections there, and any program could take it, with
what the sandbox sends the proxy, its credential included. Held by the host, the port stays bound
until the proxy is stopped, which the session does only once the network is closed, pasta ended; a
connection meanwhile waits unanswered. Tested: with the proxy killed, another program could not bind
its port until the stop, and a connection got no answer. A proxy that ends by itself closes the
network, as pasta's end does, and the session says so; one that ends while the network is prepared
is seen right before the worker's release, which does not happen. A close, the end of the window and
a start given up close the network before they stop the proxy. The proxy reports each connection it
authorizes, once the ClientHello or the request was checked, and each it refuses, for the evidence
log of phase 5.

**Its window.** The kernel refuses the proxy's port outside the window, as any destination. The
connections the proxy opens leave from the host's network, which the sandbox's ruleset does not
see: the proxy checks the window when a connection arrives and before it relays each chunk, in
both directions, and the end of the window stops it with the network. A chunk already written to a
socket before the end may still reach the target, as for pasta. Tested: a tunnel that wrote the
time every 10 ms across the end of the window, and no time written after it reached the target.

**Its limits.** 256 connections at once, and as many lookups under way: a lookup cannot be
cancelled, so it counts until the resolver answers it, its client gone or not, past the ten seconds
the proxy waits for it, and a client gone before its connection to the target opened gets none. 16
KiB and ten seconds for a request head, read in time linear in its length however it is cut; ten
seconds for the resolver, for the connection to the target, all the addresses of a name together,
each checked against the scope again right before it is tried, and for the ClientHello; five minutes
without a byte in either direction closes a connection, one whose target keeps it open after a plain
request included. It relays with backpressure, pausing a side while the other's buffer is full. An
error accepting a connection, as when descriptors run out, costs that connection only, and is told.
The rate applies per address **on each way**: the kernel counts what the sandbox opens directly, and
the proxy what it opens, with a bucket per address of burst N refilled at N per second, 65,536
addresses at most, past which a new one is refused. An address authorized directly on one port and
through the proxy on another can receive both rates; one budget for both would need the proxy and
nft to share a count.

Wildcard names, WebSocket over plain HTTP, HTTP/2 to the proxy itself and the interception of TLS
are left out.

### Raw sockets

In its own network namespace, the sandbox can hold `CAP_NET_RAW` without affecting the host, but
user-mode networking translates TCP and UDP connections instead of forwarding packets, so SYN
scans and packet capture would not behave as on a real interface. Tools that need raw packets on
the wire belong in the virtual machine backend's laboratory profile, not in `security`.

## Engagement file

`--engagement <file>` gives the scope. JSON, like the session file, so no new parser is needed:

```json
{
  "name": "ACME external test",
  "scope": {
    "allow": [
      { "cidr": "203.0.113.0/28", "ports": [80, 443] },
      { "host": "app.acme.example", "ports": [443] }
    ],
    "deny": [{ "cidr": "203.0.113.5/32" }]
  },
  "window": { "from": "2026-11-20T09:00:00-03:00", "until": "2026-11-20T18:00:00-03:00" },
  "rate": { "newConnectionsPerSecond": 20 }
}
```

`"evidence": { "dir": "./evidence" }` adds the evidence log, described under Evidence log.

- `deny` wins over `allow`. A file without `allow` entries leaves the sandbox without network.
- `"via": "proxy"` on a host entry, as `{ "host": "app.acme.example", "ports": [443], "via":
  "proxy" }`, reaches that name through the proxy alone, as described under Names reached through
  the proxy. `via` takes only `"proxy"`, and only on a host: a cidr is reached directly. A name is
  reached one way: given once with `via` and once without, the file is refused. Such a name must
  resolve to public addresses the scope does not deny, every address of the answer, whatever a cidr
  of the file holds, since a cidr that authorized one would open the direct way to it; and none of
  its addresses may be authorized directly on one of its ports.
- `rate` applies per destination address.
- Outside `window`, the kernel refuses every packet and the broker refuses commands before they
  start. When the window ends, the network closes for good and the running commands and jobs are
  stopped, as described under Revoking a destination. Times take three decimals at most: a Date
  keeps milliseconds, and a finer fraction would move the start earlier. They lie between 1970 and
  2500: nft keeps a time in nanoseconds since 1970 in 64 bits, and wraps one out of that range in
  silence, so that a start in 1900 would read as one in 2484 and refuse everything.
- The scope reaches the model as a system prompt section stating the facts, so it can plan within
  them; nothing depends on the model reading it.
- The file is validated whole before anything starts, and an error names the item that failed, as
  `scope.allow[2].ports[0]: must be an integer from 1 to 65535`: an unknown field at any level; a
  key repeated in one object, of which JSON keeps the last in silence, so that a second `deny` would
  empty the first; a list given as `null`; an address or network that does not parse, or a network
  whose address has bits set past its prefix (`203.0.113.7/28`), never widened in silence; an entry
  with both `cidr` and `host`, or neither; a host name that is not one, or an address given as one,
  which includes a name whose last label is a number, as `10` or `0x7f.1`, since the resolver reads
  it as an IPv4 address; ports out of 1 to 65535 or an empty list (left out, every port); a time
  without its offset, so it does not depend on the machine's time zone, or one the calendar does not
  have, as a 30th of February or 24:00, which a date parser would move to the day after; a window
  that ends before it starts; a rate out of 1 to 1,000,000. `deny` takes networks only; `evidence`
  takes `dir` alone, a path; `name` may not hold control
  characters. The file is opened without blocking, and a FIFO or anything else that is not a regular
  file is refused; a file is read no further than its limit, whatever its size says. The file may
  hold 4 MiB and 1,000 host names, and the scope, once resolved, 20,000 destinations: each network
  or address once per port, or once without ports, and each denied network. Twenty thousand install
  in about a second; the ninety thousand that 4 MiB can hold would pass the time a helper has, ten
  seconds, and close the network.
- Host names are compared in lower case, without a final dot, and resolved by the host's resolver
  when the session starts, every address of both families, sixteen at a time, ten seconds at most
  each and thirty for all of them: the session waits no longer. A lookup cannot be cancelled, so
  one the resolver has not answered goes on in its thread after that, and its answer is dropped. A
  name that resolves to nothing, or not in time, stops the session, as a mistake in a target would;
  the error lists ten such names and counts the rest. Each address is authorized with its name's
  ports. The sandbox's `/etc/hosts` holds the loopback and each name with its addresses.
- A name that resolves to an address off the public internet stops the session too, unless a `cidr`
  of the file holds that address: in `deny`, or in `allow` with every port of the name, so that an
  answer cannot open ports the `cidr` does not. Each entry of a name is held to it with its own
  ports, a name given twice included. An authorization by name must not reach the inside by an
  answer of DNS, as a cloud's metadata service at `169.254.169.254`. These are the unspecified,
  private, shared, loopback, link-local, multicast and reserved ranges of IPv4; of IPv6 the
  unspecified and loopback addresses, the IPv4-compatible, IPv4-mapped, IPv4-translated, NAT64
  (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4, Teredo, unique local, site-local, link-local and
  multicast ranges, the ones that hold an IPv4 address included; and the addresses of this host. A
  private network is a common target: it is authorized by naming it.
- At the start, and in the system prompt, the scope is stated as facts the host validated and
  resolved: each network and name with its ports and, for a name, the addresses it authorized;
  what is denied; the rate; the window. The system prompt adds that every other destination is
  refused, that a refusal means out of scope, and that there is no DNS.

## Evidence log

With `"evidence": { "dir": "./evidence" }` in the engagement file, relative to the file's directory,
the host records the session in a JSON lines file there: what ran, and what the sandbox could reach
at each moment. Nothing is written without it. The worker never sees the evidence directory.

**What it shows, and what it does not.** Each entry holds the SHA-256 of the line before it. The
chain alone shows the material is consistent: an entry edited, removed or reordered breaks it. It
does not show that the file was not rewritten whole with its hashes worked out again; compared
with the final hash the operator is given at the end of the session, kept apart from the log, it
shows nothing changed since. It is not a proof of authenticity, which would need a signature or a
record kept by someone else.

**The directory.** It is opened one component at a time without following a link, the last made with
0700 when missing; one that exists must be the user's, not writable by group or others, and its real
path, read from the descriptor opened, must not be inside what the sandbox sees: the project, a
directory bound read-only, or the worker's own files, the source tree when it runs from source. Each
session writes `<UTC time>-<pid>.jsonl` (0600, created exclusively) and a directory of the same name
(0700) with `engagement.json`, the bytes of the engagement file the parser read, and the copies of
outputs. `engagement.json` and its directory entry are synced, then the log is created and its entry
synced, before the first entry is written.

**The entries.** `{ seq, at, prev, type, ... }`:

- `session.started`: the version and profile; the engagement file's path and the SHA-256 of the
  bytes parsed, which `engagement.json` holds; the resolved scope and the SHA-256 of its canonical
  form; the names with their addresses, those of the proxy, and the warnings. Written and synced
  before the worker exists, or the session does not start.
- `tool.started`: written and synced before the call is dispatched, or it is not; then the broker
  checks again, with nothing awaited between the checks and the send, that the window is open and
  the backend there, and a call refused then ends as `tool.refused` with the same id. It holds the
  call's `callId`, unique in the session, the provider's id, the agent (`main` or a subagent's id),
  the tool, the arguments with credentials taken out, the directory, and whether the tool runs on
  the host. The broker records every call, those of the host and of subagents included.
- `tool.finished`: whether the call failed, its result with the host's secrets taken out, its exit
  code, signal and termination, and its outputs.
- `tool.refused`: a call the broker did not dispatch, with why: the window, the policy, a lost
  backend, the evidence log. With `started`, after its start was written.
- `job.started`: a background job with the `callId` of the call that started it, which the worker
  reports on the protocol. It is the observation of a start already under way: the durable intent
  is the start of the `bash_background` call. `job.finished`: its status, exit code and log.
  Recorded as the facts arrive, apart from what the model is told of them.
- `scope.refreshed`, with the changes, the SHA-256 of the scope before and after, and the scope
  in force after; `scope.refresh.failed`; `network.stopped`, with why; `window.ended`;
  `proxy.authorized` and `proxy.refused`, twenty refusals a second one by one and the rest counted
  in `proxy.refused.omitted`, written each second and at the end; `session.ended`, with the calls
  started without an outcome and the jobs without an end.

`session.started`, `tool.started`, `job.started`, `tool.refused`, the scope's, the network's and
the window's entries and `session.ended` are synced; outcomes and the proxy's decisions are left to
the system, and a loss of power shows as an operation without an outcome.

**Outputs: received, saved, preserved.** With an evidence log, the worker hashes, as a command's
output comes, every byte received, before any limit stops the saving, and every byte saved to parts;
without one it hashes nothing. The result carries these, and the parts, in a field of its own the
protocol checks, never read from its text. These are the bytes the capture received, which a timeout
can cut short of what the command wrote. An output the result holds whole is recorded `inline`: its
text, the host's secrets taken out, is the record. A reduced one was saved to parts in the sandbox's
`/tmp`, held to its 1 GiB, which the host copies, reading it through the root of the sandbox's first
process (`/proc/<pid>/root`, that process checked by its start to be the sandbox's still):

- a part is taken only by a path of the output code's form, resolved with `openat2` as if that root
  were the root directory, so that neither `..` nor an absolute path leaves it, through no symbolic
  link at all, without blocking, as a regular file no larger than a part, read no further than that
  plus a byte, in chunks without blocking the session. Checked: a link at the end of the path, or in
  a directory of it, and `..`, were refused;
- it must still be the same file, of the same size, once copied, and the copy and the directory
  are synced before the entry that names the copy is written;
- the record gives `receivedBytes`, `savedBytes`, `copiedBytes` and their SHA-256, whether all
  that came was saved (`complete`), and whether the copy is what the worker saved
  (`matchesSaved`), a truncated output included; null only when nothing was copied.

A command can rewrite or replace a part before it is copied: the copy is then refused, or not what
the worker saved, which the record says and the operator is told, never taken as preserved. Tested:
a job that replaced each part with a link left the output recorded as not preserved. The copies of
a session take 2 GiB at most; past them an output is recorded as not preserved. At the end of the
session, while the sandbox still runs, the jobs are stopped, so that their end and their log are
recorded, and the copies under way are waited for, ten seconds at most; those that did not end are
recorded. The final hash is shown once the session is closed, on the standard error of an
interactive one, whose terminal is restored by then.

**Credentials.** In the arguments, the values of the secrets the host holds go by exact match, of
eight characters or more: the providers' keys, the proxy's credential, and the password of the
proxy the host goes through; and by pattern, best effort: `Authorization` and
`Proxy-Authorization` values, passwords in URLs, the values of `--password`, `--passwd`, `--token`,
`--api-key`, `--apikey`, `--secret` and `--client-secret`, curl's `-u user:password`, and
`password`, `token` and `api_key` in query strings. A marker names what was removed. In results,
the host's secrets go by exact match only, and the copies are kept as produced, since they are the
findings: the evidence directory is to be handled as sensitive.

**When it cannot be written.** A write is retried until the whole line is written; the sequence and
the hash advance only after. On a failure, of a write, a sync, or the log's limit of 1 GiB, the log
writes nothing more and throws nothing, and the session, told once, stops by ways that do not depend
on it: the network closes, every call is refused (`evidence.failed`), since its start cannot be
written, the jobs stop, and the operator is told, with the hash of the last line written. A session
with an evidence log does not go on unrecorded.

**Checking it.** `nullrivet --verify-evidence <file> [--expected-hash <sha256>]` works out the chain
and the sequence again, checks the transitions (an outcome without a start, an id used twice, a job
ended twice, an entry after the end, a job of an unknown call), the copy of the engagement file, and
each copy named, looked for only in the directory beside the log, by a name of the form the host
gives, never through a link. It exits 0 when the session is complete; 1 when it is corrupted, or its
final hash is not the one expected, naming the first entry that is; and 4 when it is consistent but
incomplete, with a line cut short, no end, operations without an outcome, or outputs not saved or
preserved whole, 4 when it is consistent but incomplete, apart from the CLI's other codes, so that a
script tells it from a mistyped option. Without `--expected-hash`, it says that only the consistency
was checked. Tested: with the host killed during a command, the log keeps the call, which the
verifier reports without an outcome.

Individual packets are not recorded: the log shows what the sandbox could reach, what the proxy
decided, and what the commands did.

## Resources

The sandbox's resources are limited, for every profile, so that a command that exhausts them, by
design or by mistake, leaves the host usable. The limits protect the host's stability, not the
boundary: unlike the file and network isolation, which stop the session when unavailable, a limit
that cannot be put in force is a warning, except in the `security` profile, which runs tools
against targets and does not start without the cgroup limits.

With the user's service manager, the sandbox runs in a scope of its own, made by
`systemd-run --user --scope`: a cgroup that holds the whole sandbox, whatever namespaces it makes.

- `TasksMax=4096`: processes and threads together.
- `MemoryMax`: three quarters of the host's memory, or of the smallest memory limit of the cgroups
  above the scope when that is less, so that the rest is left to what shares that limit; rounded
  down to 64 KiB so that the kernel holds it as given.
- `MemorySwapMax=0`, so that the sandbox cannot push the host into swap.
- `CPUWeight=20`, against a default of 100. It is not a cap: the sandbox slows down only when the
  host needs the processors, and takes them all otherwise.
- `OOMPolicy=continue`: when the sandbox passes its memory, the kernel kills its largest process,
  usually the command that took the memory, and the manager leaves the rest running. With `stop`,
  the default of `DefaultOOMPolicy=`, the manager ends the whole scope a moment after the kill.
  When the largest process is the worker, the session reports its sandbox lost, as for any end of
  the worker.
- `--expand-environment=no`: otherwise systemd-run replaces `${...}` in the sandbox's command line
  with values of its own environment, before the sandbox exists, in paths and in the values of the
  sandbox's environment alike.

Scopes took `OOMPolicy=` in systemd 253, and systemd-run `--expand-environment` in 254. An older
manager refuses them, and does neither of what they prevent, so the scope is made without what the
manager refuses, and with the rest.

Before the first sandbox of a session, a scope made the same way reads its limits back from its
cgroup, `memory.max`, `memory.swap.max`, `pids.max` and `cpu.weight`, with the memory limit of each
cgroup above it: a manager that does not delegate a controller accepts the property and holds
nothing, and only the values as the kernel holds them show it, or the file's absence. When a
cgroup above has less memory than the host, a second scope reads back the lowered limit. A kernel
that does not account swap to cgroups has no `memory.swap.max`: no swap limit is possible there,
and the session says so when the host has swap. The check takes about fifty milliseconds, and the
manager's answer is awaited five seconds at most. systemd-run reaches the manager by
`XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`, given to it alone: it runs the sandbox through
`env -i` with the sandbox's own environment, since Bubblewrap's first process keeps the
environment it was started with, readable in `/proc/1/environ`, and systemd-run adds
`INVOCATION_ID` besides. Tested: none of the three is there. A helper's memory in a scope of its
own, as pasta's, comes out of the sandbox's whatever limits it, a cgroup above included.

Without the manager, as over SSH without lingering or in a container, only the processes are
limited, by `prlimit --nproc` around Bubblewrap. RLIMIT_NPROC counts every task of the user, the
host's included, whatever user namespace they run in: a limit of 64 with 700 tasks running lets the
sandbox start nothing. Each sandbox's is therefore the user's count when it starts plus 4096,
counted again for the sandbox that follows an `/apply`, never above the user's own limit, and soft
and hard alike so that nothing inside can raise it. It is a partial protection: other processes of
the user that start meanwhile take from the same budget, and memory and CPU are not limited. The
session says so when it starts.

systemd-run and prlimit are taken from system directories only, as Bubblewrap is, and run the
sandbox in place of themselves, with the descriptors the worker's protocol uses.

In the `security` profile, pasta runs in a scope of its own, `nullrivet-pasta-<pid>-<n>.scope`,
made with what the manager accepted for the sandbox's: `TasksMax=8`, `MemoryMax` of 256 MiB, no
swap and `CPUWeight=20`, so that traffic to and from the targets costs it what these allow. Its
256 MiB come out of the sandbox's three quarters: a budget per session, not a limit the kernel
holds on the two together, which several sessions at once would need a parent cgroup for. Once
pasta is ready, the host checks that the process it follows is pasta itself (`pasta`, or `passt`
and `passt.avx2`, which it runs again as), in that scope, which holds those limits; a wrapper that
did not run it in place, or a scope that does not hold them, ends the start. Its stop ends pasta,
then kills what is left of its scope with `cgroup.kill` and waits for `populated 0` in its
`cgroup.events`, or for the scope's removal, five seconds at most: a stop that cannot confirm it
fails, and the session says so. The proxy of the names reached through it has a scope of its own
too, `nullrivet-proxy-<pid>-<n>.scope`, with the limits given under Names reached through the
proxy. The network helpers, nsenter and nft, live for one command each,
under a ten-second timeout, and run outside it, each in a process group of its own: at its timeout,
or when the preparation is given up, the group is killed whole, so that nothing a helper started
holds its output open. A start given up within its thirty seconds undoes what it made, and says
what it could not undo.

Tested: a process that forks under a limit of 64 tasks stops below it, in a cgroup and by
RLIMIT_NPROC; a process that passes 256 MiB is killed, and the sandbox still runs a second later;
managers that refuse `--expand-environment` or `OOMPolicy=`, that refuse a limit, or that accept
the memory or swap limit without holding it; a slice of one gigabyte above the scope, which lowers
its memory to three quarters of it; `${...}` passed through as written; a command of a session's
sandbox, seen from the host, is in a scope with the limits and no swap, or has RLIMIT_NPROC soft and
hard alike.

## Lifecycle

- The sandbox starts with the session, before the model is resolved, so a session that cannot
  have one stops with the reason before any request leaves the machine. It lives until exit or
  until a ChangeSet is applied, after which the next tool call starts a new one. Background jobs
  and saved output need a shared, lasting environment; one sandbox per call would lose both.
- Bubblewrap keeps a minimal reaper of its own as PID 1 of the sandbox's PID namespace, so the
  worker is not PID 1. When the sandbox's main process ends, the namespace ends with every
  process in it. Checked: a process left behind that ignores SIGTERM and writes to `/dev/null` did
  not survive the end of the sandbox. `--die-with-parent` ties the sandbox to the nullrivet process.
  Tested: a process left with `setsid` that ignores SIGTERM ends when the session closes, when
  nullrivet gets SIGTERM or SIGKILL, and when a command kills the worker.
- Timeouts and aborts reach the worker as `tool.cancel`, and the worker signals the command's
  process group inside the namespace, as `src/tools/process.ts` does today.
- `/clear` keeps the sandbox, as it keeps background jobs; exit destroys it.

## Platforms

- **Linux:** Bubblewrap 0.8.0 or later, for `--disable-userns`, and 0.10.0 or later for the
  overlays the `workspace` and `security` profiles mount (`--overlay-src`, with `--overlay` and
  `--tmp-overlay`), unprivileged user namespaces enabled, and for `security` nftables, passt, a
  kernel with `meta time` and the user's service manager. Some distributions restrict
  unprivileged user namespaces through AppArmor; the check at start says which requirement is
  missing.
- Bubblewrap sets the boundary up from outside it, with the user's access, so it is never looked
  up on `PATH`, where an entry can be a directory the project controls, such as its
  `node_modules/.bin`. It is taken from `/usr/bin`, `/usr/local/bin`, `/bin` or NixOS's
  `/run/current-system/sw/bin`, and only when the file and every directory above it are owned by
  root and writable by no one else (a sticky directory excepted), and it is run by its real
  path.
- **macOS:** no Bubblewrap. The profiles stop with that reason until the virtual machine backend
  (Lima, or Apple's container on macOS 26 and later). `sandbox-exec` is deprecated and not used.
- **Docker** is not a backend in this plan: it needs a daemon and an image, and the same namespace
  and nftables design applies without it. The container tests above served to check that design.

## Phases

0. **Checks.** Bun inside the sandbox, the end of the PID namespace, rootless nftables, nested user
   namespaces, `no_new_privs`, `openat2` through `bun:ffi`, `statfs` and `O_NOFOLLOW` in Bun, and
   the seccomp program with Bun, its spawning and worker threads (done). pasta with the firewall,
   and ruleset changes from outside a running sandbox: the tests listed under User-mode
   networking.
1. **ToolBroker** (done). Every tool call goes through the broker and the in-process backend. No
   change in behavior; existing tests pass with only the backend added to their setup.
2. **Worker and `inspect`** (2a, done). The worker protocol, tested first with the worker started
   directly and with a worker that breaks the protocol, then inside Bubblewrap with no network.
   With it:
   - the broker, not the backend, decides which tools run on the host, from a declaration on each
     tool (`runsOnHost`): a worker receives only a tool's name, and has no `delegate`;
   - under a profile, `delegate` and the `AGENTS.md` discovery consider only paths inside the
     project, before and after their links are resolved;
   - the backend is a required option of the agent, chosen by the command line, so a session with
     a profile cannot run its tools in process by omission;
   - routing tests: `delegate` runs in process, every other tool and the subagents' calls on the
     session backend, and a lost backend is never replaced by the in-process one.
2b. **Background jobs in the worker** (done). The worker is the source of truth for the
   processes, their logs and their state; `bash_jobs` and `bash_kill` are forwarded to it like any
   other call. The host keeps only a projection of what the agent loop and the interface read at
   once, fed by facts with sequence numbers. Two parties never control the same processes.
3. **`workspace`.** The ChangeSet, with the reference time, the stop before reading and the
   descriptor-based resolution, specified and tested on its own before the overlay is wired in.
   3a, the ChangeSet on its own, is done; 3b, the one-shot task with `--apply`, is done; 3c, the
   interactive session, with its commands to review and apply, is done; 3d, the documentation and
   an adversarial review, is done.
4. **`security`.** Only after the network isolation tests pass. Its steps:
   1. the network layer with its tests (the namespaces, the ruleset, pasta, revocation), done;
   2. the engagement file: its validation, the resolution of its names, the sandbox's hosts file,
      and the scope stated at the start and in the system prompt, done;
   3. the resource limits described under Resources, for every profile, done: the `security`
      profile runs tools against targets, and a sandbox that isolates files and network would
      otherwise share the host's CPU, memory and process table;
   4. the profile end to end, done: `--sandbox security --engagement`, the hosts file, the window
      in the kernel, `/scope refresh`, pasta in a scope of its own, and the cgroup limits
      required;
   5. the documentation and an adversarial review, done: four reviews, of the network's guarantees,
      of the host's orchestration and of what a command inside can do, found the rate limit
      failing open once its meter was full, ports an answer of DNS could open, the git tool
      running a program the repository named for signatures, and the gaps listed in this
      document, all fixed and tested.

   4b: the proxy that authorizes names, done, in the order two reviews of its plan set: the parsers
   of the ClientHello and of the request head; the proxy, tested in the host's process; the
   engagement file's `via` and the rule against overlaps, at the start and on a refresh; the
   credential on the worker's protocol, before anything was wired to the launch; the proxy's
   process in its Bubblewrap and scope, the forwarded port and its rules; the session. Then two
   reviews, of the proxy and of its place in the sandbox, found a port the proxy left that pasta
   still led to, the abstract Unix sockets its network shares, a connection opened for a client
   gone during its lookup, and the gaps listed in this document, all fixed and tested.
5. **Evidence log**, done, in the order three reviews of its plan set: the writer, the removal of
   credentials and the verifier; the directory opened by descriptor and the session's and the
   network's entries; the broker's record of each call, its start written before it is
   dispatched, and the outputs' hashes in the worker; the shared output directory and the copies;
   `--verify-evidence`.
6. **Virtual machine backend** for macOS and for raw-socket laboratories.

Each phase ends with tests that try to cross the boundary: read `~/.ssh` and the host's processes
through `/proc`, through every file tool and through `bash`; write outside the project; apply a
ChangeSet with a link that leaves the project, or with a project path that is a symbolic link;
leave a symbolic link to a host file or a FIFO in the saved output directory; connect out of scope
by TCP, UDP and ICMP, over IPv4 and IPv6; keep a connection open across `/scope refresh` and the
end of the window; resolve a name; change the ruleset; create a user namespace; leave a process
behind; read a provider key from the environment; send the host a malformed or oversized message.

## Decisions

1. **Confirmation in `workspace`:** accepted, as the only approval. Applying the ChangeSet is
   confirmed by the operator.
2. **An approval mode for intrusive actions in scope:** not added. The network boundary does not
   depend on it; it can be reconsidered after phase 4.
3. **passt as a requirement of `security`:** accepted. A namespace whose only way out is an HTTP
   proxy cannot carry the non-HTTP tools security work needs.
4. **macOS:** no sandbox profile until the virtual machine backend.
5. **Background jobs in a sandbox:** in the worker, with a projection on the host (phase 2b). The
   host keeps no job registry of its own in a sandboxed session.
