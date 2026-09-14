# Architecture

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
moves the supervisor to `verifying`; only a successful verifier moves it to
`completed`.

The extension keeps a registry of independent task sessions. Each session has
its own Supervisor, watchdog, state machine and Worker handle, while the event
log is shared and protected by an inter-process lock. Concurrent active sessions must use non-overlapping canonical working
directories/worktrees; same-cwd and parent/child cwd starts are rejected before
spawn, including concurrent starts, to prevent uncoordinated edits. Pending starts
are also awaited during Pi shutdown.

## MVP transport

`ProcessWorkerAdapter` uses `node:child_process.spawn` with:

- `shell: false` (the default and intentionally not overridden);
- a detached process group for pause/resume/kill control;
- separate stdout/stderr capture;
- idempotency keys for messages;
- no session-resume claim.

This is a control-boundary fixture and headless transport. It does not emulate a
terminal. Manual compatibility mode remains `process-pipe`; automatic mode
(`PI_CLAUDE_SUPERVISOR_MODE=auto`) defaults to Claude JSONL and uses the CLI
contract validated by the fixed-version spike; an explicit tmux transport remains
screen-based.

A worker exit automatically triggers cleanup, and terminal status waits for
that cleanup to be confirmed (or reports a cleanup error). On Linux the adapter
uses cgroup v2 automatically when the current user cgroup is writable; the
`required` mode fails startup if cgroup attachment is unavailable. Cgroup
cleanup kills descendants even when they call `setsid()` or create another
process group. Attachment occurs immediately after spawn, so a worker that
forks before attachment remains a documented startup-window limitation.

When cgroup v2 is unavailable, the adapter falls back to detached
process-group cleanup. That fallback is not recursive: `setsid()` descendants
can escape, and PID reuse between leader exit and cleanup is a host-level
limitation. Production deployments that require an atomic boundary should use a
service-manager scope, Job Object, pidfd-aware reaper, or equivalent supervisor.
The Pi host installs graceful `SIGTERM`/`SIGINT` handlers, but `SIGSTOP` and
`SIGKILL` cannot be handled; no orphan guarantee is claimed for those host-fatal
signals.

## tmux/PTY transport

`TmuxWorkerAdapter` is an explicit second transport, selected with
`PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux`. Because tmux has no equivalent cgroup
containment boundary, `PI_CLAUDE_SUPERVISOR_CGROUP_MODE=required` is rejected
with this transport; use `auto`/`off` only when the tmux boundary is acceptable.
An owned worker gets a private tmux server/socket and executes the validated Claude command directly in the pane,
so its pane identity remains re-adoptable after a Pi restart. The worker
environment is supplied to the tmux server through the same least-privilege
environment builder; credentials are not copied into a file; credential-shaped
command arguments are rejected.
`load-buffer`, bracketed `paste-buffer` and `send-keys Enter` provide the input
boundary without interpolating a task into a shell command. C0/C1 terminal
control bytes are rejected; CRLF is normalized to a newline.

The transport has three deliberately separate observations:

- `pipe-pane` provides an append-only raw PTY log for output polling and audit;
- `capture-pane` provides a bounded screen snapshot used only for stable prompt
  detection and human display;
- Claude's own transcript, when available, remains the structured history. The
  screen is never relabeled as JSONL or permission evidence.

For an owned initial turn, the adapter emits a synthetic `turn_completed` only
after output activity and two stable input-prompt observations. Adopting an idle
prompt remains inactive and emits no synthetic completion. This is a liveness
signal, not proof that the task succeeded; the independent verifier remains
mandatory. Interactive dialogs,
trust prompts and ambiguous screens are not auto-approved. Human takeover sets a
Supervisor gate that stops automatic messages until `resume-auto`.

`/supervise adopt-tmux` is explicit and validates the pinned pane's cwd and
process identity before attaching. Every later input, capture and signal uses
that immutable pane target; a replacement process is refused. Adopted sessions
are not owned: stop and Pi shutdown detach rather than kill them. Tmux commands
and serialized input waits have bounded deadlines so shutdown cannot hang
forever. Sessions started by the adapter also survive a Pi disconnect, but
recovery after restart is explicit re-adoption; the extension never claims to
attach to an arbitrary non-tmux PTY. A normal Claude
`--resume` starts another process from history and is not a live PTY migration.

## State machine

```text
idle -> starting -> running -> waiting -> running -> verifying -> completed
                  |       |       |             |
                  v       v       v             v
                paused  failed  stopped        idle
```

