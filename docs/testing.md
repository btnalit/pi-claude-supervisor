# Testing

> Autonomy target: local editing, testing, repair and local commits run without a human being online. Invalid output (after one corrective re-prompt), unavailable evidence, duplicate findings, a `human` Reviewer verdict and exhausted budgets become parked/non-publishable candidates rather than synchronous human gates. Remote push and main/integration merge remain independent-boundary tests. See [autonomy-target.md](autonomy-target.md).

## Local checks

```bash
npm ci --ignore-scripts --include=dev
npm run check
npm run test:pi
npm run test:install
npm audit --audit-level=high
npm run build
```

`npm run check` performs strict TypeScript checking, Node tests, and npm package
content assertions. `npm run build` creates an installable npm archive; Pi loads
the published TypeScript source directly and there is no second runtime bundle.

## Test layers

- `policy.test.ts`: deterministic local allow and hard-boundary deny behavior; legacy approval cannot override denial.
- `state.test.ts`: legal and illegal lifecycle transitions.
- `events.test.ts`: ordered JSONL persistence, sequence recovery and credential-shaped redaction.
- `decision-session-store.test.ts`: atomic Decision Worker task mapping, permissions, restart discovery and corrupt-record isolation.
- `index.test.ts`: command-level cwd reservation/reuse and session-shutdown
  cleanup for a real child process.
- `supervisor.test.ts`: a real local child process must reach `verifying` and
  require a separate successful verification command before `completed`.
- `worker/process-adapter.test.ts`: spawn failure is observable, JSONL framing and
  idempotent duplicate suppression work, and a child does not remain indefinitely
  in a running state.
- `worker/tmux-adapter.test.ts`: an owned private tmux socket accepts multi-line
  input, emits a stable-prompt turn event, preserves PTY output and cleans its
  session on stop. It also verifies explicit idle startup does not submit a
  blank turn, idle adoption emits no synthetic completion, adopted pipe
  detachment permits re-adoption, and adopted stop preserves the user's
  session.
- `worker/environment.test.ts`: manual environment inheritance remains minimal, while
  automatic mode merges explicit overrides onto the complete inherited environment,
  removes only `CLAUDECODE` so nested Claude can run, adds a safe default permission
  mode when omitted, resolves settings from effective `HOME`/`CLAUDE_CONFIG_DIR`, and
  rejects Bash preauthorization in CLI/settings configuration.
- `supervisor.test.ts`: the no-output watchdog stops a stalled worker, lifecycle event failures are retried, and output is restored when event persistence fails.
- `scripts/check-package.mjs`: verifies the Pi manifest, peer dependency policy,
  required files and forbidden secret paths.

## Transport spike acceptance

Run `npm run spike:transport` only in an isolated test workspace after the test
account is authenticated with Claude Code. The script uses `spawn` with
`shell: false`, disables session persistence, restricts tools, sends one fixed
non-sensitive prompt, and prints protocol metadata rather than raw model output.
It must not be added to the normal CI gate because authentication is an owner
controlled prerequisite.

