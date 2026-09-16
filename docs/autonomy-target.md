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
repository baseline, captures the startup HEAD and requires that exact HEAD again at
final pre-spawn, requires a non-protected branch and a pinned operator-owned direct Claude
JSONL Worker or Supervisor-owned tmux bridge, and by default requires a local commit before a candidate is deliverable.

## 2. Hard authority boundary

Automatic Worker supervision uses either the structured JSONL transport or a
Supervisor-owned tmux bridge. The bridge runs Claude's stream-json protocol inside the live
PTY, renders a human-readable display, and returns private framed records through the same
PTY; adopted tmux sessions remain manual-only. Automatic local work still has no Supervisor API
for remote push or merging into `main` or another protected integration branch. It also refuses
known direct Bash forms of those operations, protected Git metadata writes and package publication.
Starting candidate work directly on a protected integration branch remains refused; automatic
repositories use a non-protected local branch.

Automatic Claude workers intentionally inherit credentials, helpers, network configuration and
custom Claude configuration. Agents, background tasks, plugins, MCP servers and nested Claude
processes are allowed and remain inside the Supervisor-owned process/cgroup cleanup boundary.
Those custom or nested capabilities are trusted local execution, not a second Supervisor
permission loop; an absolute remote/main security boundary for them must be provided by the
repository, host or protected integration service. To keep the direct Claude Bash boundary
observable, automatic startup adds the safe `default` permission mode when none is supplied and
rejects `--allowedTools`/settings rules that pre-authorize `Bash`; the Bash tool remains available
through a Supervisor-visible permission request. Settings are resolved from the effective
`HOME`/`CLAUDE_CONFIG_DIR`, and the automatic tmux bridge repeats this inspection immediately
before spawning Claude so a startup mutation fails closed.

A completed local task is a candidate until it passes the independent boundary. That boundary may
be a later read-only review, CI policy, a maintainer action, or an explicit shutdown/rejection.
No local decision or model response may turn a blocked candidate into a published result.

Automatic mode still admits only the bare direct Claude command name and pins its operator-owned
resolved executable. No additional synchronous human-approval boundary should be invented for
local editing, local tests, local commits or local repair unless the task owner explicitly
configures one.

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
repository states, malformed baselines, startup-HEAD races, the unstructured
process-pipe transport, Bash-preauthorizing Claude arguments/settings and non-Claude or untrusted
executable identities before Worker startup. The resolved
executable identity is persisted with the Decision Worker recovery record and must match
again during recovery.

Legacy `humanRequired`, takeover and approval fields remain for compatibility and explicit operator
control. They are not entered by ordinary uncertainty, and a legacy approval object cannot override
the deterministic known-command remote push/main merge denial. The existing independent Review
and protected CI/release paths remain the final external checks. Automatic Claude workers preserve
Claude Code's normal environment, network, tool, agent and MCP surface; `CLAUDECODE` is removed
only to permit intentional nested Claude sessions. The Supervisor-owned cgroup remains a cleanup
boundary, not a capability allowlist. Automatic tmux parent-death recovery leaves an empty
cgroup as evidence and permits `recover --takeover` only after Supervisor ownership, persisted
Worker/cgroup identity (including the cgroup device/inode), dead tmux-server identity, a gone
private session, and an empty cgroup are all confirmed. Automatic normal-exit cleanup retains an
empty cgroup until cwd lease release, and automatic lease acquisition records a no-spawn startup
marker that is cleared only after provisional Worker/cgroup identity is persisted before spawn.
Recovery atomically reserves the private socket until the replacement lease is written. Full host/repository
enforcement for untrusted custom or nested integrations remains the independent boundary's
responsibility.

## 7. Explicit non-goals of this target

This target does not authorize:

- remote push from the Worker;
- merge into `main` from the Worker;
- bypassing the independent integration boundary;
- silently treating incomplete evidence as success;
- claiming that a failed or parked task completed.

Coordinated multi-Worker scheduling, OS sandboxing and validation of future breaking CLI/API
changes remain separate engineering milestones. The supported Claude Code compatibility floor is
`2.1.270`; versioned install paths are not fixed, but a newer CLI should still rerun the real
spikes before release. These milestones must not be used to add synchronous human approval to the
local development loop.
