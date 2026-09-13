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

The current fixtures validate one prompt, multiple turns, session resume,
permission allow/deny and SIGTERM/SIGINT behavior with Claude Code 2.1.268.
The adapter regression suite also verifies event subscription, parsed
`permission_request` events, and the exact nested `control_response` envelope.
The automation spike additionally exercises a real Pi SDK Decision Worker with
Claude: ordinary completion, harmless Bash permission approval, and an
`AskUserQuestion` denial-to-text fallback followed by automatic verification.
The extension persists each automatic Decision Worker session as Pi JSONL plus a
0600 task mapping. Recovery is explicit and safe: after an unclean Pi restart,
`/supervise sessions` shows the task as `recoverable`, and `/supervise recover
<task-id>` restores the Decision Worker history before starting a new Claude
Worker.
Run the permission and signal probes explicitly when validating a CLI release:

```bash
npm run spike:permissions
SPIKE_PERMISSION_DECISION=deny npm run spike:permissions
npm run spike:signals
npm run spike:automation
SPIKE_AUTOMATION_PERMISSION=1 npm run spike:automation
SPIKE_AUTOMATION_QUESTION=1 npm run spike:automation
```

For this release, pin and record Claude Code `2.1.268` and its resolved
executable path. Record:

1. exact version and resolved executable path;
2. license and source revision;
3. startup, prompt delivery and output framing;
4. stop, process-group cleanup and crash behavior;
5. timeout, duplicate-message and recovery behavior;
6. human takeover and session-resume semantics;
7. no secret leakage in event logs or npm archives.

A passing worker task is not sufficient. The independent verifier must repeat the
relevant checks from a clean host perspective.

Automatic mode is enabled with `PI_CLAUDE_SUPERVISOR_MODE=auto`; it forces JSONL
and routes `result`, permission, and process-exit events to the persistent Pi
Decision Worker. `process-pipe` remains the manual compatibility mode. Human
escalation is outbound-only through `PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL`;
approval callbacks are deliberately not accepted without a separately
authenticated endpoint.

The tmux transport is selected with `PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux`. Before
release, manually verify: private-socket attach, multi-line paste, prompt
stability while Claude is busy, trust/permission dialog takeover, duplicate
send prevention, pane replacement refusal, pause/resume, owned-session stop,
adopted-session detach/re-adoption, bounded shutdown, and Pi shutdown without
closing an attached window. Use `--permission-mode plan`
and read-only tools for live Claude checks. Do not run JSONL and tmux control
against the same Claude process, and do not treat `capture-pane` text as a
structured permission response.

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
