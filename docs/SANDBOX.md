# Sandbox and engagement scope

Status: phases 1 and 2 are implemented: the ToolBroker, and the worker with the `inspect` profile
(`--sandbox inspect`), background jobs included. The later phases are not. The document records the
design, the facts checked on a Linux host while preparing it, and the decisions taken on it.

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
  with `--session`. The evidence log (phase 5) is off unless an engagement file names its
  directory, and the host writes it.
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
| `security` | Working directory in an overlay; system read-only; tmpfs home | Only the engagement scope | Authorized testing, laboratories |

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
  | { type: 'worker.shutdown' };

type WorkerToHost =
  | { type: 'worker.ready'; protocol: 1; tools: string[] }
  | { type: 'tool.result'; id: string; result: ToolResult }
  | { type: 'worker.error'; message: string }
  | { type: 'job.started'; jobId: string }
  | { type: 'job.event'; seq: number; event: JobEvent }
  | { type: 'job.shown'; jobId: string };
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

The fields of an event become text of a runtime note, which the model trusts, so the host checks
or reduces them: log parts must be log files of the sandbox's `/tmp`, at most 8; sizes, times and
exit codes are bounded integers; a signal must be one the system knows; a stop reason or an
interruption keeps only its kind, without the system message after it, and unknown text becomes a
generic kind. Text a correct worker can produce when a command interferes, such as a log directory
made again or a full disk, never stops the sandbox.

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
  the host saves subagent reports is bound read-only at its path. The writable directory shared
  with the host, described under Files the worker writes, comes with its first consumer, the
  evidence log (phase 5).
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
- `socket` of any family but `AF_INET`, `AF_INET6` and `AF_NETLINK` with `NETLINK_ROUTE`, which
  the network namespace isolates. Others are not all isolated by it: with `AF_UNIX`, a read-only
  bind does not stop a connection to a host socket inside the project, including one created
  after the start; `AF_VSOCK` can reach the hypervisor or other machines when vsock namespaces are
  global, the kernel's default. Families are allowed by name, so one the kernel adds later is
  denied. `socketpair` stays allowed, since it only makes a pair connected to itself.
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
so an abnormal exit leaves nothing on disk, and what remains is removed when the user's last session
ends or at reboot. The variable's value is not taken on trust: the host checks with `statfs` that
the directory is a tmpfs, and that it belongs to the user with mode 0700. Checked: `statfs` in Bun
reported tmpfs (`0x1021994`) for the runtime directory and another type for `/home`. Without a
directory that passes, the profiles that need one stop, unless the operator passes
`--sandbox-storage <dir>` to accept a directory on disk.

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

- **Baseline.** Before the worker starts, the host records in memory the metadata of every entry
  under the project: device, inode, type, size, and modification and change times. The files the
  session will change are not known yet, so the record covers the whole project; hashing every
  file would serve the same purpose, at a cost proportional to the project's size.
- **Stopping the sandbox.** Applying starts by ending the sandbox, with its commands and background
  jobs, which the confirmation lists. The broker holds tool calls until the application ends, and
  the next call starts a new sandbox over the updated project. With no process left that can write
  the upper layer, it cannot change between validation and writing. overlayfs requires the stop as
  well: changing a lower layer while the overlay is mounted has undefined behavior.
- **Snapshot.** The ChangeSet walks the upper layer once, without following its symbolic links,
  and records each entry: type, mode and, for a regular file, its SHA-256. Regular files are
  additions or modifications; whiteouts are deletions; an opaque directory replaces the one below.
  A rename appears as a deletion and an addition, and is applied as such. The diff is built from
  the snapshot, and each file is checked against its hash again when written, so what is written
  is what was shown.
- **Validation, before anything is written.** Every target path is resolved from a descriptor of
  the project directory, beneath it and without following a symbolic link in any component
  (`openat2` with `RESOLVE_BENEATH` and `RESOLVE_NO_SYMLINKS`), so a path cannot lead elsewhere
  between the check and the write. A target that is a symbolic link in the project and a
  directory in the snapshot is replaced, not followed. Symbolic links in the snapshot whose target
  leaves the project, hard links, devices, FIFOs and sockets are refused. Modes are kept,
  set-user-ID and set-group-ID bits dropped. Checked: through `bun:ffi`, `openat2` refused a
  component that is a symbolic link with `ELOOP` and a path that leaves the directory with
  `EXDEV`. The file API Bun provides opens by path only, so these calls go through `bun:ffi`.
