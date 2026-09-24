# Architecture

> The confirmed target is fully unattended local development with an independent remote/main boundary. Automatic mode implements the local editing, testing, repair, acceptance, Review and local-commit loop; unresolved work becomes a parked candidate. Legacy human/takeover APIs remain compatibility controls only. See [autonomy-target.md](autonomy-target.md).

## Control boundary

Pi owns the `Supervisor`. The supervisor owns the task state machine, event log,
turn budget, policy decision and independent verifier. `WorkerAdapter` owns only
process lifecycle and transport details.

```text
Pi extension
    |
    v
Supervisor -> Policy Gate -> WorkerAdapter -> child process
    |
    +------> EventLog (JSONL)
    +------> Independent Verifier
```

The Worker cannot advance a task directly to `completed`. A clean worker exit
moves the supervisor to `verifying`; only successful acceptance, independent Review,
complete evidence and the configured local-commit boundary move it to `completed`.
An unresolvable automatic path moves it to `blocked`, never to a publishable result.

The extension keeps a registry of independent task sessions. Each session has
its own Supervisor, watchdog, state machine and Worker handle, while the event
log is shared and protected by an inter-process lock. Once a task starts, the
local development loop is intended to run unattended: the Worker may edit, test,
repair and commit locally. Supervisor-managed remote push and merge into `main`/an integration branch
requests remain outside the local loop and cross an independent boundary; custom/nested tools require
that boundary to enforce the same rule independently. Concurrent active sessions must use non-overlapping canonical working
directories/worktrees; same-cwd and parent/child cwd starts are rejected before
spawn, including concurrent starts, to prevent uncoordinated edits. Pending starts
are also awaited during Pi shutdown.

### Multi-worker boundary and roadmap

The current implementation supports multiple **independent** task sessions, not
coordinated shared-worktree editing. Every active session must own a
non-overlapping canonical cwd/worktree and has an isolated Supervisor,
watchdog, Worker handle and acceptance/review loop. The shared EventLog is only
an audit stream; it is not a collaboration or authorization channel.

A future multi-worker scheduler must introduce an explicit parent/child task
graph, roles, dependencies, bounded concurrency and structured handoff
artifacts. Child Workers must communicate through validated evidence and event
references rather than another Worker's control channel. Each child is accepted
independently; the parent can complete only after aggregate acceptance and
independent Review. Integration and conflict resolution remain separate from the local development
loop. The Worker cannot push remotely or merge into `main`/an integration branch;
the independent integration boundary may combine read-only review, CI and an
authorized integration action in a separate integration worktree. Rejection or
shutdown leaves the candidate local.

Recovery and shutdown must be graph-aware: a parent with an unknown child state
cannot complete, cancellation must propagate within a bounded budget, and Pi
shutdown must leave every child either cleanup-verified or explicitly
recoverable. This work is scheduled after single-worker stability and session
recovery, not by relaxing the current cwd lease rule.

## MVP transport

`ProcessWorkerAdapter` uses `node:child_process.spawn` with:

- `shell: false` (the default and intentionally not overridden);
- a detached process group for pause/resume/kill control;
- separate stdout/stderr capture;
- idempotency keys for messages;
- no session-resume claim.

Worker capabilities distinguish two different properties. `persistentSession` means that a
Worker can remain usable across a Pi disconnect/restart and can be explicitly re-adopted;
`repairableSession` means that the current Supervisor can send another bounded turn after a
verification/review result. Claude JSONL is repairable while attached but does not claim
cross-restart resume. Tmux is both repairable and persistent. The Supervisor must never infer
one capability from the other.

