# Implementation Review

An independent read-only reviewer examined the implementation before the final
hardening pass. The earlier review found release blockers in automatic startup
validation, shell-policy lexical handling, malformed custom Reviewer results and
stale security documentation; those findings remain covered by the current
implementation and regression tests. Its previous credential-filtering and
Claude-sandbox assumptions were deliberately superseded by the full-capability
unattended operating model.

Automatic mode still validates a non-bare Git worktree, an existing full baseline
commit, a non-protected branch, the Claude JSONL/tmux transport and the bare
`claude`/`claude.exe` command name. Startup resolves and pins an operator-owned,
non-writable executable path (or an explicit `PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE`
path), and the final pre-spawn check compares the current repository HEAD with the
exact startup HEAD. Automatic Claude workers retain their normal environment,
network, tools, agents, plugins and MCP configuration; `CLAUDECODE` is removed only
to permit nested Claude sessions. Cgroup/process cleanup owns all descendants, but
custom/nested descendants are trusted rather than denied by a nested-process guard.

## Findings addressed in this pass

- Policy now evaluates every shell argument as well as the executable and argv
  together. A dynamic argument (`$VAR`, `$(…)`, a glob) is denied on the commands
  where it could reach the boundary — repository, package, network, nested
  `claude`, interpreters and runners, or a dynamic command name — as a best-effort
  veto; elsewhere it is ordinary shell that Claude's own permission mode governs.
  Quoted heredoc bodies are evaluated according to their consumer (a shell runs
  them, a data sink stores them, anything else keeps them visible to the checks).
- Automatic startup pins a secure resolved Claude executable identity and rejects
  explicit paths, persists that identity for recovery, and rechecks the exact startup
  HEAD through the built-in adapter's final `preSpawnCheck` immediately before spawn.
- Manual Worker and verifier processes retain the baseline environment behavior;
  automatic Workers pass the full Supervisor environment, including credentials,
  helpers, custom settings and proxy/network variables, with only `CLAUDECODE`
  removed so nested Claude can start.
- Startup failures clean up a worker and do not let event-log failures hide the
  original error.
- Default wall-clock and no-output watchdogs stop stalled workers.
- New tasks clear stale handles and verification results.
- Custom verifier commands pass through the same deterministic policy gate.
- CI runs package-install and Pi-registration smoke tests.
- Spawn failures have a regression test; process termination escalates to the
  process group after a grace period.

## Residual risks and follow-up hardening

The final independent review also raised a pathname TOCTOU concern for Claude
file-tool authorization. That finding is intentionally recorded as a false positive
for this release's trusted local-development threat model: normal edits may replace
file contents, but automatic workers are not treated as hostile same-UID filesystem
actors, and this policy is a metadata guard rather than a host filesystem isolation
boundary. A future untrusted-worker mode would need a host-side broker or an OS
sandbox that prevents `.git` writes.

These are verified limitations and follow-up work after the automatic boundary
hardening:

- Automatic mode intentionally does not provide a host-level network sandbox or
  low-privilege account. Known direct remote push/main operations remain policy
  denied, but nested agents, plugins and MCP servers are trusted capabilities and
  need an independent repository/host boundary for absolute enforcement.
- Event contents can contain worker output or user messages; common credential
  patterns are redacted and sequence recovery is persisted, but broader structured
  secret coverage remains follow-up work.
- PTY semantics, permission-event handling, and process-group behavior with the
  target Claude Code versions still require dedicated transport evidence. Basic
  Claude JSONL prompt, multi-turn and session-resume fixtures now pass in the
  recorded Spike.
- Fault injection coverage now includes lifecycle-log failure, SIGTERM refusal,
  blocked stdin and managed orphan descendants; shutdown cleanup under injected
  adapter failure remains a follow-up failure-injection case.
- The default manual transport is process-pipe. Claude JSONL is mandatory for
  automatic mode; the remaining transport work concerns signal, shutdown and
  descendant-cleanup evidence rather than weakening the automatic boundary.

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
