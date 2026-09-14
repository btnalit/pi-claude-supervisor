# Testing

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

- `policy.test.ts`: deterministic allow/review/deny behavior.
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
- `worker/environment.test.ts`: unrelated host credentials are excluded unless
  explicitly supplied.
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
permission allow/deny and SIGTERM/SIGINT behavior. The current release validation
uses Claude Code 2.1.270 at
`/home/yancao/.local/share/mise/installs/claude/2.1.270/claude`, including real
owned tmux turns, pause/resume, and restart re-adoption.
The adapter regression suite also verifies event subscription, parsed
`permission_request` events, and the exact nested `control_response` envelope.
The automation spike additionally exercises a real Pi SDK Decision Worker with
Claude: ordinary completion, harmless Bash permission approval, and an
`AskUserQuestion` denial-to-text fallback followed by automatic verification.
A local pinned-CLI run completed all three scenarios with `state=completed`,
`verified=true`, and zero human interventions. Provider/model latency can still
cause a later run to fail closed as human-required after the bounded Decision
Worker or Reviewer timeout; this is evidence for the manual spike only, not a CI
guarantee.
The extension persists each automatic Decision Worker session as Pi JSONL plus a
0600 task mapping. Automatic startup preflights the state/lease directories, cwd,
worker executable, transport dependency and required cgroup boundary before model
execution. Progress callbacks expose the current phase and periodic Worker
heartbeat. Recovery is explicit and safe: after an unclean Pi restart,
`/supervise sessions` shows the task as `recoverable`, and `/supervise recover
[--takeover] <task-id>` restores the Decision Worker history before starting a new
Claude Worker. `--takeover` is accepted only when the old Pi owner is dead, the
Worker process group is gone, and its cgroup is a real readable empty boundary;
persistent tmux sessions use `adopt-tmux`.
Run the permission and signal probes explicitly when validating a CLI release:

```bash
npm run spike:permissions
SPIKE_PERMISSION_DECISION=deny npm run spike:permissions
npm run spike:signals
npm run spike:automation
SPIKE_AUTOMATION_PERMISSION=1 npm run spike:automation
SPIKE_AUTOMATION_QUESTION=1 npm run spike:automation
PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_PATH=/home/yancao/.local/share/mise/installs/claude/2.1.270/claude \
PI_CLAUDE_SUPERVISOR_REAL_CLAUDE=1 npm run spike:tmux
PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_PATH=/home/yancao/.local/share/mise/installs/claude/2.1.270/claude \
PI_CLAUDE_SUPERVISOR_REAL_CLAUDE=1 npm run spike:tmux-interactive
```

The tmux spike is gated, authenticated, and excluded from normal CI. It uses
plan mode with a fixed `opus` model, records only protocol metadata, and
verifies three real Claude turns, exact screen-result markers, pause/resume,
automation enabled with human takeover, direct human PTY input, owned detach,
and identity-bound restart re-adoption. The interactive spike uses a fresh temporary
cwd to verify Claude's trust prompt, a real Bash permission prompt, an allow-once
response, and an exact result marker; it also records metadata only.

For each release, pin and record the validated Claude Code version, resolved
executable path, and model. The spikes reject an unpinned/mismatched executable
version. For this release the validated version is `2.1.270` with model `opus`;
the bounded matrix and its fail-closed outliers are recorded in
[`docs/stability-matrix-2.1.270.md`](stability-matrix-2.1.270.md).
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
Pi Decision Worker. An explicit `PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux` selection
remains screen-based and does not use the JSONL permission protocol. `process-pipe` remains the manual compatibility mode. Human
escalation is outbound-only through `PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL`;
approval callbacks are deliberately not accepted without a separately
authenticated endpoint.

The tmux transport is selected with `PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux`.
Automatic mode rejects an explicit `process-pipe` transport; use JSONL or tmux for
bounded decisions and repair. Before
release, verify: private-socket attach, multi-line paste, prompt stability while
Claude is busy, trust/permission dialog takeover, duplicate send prevention, pane
replacement refusal, pause/resume, owned-session stop, adopted-session
detach/re-adoption, bounded shutdown, and Pi shutdown without closing an
attached window. The two gated real-Claude spikes above cover the trust prompt,
permission prompt, exact output, human takeover, and adopted detach paths. Use
`--permission-mode plan` and read-only tools for ordinary live Claude checks;
the interactive spike is restricted to one harmless `rm -f` in a disposable
fresh directory. Do not run JSONL and tmux control against the same Claude
process, and do not treat `capture-pane` text as a structured permission
response.

## Failure injection