- **Conflicts.** A target whose metadata differs from the baseline, or that appeared or
  disappeared since, changed on the host during the session: a conflict, shown and not applied.
  Equal metadata does not prove equal content: timestamps have a granularity, and a file changed
  twice within one tick, keeping its size, keeps its metadata. As Git does for racily clean
  entries, files whose change time is not earlier than the moment the baseline is taken are also
  hashed then, and compared by content. The check prevents accidental overwrites; it does not
  detect every concurrent change.
- **Application.** The validated set is shown as a diff with the existing diff rendering. On
  confirmation, files are written one by one with the atomic write `write_file` uses, through the
  same descriptor-based resolution. Stopping the sandbox ends the worker's processes, not the
  host's: an editor or a build can still change a file during the application, so the conflict
  check runs again just before each file is replaced. The application is atomic per file, not
  across the project; a failure or a new conflict stops it and reports what was applied and what
  was not. Applied entries leave the upper layer. The others stay with their original
  baseline, so a conflict is still a conflict in the next sandbox, and can be retried or
  discarded.
- **Discarding** removes the upper layer.

While the sandbox runs, the overlay does not promise a consistent view of files the operator edits
on the host. Such edits are found as conflicts when the ChangeSet is applied.

`security` uses the same overlay with its upper layer kept in memory (`--tmp-overlay`): its writes
are not meant to be applied anywhere, and they are discarded at exit. What outlasts the session is
the evidence log, when the engagement file enables it.

## Network scope

### Setup order

The namespaces are configured by helper processes the host starts for that purpose; the host
process never joins them, so the agent loop and the providers keep the host's network.

1. Bubblewrap creates the sandbox's user and network namespaces, reports the sandbox's PID
   (`--info-fd`) and waits (`--block-fd`) before starting the worker.
2. A helper enters those namespaces from outside the sandbox and installs the ruleset; only then
   does pasta connect the network namespace to the outside. The user that created a user namespace
   holds every capability in it from the parent namespace, so the helper needs no privilege on the
   host, and no process inside the sandbox keeps `CAP_NET_ADMIN`. Later ruleset changes use the
   same path.
3. The worker starts with every capability dropped from its bounding set, `no_new_privs`, and
   `--disable-userns`, so it can neither change the ruleset nor create a user namespace in which
   it would hold capabilities again.

Checked: rules install without root in a user-owned namespace; with the capabilities dropped,
`nft flush ruleset` fails with "Operation not permitted"; Bubblewrap sets `no_new_privs` by default
(`NoNewPrivs: 1`); a sandbox may create a nested user namespace by default, and cannot with
`--disable-userns`. A Docker container without `NET_ADMIN` behaved the same, with
`ip route del default` refused.

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
  keyed by destination address. A plain `limit rate` counts packets, which is not what the
  engagement file promises.

### Revoking a destination

The scope can shrink during a session: `/scope refresh` drops an address a name no longer resolves
to, and the window ends. A connection opened earlier must not outlive its authorization, as it
would under a rule that accepts established connections.

- The helper replaces the ruleset in one `nft -f` transaction, which applies in full or not at all.
- Since every packet is matched, a connection to a revoked destination is refused at its next
  packet, and the process gets a reset or an error, as for any destination out of scope. No
  process is killed for it, and the boundary does not depend on removing conntrack entries.
- Before the window starts and after it ends, the ruleset authorizes nothing. At its end, the
  ruleset is replaced first; then the broker cancels the running command and stops the jobs. A
  process a command left behind loses the network with the rest. The sandbox stays, so the files
  written in it can still be read.

### Profiles without network

In `inspect` and `workspace`, the sandbox has its own network namespace with only the loopback
interface. Checked: a connection from inside fails at once with "Network is unreachable".

### User-mode networking

In `security`, passt's `pasta` connects the namespace to the host network once the rules are in
place. Without it the profile does not start. Before phase 4, tests establish:

