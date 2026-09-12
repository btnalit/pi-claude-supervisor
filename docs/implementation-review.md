# Implementation Review

An independent read-only reviewer examined the implementation before the final
hardening pass. The review found no blocker in the TypeScript/Pi registration
surface. The MVP intentionally does not provide OS sandboxing, low-privilege
execution, or network isolation; those are deferred security-hardening items,
not blockers for the lifecycle and recovery track.

## Findings addressed in this pass

- Policy now evaluates the executable and argv together, including Claude
  permission-bypass flags.
- Worker and verifier processes use a minimal environment; explicit worker
  variables can be selected with `PI_CLAUDE_SUPERVISOR_WORKER_ENV` or an
  embedding caller's `WorkerStartInput.env`.
- Startup failures clean up a worker and do not let event-log failures hide the
  original error.
- Default wall-clock and no-output watchdogs stop stalled workers.
- New tasks clear stale handles and verification results.
- Custom verifier commands pass through the same deterministic policy gate.
- CI runs package-install and Pi-registration smoke tests.
- Spawn failures have a regression test; process termination escalates to the
  process group after a grace period.

## Residual risks and follow-up hardening

These are verified limitations and follow-up work, not reasons to stop the
lifecycle track:

- OS sandbox, lower-privilege execution, and network allowlisting are not
  provided by the adapter. The caller may run with explicitly authorized host
  permissions; the deployment owner accepts responsibility for that boundary.
- Event contents can contain worker output or user messages; common credential
  patterns are now redacted and sequence recovery is persisted, but broader
  structured-secret coverage remains follow-up work.
- PTY semantics, permission-event handling, and process-group behavior with the
  target Claude Code versions still require dedicated transport evidence. Basic
  Claude JSONL prompt, multi-turn and session-resume fixtures now pass in the
  recorded Spike.
- Fault injection coverage now includes lifecycle-log failure, SIGTERM refusal,
  blocked stdin and managed orphan descendants; shutdown cleanup under injected
  adapter failure remains a follow-up failure-injection case.
- The default transport is process-pipe. Claude JSONL framing is opt-in; the
  next priority is signal, shutdown and descendant-cleanup evidence rather than
  network or low-privilege isolation.

## Evidence

The review was performed against `src/`, `package.json`, workflows and tests.
The final local evidence is recorded by:

```text
npm ci --ignore-scripts --include=dev
npm run check
npm run test:pi
npm run test:install
npm audit --audit-level=high
npm run build
```

All commands passed on Node `v26.8.1`; Node `>=22.19` remains the declared
runtime target and still requires validation on the minimum supported version.