This is a control-boundary fixture and headless transport. It does not emulate a
terminal. Manual compatibility mode remains `process-pipe`; automatic mode
(`PI_CLAUDE_SUPERVISOR_MODE=auto`) defaults to Claude JSONL and can select the
tmux transport, which by default drives the real interactive Claude TUI through
Claude Code hooks (`PI_CLAUDE_SUPERVISOR_TMUX_MODE=interactive`, see "Interactive
tmux transport" below) and can fall back to the Supervisor-owned bridge
(`TMUX_MODE=bridge`). The bridge uses the CLI contract validated by the
fixed-version spike, renders the stream in the pane and carries structured records
through private framing on the same PTY; the bridge cannot adopt an existing
session, whereas the interactive mode adopts one through the user-level hook relay.

A worker exit automatically triggers cleanup, and terminal status waits for
that cleanup to be confirmed (or reports a cleanup error). Automatic Claude
startup rejects Bash preauthorization in the effective CLI/settings roots,
including an overridden `HOME`, and adds a safe `default` permission mode when
no mode was supplied, preserving the Supervisor's permission-event boundary
without removing the Bash tool. The automatic tmux bridge repeats the settings
inspection synchronously immediately before its Claude child `spawn`, so a
mutation after Supervisor preflight fails closed. On Linux,
manual workers may use cgroup v2 automatically when the current user cgroup is writable;
the `required` mode performs a preflight and fails before Claude starts if cgroup
attachment or cleanup is unavailable. Automatic JSONL workers always require the
same preflight and a guarded cgroup bootstrap; automatic startup fails closed on
non-Linux hosts or when the boundary cannot be established. Cgroup cleanup kills
descendants even when they call `setsid()` or create another process group. If
an automatic parent-death bootstrap performs cleanup after the Supervisor is
killed, it leaves the now-empty cgroup as takeover evidence; the lease persists
the generated Worker/cgroup identity and cgroup device/inode, and explicit
recovery removes the cgroup only after those identities, the dead tmux server,
and the empty boundary pass. Automatic workers retain their verified empty
cgroup until the owning cwd lease is finalized, so a normal-exit crash remains
recoverable; explicit lease release then removes it. Takeover first persists a
cleanup-pending transaction in the existing lease, then atomically reserves the
gone private socket; it replaces that same lease record before removing the
guardian cgroup and clears the transaction only after all cleanup proofs
complete. A fresh lease reader can reconcile the pending transaction after a
crash, retaining a replacement lease during the replacement phase, while
ordinary manual worker cleanup still removes its cgroup.

When cgroup v2 is unavailable, manual mode falls back to detached process-group
cleanup. That fallback is not recursive: `setsid()` descendants can escape, and
PID reuse between leader exit and cleanup is a host-level limitation. Production
deployments that require an atomic boundary should use a service-manager scope,
Job Object, pidfd-aware reaper, or equivalent supervisor.
Pi owns graceful `SIGTERM`/`SIGINT` handling and invokes the extension's
`session_shutdown` hook. The extension does not install a second `process.exit()`
handler, avoiding races with Pi terminal restoration and other extensions. `SIGSTOP`
and `SIGKILL` cannot be handled; no orphan guarantee is claimed for those
host-fatal signals.

## tmux/PTY transport

`TmuxWorkerAdapter` is an explicit second transport, selected with
`PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux`. Both owned and adopted tmux currently
require Linux because pane identity and cleanup use `/proc`; manual tmux may use
cgroup `auto`/`off`. Automatic owned tmux additionally creates a required Linux
cgroup for the bridge and its descendants; it is rejected when cgroup v2 or the
parent-death guardian is unavailable.
An owned manual worker gets a private tmux server/socket and executes the
validated Claude command directly in the pane. An owned automatic worker instead
starts the Supervisor bridge through a cgroup-joining pane bootstrap, so its
bridge identity is not a manual adoption target. The worker environment is
passed through unchanged, apart from removing `CLAUDECODE` so nested Claude can
start and defaulting `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` (see the hook
relay below); credentials are not copied into a file, and credential-shaped
command arguments are still rejected.
`load-buffer`, bracketed `paste-buffer` and `send-keys Enter` provide the input
boundary without interpolating a task into a shell command. C0/C1 terminal
control bytes are neutralized (escape sequences removed, a lone CR becomes a newline,
other C0/C1 bytes become spaces); CRLF is normalized to a newline. Automatic agents,
background tasks, plugins, MCP servers and nested Claude processes stay in the
same cgroup and are cleaned with the Worker; they are intentionally not rejected
or polled as a nested-process policy failure. The lexical Bash/file-tool policy
still handles known direct remote/main operations, while custom descendants are
trusted and require an independent host/repository boundary for stronger
protection.

The transport has three deliberately separate observations:

- `pipe-pane` provides an append-only raw PTY log for output polling and audit;
- `capture-pane` provides a bounded screen snapshot used only for stable prompt
  detection and human display;
- the Supervisor-owned bridge emits Claude stream-json records as private framed
  PTY control data; `pipe-pane` carries those records to the adapter without an
  independent JSONL sidecar;
- Claude's own transcript, when available, remains the structured history. Ordinary
  screen text is never relabeled as JSONL or permission evidence.

For an owned initial turn, the adapter emits a synthetic `turn_completed` only
after output activity and two stable input-prompt observations. Adopting an idle
prompt remains inactive and emits no synthetic completion. This is a liveness
signal, not proof that the task succeeded; the independent verifier remains
mandatory. Interactive dialogs, trust prompts and ambiguous screens are interpreted by
the configured autonomy policy and recorded as evidence. An unresolved task is
parked or failed as a non-publishable candidate rather than requiring a human to
remain online. Human takeover remains an explicit kill/control path and stops
automatic messages until `resume-auto`.

`/supervise adopt-tmux` is explicit and validates the pinned pane's cwd and
process identity before attaching. Every later input, capture and signal uses
that immutable pane target; a replacement process is refused. Adopted sessions
are not owned: stop and Pi shutdown detach rather than kill them. Tmux commands
and serialized input waits have bounded deadlines so shutdown cannot hang
forever. Manual sessions started by the adapter survive a Pi disconnect, but recovery
after restart is explicit re-adoption; automatic sessions are terminated by
their parent-death guardian when the Supervisor disappears. The guardian leaves
the verified empty automatic cgroup so `recover --takeover` can confirm the
private tmux session and Worker identities. Recovery reserves the gone private
socket, writes the replacement lease, and only then releases the reservation
and removes that cgroup. The extension never claims to attach to an arbitrary
non-tmux PTY. Startup cleanup always attempts the
private tmux server teardown, including after partial session creation, and a
confirmed `kill-server` is sufficient cleanup evidence. A normal Claude
`--resume` starts another process from history and is not a live PTY migration.

### Interactive tmux transport

`PI_CLAUDE_SUPERVISOR_TMUX_MODE=interactive` (the default when `TRANSPORT=tmux`)
runs the real Claude Code TUI in the tmux pane instead of the structured
stream-json bridge described above (`bridge` mode is the pre-existing
transport, kept as an opt-out). `TmuxWorkerAdapter.start({ automatic: true,
interactive: true, ... })` selects it; `interactive` and `structured` (bridge)
are mutually exclusive sub-modes of the automatic tmux transport.

**Hook relay and server.** Claude Code hooks (`SessionStart`, `PreToolUse`,
`PermissionRequest`, `Stop`, `Notification`, `UserPromptSubmit`, `SessionEnd`)
are configured to run a small embedded relay script
(`src/hooks/relay.ts`'s `HOOK_RELAY_SCRIPT`, written to
`<stateDir>/hooks/relay.js`). The relay reads the hook event JSON from stdin,
hashes the task directory to find `<stateDir>/hooks/by-cwd/<sha256(cwd)>` — a
symlink to a `HookServer`'s unix socket, created only while a Supervisor holds
that cwd — and forwards the event over the socket together with the directory
it routed by (`routeCwd`), printing the reply as Claude's hook output. The task
directory is Claude's `CLAUDE_PROJECT_DIR` (set on every hook command to the
session's launch directory) when a Supervisor owns it, else the event's `cwd`:
a Bash `cd` into a subdirectory moves `cwd` but not the project directory, so
routing by `cwd` alone would silently drop every later event of that Worker.
A nested Claude launched in a different directory reports that directory as
its project directory and is not routed to the parent's Supervisor (one
launched in the task directory itself is, as it always was). A Bash request
whose shell cwd differs from the task directory is presented to the policy as
`cd <shell cwd> && <command>`: the policy does not track `cd`, but such a
command is never classed as routine, so under `hybrid` authority the Decision
Worker judges it with its real directory shown. Automatic Workers also get
`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` (unless the caller set it), which
returns Claude's Bash to the task directory after each command, so the
policy's relative-path resolution against the task directory stays true. A
directory with no owning Supervisor is a fast no-op: the
relay `stat`s the symlink path and returns before touching `net`. Non-blocking
events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Notification`) are
fire-and-forget; `PreToolUse`, `PermissionRequest` and `Stop` block Claude for
up to `HOOK_TIMEOUT_SECONDS` (180s) waiting for a reply, and an unanswered
request fails open to "no decision" so a relay or Supervisor bug never wedges
Claude. `HookServer` (`src/hooks/server.ts`) is one socket per Pi process, with
`subscribe(cwd, handler)` installing the per-cwd symlink; a Supervisor session
subscribes for the lifetime of its task and unsubscribes on stop/release.
`installUserHooks`/`uninstallUserHooks` (`src/hooks/install.ts`, exposed as
`/supervise install-hooks`/`uninstall-hooks`) register the relay for all seven
events in the user's real `~/.claude/settings.json` (or
`$CLAUDE_CONFIG_DIR/settings.json`), required once for `adopt-tmux`; an owned
launch instead writes a standalone settings file
(`writeHookSettingsFile`, `src/hooks/settings.ts`) passed as Claude's
`--settings <path>`, so it never touches the user's own configuration.

**Two permission phases.** `PreToolUse` fires before Claude's own permission
mode runs and is the enforced boundary: the Supervisor answers a policy denial
there (a `PreToolUse` deny is reported to block a tool such as `git push`
even under `permissions.defaultMode: auto`), forwards `AskUserQuestion` to the
Decision Worker, and otherwise returns no decision (`defer: true`) so Claude's
own permission mode decides — every other tool call is intentionally not
audited at this phase, since it
would just reproduce Claude's own prompt. `PermissionRequest` fires only when
Claude is about to show a human a permission prompt (i.e. its own mode did not
already decide); the Supervisor's existing hybrid/policy/Decision-Worker
authority answers it exactly as before. `WorkerPermissionRequest.phase` is
`"pre" | "prompt"` for an interactive session and `undefined` for the
stream-json bridge or process-pipe transports. `AskUserQuestion` is always
answered by the Decision Worker as a permission deny whose message is
`Supervisor answer: <reason>` — Claude reads a `PreToolUse`/`PermissionRequest`
deny's message as the reason the tool did not run, so the chosen answer and
its rationale reach the model as ordinary text and the turn continues.

**Human coexistence.** A prompt Claude receives that the Supervisor did not
send (a human typing into the attached tmux pane) surfaces as a `human_input`
Worker event; the Supervisor appends a bounded `human_input` event, enters
human takeover (`human_takeover` with `data.source: "worker_prompt"`) if not
already active, and pauses Decision Worker notification of further
`turn_completed` events (they are still recorded so `resume-auto` can replay
the last one) until `/supervise resume-auto`. A `pre`-phase request is still
answered automatically during a human takeover (policy deny or defer) since it
is not something a human is expected to approve; only a `prompt`-phase request
pends for `/supervise approve`.

**What stays scraped.** `pipe-pane`/`capture-pane` still provide the raw
output log and a stable-prompt readiness signal for owned startup
(`#waitForInteractiveReady`); no permission or completion decision is ever
derived from screen text in interactive mode — `Stop` (→ `turn_completed`,
`result.result` the last assistant message, `subtype: "stop"`) and the two
permission hooks are the only structured signals. `--max-budget-usd` has no
effect on the interactive TUI (Claude Code only enforces it under `-p`), so
`automaticClaudeArgs`'s injected `--permission-mode default` and
`--max-budget-usd` are stripped for an interactive launch; the Supervisor's own
cumulative cost check (`#recordWorkerUsage`) is the only budget enforcement
left, and it tolerates a `Stop` result with no `total_cost_usd`/`usage` (turn
count still increments).

