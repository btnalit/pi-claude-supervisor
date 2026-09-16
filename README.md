# pi-claude-supervisor

[![CI](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-claude-supervisor)](https://www.npmjs.com/package/pi-claude-supervisor)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English · [简体中文](README.cn.md)

A policy-gated [Pi](https://pi.dev) extension for supervising a Claude Code worker.
The MVP keeps Pi in control of lifecycle, state, policy and verification while the
worker remains an explicitly started child process.

> **Release status:** `v0.5.3` is the released single-Worker recovery baseline. The
> default manual transport is dependency-free process pipes, not PTY. Automatic
> supervision uses Claude JSONL or the Supervisor-owned tmux bridge; adopted tmux
> sessions remain manual-only. Repairable-vs-persistent capabilities,
> cancellable verification, evidence completeness gates, startup preflight and phase
> progress reporting. A real edit-capable Claude Code `2.1.270` repair/reacceptance
> drill passed in an isolated temporary worktree. Real-Claude validation resolves the
> current executable from `PATH` and accepts Claude Code `2.1.270` or newer. The
> confirmed product target is unattended local development; see [the autonomy target](docs/autonomy-target.md).
> Remote push and merge into the main/integration branch remain outside Worker authority
> and must cross an independent boundary.
>
> **Autonomy status:** automatic mode continues local editing, testing, bounded repair,
> acceptance, independent Review and local-commit enforcement without a synchronous human
> callback. Unresolvable work is parked as a non-publishable candidate; optional outbound
> notifications do not approve actions.

## Safety boundary

- The extension never starts a worker automatically.
- Worker commands are launched without a shell.
- Manual workers retain the small inherited environment unless the caller supplies explicit variables. Automatic Claude workers inherit the supervisor environment unchanged except for `CLAUDECODE`, which must be removed so Claude can intentionally launch nested Claude sessions; credentials, Git/package helpers, custom settings and network configuration are not filtered.
- The full Claude Code tool surface is available in automatic mode, including agents, background tasks, plugins and MCP. The adapter adds only the stream-json transport framing and keeps every Worker descendant inside the Supervisor-owned cleanup boundary. `AskUserQuestion` is converted to ordinary text because no human is synchronously present.
- Local command and permission behavior follows the configured task/runtime policy; known direct remote push/main-integration operations and protected Git metadata remain rejected or parked without requiring a synchronous human response. Nested/custom tools run with the inherited capabilities and are cleaned with the Worker; they are not a second Supervisor permission loop.
- Automatic mode still admits only the bare `claude`/`claude.exe` command name, resolves and pins an operator-owned executable from the supervisor PATH (or `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE`), and rejects explicit paths or writable/untrusted locations. Manual/custom integrations must provide their own executable and host authority boundary.
- A worker completion is only a transition to `verifying`; it is not evidence of success.
- Verification is an independent host command (default: `git diff --check`).
- Target local development runs unattended after a task starts: the Worker may edit, test, repair and commit locally. Supervisor-managed requests for remote push or merge into `main`/an integration branch remain denied, while the final remote/main boundary must independently protect trusted nested/custom capabilities.
- The extension never performs merge, deploy, release, or publish at runtime. Remote/main integration and repository releases cross independent protected boundaries.
- A 4-hour wall-clock and 20-minute no-output watchdog stop a worker by default for long development tasks; embedding callers can set either to `0` to disable.
- On Linux, the adapter automatically uses a writable cgroup v2 for descendant cleanup, including `setsid()` descendants; it falls back to process-group cleanup when unavailable. Use `cgroupMode: "required"` for a fail-closed integration; required mode is preflighted before Claude starts.
- Acceptance commands, repository evidence collection and independent Review share an abort signal, so operator stop/shutdown does not wait for a full command or model timeout.
- Events are append-only JSONL records in `~/.pi/agent/claude-supervisor/events.jsonl`.

## Install

Requires Pi 0.85+ and Node.js 22.19+.

```text
pi install npm:pi-claude-supervisor
```

For local development:

```bash
npm ci --ignore-scripts
npm run check
npm run build
```

Authenticated real-Claude spikes resolve `claude` from `PATH` by default, so
installer-managed `latest` links work without a versioned path. Set
`PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_PATH` only when an explicit executable is needed;
the spikes require Claude Code `2.1.270` or newer and report the resolved path and version.

## Use

Set the worker executable if needed, then use explicit commands in Pi:

```bash
export PI_CLAUDE_SUPERVISOR_WORKER=claude
```

```text
/supervise capabilities
/supervise start inspect the current repository and report what should be changed
/supervise start --spec ./task.json
/supervise sessions
/supervise recover [--takeover] <task-id>
/supervise poll
/supervise poll all
/supervise send continue with read-only inspection
/supervise pause
/supervise resume
/supervise stop human requested stop
/supervise verify
```

`--spec` accepts a JSON file; checks are always executed with argv (never through
a shell), for example:

```json
{
  "goal": "Implement the requested change",
  "scope": ["src/"],
  "constraints": ["Keep the public API compatible"],
  "forbidden": ["Do not publish artifacts"],
  "acceptance": [
    { "id": "tests", "name": "tests", "command": "npm", "args": ["test"], "required": true }
  ],
  "maxRepairRounds": 3,
  "autonomy": {
    "unattended": true,
    "requireLocalCommit": true,
    "maxDecisionRetries": 2
  }
}
```

The default MVP writes the task to the worker's stdin as plain process-pipe
text. After running the transport spike for the target CLI, JSONL framing can
be selected explicitly:

```bash
export PI_CLAUDE_SUPERVISOR_TRANSPORT=jsonl
export PI_CLAUDE_SUPERVISOR_WORKER='claude --permission-mode acceptEdits'
```

This adds Claude Code stream-json flags and frames supervisor messages as JSONL.
The supervisor allows only one active JSONL request per session: poll until its
`result` and `waiting` state before sending the next turn. Session resume is not
yet exposed by the adapter. Multiple independent task sessions can run
concurrently when they use different canonical working directories or
worktrees; same-directory starts are rejected even when concurrent, and
`/supervise sessions` lists the sessions. This is independent-session
parallelism, not coordinated multi-worker collaboration. A future multi-worker
milestone will add explicit parent/child task graphs, dependencies, bounded
scheduling, structured handoffs, aggregate acceptance and graph-aware recovery;
it will not grant any Worker remote push or main/integration merge authority.
Unattended local development is the target operating mode; a blocked or failed
candidate is parked with its evidence rather than made dependent on a human being
online. Automatic mode preserves Claude Code's normal argument and extension surface:
its tools, agents, background tasks, plugins, MCP configuration, credentials and network
access are not replaced with a sandbox or allowlist. `CLAUDECODE` is removed from the
Worker environment so nested Claude sessions can start, and the Supervisor-owned cgroup
still cleans every descendant. The adapter adds only the stream-json transport framing
and its known direct command policy refuses remote push/main integration operations.
Automatic mode still accepts only the bare direct Claude command name, pins its
operator-owned resolved executable path, and rejects explicit executable paths or
writable/untrusted locations. Set `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE` when the resolved
path must be pinned explicitly. Custom tools and nested workers are trusted capabilities,
so a hard remote/main boundary must remain independently protected outside this process.
Set `PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT=0` only for a task that intentionally
produces no local commit candidate, or set `autonomy.requireLocalCommit` in its spec;
automatic mode still requires a valid Git baseline and non-protected worktree.
`PI_CLAUDE_SUPERVISOR_UNATTENDED=0` opts a task out of automatic Decision Worker control;
a required local commit is checked on a non-protected task branch;
`PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES` bounds transient Decision Worker retries.

The `v0.5.0` automation milestone adds a structured acceptance pipeline:
multiple argv-based checks, an independent read-only Reviewer, bounded structured
findings and repair rounds. Legacy text tasks keep the default `git diff --check`.
The Reviewer only has `read`, `grep`, `find` and `ls`; it cannot edit files or grant
permissions. Automatic mode requires complete baseline-relative tracked, commit and
bounded untracked evidence, repairs a live `repairableSession` Worker within a
bounded budget, enforces a local commit when enabled, and prevents a non-publishable
candidate from crossing the remote/main boundary. Automatic mode rejects explicit
`process-pipe` and preflights runtime prerequisites. Invalid output, unavailable
evidence, duplicate findings, P0/P1 findings and exhausted repair budgets park the
candidate without waiting for a human; see [the autonomy target](docs/autonomy-target.md).
The automatic tmux bridge carries Claude stream-json records inside the same live PTY
as display output using private terminal framing; it does not create an independent
structured-event sidecar. Automatic tmux accepts only Supervisor-owned sessions,
while `adopt-tmux` remains manual-only.
Coordinated multi-worker scheduling is a later milestone; CI uses deterministic fake
Workers/replay fixtures, and real multi-worker Claude tests remain authenticated
manual Spikes. Full host-level sandboxing and low-privilege execution for custom
integrations remain separate hardening work.

Automatic mode persists the Pi Decision Worker session under the configured state
directory. After an unclean Pi restart, `/supervise sessions` lists recoverable
tasks; `/supervise recover [--takeover] <task-id>` explicitly restores the Decision Worker
context and starts a new Claude Worker. It never silently resumes or duplicates
work. If the old Pi owner is dead, add `--takeover` only after the lease proves
the old Worker's process group is gone and its cgroup is a real, readable empty
boundary; missing or unverifiable Worker evidence is refused.
For a persistent tmux Worker, use explicit `adopt-tmux` instead of takeover.
Manual embedding integrations may pass credentials through an explicit
`WorkerStartInput.env`. Automatic mode passes the full supervisor environment to the
Worker (except `CLAUDECODE`), including provider/remote credentials, credential helpers,
configuration and proxy settings. Keep the Supervisor's own environment appropriate for
the task; `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE` pins executable identity but is otherwise
not used to select the Claude binary.

### tmux/PTY transport

For an interactive Claude Code window, opt in to the tmux transport:

```bash
export PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux
export PI_CLAUDE_SUPERVISOR_WORKER='claude'
# Manual tmux currently requires Linux for process identity and cleanup;
# it may use cgroup mode auto/off.
# Set PI_CLAUDE_SUPERVISOR_MODE=auto for the Supervisor-owned automatic bridge;
# automatic tmux additionally requires Linux cgroup v2 and a parent-death guardian.
# Optional, only when adopting a non-default tmux server:
# export PI_CLAUDE_SUPERVISOR_TMUX_SOCKET=/path/to/tmux.sock
```

`/supervise start <task>` starts Claude in a private tmux server and reports a
literal attach command. Use that command in another terminal to watch or
manually interact with the same PTY; attaching is optional for unattended local
development. The adapter sends multi-line input through
tmux buffers and Enter, never by interpolating the message into a shell command.
In automatic mode the Supervisor starts a bridge in the pane: it runs Claude's
stream-json protocol inside the live PTY, contains the bridge and descendants in
an owned cgroup, fails closed when that containment or the Linux guardian is
unavailable, renders readable deltas for the attached terminal, and returns
structured records through private terminal framing on the same PTY.
The adapter parses those records from the raw PTY pipe, so there is no independent
JSONL event sidecar. Automatic mode refuses adopted sessions; use JSONL or the owned
bridge for unattended decisions, repair and protected command enforcement.

A session that you started yourself can be explicitly adopted without replaying
the task:

```text
/supervise adopt-tmux <tmux-session-name> <task description>
```

Adoption checks the session's working directory and pane command, and refuses a
pane that already has another output pipe. Owned sessions use a generated
private tmux socket, so preserve the complete `attach=...` command printed by
`start`. When re-adopting after a Pi restart, set
`PI_CLAUDE_SUPERVISOR_TMUX_SOCKET` to the socket path from that command before
running `adopt-tmux`; the session name alone is sufficient only for the default
server. Adoption does not claim ownership: `/supervise stop` and Pi shutdown
detach supervision rather than killing the user's tmux session. Use `tmux
kill-session` yourself when the adopted window should be closed.
`/supervise takeover <task-id>` disables automatic Decision Worker messages;
resume them only with `/supervise resume-auto <task-id>`.

PTY screen text is not itself Claude JSONL and must not be treated as structured
permission evidence; only the Supervisor bridge's private framed records are
authoritative. TUI decisions follow the configured autonomy policy and are
recorded; an unresolved task may be parked without requiring a human to remain
online. A normal terminal Claude process cannot be migrated into tmux, and
`--resume` is historical recovery rather than live PTY attach. Manual owned tmux
sessions survive a Pi disconnect and require an explicit `adopt-tmux` after
restart; automatic owned sessions are terminated by their parent-death guardian
when the Supervisor disappears. Use plan/read-only flags for live testing.

## Development

```bash
npm run typecheck
npm test
npm run check:package
npm run check:docs
npm run check:automation
npm run check:workflows
npm run build
```

See [the engineering plan](docs/engineering-plan.md), [the confirmed autonomy target](docs/autonomy-target.md), [the independent review](docs/independent-review.md),
[architecture](docs/architecture.md), [testing](docs/testing.md), and [releasing](docs/releasing.md).

Pull requests are gated by the aggregated `CI / Quality gate`. Release Please
creates version PRs from Conventional Commits; after a maintainer merges one,
`Release` verifies the exact tag commit and publishes the package with npm
provenance through the protected `npm` environment.

## License

MIT. See [LICENSE](LICENSE).