The automated adapter matrix covers external `SIGTERM`, `SIGINT`, `SIGKILL`,
`SIGSTOP`/`SIGCONT`, SIGTERM refusal/escalation, leader-early-exit descendant
cleanup, required cgroup cleanup of a `setsid()` descendant, repeated stop,
spawn failure, output truncation, blocked stdin write timeouts, and immediate
JSONL results. The Supervisor matrix also covers
retrying failed lifecycle events, preserving startup event order, stopping under
persistent timeout-event failure, and restoring output after event-log failure. The Supervisor matrix covers startup rejection, externally terminated
workers, lifecycle serialization and stop races.

Before release, manually test at least: immediate crash, hung process, malformed
output, duplicate send, send/exit race, Pi `SIGTERM`/`SIGINT` shutdown,
verification failure, blocked stdin writes/stop preemption, corrupt event-log
tails, and descendants that call `setsid()` when cgroup mode is unavailable (expected
fallback limitation). The cgroup test proves cleanup after attachment but does
not eliminate the post-spawn attachment window. `SIGSTOP` and `SIGKILL` of the Pi host cannot be handled;
verify and document the resulting orphan behavior.
Default behavior must be fail-closed and leave no orphaned worker process within
the managed process group.

## Near-term automation acceptance gate

The `v0.5.0` implementation of the acceptance—independent Review—repair—reacceptance
loop is shipped. The `v0.5.1` real read-only drill reached acceptance and independent
Review, then correctly stopped at human intervention after two P1 and two P2 findings.
The drill did not exercise real repair because the task forbade edits and set
`maxRepairRounds=0`; replay coverage is not a substitute for a real repairable capability
matrix. The current hardening plan is recorded in
[`docs/automation-hardening-plan.md`](automation-hardening-plan.md). Deterministic
coverage now includes repairable-vs-persistent capability assertions, cancellation
of acceptance commands, stop-from-verifying precedence, paused watchdog baselining,
staged/untracked evidence and untracked symlink rejection. A real edit-capable
repair/reacceptance drill remains a release gate and has not been claimed by the
current source changes.

### Acceptance and Reviewer fixtures

Deterministic tests must cover:

- legacy text tasks normalized to a Goal with the default `git diff --check`;
- multiple required/optional checks with bounded output, timeout and exit-code evidence;
- independent read-only Reviewer pass/revise/human results;
- invalid Reviewer JSON and Reviewer API failure escalating to human;
- repair rounds, repeated finding detection, P0/P1 escalation and repair-budget exhaustion;
- non-persistent JSONL verification failure without duplicate terminal transitions;
- repairable-but-not-persistent JSONL multi-turn repair;
- stop and Pi shutdown from `verifying`, including Decision Worker closure and cwd lease release;
- completion being impossible without passing all required checks and review.

Reviewer sessions use only `read`, `grep`, `find` and `ls`; they must not modify
the worktree or send Worker input. Decision Worker and Reviewer model calls are
bounded; timeout or API failure escalates instead of auto-completing. Review reports
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

Real Claude tests remain authenticated manual Spikes and are pinned to
`2.1.270`; they are not part of normal CI. Normal CI runs deterministic fake
Worker and replay fixtures. The short-term stability gate is still pending and
must include ten consecutive ordinary automatic runs and at least five runs each
for permission and question handling, with no duplicate action, false completion
or unreaped Worker.

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
- no child can grant permissions, send control input to another child or bypass Policy Gate;
- explicit human-controlled integration in a separate worktree; no automatic merge or publish.

The multi-worker gate should be added only after the pinned single-worker stability
and recovery gates pass. CI should use fake Workers and replay fixtures; authenticated
Claude multi-worker Spikes remain manual and version-pinned.

## Live drill and hardening gate

A live review must record the exact Claude executable/version, transport, cgroup mode,
permission flags, task id, acceptance result, Reviewer result, cleanup status and cwd lease
status. A human-required result is a valid safety outcome and must not be converted into a
pass by retrying the same task automatically.

Before release of the hardening changes, run in this order:

1. `npm run check`, `npm run test:pi`, `npm run test:install`, `npm run build`;
2. deterministic lifecycle/evidence/capability tests;
3. a disposable temporary-worktree real Claude repair/reacceptance spike with explicit human
   approval for any edit-capable Worker;
4. a read-only review of the exact resulting commit;
5. cleanup verification: no Worker, no Decision Worker, no unreconciled lease and clean Git
   worktree.

The repair spike must not run against the release worktree, must not use Claude `--resume` as
an invented recovery mechanism, and must not merge, publish or release automatically.