- that the host's loopback services are not reachable through pasta's address mapping, with the
  mapping disabled (`--no-map-gw`) and checked;
- that TCP, UDP and ICMP to an authorized destination pass, and to any other do not, in both
  address families;
- that a helper outside the sandbox can replace the ruleset of a running sandbox;
- that a TCP connection kept open stops at its next packet when `/scope refresh` removes its
  destination and when the window ends, and that a connection opened just before a change behaves
  as the new ruleset says.

### Names and DNS

The ruleset matches addresses, so the scope's host names are resolved by the host process when
the session starts, and the sandbox gets an `/etc/hosts` with them and no resolver. Without a
resolver, DNS cannot carry data out. Checked: Docker's embedded resolver answered any name from a
container whose output was otherwise blocked, which would leave that channel open.

An authorized address is not an authorized host name. A name that resolves to a shared address (a
CDN) authorizes every site served from that address, and the session shows at start the addresses
each name authorized. When the engagement requires the distinction, the address allowlist does not
provide it, and phase 4b does: an allowlisting HTTP proxy on the host, matched on the requested
host name. A name handled by the proxy gets no rule of its own, since a tool could otherwise reach
the address without the proxy.

`/scope refresh` resolves the names again and replaces the ruleset, for targets whose addresses
change.

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
  "rate": { "newConnectionsPerSecond": 20 },
  "evidence": { "dir": "./evidence" }
}
```

- `deny` wins over `allow`. A file without `allow` entries leaves the sandbox without network.
- `rate` applies per destination address.
- Outside `window`, the ruleset authorizes nothing and the broker refuses commands before they
  start. When the window ends, the running command and jobs are stopped, as described under
  Revoking a destination.
- The scope reaches the model as a system prompt section stating the facts, so it can plan within
  them; nothing depends on the model reading it.
- The file is validated like a session file: unknown fields, malformed addresses and a window
  that ends before it starts are errors that stop the session.

## Evidence log

With `evidence.dir` set, the host records each tool call in a JSON lines file there, from what
passes through the broker: time, tool, arguments, working directory, exit code, the SHA-256 of each
output stream, and copies of the saved output, read from the session's saved output directory as
described under Files the worker writes. The worker has no access to the evidence directory.
Nothing is written when it is not set.

Before an entry is written, credentials in the arguments are replaced by a marker that names what
was removed: the values of the secrets the host holds, such as provider keys, by exact match, and
by pattern `Authorization` headers, passwords in URLs and the values of password and token options.
The pattern part is best effort, so the evidence directory is still to be handled as sensitive.
Output copies are kept as produced, since they are the findings.

Each entry holds the hash of the previous one, which detects an entry removed or edited by
accident. It does not prove integrity against someone who rewrites the whole file and recomputes
the chain; that needs an anchor kept elsewhere, such as the final hash shown to the operator at
the end of the session, or a signature.

## Resources

CPU, memory and process limits use cgroups when the user's systemd manager can create a scope
(`systemd-run --user --scope`), and `prlimit` otherwise. Unlike the file and network isolation,
which stop the session when unavailable, a missing limit is a warning: limits protect stability,
not the boundary.

Not implemented yet. In phase 2a only the sizes of the sandbox's `/tmp` and home are limited:
`inspect` isolates files, network, processes and credentials, and gives no protection against a
command that exhausts CPU, memory or the process table. Code meant to do that waits for these
limits or for the virtual machine backend.

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

- **Linux:** Bubblewrap 0.8.0 or later, for `--disable-userns`, with overlay support for the
  later profiles (`--overlay-src`, `--tmp-overlay`; checked on 0.13), unprivileged user
  namespaces enabled, nftables, and passt for `security`. Some distributions restrict
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
3. **`workspace`.** The ChangeSet, with the baseline, the stop before reading and the
   descriptor-based resolution, specified and tested on its own before the overlay is wired in.
4. **`security`.** Only after the network isolation tests pass: the engagement file, the ruleset,
   revocation, pasta, the hosts file, `/scope refresh` and the window. 4b: the allowlisting HTTP
   proxy.
5. **Evidence log**, written by the host, with credentials removed from the arguments.
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
