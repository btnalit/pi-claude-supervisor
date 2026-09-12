# Changelog

All notable changes to this project will be documented here.

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
- Event-log sequence recovery and credential-shaped redaction.
- Bounded output capture, stdin-write timeout, process-group cleanup retry and stop preemption.
- Linux cgroup-v2 descendant cleanup, including a `setsid()` regression fixture, with required/auto modes.
- Lifecycle event retry/order preservation, output restoration after log failure and shutdown cleanup retries.
- Claude CLI 2.1.268 permission allow/deny and SIGTERM/SIGINT transport spike evidence.
- Event-driven JSONL `control_request`/`result`/exit events, permission responses, persistent Pi Decision Worker automation, bounded duplicate/turn handling, and outbound human-intervention webhooks.
- Long-task defaults are now 100 automatic turns, 4 hours wall time and 20 minutes without output; Decision Worker API failures alert human operators directly instead of attempting an LLM fallback.
- Automatic Decision Worker sessions now persist as Pi JSONL with a 0600 task registry. Unclean Pi restarts expose explicit `/supervise recover <task-id>` recovery; Claude work is not silently duplicated.
- Local tests and package-content checks.

### Limitations

- PTY transport and cross-version Claude CLI permission/session semantics are out of scope for this pinned release; Claude JSONL support remains opt-in outside automatic mode. The installed 2.1.268 CLI is covered by local permission and signal spikes, while the cgroup startup-attachment window remains.
- No automatic merge, deployment, release or publication is implemented.
