# pi-claude-supervisor

[![CI](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-claude-supervisor)](https://www.npmjs.com/package/pi-claude-supervisor)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English · [简体中文](README.cn.md)

A policy-gated [Pi](https://pi.dev) extension for supervising a Claude Code worker.
The MVP keeps Pi in control of lifecycle, state, policy and verification while the
worker remains an explicitly started child process.

> **Release status:** `v0.5.2` is the released single-Worker recovery baseline. The
> default manual transport is dependency-free process pipes, not PTY. Automatic
> supervision uses Claude JSONL only; tmux is manual-only because it has no structured
> permission boundary. Repairable-vs-persistent capabilities,
> cancellable verification, evidence completeness gates, startup preflight and phase
> progress reporting. A real edit-capable Claude Code `2.1.270` repair/reacceptance
> drill passed in an isolated temporary worktree. The confirmed product target is
> unattended local development; see [the autonomy target](docs/autonomy-target.md).
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
- Workers receive a minimal environment; automatic mode uses a deny-by-default variable allowlist, strips remote credentials and disables Git/package credential helpers. Only documented Claude provider variables may be selected for automatic mode; arbitrary custom variables remain manual-only.
- Local command and permission behavior follows the configured task/runtime policy; actions outside that authority are rejected or parked without requiring a synchronous human response.
- Automatic mode admits only the bare `claude`/`claude.exe` command name, resolves and pins an operator-owned executable from the supervisor PATH (or `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE`), and rejects explicit paths or writable/untrusted locations. It requests a fail-closed Claude Code Bash sandbox with no outbound domains; command policy remains a second guard. Manual/custom integrations must provide their own equivalent host/network boundary.
- A worker completion is only a transition to `verifying`; it is not evidence of success.
- Verification is an independent host command (default: `git diff --check`).
- Target local development runs unattended after a task starts: the Worker may edit, test, repair and commit locally. The Worker must have no authority or credentials to push remotely or merge into `main`/an integration branch.
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
export PI_CLAUDE_SUPERVISOR_WORKER='claude --safe-mode --tools ""'
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
online. Automatic mode accepts only the bare direct Claude command name, pins its
operator-owned resolved executable path, and uses a fail-closed Bash sandbox with no
outbound domains; arbitrary custom executables and explicit executable paths are rejected
in automatic mode. Set `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE` when the resolved path must
be pinned explicitly. Manual/custom integrations must provide an equivalent host/network
boundary.
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
The adapter intentionally does not inherit arbitrary host environment variables.
Manual embedding integrations may pass credentials through an explicit
`WorkerStartInput.env`; automatic mode accepts only documented Claude provider
variables, for example `PI_CLAUDE_SUPERVISOR_WORKER_ENV=ANTHROPIC_API_KEY`, and
filters remote credentials and configuration-injection variables. The host-side
`PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE` setting pins the executable identity and is not
passed into the Worker environment.

### tmux/PTY transport

For an interactive Claude Code window, opt in to the tmux transport:

```bash
export PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux
export PI_CLAUDE_SUPERVISOR_WORKER='claude --permission-mode plan'
# tmux does not support cgroup required mode; use cgroup mode auto/off.
# tmux is manual-only; automatic Decision Worker supervision requires JSONL.
# Optional, only when adopting a non-default tmux server:
# export PI_CLAUDE_SUPERVISOR_TMUX_SOCKET=/path/to/tmux.sock
```

`/supervise start <task>` starts Claude in a private tmux server and reports a
literal attach command. Use that command in another terminal to watch or
manually interact with the same PTY; attaching is optional for unattended local
development. The adapter sends multi-line input through
tmux buffers and Enter, never by interpolating the message into a shell command.
It records the PTY stream with `pipe-pane` and uses `capture-pane` to detect a
stable Claude input prompt. Because tmux has no structured permission boundary,
automatic Decision Worker supervision is disabled for this transport; use JSONL for
unattended decisions, repair and protected command enforcement.

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

PTY screen text is not Claude JSONL and must not be treated as structured
permission evidence. TUI decisions follow the configured autonomy policy and are
recorded; an unresolved task may be parked without requiring a human to remain
online. A normal terminal Claude process cannot be migrated into tmux, and
`--resume` is historical recovery rather than live PTY attach. Owned tmux sessions
survive a Pi disconnect and require an explicit `adopt-tmux` after restart. Use
plan/read-only flags for live testing.

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