`stop` is available from `starting`, `running`, `waiting` and `paused`. Invalid
transitions fail closed. Supervisor lifecycle operations and their state/event
updates run through one serial queue, so concurrent `poll`, `send`, `stop`,
watchdog and shutdown work cannot produce duplicate terminal transitions. If a
lifecycle event append fails after the state transition, it remains pending and
is retried before the next lifecycle operation; output events restore their
chunks for a lossless retry.

### Cross-process cwd leases and startup cancellation

Every start and explicit recovery acquires an atomic lease in the shared lease
registry before spawning Claude. The default registry is
`~/.pi/agent/claude-supervisor/cwd-leases`; `PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR`
may point all Pi processes at an alternate shared directory. Canonical paths
conflict with both their parents and descendants, and the registry lock
serializes acquisition across independent Pi processes. A lease is released
only after the adapter confirms the worker and its descendant cleanup; an
unconfirmed lease left by a crashed Pi is intentionally retained and requires
operator verification/manual cleanup rather than unsafe automatic reclamation.
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
holding the lock, so independent Pi processes cannot reuse sequence numbers.
The log is diagnostic evidence, not an authorization mechanism. Log contents
must be treated as sensitive because worker output may contain repository data.

For Claude JSONL, the adapter tracks `activeRequests`, `lastInputAt` and
`lastOutputAt`. A `result` record closes an active request; malformed output does
not. JSONL sends are rejected while a request is active, and a valid terminal
result moves the session to `waiting`; only then may the next turn be sent.
Input writes are serialized with stop and are acknowledged through the stream
write callback before their idempotency key is consumed. Writes have a bounded
timeout, and `stop()` preempts a queued lifecycle operation by initiating adapter
termination immediately. This status is observable by `poll` and prevents blind
duplicate turns. The adapter also exposes event subscriptions for `result`,
`control_request`, permission requests and process exit. Automatic mode routes
those events to a persistent, read-only Pi Decision Worker; its Pi session JSONL
and task mapping are persisted under the supervisor state directory. After an
unclean Pi restart, recovery is explicit: `/supervise recover <task-id>` restores
the Decision Worker context and starts a new Claude Worker. It does not silently
resume or duplicate a task. It does not poll to detect turn completion. A watchdog timer remains only as a deadlock safety
fallback. Permission actions pass through `evaluatePermission` and can be
approved or denied manually with `/supervise approve`; human escalation is sent
to an outbound webhook when configured. If the Decision Worker API/model call
fails, the system records `decision_worker_failed` and directly alerts the
human operator; it does not attempt a second LLM fallback. Alert delivery is
kept independent from event-log persistence so an audit write failure cannot
suppress the alert.

## Acceptance, review and repair loop

A task may provide a structured `TaskSpec` with `goal`, `scope`, `constraints`,
`forbidden` and an ordered list of required or optional acceptance checks. A
legacy plain-text task is normalized to a goal with the default `git diff
--check` acceptance check. The verifier runs every configured check with argv,
bounded output and the same deterministic command policy; a Worker completion
claim never substitutes for these results.

When automatic supervision is enabled, a successful check set is passed to a
fresh read-only Reviewer session. The Reviewer receives the task specification, repository status/diff evidence,
check results and bounded Worker completion evidence, but not the Decision Worker
conversation or control channel. It can inspect only `read`, `grep`, `find` and `ls`, and must return
`pass`, `revise` or `human` with bounded structured findings. Invalid Reviewer
output or a Reviewer API failure is a human-required condition.

A `revise` result produces an audited repair round and sends a bounded corrective
instruction to a still-live JSONL/tmux Worker. Checks and review then run again.
The repair budget defaults to three rounds; repeated findings and P0/P1 findings
stop automation and escalate. A non-persistent Worker that has already exited
cannot be silently recreated for repair; it remains failed/recoverable rather
than replaying the original task.

## Deliberate non-goals

- automatic merge/deploy/release;
- unauthenticated inbound webhook commands; outbound notifications do not grant
  permission and do not replace Pi human takeover;
- treating an unknown Claude interactive question as safe to answer automatically;
- bypassing Claude Code permissions;
- accepting model text as verification;
- shell command interpolation;
- automatic network denial or a fake domain allowlist. Network access follows
  Claude's own permission model and the command policy; suspicious download-to-
  shell patterns require human review rather than blanket network rejection;
- Claude CLI multi-version compatibility in the current stability milestone;
- OS sandbox, low-privilege execution and network isolation in the current
  lifecycle milestone.