The transport fixtures validate one prompt, multiple turns, session resume,
permission allow/deny and SIGTERM/SIGINT behavior. The compatibility floor for the current release line is Claude Code `2.1.270`.
The real-Claude spikes resolve the current `claude` executable from `PATH` by
default, so installer-managed `latest` paths work without naming a versioned
installation directory; `PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_PATH` is an optional
explicit override. Versions older than `2.1.270` are rejected, while newer
versions are accepted and recorded in the spike output. The recorded baseline
run used Claude Code `2.1.270` and covered real owned tmux turns, pause/resume,
and restart re-adoption.
The adapter regression suite also verifies event subscription, parsed
`permission_request` events, the exact nested `control_response` envelope, and
that an automatic Worker may launch a nested Claude executable while cgroup
cleanup still reaps the child.
The automation spike additionally exercises a real Pi SDK Decision Worker with
Claude: ordinary completion, harmless Bash permission handling, and an
`AskUserQuestion` denial-to-text fallback followed by automatic verification.
A local baseline-CLI run completed all three scenarios with `state=completed`,
`verified=true`, and zero human interventions. Provider/model latency can still
cause a later run to fail closed as a parked/non-publishable candidate after the bounded Decision
Worker or Reviewer timeout; this is evidence for the manual spike only, not a CI guarantee.
The extension persists each automatic Decision Worker session as Pi JSONL plus a
0600 task mapping. Automatic startup preflights the state/lease directories, cwd,
worker executable, transport dependency and required cgroup boundary before model
execution. Progress callbacks expose the current phase and periodic Worker
heartbeat. Recovery is explicit and safe: after an unclean Pi restart,
`/supervise sessions` shows the task as `recoverable`, and `/supervise recover
[--takeover] <task-id>` restores the Decision Worker history before starting a new
Claude Worker. `--takeover` is accepted only when the old Pi owner is dead, the
Worker process group is gone, and its cgroup is a real readable empty boundary.
Automatic tmux takeover additionally verifies Supervisor ownership, persisted
Worker/cgroup and tmux-server identities, and that the private tmux session is gone.
It persists cleanup-pending state before reserving the gone private socket,
reuses the old lease record for an atomic replacement, then removes the
guardian-left-empty cgroup and clears the transaction only after cleanup is
verified; a fresh lease reader reconciles an interrupted transaction while
retaining a replacement lease during its replacement phase. Automatic lease acquisition records a no-spawn startup marker; the adapter
persists its generated cgroup/socket plan before resource creation, then records
cgroup and tmux-server identity in stages before spawn. Startup takeover verifies
and cleans a planned empty cgroup/session when a crash interrupts that sequence;
a stale marker can otherwise be reclaimed only after its owner is proven dead.
Automatic normal-exit cleanup retains an empty cgroup until lease release.
Persistent manual tmux sessions use `adopt-tmux`. The bridge has a regression test that mutates settings
between Supervisor preflight and `respawn-pane` and confirms Claude is not spawned.
Run the permission and signal probes explicitly when validating a CLI release:

```bash
npm run spike:permissions
SPIKE_PERMISSION_DECISION=deny npm run spike:permissions
npm run spike:signals
npm run spike:automation
SPIKE_AUTOMATION_PERMISSION=1 npm run spike:automation
SPIKE_AUTOMATION_QUESTION=1 npm run spike:automation
PI_CLAUDE_SUPERVISOR_REAL_CLAUDE=1 npm run spike:tmux
PI_CLAUDE_SUPERVISOR_REAL_CLAUDE=1 npm run spike:tmux-interactive
# Optional explicit override; PATH/latest is preferred:
PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_PATH="$HOME/.local/share/mise/installs/claude/latest/claude" \
PI_CLAUDE_SUPERVISOR_REAL_CLAUDE=1 npm run spike:tmux
```

The Decision spike runs a real Pi Decision Worker and Reviewer, on any Pi
model, against a scripted Worker that edits a temporary git repository. It
needs no Claude Code, cgroup or tmux, so it runs on hosts that cannot run the
real-Claude spikes. It is gated and excluded from normal CI:

```bash
# Default model: google/gemini-3.5-flash-lite
PI_CLAUDE_SUPERVISOR_REAL_DECISION=1 npm run spike:decision
# Optional: another Pi model, a subset of scenarios, a per-scenario deadline,
# and keeping the temp repositories
SPIKE_DECISION_MODEL=google/gemini-3.1-flash-lite \
SPIKE_DECISION_SCENARIOS=review,stuck SPIKE_TIMEOUT_MS=600000 SPIKE_KEEP=1 \
PI_CLAUDE_SUPERVISOR_REAL_DECISION=1 npm run spike:decision
```

Credentials come only from Pi's own sources (for example `GEMINI_API_KEY` in
the environment, or `~/.pi/agent/auth.json`); the script never reads, prints or
stores a key, and redacts what it prints. The scenarios cover:
- `review`: an incomplete first turn is caught and repaired. Two model
  behaviors fail it without being regressions: a Reviewer that passes the
  incomplete turn, and a Decision Worker that answers the "task is complete"
  turn with `stop`, which ends the task blocked with no repair;
