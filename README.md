# pi-claude-supervisor

[![CI](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-claude-supervisor)](https://www.npmjs.com/package/pi-claude-supervisor)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English · [简体中文](README.cn.md)

A policy-gated [Pi](https://pi.dev) extension for supervising a Claude Code worker.
The MVP keeps Pi in control of lifecycle, state, policy and verification while the
worker remains an explicitly started child process.

> **MVP status:** the default transport is dependency-free process pipes, not PTY.
> An opt-in Claude JSONL framing mode has passed basic prompt, multi-turn and
> resume fixtures. The current priority is signal, shutdown, process-group and
> recovery validation; OS sandbox, low-privilege execution and network isolation
> are deferred hardening items and are not required by the current MVP plan.

## Safety boundary

- The extension never starts a worker automatically.
- Worker commands are launched without a shell.
- Workers receive a minimal environment; credentials must be explicitly supplied by the caller.
- Destructive command patterns and permission-bypass worker flags are denied; review-level patterns request explicit user approval instead of being blanket-denied.
- Ordinary network use is not denied merely because it is network use; download-to-shell patterns still require review.
- A worker completion is only a transition to `verifying`; it is not evidence of success.
- Verification is an independent host command (default: `git diff --check`).
- The extension never performs merge, deploy, release, or publish at runtime. Repository releases are automated only after a maintainer merges a Release Please PR and the full CI gate passes.
- A 4-hour wall-clock and 20-minute no-output watchdog stop a worker by default for long development tasks; embedding callers can set either to `0` to disable.
- On Linux, the adapter automatically uses a writable cgroup v2 for descendant cleanup, including `setsid()` descendants; it falls back to process-group cleanup when unavailable. Use the adapter's `cgroupMode: "required"` for a fail-closed integration.
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
/supervise sessions
/supervise recover <task-id>
/supervise poll
/supervise poll all
/supervise send continue with read-only inspection
/supervise pause
/supervise resume
/supervise stop human requested stop
/supervise verify
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
`/supervise sessions` lists the sessions. Unattended use still requires the
remaining lifecycle, signal and recovery checks. Host permissions and network
access follow explicit caller authorization and host policy; there is no
automatic merge, deploy, release or publish.

Automatic mode persists the Pi Decision Worker session under the configured state
directory. After an unclean Pi restart, `/supervise sessions` lists recoverable
tasks; `/supervise recover <task-id>` explicitly restores the Decision Worker
context and starts a new Claude Worker. It never silently resumes or duplicates
work. The adapter intentionally does not inherit arbitrary host environment variables.
Pass credentials through an explicit `WorkerStartInput.env` in an embedding
integration. For the built-in command, opt in to named variables, for example
`PI_CLAUDE_SUPERVISOR_WORKER_ENV=ANTHROPIC_API_KEY`.

### tmux/PTY transport

For an interactive Claude Code window, opt in to the tmux transport:

```bash
export PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux
export PI_CLAUDE_SUPERVISOR_WORKER='claude --permission-mode plan'
# tmux does not support cgroup required mode; use cgroup mode auto/off.
# Optional automatic Decision Worker (manual mode is the default):
# export PI_CLAUDE_SUPERVISOR_MODE=auto
# Optional, only when adopting a non-default tmux server:
# export PI_CLAUDE_SUPERVISOR_TMUX_SOCKET=/path/to/tmux.sock
```

`/supervise start <task>` starts Claude in a private tmux server and reports a
literal attach command. Use that command in another terminal to watch or
manually interact with the same PTY. The adapter sends multi-line input through
tmux buffers and Enter, never by interpolating the message into a shell command.
It records the PTY stream with `pipe-pane`, uses `capture-pane` to detect a
stable Claude input prompt, and feeds turn-completion events into the same
watchdog, Decision Worker, audit and verification paths as JSONL.

A session that you started yourself can be explicitly adopted without replaying
the task:

```text
/supervise adopt-tmux <tmux-session-name> <task description>
```

Adoption checks the session's working directory and pane command, and refuses a
pane that already has another output pipe. It does not claim ownership: `/supervise stop` and Pi shutdown detach supervision rather
than killing the user's tmux session. Use `tmux kill-session` yourself when the
adopted window should be closed. `/supervise takeover <task-id>` disables
automatic Decision Worker messages; resume them only with
`/supervise resume-auto <task-id>`.

PTY screen text is not Claude JSONL. Permission dialogs, trust prompts and
ambiguous TUI states are escalated to a human; tmux mode must not be treated as
structured permission evidence. A normal terminal Claude process cannot be
migrated into tmux, and `--resume` is historical recovery rather than live PTY
attach. Owned tmux sessions survive a Pi disconnect and require an explicit
`adopt-tmux` after restart. Use plan/read-only flags for live testing.

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

See [the engineering plan](docs/engineering-plan.md), [the independent review](docs/independent-review.md),
[architecture](docs/architecture.md), [testing](docs/testing.md), and [releasing](docs/releasing.md).

Pull requests are gated by the aggregated `CI / Quality gate`. Release Please
creates version PRs from Conventional Commits; after a maintainer merges one,
`Release` verifies the exact tag commit and publishes the package with npm
provenance through the protected `npm` environment.

## License

MIT. See [LICENSE](LICENSE).
