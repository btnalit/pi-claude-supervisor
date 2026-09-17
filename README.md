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
> notifications do not approve actions. An unattended failure (an unexpected Worker exit,
> a watchdog timeout or unconfirmed cleanup) also emits a `candidate_failed` notice with
> status `failed`, and webhook delivery retries transient errors.

## Safety boundary

- The extension never starts a worker automatically.
- Worker commands are launched without a shell.
- Manual workers retain the small inherited environment unless the caller supplies explicit variables. Automatic Claude workers inherit the supervisor environment unchanged except for `CLAUDECODE`, which must be removed so Claude can intentionally launch nested Claude sessions; credentials, Git/package helpers, custom settings and network configuration are not filtered.
- The full Claude Code tool surface is available in automatic mode, including agents, background tasks, plugins and MCP. Automatic mode refuses CLI/settings rules that pre-authorize `Bash`, and adds Claude's safe `default` permission mode when none is supplied, so Bash requests remain visible to the Supervisor; it does not remove the Bash tool. The adapter also adds stream-json transport framing and keeps every Worker descendant inside the Supervisor-owned cleanup boundary. `AskUserQuestion` is converted to ordinary text because no human is synchronously present.
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

Pi's distributed executable may be Bun-compiled, so the Linux cgroup and tmux
helper scripts resolve a real `node` executable from `PATH` instead of assuming
`process.execPath` accepts `-e`. Set `PI_CLAUDE_SUPERVISOR_NODE` to an executable
path when Node is not on the Supervisor's `PATH`.

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
still cleans every descendant. Automatic mode adds a safe `default` permission mode
when omitted and rejects Bash preauthorization in the effective CLI/settings roots
(including an overridden `HOME`); Bash itself remains available through
Supervisor-visible permission requests. The automatic tmux bridge repeats that
settings check synchronously immediately before spawning Claude, so a mutation after
Supervisor preflight fails closed. The adapter also adds stream-json transport framing,
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
`PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES` bounds retries of a Decision Worker
request that times out or whose model/API call fails (429/529, network, auth);
exhausted retries record `decision_worker_failed` and park the candidate, while
an abort is never retried. `PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS` bounds the
total independent Reviewer budget per round, including one retry on a provider
error (default 10 minutes). `PI_CLAUDE_SUPERVISOR_EVENT_LOG_MAX_BYTES` rotates
`events.jsonl` to timestamped siblings once it reaches this size, keeping 5
rotated files (default 64 MiB).

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
boundary; missing or unverifiable Worker evidence is refused. The lease also
persists the generated Worker/cgroup identity, including the cgroup device/inode,
and rejects a renamed or replaced cgroup. Automatic Workers retain a verified
empty cgroup until the owning cwd lease is released, covering a normal-exit
crash between Worker cleanup and lease finalization; release then removes it.
Automatic lease acquisition records a no-spawn startup marker and the adapter
persists its generated cgroup/socket plan before creating those resources,
then records cgroup and server identity in stages before spawn. Recovery
inspects and cleans a planned empty cgroup/session instead of assuming that
startup-only means no resource exists. A stale marker is reclaimable only after
its owner is proven dead because that adapter has not reached spawn. For an automatic tmux lease, takeover additionally requires Supervisor ownership,
dead tmux-server identity, a gone private tmux session, and a durable
cleanup-pending transaction plus atomic reservation of the private socket. The
replacement reuses the old lease record, and the reservation remains until that
replacement is written. Only then is the guardian-left-empty cgroup removed; a
fresh Supervisor can reconcile the pending transaction if recovery is
interrupted. For a persistent manual tmux Worker, use explicit `adopt-tmux`
instead of takeover.
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
structured records through private terminal framing on the same PTY. The bridge
re-reads effective Claude settings in the same process immediately before its
child `spawn`, so a startup settings mutation fails closed instead of reaching
an unchecked Claude process. The adapter parses those records from the raw PTY
pipe, so there is no independent
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
when the Supervisor disappears. A later `/supervise recover --takeover` may
reclaim an automatic lease only after the guardian, process, cgroup and private
tmux-session proofs pass. Use plan/read-only flags for live testing.

## Token usage and cost controls

Measured on one real unattended review task (29 minutes wall clock):

| Component | Turns/calls | Tokens | Cost |
| --- | --- | --- | --- |
| Claude Code Worker | 70 turns | 15.5M cache-read + 370k cache-write + 100k output | $18.46 |
| Pi Decision Worker | 30 model calls | ~1.0M (91k uncached + 914k cache-read) | $0.04 |

