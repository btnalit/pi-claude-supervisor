# Confirmed autonomy target

> Owner-confirmed product requirement: local development is fully unattended; code entering a remote repository or the main/integration branch must cross an independent boundary.

This document is authoritative for the autonomy direction. Earlier planning text that treats a
human as a synchronous approval step for ordinary local development is historical conservative
baseline text and must not be used to add a new gate to the local development loop.

## 1. Target operating model

Once a task has been started with its task specification, the local development loop may run
without a human watching it:

```text
Worker edits and runs local commands
  -> acceptance checks
  -> independent Reviewer
  -> bounded repair/reacceptance
  -> local commit/candidate artifact
  -> independent remote/main integration boundary
```

The Supervisor may continue, answer, repair, test, review and commit locally. A human is not a
synchronous dependency for ordinary progress, routine ambiguity, or a normal failed test.

The system must still provide a kill switch, bounded execution, cleanup verification and a
complete audit trail. These are reliability and containment mechanisms, not requests for a human
to approve every development action. Automatic mode also records and revalidates a full existing
repository baseline, requires a non-protected branch and direct Claude JSONL Worker, and by
default requires a local commit before a candidate is deliverable.

## 2. Hard authority boundary

Automatic Worker supervision uses the structured JSONL transport; the interactive tmux transport
remains manual-only because it has no equivalent permission-response boundary. The Worker and local
automation do **not** receive authority or credentials for:

- pushing code to a remote repository;
- merging into `main` or another protected integration branch;
- starting automatic candidate work directly on a protected integration branch; repositories with a
  branch use a non-protected local branch for unattended work;
- inheriting Git/GitHub/package credential helpers or explicitly selected remote credentials in
  automatic mode.

A completed local task is a candidate until it passes the independent boundary. That boundary may
be a later read-only review, CI policy, a maintainer action, or an explicit shutdown/rejection.
The Worker must not be able to bypass it through a prompt, a local decision, or a model response.

This is the required authority boundary. Automatic mode admits only the direct Claude executable
because its fail-closed Claude Code sandbox is part of the supported boundary; arbitrary custom
executables must use manual mode or an independently hardened integration. No additional
synchronous human-approval boundary should be invented for local editing, local tests, local
commits, or local repair unless the task owner explicitly configures one.

## 3. Unattended decision behavior

The Decision Worker should resolve ordinary development decisions from the task specification,
repository evidence and configured task policy, and record its assumptions and actions. It should
not turn every uncertainty into an interactive human prompt.

If the system cannot safely reach a candidate, it may automatically retry within the configured
budget, mark the task blocked/failed, preserve the worktree and evidence, or park it for later
inspection. “Parked for later inspection” is not the same as requiring a human to be online before
other tasks can proceed.

A task that reaches `blocked`, `review_pending` or `candidate_failed` must not be pushed or merged.
The same rule applies to a ready local candidate until the independent remote/main boundary accepts it.
It may be resumed, repaired or discarded later without weakening the remote/main boundary.

## 4. Acceptance and independent review

Acceptance and Reviewer remain automatic parts of the local loop:

- run all required checks;
- collect complete baseline-relative status, commit and untracked evidence;
- run the independent read-only Reviewer;
- apply bounded repair rounds;
- re-run acceptance and Review;
- produce a candidate with its evidence and assumptions.

Reviewer findings are first an automatic repair input. Exhausted budgets, incomplete evidence,
invalid output, duplicate findings or an unresolved finding produce a non-publishable
candidate/parked task; they do not by themselves require a synchronous takeover notification.

## 5. Notifications and shutdown

Progress, assumptions, failures and candidate readiness must be recorded in the event log. Live
notifications are optional delivery policy, not the local development control protocol.

Immediate shutdown remains appropriate for technical containment failures such as an unverified
Worker cleanup boundary, corrupted control state or an explicit operator kill. The system should
stop or park safely and retain evidence; it must not silently grant remote or main-branch access.

## 6. Current implementation

Automatic mode implements the local loop: policy decisions allow ordinary local development,
`AskUserQuestion` is converted to a denied interactive permission, the Decision Worker can
continue/redirect/answer/repair, acceptance and independent Review run without a human callback,
and unresolved situations become `blocked` candidates. The default task autonomy is unattended, requires a local commit, and permits two bounded
Decision Worker request retries. Automatic startup rejects non-Git/detached/bare/protected
repository states, malformed baselines, non-JSONL transports and non-Claude executables before
Worker startup.

Legacy `humanRequired`, takeover and approval fields remain for compatibility and explicit operator
control. They are not entered by ordinary uncertainty, and a legacy approval object cannot override
the deterministic remote push/main merge denial. The existing independent Review and protected
CI/release paths remain the final external checks. Built-in automatic Claude workers request a fail-closed Claude Code Bash sandbox with no
outbound domains; automatic command policy and credential filtering remain defense in depth.
Full host-level sandboxing for custom Worker integrations is separate hardening work.

## 7. Explicit non-goals of this target

This target does not authorize:

- remote push from the Worker;
- merge into `main` from the Worker;
- bypassing the independent integration boundary;
- silently treating incomplete evidence as success;
- claiming that a failed or parked task completed.

Coordinated multi-Worker scheduling, OS sandboxing and broader CLI compatibility remain separate
engineering milestones. They must not be used to add synchronous human approval to the local
development loop.