A completed task normally releases (not stops) an interactive Worker,
leaving the session open for the operator to review or continue by hand;
`PI_CLAUDE_SUPERVISOR_CLOSE_WORKER_ON_COMPLETION=1` restores the old
close-on-completion behavior. A blocked or failed outcome always stops the
Worker as before.

## State machine

```text
idle -> starting -> running -> waiting -> running -> verifying -> completed
                  |       |       |             |
                  v       v       v             v
                paused  failed  stopped        idle
                              verifying -> stopped
```

`stop` is available from `starting`, `running`, `waiting`, `paused` and `verifying`.
A stop request from `verifying` is cleanup-authoritative and takes precedence over a
verification result that has not yet been finalized. Invalid transitions fail closed. Supervisor lifecycle operations and their state/event
updates run through one serial queue, so concurrent `poll`, `send`, `stop`,
watchdog and shutdown work cannot produce duplicate terminal transitions. If a
lifecycle event append fails after the state transition, it remains pending and
is retried before the next lifecycle operation; output events restore their
chunks for a lossless retry. Worker lifecycle events (`turn_completed`,
`permission_request`, `exited`) whose processing fails are kept in a deferred
set and retried both by the watchdog tick and by `poll`, so an unattended task
cannot lose its exit or turn result. `worker_output` events are size-capped
(per-chunk and per-event) while the in-memory Reviewer tail stays complete.