Almost all of the money goes to the Worker, not the Supervisor's own Decision Worker
or Reviewer calls. In this run the Worker averaged ~220k tokens of context per turn
because it ran as a single long `-p` session under a 1M-token window that never
compacted; a trivial Claude Code turn costs roughly 24k prompt tokens for its system
prompt alone, regardless of which MCP servers are configured. Of the 30 Decision
Worker calls, 28 were permission requests, and the Decision Worker overrode the
deterministic policy 4 times (denying downloads and writes outside the task
directory) — this is why `hybrid` is the default `permissionAuthority`, not
`policy`. Replaying those 28 requests through the shipped `isRoutinePermission`
classifier answers 4 of them locally; that task was dominated by inline `node -e`
scripts and `$(...)` substitutions, which are never routine. An ordinary
implementation task is mostly in-cwd `Edit`/`Write`, `npm test` and
`git status/diff/add/commit`, all of which are routine, so its Decision Worker
call count drops much further.

Knobs, with their defaults and trade-offs:

- `PI_CLAUDE_SUPERVISOR_PERMISSION_AUTHORITY` / `autonomy.permissionAuthority`
  (`policy` | `hybrid`, default | `decision-worker`): `hybrid` answers routine
  in-cwd file edits and local read-only/dev shell commands from the deterministic
  policy alone (`isRoutinePermission` in `src/policy.ts`) and still sends every
  ambiguous request, and every policy denial, to the Decision Worker. This mainly
  buys latency and a smaller Decision Worker context, not dollars: the 30 calls
  above already cost $0.04.
- `PI_CLAUDE_SUPERVISOR_WORKER_MODEL` / `--model`: roughly a 5x price difference
  between Opus- and Sonnet-class models. This is the single largest lever on the
  actual bill, and it is the operator's choice; the Supervisor does not pick it
  for you.
- `PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS` (default 200000 in automatic
  mode; `0` keeps Claude's own default): bounds context per Worker turn so a long
  session does not keep accumulating ~220k-token turns. Worth tens of percent, at
  the cost of some context quality.
- `PI_CLAUDE_SUPERVISOR_WORKER_MAX_BUDGET_USD` / `autonomy.maxWorkerCostUsd`: a
  hard cap passed to Claude as `--max-budget-usd` and re-checked by the Supervisor
  against the cumulative Worker `result` cost. It is a cap, not a saving; a task
  that hits it is parked with its evidence.
- `PI_CLAUDE_SUPERVISOR_WORKER_MCP_CONFIG` (`--strict-mcp-config --mcp-config`):
  restricts the Worker to only the listed MCP servers. It bounds what the Worker
  can reach, not the ~24k-token fixed overhead of an ordinary turn.
- `PI_CLAUDE_SUPERVISOR_DECISION_MODEL` / `PI_CLAUDE_SUPERVISOR_REVIEWER_MODEL`
  (`provider/model-id`, for example `anthropic/claude-haiku-4-5-20251001`): the
  Pi Decision Worker and Reviewer models. Pi-side usage was already a few cents in
  this run, so a cheaper model here mostly buys latency, not headline savings.
- `PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS` (default 60000; `0` disables):
  proactively compacts the persistent Decision Worker session once its estimated
  context passes this threshold, and re-sends the startup instructions once on
  the next prompt after compaction.

The Supervisor records what it spends rather than estimating it after the fact:
every Worker `result` record becomes a `worker_usage` event, every Decision
Worker/Reviewer model call becomes a `pi_usage` event, and both accumulate into
`session.usage` (`SupervisorTokenUsage`). `/supervise status <task-id>` prints a
`cost=… workerTurns=… workerTokens=… piTokens=… decisionCalls=… reviewerCalls=…`
summary; progress notifications carry `SupervisorProgress.costUsd`/`.piTokens`,
and a candidate notification carries the same summary through `CandidateNotice.usage`,
which the generic webhook serialises as a numeric `usage` object and the WeCom
format renders as two extra lines.

None of this changes what a task actually costs beyond the Worker model and budget
choice; the Supervisor-side changes here mainly cut Decision Worker tokens and
latency, which were cents to begin with. For a cost-sensitive unattended run, a
reasonable starting point is a Sonnet-class `PI_CLAUDE_SUPERVISOR_WORKER_MODEL`, an
explicit `PI_CLAUDE_SUPERVISOR_WORKER_MAX_BUDGET_USD` per task, the default `hybrid`
permission authority, and a Haiku-class `PI_CLAUDE_SUPERVISOR_DECISION_MODEL`.

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