- `question`: a mid-task question is answered from the spec without a human;
- `stuck`: a Worker that only claims success ends `blocked` within its repair
  budget.

Each prints a redacted summary: state, decisions, overrides, Reviewer verdicts
and answer-format failures. The script exits non-zero when a scenario misses
its expected outcome. Weak and rate-limited models are useful here, because
they exercise the deterministic guards that the prompt alone does not
guarantee. A daily quota error at startup or mid-task is expected to fail
closed (park), and is not a regression.

The tmux spike is gated, authenticated, and excluded from normal CI. It uses
plan mode with a fixed `opus` model, records only protocol metadata, and
verifies three real Claude turns, exact screen-result markers, pause/resume,
manual takeover, direct PTY input, owned detach,
and identity-bound restart re-adoption. The interactive spike uses a fresh temporary
cwd to verify Claude's trust prompt, a real Bash permission prompt, an allow-once
response, and an exact result marker; it also records metadata only.

For each release, record the validated Claude Code version, resolved executable
path, and model. The spikes resolve `claude` from `PATH` by default and reject
versions below the compatibility floor `2.1.270`; they do not require an exact
versioned installation path. The recorded baseline for this release is `2.1.270`
with model `opus`; the bounded matrix and its fail-closed outliers are recorded
in [`docs/stability-matrix-2.1.270.md`](stability-matrix-2.1.270.md).
Record:

1. exact version and resolved executable path;
2. license and source revision;
3. startup, prompt delivery and output framing;
4. stop, process-group cleanup and crash behavior;
5. timeout, duplicate-message and recovery behavior;
6. human takeover and session-resume semantics;
7. no secret leakage in event logs or npm archives.

A passing worker task is not sufficient. The independent verifier must repeat the
relevant checks from a clean host perspective.

Automatic mode is enabled with `PI_CLAUDE_SUPERVISOR_MODE=auto`; it defaults to
JSONL and routes `result`, permission, and process-exit events to the persistent
Pi Decision Worker. Setting `PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux` selects the
Supervisor-owned live bridge, which carries the same structured records through
private framing on the PTY rather than an independent JSONL sidecar. Task autonomy
defaults to unattended local work, a required
local commit on the task branch (any branch, anchored to the baseline commit) and four bounded Decision Worker retries. Configure
`PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT=0` or task `autonomy.requireLocalCommit`
only to disable the local-commit deliverability check; automatic mode still requires a Git
baseline (any branch, including `main`; the candidate must descend from it). The tmux bridge
requires Supervisor ownership; the interactive tmux mode (the default `TMUX_MODE`) also adopts an
existing session through the user-level hook relay. `process-pipe` remains the manual compatibility mode. Candidate/failure notification is optional and outbound-only through
`PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL`; it is not a synchronous approval
callback. Approval callbacks are deliberately not accepted without a separately
authenticated endpoint.

The tmux transport is selected with `PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux`.
Automatic mode rejects explicit `process-pipe`; use JSONL or the Supervisor-owned
bridge for bounded decisions and repair. Automatic JSONL and tmux workers also
require Linux cgroup v2 containment (and the tmux parent-death guardian); startup
fails closed when it is unavailable. Parent-death cleanup leaves an empty cgroup
for verified takeover, while automatic normal worker cleanup retains an empty
cgroup until cwd lease release (manual cleanup removes it). Automatic workers
preserve Claude Code's normal
arguments, environment, network access, tools, agents, plugins and MCP configuration;
there is no injected sandbox or automatic tool allowlist. The only automatic CLI
safety addition is a `default` permission mode when none was supplied; Bash
preauthorization through `--allowedTools` or loaded settings is rejected so Bash
requests remain visible to Supervisor policy. Automatic startup also requires
a full existing Git baseline, a non-bare worktree on any branch and the bare
`claude`/`claude.exe` command name. It resolves and pins an
operator-owned, non-writable executable path (or the path configured by
`PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE`), rejects explicit/custom executable paths, and
compares the exact startup HEAD again immediately before spawn. Before release, verify:
private-socket attach,
multi-line paste, prompt stability while
Claude is busy, trust/permission policy handling, duplicate send prevention, pane
replacement refusal, live bridge event framing, pause/resume, owned-session stop, adopted-session
detach/re-adoption, bounded shutdown, and Pi shutdown without closing an
attached window. The two gated real-Claude spikes above cover the trust prompt,
permission prompt, exact output, optional takeover, and adopted detach paths. Use
`--permission-mode plan` and read-only tools for ordinary live Claude checks;
the interactive spike is restricted to one harmless `rm -f` in a disposable
fresh directory. Do not run JSONL and tmux control against the same Claude
process, and do not treat `capture-pane` text as a structured permission
response.