### Cross-process cwd leases and startup cancellation

Every start and explicit recovery acquires an atomic lease in the shared lease
registry before spawning Claude. The default registry is
`~/.pi/agent/claude-supervisor/cwd-leases`; `PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR`
may point all Pi processes at an alternate shared directory. Canonical paths
conflict with both their parents and descendants, and the registry lock
serializes acquisition across independent Pi processes. A lease is released
only after the adapter confirms the worker and its descendant cleanup. An
unconfirmed lease left by a crashed Pi is intentionally retained. Ordinary
recovery refuses it; an operator may use `recover --takeover` only when the old
owner is dead, the Worker process group is gone, and the lease independently
reads a real empty cgroup boundary for the old Worker. Automatic tmux takeover
additionally requires Supervisor ownership and a gone private tmux session, then
removes the guardian-left-empty cgroup only after all proofs pass. Missing or
unverifiable Worker evidence retains the lease and parks the task rather than
performing unsafe reclamation; later recovery can inspect or clean it without
requiring an operator to be online.
An explicitly adopted tmux session may hand off an existing lease only after
its owner identity is no longer live and its canonical cwd, tmux session/socket,
pane id, pane PID/start time, and pane command all match; ordinary starts
cannot consume another task's lease. If post-start worker identity registration
fails, owned workers are stopped before the lease is released; cleanup failure
retains both the worker and lease fail-closed. Explicit `stop` cleans owned tmux
sessions, while Pi shutdown detaches persistent sessions so they remain explicitly
re-adoptable. A detached adopted session retains its lease while the verified pane
is alive; the extension periodically rechecks released sessions and removes the
lease only after the pane is confirmed gone. If that check fails, the lease is
retained rather than allowing a cwd overlap.

A lease record that cannot be read (corrupt JSON, unexpected shape) is
quarantined into `<leaseDir>/quarantine/` instead of blocking every other cwd
lookup; `/supervise sessions` lists the current quarantined records so an
operator can inspect and clean them up. A lease whose own directory has since
disappeared is not treated the same as an unreadable record: it still fails
closed for its own (possibly reused) path, but a directory that merely
disappeared does not block lookups for unrelated, non-overlapping cwds.
Releasing a retained cgroup removes verified-empty nested child cgroups
bottom-up, since systemd/Claude can create child cgroups under a Worker's own
cgroup that would otherwise leave the parent non-empty.

