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
(`PI_CLAUDE_SUPERVISOR_MODE=auto`) forces Claude JSONL and uses the CLI contract
validated by the fixed-version spike.

A worker exit automatically triggers cleanup, and terminal status waits for
that cleanup to be confirmed (or reports a cleanup error). The Pi extension
constructs Process Worker adapters with cgroup mode `required` by default. On
Linux this creates a private cgroup v2 boundary and refuses startup if the
boundary cannot be attached. Cgroup cleanup kills descendants even when they
call `setsid()` or create another process group. Attachment occurs immediately
after spawn, so a worker that forks before attachment remains a documented
startup-window limitation; an atomic boundary still requires a service-manager
scope, container, Job Object, pidfd-aware reaper, or equivalent host facility.

The adapter's `auto` mode is an explicit compatibility fallback. It uses
detached process-group cleanup when cgroup v2 is unavailable, records the
cgroup error in status, and the Pi host retains the cwd reservation rather than
claiming descendant cleanup was safe. That fallback is not recursive:
`setsid()` descendants can escape, and PID reuse between leader exit and cleanup
is a host-level limitation. `required` mode also refuses to report cleanup as
complete when its cgroup attachment failed.
The Pi host installs graceful `SIGTERM`/`SIGINT` handlers, but `SIGSTOP` and
`SIGKILL` cannot be handled; no orphan guarantee is claimed for those host-fatal
signals.

## tmux/PTY transport

`TmuxWorkerAdapter` is an explicit second transport, selected with
`PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux`. An owned worker gets a private tmux
server/socket and a launcher file containing only the validated command, args and
cwd. The worker environment is supplied to the tmux server through the same
least-privilege environment builder; environment credentials are not copied into
the launcher file; credential-shaped command arguments are rejected.
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
  shell patterns require human review rather than blanket network rejection.