## Failure injection

The automated adapter matrix covers external `SIGTERM`, `SIGINT`, `SIGKILL`,
`SIGSTOP`/`SIGCONT`, SIGTERM refusal/escalation, leader-early-exit descendant
cleanup, required cgroup bootstrap containment of a pre-attachment detached
and `setsid()` descendant, nested Claude/agent descendant allowance with cgroup cleanup,
repeated stop, spawn failure, output truncation,
blocked stdin write timeouts, and immediate JSONL results. The Supervisor
matrix also covers retrying failed lifecycle events, preserving startup event
order, stopping under persistent timeout-event failure, and restoring output
after event-log failure. The Supervisor matrix covers startup rejection,
externally terminated workers, lifecycle serialization and stop races. Cwd lease
coverage includes successful automatic process and tmux takeover, token-bound
same-record replacement, provisional pre-spawn identity, retained-cgroup
release, and reconciliation of a durable pending-cleanup transaction.

Before release, manually test at least: immediate crash, hung process, malformed
output, duplicate send, send/exit race, Pi `SIGTERM`/`SIGINT` shutdown,
verification failure, blocked stdin writes/stop preemption, corrupt event-log
tails, and descendants that call `setsid()` when cgroup mode is unavailable (expected
fallback limitation). In cgroup mode, a small bootstrap joins the cgroup before
launching Worker code, and cleanup also validates and reaps the detached process
group; this closes the post-spawn attachment window. `SIGSTOP` and `SIGKILL` of
the Pi host cannot be handled; verify and document the resulting orphan behavior.
Default behavior must be fail-closed and leave no orphaned worker process within
the managed process group.

## Near-term automation acceptance gate

The `v0.5.0` implementation of the acceptance—independent Review—repair—reacceptance
loop is shipped. The `v0.5.1` real read-only drill reached acceptance and independent
Review, then correctly produced a non-publishable candidate after two P1 and two P2 findings under the then-current human-gated compatibility path.
A separate real edit-capable Claude Code `2.1.270` baseline drill then exercised one bounded
acceptance failure, repair turn, reacceptance and independent Reviewer `pass` in an
isolated temporary worktree. The current hardening plan and evidence paths are recorded
in [`docs/automation-hardening-plan.md`](automation-hardening-plan.md). Deterministic
coverage now includes repairable-vs-persistent capability assertions, cancellation
of acceptance commands, stop-from-verifying precedence, paused watchdog baselining,
staged/untracked evidence, and untracked symlink/hard-link rejection. The exact-head
independent read-only review was rerun. Its pathname TOCTOU finding is recorded as a
false positive for the trusted local-development threat model: automatic workers are
trusted development agents, and this policy is a metadata guard rather than a host
filesystem isolation boundary. A hostile same-UID worker would require a separate
sandbox/broker design and is out of scope for this release.

### Acceptance and Reviewer fixtures

Deterministic tests must cover:

- legacy text tasks normalized to a Goal with the default `git diff --check`;
- multiple required/optional checks with bounded output, timeout and exit-code evidence;
- independent read-only Reviewer pass/revise/human results;
- invalid Reviewer JSON and Reviewer API failure becoming a parked/non-publishable candidate without requiring a live callback;
- repair rounds (P0/P1 findings are repaired, never passed), repeated finding detection and repair-budget exhaustion;
- non-persistent JSONL verification failure without duplicate terminal transitions;
- repairable-but-not-persistent JSONL multi-turn repair;
- stop and Pi shutdown from `verifying`, including Decision Worker closure and cwd lease release;
- completion being impossible without passing all required checks and review.

