# Changelog

All notable changes to this project will be documented here.

## [0.6.0](https://github.com/btnalit/pi-claude-supervisor/compare/v0.5.5...v0.6.0) (2026-09-16)


### Features

* preserve full automatic Claude capabilities ([#34](https://github.com/btnalit/pi-claude-supervisor/issues/34)) ([f3ef24b](https://github.com/btnalit/pi-claude-supervisor/commit/f3ef24bf4e2bbbce27516a0e36c6000a00222b71))

## [0.5.5](https://github.com/btnalit/pi-claude-supervisor/compare/v0.5.4...v0.5.5) (2026-09-15)


### Bug Fixes

* ignore expected tmux teardown races ([ac7ad57](https://github.com/btnalit/pi-claude-supervisor/commit/ac7ad57efa835764ea02fa138f8837947a5d9c39))

## [0.5.4](https://github.com/btnalit/pi-claude-supervisor/compare/v0.5.3...v0.5.4) (2026-09-15)


### Bug Fixes

* harden unattended local lifecycle ([4f68760](https://github.com/btnalit/pi-claude-supervisor/commit/4f6876044cd8be00b0376239377b02b70aae8473))

## [0.5.3](https://github.com/btnalit/pi-claude-supervisor/compare/v0.5.2...v0.5.3) (2026-09-15)


### Bug Fixes

* harden unattended local lifecycle ([#27](https://github.com/btnalit/pi-claude-supervisor/issues/27)) ([2bb29d3](https://github.com/btnalit/pi-claude-supervisor/commit/2bb29d3c31f5196f208716723d89b6b538777939))

## [0.5.2](https://github.com/btnalit/pi-claude-supervisor/compare/v0.5.1...v0.5.2) (2026-09-14)


### Bug Fixes

* harden automatic review lifecycle ([fefa5c5](https://github.com/btnalit/pi-claude-supervisor/commit/fefa5c5b39fd2411b5e82df384074983252263ca))

## [0.5.1](https://github.com/btnalit/pi-claude-supervisor/compare/v0.5.0...v0.5.1) (2026-09-14)


### Bug Fixes

* harden single-worker recovery lifecycle ([14c01ec](https://github.com/btnalit/pi-claude-supervisor/commit/14c01ec610b1210eda1ea2d60269fad25b8b3575))

## [0.5.0](https://github.com/btnalit/pi-claude-supervisor/compare/v0.4.1...v0.5.0) (2026-09-14)


### Features

* add acceptance review repair loop ([fe29c78](https://github.com/btnalit/pi-claude-supervisor/commit/fe29c78a228494768aa52b03ee1bf1545b079119))

## [Unreleased]

### Hardening implemented in working tree (not yet released)

- Split JSONL in-process `repairableSession` from cross-restart `persistentSession` and eliminate duplicate terminal transitions.
- Make `verifying` stop/shutdown cleanup authoritative, with abortable acceptance and Reviewer operations.
- Pause and rebase the no-output watchdog clock across pause/resume while retaining the cumulative deadline.
- Include staged, unstaged and bounded untracked evidence in independent Review, with symlink/path safety and fail-closed completeness.
- Harden assistant-message output framing, startup/runtime preflight, permission gates, bounded acceptance buffers and lifecycle progress reporting.
- Close automatic startup baseline/worktree/branch validation gaps, including persisted recovery baselines and the final pre-spawn boundary recheck.
- Replace shell-policy lexical bypasses with quote-aware parsing, nested-shell inspection and protected Git-ref checks; deny dynamic shell expansions while preserving literal argv values, and reject arbitrary non-Claude automatic executables.
- Normalize malformed custom Reviewer values to blocking reports, persist recovery baselines and the resolved Claude executable identity, filter automatic environment variables with a deny-by-default allowlist, and compare the exact startup HEAD at the adapter spawn boundary.
- Keep protected CI checks on the exact checked-out commit while giving automatic-mode fixtures a local validation branch and an owned deterministic Claude executable.
- Add a Supervisor-owned automatic tmux bridge that renders Claude stream-json in a live PTY and carries structured records through private framing instead of an independent event sidecar; adopted sessions remain manual-only.
- Add parent-identity tmux guardians, guarded Linux bootstrap readiness/cleanup, explicit nested-Agent/background-reviewer denial, and tolerant Reviewer prose/fence/repeated-JSON parsing with separate display-truncation markers.
- Preserve the complete Supervisor environment when automatic callers provide partial overrides, while still removing only `CLAUDECODE`.
- Keep direct Claude Bash permission events observable by adding a safe default mode and rejecting Bash preauthorization in CLI/settings configuration.
- Permit verified automatic tmux recovery after the guardian removes the session, with dead-owner/process/cgroup/session proofs before reclaiming the cwd lease; bind recovery to persisted Worker/cgroup identities, persist phased cleanup-pending state before reservation, replace the same lease record atomically, and repeat the effective-settings permission check immediately before the tmux bridge spawns Claude.
- Retain verified empty automatic cgroups until cwd lease release, persist a no-spawn startup marker and provisional identity before Worker spawn, bind lock release/reclamation to directory identity and owner tokens, and pin the automatic tmux bridge cwd.

### Release readiness

- The exact-head read-only review, real editable Claude `2.1.270` repair/reacceptance drill and cleanup/lease evidence are recorded in `docs/automation-hardening-plan.md`. The review's pathname TOCTOU concern is explicitly accepted as a false positive for the trusted local-development threat model; host-side broker isolation remains future work for an untrusted-worker mode.

### Added

- Structured task specifications with Goal, scope, constraints, forbidden actions and multiple argv-based acceptance checks.
- Independent read-only Reviewer results with bounded findings and automatic repair rounds.
- JSONL malformed-record handling and duplicate result/permission suppression fixtures.
- Active JSONL request shutdown coverage and deterministic acceptance/review tests.
- Durable Decision Worker recovery claims with stale-owner reconciliation and explicit fail-closed takeover.
- Identity-bound tmux handoff cleanup and recovery/lease lifecycle coverage.
- Claude Code 2.1.270 bounded stability matrix evidence in `docs/stability-matrix-2.1.270.md`.

## [0.4.1](https://github.com/btnalit/pi-claude-supervisor/compare/v0.4.0...v0.4.1) (2026-09-14)


### Bug Fixes

* reconcile detached tmux leases and validate prompts ([d20262c](https://github.com/btnalit/pi-claude-supervisor/commit/d20262c8481ca761a48f7dc2b877951173d4681e))

## [0.4.0](https://github.com/btnalit/pi-claude-supervisor/compare/v0.3.0...v0.4.0) (2026-09-13)


### Features

* add cross-process cwd leases and cancellable startup ([#17](https://github.com/btnalit/pi-claude-supervisor/issues/17)) ([448cbdb](https://github.com/btnalit/pi-claude-supervisor/commit/448cbdb4c6b5dd02b9ea07ba660d3689b7e2ace8))

## [0.3.0](https://github.com/btnalit/pi-claude-supervisor/compare/v0.2.2...v0.3.0) (2026-09-13)


### Features

* add safe tmux Claude worker transport ([1706153](https://github.com/btnalit/pi-claude-supervisor/commit/1706153289f9a6f7f9f59b2763ed98d061b79204))
* add cross-process canonical cwd leases and identity-bound tmux handoff
* make startup cancellation scoped per start and shutdown cleanup fail closed
* add cgroup-v2 required/auto/off policies with verified fallback cleanup
* harden owned/adopted tmux lifecycle, pane identity validation, and restart re-adoption
* validate real Claude Code 2.1.270 tmux multi-turn, pause/resume, and re-adoption behavior

## [0.2.2](https://github.com/btnalit/pi-claude-supervisor/compare/v0.2.1...v0.2.2) (2026-09-12)


### Bug Fixes

* baseline no-output watchdog at worker start ([6596d85](https://github.com/btnalit/pi-claude-supervisor/commit/6596d857522e61be7a4aa837dcd74f520300da0a))

## [0.2.1](https://github.com/btnalit/pi-claude-supervisor/compare/v0.2.0...v0.2.1) (2026-09-12)


### Bug Fixes

* make npm publication idempotent ([27eec2c](https://github.com/btnalit/pi-claude-supervisor/commit/27eec2c10f93e4ca3edcc52dc4ac58d2cfad0764))
* publish npm archive reliably ([14cd7aa](https://github.com/btnalit/pi-claude-supervisor/commit/14cd7aa497863cce2579ed84c03581cbc45818d9))

## [0.2.0](https://github.com/btnalit/pi-claude-supervisor/compare/v0.1.0...v0.2.0) (2026-09-12)


### Features

* persist decision worker sessions across restarts ([a926c0e](https://github.com/btnalit/pi-claude-supervisor/commit/a926c0e4f3455cbc5dfbbcff1441d1d1497939ed))
* persist Decision Worker sessions and add release gates ([de73d29](https://github.com/btnalit/pi-claude-supervisor/commit/de73d29549605026985db301112ae3745d164bd7))

## [0.1.0] - Unreleased

### Added

- Standard Pi/npm package metadata and TypeScript extension entry point.
- Dependency-free process-pipe WorkerAdapter with process-group control.
- Explicit Supervisor state machine, append-only event log and turn budget.
- Deterministic Policy Gate and independent verification phase.
- Minimal worker environment, argv-aware permission policy, watchdog timeouts and startup cleanup.
- Opt-in Claude JSONL framing with duplicate-message suppression and transport Spike evidence for prompt, multi-turn and session resume.
- Opt-in tmux/PTY transport with private owned sessions, explicit existing-session adoption, human takeover and prompt-gated multi-line input.
- Event-log sequence recovery and credential-shaped redaction.
- Bounded output capture, stdin-write timeout, process-group cleanup retry and stop preemption.
- Linux cgroup-v2 descendant cleanup, including a `setsid()` regression fixture, with required/auto modes.
- Lifecycle event retry/order preservation, output restoration after log failure and shutdown cleanup retries.
- Historical Claude CLI 2.1.268 permission allow/deny and SIGTERM/SIGINT transport spike evidence; current release validation uses Claude CLI 2.1.270.
- Event-driven JSONL `control_request`/`result`/exit events, permission responses, persistent Pi Decision Worker automation, bounded duplicate/turn handling, and outbound human-intervention webhooks.
- Long-task defaults are now 100 automatic turns, 4 hours wall time and 20 minutes without output; Decision Worker API failures alert human operators directly instead of attempting an LLM fallback.
- Automatic Decision Worker sessions now persist as Pi JSONL with a 0600 task registry. Unclean Pi restarts expose explicit `/supervise recover [--takeover] <task-id>` recovery; Claude work is not silently duplicated.
- Local tests and package-content checks.

### Limitations

- tmux/PTY screen state is not Claude JSONL: trust, permission and ambiguous TUI states require human handling. Cross-version Claude CLI permission/session semantics remain outside the pinned compatibility claim. Historical permission and signal spikes use 2.1.268; current tmux validation uses 2.1.270, while the cgroup startup-attachment window remains.
- No automatic merge, deployment, release or publication is implemented.
