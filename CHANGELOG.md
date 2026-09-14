# Changelog

All notable changes to this project will be documented here.

## [0.5.0](https://github.com/btnalit/pi-claude-supervisor/compare/v0.4.1...v0.5.0) (2026-09-14)


### Features

* add acceptance review repair loop ([fe29c78](https://github.com/btnalit/pi-claude-supervisor/commit/fe29c78a228494768aa52b03ee1bf1545b079119))

## [Unreleased]

### Added

- Structured task specifications with Goal, scope, constraints, forbidden actions and multiple argv-based acceptance checks.
- Independent read-only Reviewer results with bounded findings and automatic repair rounds.
- JSONL malformed-record handling and duplicate result/permission suppression fixtures.
- Active JSONL request shutdown coverage and deterministic acceptance/review tests.

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
- Automatic Decision Worker sessions now persist as Pi JSONL with a 0600 task registry. Unclean Pi restarts expose explicit `/supervise recover <task-id>` recovery; Claude work is not silently duplicated.
- Local tests and package-content checks.

### Limitations

- tmux/PTY screen state is not Claude JSONL: trust, permission and ambiguous TUI states require human handling. Cross-version Claude CLI permission/session semantics remain outside the pinned compatibility claim. Historical permission and signal spikes use 2.1.268; current tmux validation uses 2.1.270, while the cgroup startup-attachment window remains.
- No automatic merge, deployment, release or publication is implemented.