Before model or Worker execution, automatic starts validate a full existing Git
baseline, a non-bare worktree, a readable branch, the direct bare
`claude`/`claude.exe` command name, JSONL transport, runtime state/lease directories
and, when requested, the real writable cgroup-v2 boundary. The task is anchored to
this baseline commit, not to the branch name: any branch, including `main`, may
start or host a supervised task, since Claude Code's own "branch first" guidance is
advisory and the Worker commonly branches mid-task on its own. A protected branch
name (`main`, `master`, `trunk`, `integration`, `develop`) is never itself a reason
to refuse a start or park a candidate; only a remote push/merge/PR or a destructive
rewrite of a protected branch (`reset`, `update-ref`, `symbolic-ref`, or `branch`
with a delete/move/force flag) remains denied by policy. The resolved Claude
executable is checked for an operator-owned, non-writable path and then pinned by
absolute path; `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE` can pin the expected identity. The initial repository HEAD is captured, and the repository boundary immediately
before the Worker adapter starts must report that exact same HEAD (recovery captures
and compares its current HEAD separately while retaining the persisted baseline).
Every boundary check, and candidate verification itself, also requires the recorded
baseline commit to remain an ancestor of the current HEAD; if history was rewritten
out from under it, the boundary check fails closed and a candidate is parked rather
than accepted. A branch name change (the Worker moving off its starting branch, most
often onto a fresh feature branch) is recorded once as a `worker_branch_changed`
event rather than rejected; the task context keeps the original starting branch,
and a candidate notice reports the branch a candidate currently lives on together
with whether it is protected, purely for information.
Automatic lease acquisition also persists a no-spawn startup marker. Automatic
adapters then persist the generated Worker/cgroup identity and clear that marker
before the actual Worker spawn, closing the startup-registration crash window;
a stale marker can only be replaced after the old owner is proven dead because
its adapter has not reached spawn. Adapters persist their generated cgroup/socket
plan before creating those resources, persist cgroup identity before guardian or
session setup, and persist tmux-server identity before the final spawn check. Startup
recovery validates and cleans any planned empty resource it finds instead of
assuming the marker means no resource exists. The built-in process adapter invokes
the same assertion through `preSpawnCheck` after cgroup/executable setup and
immediately before `spawn`; a failed preflight is fail-closed and does not start
Claude. Long acceptance commands and Reviewer
sessions share an abort signal with the Supervisor, so operator stop/shutdown
wins without waiting for a full check timeout. Progress hooks expose starting,
Worker heartbeat, acceptance, review, repair and candidate/decision phases in the Pi UI.

Startup owns an `AbortController` and passes its signal to the adapter. A stop
or shutdown request aborts the controller and calls the adapter's out-of-band
startup cleanup without waiting behind the serialized start operation. Each
startup carries an opaque token, so cancelling one concurrent session cannot
abort another. Process and tmux adapters terminate or detach their startup
work, and the Supervisor rechecks cancellation before reporting `running`; a cancelled startup becomes
`stopped` and never reports a worker that was not cleanup-verified.

## Event log

Events are JSONL with a monotonic sequence number, timestamp, task ID and worker
ID. Appends use a per-log atomic lock directory with owner PID, bounded waiting
and stale-owner detection. Each append refreshes the sequence from disk while
holding the lock, so independent Pi processes cannot reuse sequence numbers;
that refresh reads only the file's tail for the last sequence number rather
than the whole log, keeping appends O(1) in log size. `events.jsonl` rotates to
a timestamped sibling (`events.jsonl.<stamp>`) before an append that would
exceed `PI_CLAUDE_SUPERVISOR_EVENT_LOG_MAX_BYTES` (default 64 MiB), keeping the
5 most recent rotated files. The log is diagnostic evidence, not an authorization mechanism. Log contents
must be treated as sensitive because worker output may contain repository data.

For Claude JSONL, the adapter tracks `activeRequests`, `lastInputAt` and
`lastOutputAt`. A `result` record closes an active request; malformed output does
not. JSONL sends are rejected while a request is active, and a valid terminal
result moves the session to `waiting`; only then may the next turn be sent. A paused
Worker does not consume its no-output budget; resume, and every message the
Supervisor sends, establishes a fresh no-output baseline while the cumulative
wall-clock deadline remains active. An idle automatic Worker that reaches the
no-output timeout is verified (`worker_idle_timeout`) rather than stopped, and a
Worker under human takeover is exempt.

The wall-clock deadline is a budget, not a kill switch. The watchdog drives it
through three phases, each recorded once per task: `worker_deadline_approaching`
(`deadlineWarningMs` before the deadline) refreshes the Decision Worker's clock
(`deadline.remainingMs` in its context and `deadlineRemainingMinutes` in every
event prompt) and, if the Worker idles under a `wait`, replays the last completed
turn so the Decision Worker can steer the Worker to integrate, commit and stop;
`worker_deadline_reached` opens the close-out window (`deadlineGraceMs`), during
which an idle automatic Worker is verified at once (`deadline_close_out`), a
`wait` decision on an idle Worker is applied as verify (`decision_overridden`), a
Worker mid-turn keeps its turn and its completed turn is decided with
`closeOut: true`, and a repair round tells the Worker how much of the window
remains; `worker_watchdog_timeout` (`worker deadline exceeded`) stops the Worker
only once the close-out window has also elapsed. The deadline never verifies
underneath a decision that is still in flight for the last turn, and a repeated
`wait` for the same turn re-arms the wait timer rather than being deduplicated.
A zero grace window restores the immediate stop at the deadline, and a manual
task (no Decision Worker to drive a close-out) always behaves that way; a repair
round is refused once less than a minute of the window is left, so the findings
stay on a blocked candidate instead of being cut short by the stop. For an adopted
interactive session the outright stop is a release (the adapter never kills a
session it does not own), so the Claude process keeps running unsupervised; the
close-out exists so that a task which merely ran long still ends with a verified
candidate instead of a silent hand-back.