Reviewer sessions use only `read`, `grep`, `find` and `ls`; they must not modify
the worktree or send Worker input. Decision Worker and Reviewer model calls are
bounded; timeout or API failure parks the candidate instead of auto-completing or
requiring a human to be online. Review reports
are persisted as bounded event payloads and are not treated as permission grants.

### JSONL protocol and replay fixtures

The adapter/replay matrix must cover:

- JSON split across stdout chunks and multiple records in one chunk;
- malformed JSON between valid records without a false completion event;
- duplicate result and permission records without duplicate actions;
- duplicate Supervisor idempotency keys without duplicate input;
- stop, SIGTERM, SIGINT and Pi shutdown while a JSONL request is active;
- ordinary completion, low-risk permission allow, AskUserQuestion deny-to-text,
  multi-turn, verifier failure/repair, takeover and explicit recovery;
- staged and untracked repository evidence, symlink rejection and truncation fail-closed;
- paused watchdog behavior and resume-time no-output rebasing;
- assistant-message-bounded Reviewer and Decision Worker output parsing.

Real Claude tests remain authenticated manual Spikes and are not part of normal
CI. The spikes accept Claude Code `2.1.270` and newer, resolve the current
executable from `PATH`, and report the actual version/path. Normal CI runs
deterministic fake Worker and replay fixtures. The `2.1.270` stability matrix is
the baseline compatibility evidence for this release line; any future CLI change
must rerun ten consecutive ordinary
automatic runs and at least five runs each for permission and question handling, with
no duplicate action, false completion or unreaped Worker.

## Future multi-worker test plan

Multiple independent task sessions already run concurrently when their canonical
cwd/worktrees do not overlap. This is not yet coordinated multi-worker
collaboration. The future multi-worker milestone must be tested as a task graph,
not as unrestricted shared-worker access.

Required deterministic and integration coverage:

- two independent Workers with separate worktrees and aggregated parent status;
- dependency ordering and a blocked child that must not start early;
- child failure, timeout, cancellation propagation and bounded global budgets;
- schema-validated handoff artifacts with duplicate/oversized/stale handoffs;
- conflicting diffs detected before integration, with no same-worktree writes;
- independent child acceptance followed by root-task aggregate acceptance and Review;
- single-child recovery, whole-graph recovery and Pi shutdown during scheduling;
- scheduler-owned children cannot grant permissions or send control input to another scheduled child;
  Claude-native Agent/Task/MCP descendants remain trusted inside their Worker's cleanup cgroup;
- independent integration in a separate worktree; known direct remote push/main operations remain
  policy-denied, while absolute enforcement for trusted nested/custom capabilities belongs to that boundary.

The multi-worker gate should be added only after the minimum-version single-worker
stability and recovery gates pass. CI should use fake Workers and replay fixtures;
authenticated Claude multi-worker Spikes remain manual and must meet the same
`2.1.270` minimum.

## Live drill and hardening gate

A live review must record the exact Claude executable/version, transport, cgroup mode,
permission flags, task id, acceptance result, Reviewer result, cleanup status and cwd lease
status. A parked/non-publishable result is a valid safety outcome and must not be converted into a
pass by retrying the same task automatically or by treating the absence of a human callback as approval.

For the hardening release, the completed gate record is:

1. `npm run check`, `npm run test:pi`, `npm run test:install`, `npm run build`;
2. deterministic lifecycle/evidence/capability tests;
3. a disposable temporary-worktree real Claude repair/reacceptance spike with an edit-capable
   Worker;
4. cleanup verification: no Worker, no Decision Worker, no unreconciled lease and clean Git
   worktree.

The remaining gate is a read-only review of the exact resulting commit. The drill evidence is
recorded in `docs/automation-hardening-plan.md`; it did not run against this release worktree,
did not use Claude `--resume`, and did not merge, publish or release automatically.