A denial is a capability boundary the Worker has to route around by itself, so
each one names a remedy it can act on: a dynamic argument says to substitute the
literal value so the command can be read, and an outside-cwd write names the
write roots this Worker actually holds (and nothing when it holds none). Those
roots are what the permission policy accepts beside the task cwd: the scratchpad
Claude reports at SessionStart, and its per-project memory directory, derived
from the session's own `transcript_path`. The transcript path is captured from
any hook event, since an adopted session never replays SessionStart, and it is
untrusted input, so the shape is verified rather than trusted — it must be
`<…>/.claude/projects/<slug>/<session>.jsonl` whose slug is the one Claude
derives from this task's cwd, which rejects a subagent transcript and any path
naming another project. A root is honored before it exists (Claude creates the
memory directory on first write) and through a symlinked ancestor.

When a task is granted remote authority (`autonomy.remoteAuthority`, default
`none`), verification does not end it. `#requestPublish` first checks that
HEAD *is* the verified tree — the evidence the Reviewer judged shows a clean
working tree and carries the same `head` — then issues a `RemoteGrant` naming
that commit, the candidate's own branch, the remote, the task directory and the
remote's repository (`host/owner/repo` from its fetch URL, an SSH alias
translated through `ssh -G`), and asks the Worker to publish: the Worker runs
the push and any `gh pr create`, the Supervisor never does. A dirty tree costs a
repair round first, the remote's resolved URL lists (`get-url --all`, both sides) must equal the baseline recorded at task start (`TaskContext.remoteBaseline`, persisted with the decision session, restored on recovery, never re-taken) — checked again by `#grantedRemoteChanged` at the moment a granted command is authorized, in both the PreToolUse and prompt-phase paths — the Git directory must be the task's own `.git` or a linked worktree's, and the reviewed evidence must carry a
HEAD (fail-closed); the grant is armed before the instruction is sent and
revoked only if the send failed before delivery (the turn counter tells). The instruction is built
by `publishCommand`/`pullRequestCommand` in `policy.ts`, beside the parser that
admits it, and a test round-trips one through the other. Under every permission
authority the granted command is answered by the policy (`PolicyResult.granted`)
rather than escalated to the Decision Worker. The returning turn skips
acceptance and the Reviewer when HEAD is unchanged — they already passed on that
tree — and `#settlePublish` confirms the result read-only (`#confirmPublish`:
both pinned remote URLs unchanged, `git ls-remote` carrying the verified commit,
plus `gh pr list` for `pr`) before completing, or blocks the candidate when it
cannot; that candidate keeps `deliverable: true`, since it passed and is intact
on its branch, and an unreachable remote is reported as *unconfirmed*
(`RemoteBranchLookup` tells `absent` from `unreachable`), never as a missing
commit or a repointed remote. A tree that changed during the publish turn — an uncommitted edit included — voids
the grant and is re-verified in full, with the same confirmation deciding whether the notice
says the verified commit landed first. The grant is cleared on every terminal
path, so it never outlives the turn it was issued for, and
`permittedRemoteCommand` admits a single literal shape —
`git -C '<task dir>' -c core.hooksPath=/dev/null -c push.followTags=false push <remote> <commit>:refs/heads/<branch>`
with no other option, and `gh pr create --repo <pinned URL> --head <branch> …`
— so no force, delete, mirror, tags, push-options, other `-c`, branch or `HEAD`
source, other remote, branch or repository, relative `-C`, shell wrapper,
dynamic word or second statement; the pinned hooks path keeps any installed
`pre-push` out of the granted command and the pinned `push.followTags=false` keeps any tag out of it. `git config` writes to
transport-affecting keys (including `include.*` and `init.*`), `git config
--edit`, `git init --template`, and any statement naming `.git/config` or
`.git/hooks` in any spelling (`namesGitMetadata` normalizes the path and matches a glob segment by segment, so only a
segment that could expand to `.git` counts — a project's own `src/hooks/` is ordinary work) that does not plainly only read are refused alongside `git remote`
mutations; git's own `--git-dir`/`--work-tree` options and `remote`'s own `-v`
cannot hide either, nor can `-C /proc/self/cwd` or `-C <cwd>/link/..` (the directory must be the granted one byte for byte; every realpath comparison elsewhere uses the native implementation, since Node's JavaScript `realpathSync` collapses `link/..` lexically) or `--separate-git-dir`. The publish
hint keys on `PolicyResult.boundary`, not on the reason text, and promises a publish turn
only where `#requestPublish` will start one. For an adopted tmux session the memory write root is
located under the *adopted process's* configuration directory, read from
`/proc/<pid>/environ` at adoption, so a Claude started with another
`CLAUDE_CONFIG_DIR` keeps its memory.

A record left behind by the outright
stop (`recoverable_failure`, so `active/interrupted`) is not a dead end either:
`recover --extend <duration>` re-persists a deadline measured from now
(`extendedDeadlineMs`), `--extend 0` recovers straight into the close-out, and
`discard` closes a record nobody will recover — refused while the task's cwd
lease exists, since a live owner means the task is running in another Pi and a
dead owner's lease is reclaimed only through `recover --takeover`'s cleanup proof.
Input writes are serialized with stop and are acknowledged through the stream
write callback before their idempotency key is consumed. Writes have a bounded
timeout, and `stop()` preempts a queued lifecycle operation by initiating adapter
termination immediately. This status is observable by `poll` and prevents blind
duplicate turns. The adapter also exposes event subscriptions for `result`,
`control_request`, permission requests and process exit. Automatic mode routes
those events to a persistent, read-only Pi Decision Worker; its Pi session JSONL
and task mapping are persisted under the supervisor state directory. After an
unclean Pi restart, recovery is explicit: `/supervise recover [--takeover]
<task-id>` restores
the Decision Worker context and starts a new Claude Worker. It does not silently
resume or duplicate a task. It does not poll to detect turn completion. In automatic
mode the watchdog is always armed: besides the deadline and no-output timeouts, it
retries deferred lifecycle events, classifies a Worker that exited without an exit
event, and starts verification for it. Permission and other actions pass through the configured autonomy policy and
are recorded. The local development loop must not require synchronous human
approval for ordinary actions; a task that cannot safely produce a candidate is
parked or failed without granting remote/main authority. Model/API failures are
detected from the Pi `stopReason` (a provider error resolves the prompt normally
rather than throwing); if the Decision Worker
API/model call fails, the system records `decision_worker_failed`, applies the
bounded retry/park policy and preserves the candidate evidence. The startup
instructions prompt retries provider errors on the same backoff and budget, so a
provider overload at start does not fail the task before its first turn. An abort is never
retried, and a `noop` reply on a completed turn or a permission request parks the
candidate rather than being treated as a resolved decision, while a `noop` on a
clean Worker exit proceeds to verification. A `stop` on a completed turn of an
unattended task without remote authority stops the Worker (never keeping it open)
and then verifies its finished work instead of discarding it (`decision_overridden`);
no repair round may follow, so a failure blocks the candidate. A `stop` on a
pending permission, on a turn the Worker has already resumed, or on a task with
remote authority stays a plain stop. Optional alert
delivery remains independent from event-log persistence, but notification is not
the control boundary.

Permission requests are not all routed to the Decision Worker model. `autonomy.permissionAuthority`
(`policy` | `hybrid`, default | `decision-worker`) chooses the authority: `policy` answers
every request from the deterministic policy alone, `decision-worker` sends every
request to the model, and the `hybrid` default answers a request from policy alone
only when the policy already denies it or `isRoutinePermission` in `src/policy.ts`
recognizes it as a routine in-cwd file edit or a local read-only/dev shell command
it can fully account for; anything it does not recognize is not routine and still
goes to the Decision Worker. The shell classifier is deliberately narrow: every
pipeline segment must start with an allow-listed utility (`ls`, `grep`, `sed -n`,
`git status/diff/log/add/commit`, `npm test|run`, `node ./script`, `tsc`, ...),
inline scripts (`node -e`), programs named by path, `$(...)`/backticks, process
substitution, `env`, `xargs`, `sort` and every other utility that can run a
program from an option, git shapes that discard or relocate work
(`checkout`/`restore`/`reset`, `stash drop`, `-C` outside the cwd, `-c`,
`--git-dir`, `--ext-diff`/`--textconv`), file-writing modes of
`sed`/`awk`/`find`/`tsc`, any argument that names a path outside the cwd (reads
of `/etc` or `~/.ssh` included), and any redirection whose target is outside the
cwd (after resolving `..`, `~` and symlinks) are never routine. Executing repository code (`npm run <script>`,
`node ./x.js`) is routine by design: it is reviewed repository content and the
Worker could run it through the allowed file tools regardless. A policy denial always wins regardless of authority; the
classifier only ever narrows what reaches the model, never what the policy refuses.
An explicit human takeover suspends this local fast path entirely, so every
permission request stays pending for the human once takeover is active, even one
the policy would otherwise have answered alone.

The persistent Decision Worker session is kept small by construction, not by an
after-the-fact trim: the task/spec/cwd live once in the startup instructions, and
every subsequent prompt sends only a bounded event summary (`summarizeEvent` in
`src/decision-worker.ts`, capping a `turn_completed` result or `permission_request`
input that can otherwise run to tens of kilobytes) plus the small pieces of state
that actually change turn to turn. On top of that, the session proactively calls
`AgentSession.compact()` between decisions once its estimated context passes
`PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS` (default 60,000 tokens; `0` disables
it), asking Pi to preserve the task specification, the permission/boundary rules,
the current state and the last three decisions with their reasons. A compaction
failure never fails the decision that already succeeded. Because compaction can
drop context a decision might otherwise assume, the next primary prompt after a
successful compaction re-sends the startup instructions exactly once (tracked by an
internal "instructions stale" flag), then reverts to the compact event summary.

Every Worker `result` record and every Decision Worker/Reviewer model call is
accounted for, not just logged: a `result` becomes a `worker_usage` event carrying
its incremental and cumulative cost and token counts, and a Pi-side call becomes a
`pi_usage` event; both accumulate into `session.usage` (`SupervisorTokenUsage`),
which `/supervise status`, progress notifications (`SupervisorProgress.costUsd`/
`.piTokens`) and candidate notifications (`CandidateNotice.usage`) all read from.
`autonomy.maxWorkerCostUsd` (`PI_CLAUDE_SUPERVISOR_WORKER_MAX_BUDGET_USD`) is
enforced twice: it is passed to Claude as `--max-budget-usd` so the Worker can stop
itself first (surfaced as the `result` subtype `error_max_budget_usd`), and the
Supervisor independently parks the candidate once its own cumulative
`workerCostUsd` crosses the same limit, so a Worker that does not honor its own cap
is still bounded.

## Acceptance, review and repair loop

A task may provide a structured `TaskSpec` with `goal`, `scope`, `constraints`,
`forbidden`, an ordered list of required or optional acceptance checks, and
`autonomy` (`unattended`, `requireLocalCommit`, `maxDecisionRetries`). A
legacy plain-text task is normalized to a goal with the default `git diff
--check` acceptance check and unattended defaults. The verifier runs every configured check with argv,
bounded output and the same deterministic command policy; a Worker completion
claim never substitutes for these results.

When automatic supervision is enabled, a successful check set is passed to a
fresh read-only Reviewer session. The Reviewer receives the task specification, repository status/diff evidence,
check results and bounded Worker completion evidence, but not the Decision Worker
conversation or control channel. It can inspect only `read`, `grep`, `find` and `ls`, and must return
`pass`, `revise` or `human` with bounded structured findings. Its whole reply
must be that one JSON object (an optional ```json fence aside), carrying a
random `reviewId` that appears only in its own prompt, with no key repeated and
nothing beyond the schema (a string `summary`, and `findings` as flat objects of
the finding fields with scalar values). Each finding opens with `severity`
then a non-empty `message` (an `id` may lead) and closes with `evidence` if it
has one — the only field the prompt allows repository quotes in. Repository
text it quotes or copies therefore cannot stand in for the answer, change its
verdict, or drop a finding it wrote, and a quote in `evidence` that closes a
finding early can only add findings after it — never change the severity,
message, fix or location the Reviewer already wrote. A quote the Reviewer puts
in any other field against the prompt can still reach the rest of that
finding. Added findings cannot unblock a candidate (any P0/P1 blocks, even
under `pass`), and repair instructions list findings most severe first so
added lesser ones cannot crowd out a blocking one. A reply that breaks any of
these earns one corrective re-prompt. Invalid Reviewer
output, incomplete evidence or a Reviewer API failure must prevent a candidate
from crossing the remote/main boundary; the local system may retry, repair or
park it without requiring a human to be online. The Reviewer retries provider
errors with a fresh session within a total review budget
(`PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS`, default 10 minutes). Truncated
(oversize) evidence requests a bounded repair before parking, while incomplete
evidence still parks.

A `revise` result produces an audited repair round and sends a bounded corrective
instruction to a still-live `repairableSession` Worker. Checks and review then run again.
The Decision Worker sees the last result tagged with the Worker turn it judged, and chooses
when to verify again; if it keeps steering instead, the Supervisor verifies on its own once
the Worker has taken three turns since that failure (`decision_overridden`), so a Decision
Worker reasoning from the stale failure cannot hold a fixed Worker in a loop until the deadline.
The repair budget defaults to three rounds. P0/P1 findings block a `pass` but are repair
inputs like any other concrete finding (a `pass` carrying one is treated as `revise`); a
`human` verdict, repeated findings or an exhausted budget stop automation and park a
non-publishable candidate. A Worker that has already exited cannot be silently recreated
for repair; it remains failed/recoverable rather than replaying the original task. If a repair
or candidate branch cannot continue, a single idempotent terminalizer records
`verification_failed`, closes the Decision Worker and reports cleanup evidence; it never performs
a second `failed -> failed` transition.

Repository evidence is baseline-relative: the Supervisor records the initial HEAD,
then collects tracked committed/staged/unstaged changes, commit summaries after that
baseline and untracked regular files through bounded, component-safe, no-symlink reads.
Incomplete or truncated evidence is not sufficient for an independent `pass` verdict;
automatic mode parks a task when the required git baseline or local commit is unavailable. Acceptance
process output uses a bounded execution buffer before the smaller persisted evidence
limit, so a normal large test report is not misclassified as a failed command.

## Deliberate non-goals

- giving the Worker remote push or main/integration merge authority;
- unauthenticated inbound webhook commands; outbound notifications are optional,
  do not grant permission and do not replace the remote/main independent boundary;
- treating an unknown Claude interactive question as safe without task evidence or configured authorization;
- bypassing the known direct remote/main command and Git metadata boundaries;
- accepting model text as verification;
- shell command interpolation;
- a host-level network sandbox for automatic or manual integrations. Automatic mode
  deliberately preserves Claude Code's normal environment, network, tools, agents,
  plugins and MCP configuration; nested/custom descendants are trusted capabilities;
- Claude CLI multi-version compatibility in the current stability milestone;
- full OS sandbox and low-privilege execution for custom or nested Worker integrations in the
  current lifecycle milestone.
