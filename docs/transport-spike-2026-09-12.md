# Claude Code Transport Spike — 2026-09-12

## Scope

Validate the locally installed Claude Code CLI's headless stdin/output contract
without exposing credentials or allowing repository changes.

## Environment

- Node: `v26.8.1` (declared package minimum remains `>=22.19`)
- Claude Code: `2.1.268` (historical headless probe; current release validation uses `2.1.270`)
- Executable: resolved through `PATH` as `claude`
- Working directory: `/home/yancao/Work`
- Session persistence: disabled for the stateless fixture; enabled for the separate resume fixture
- Prompt: instructed the worker to reply exactly `SPIKE_OK` and use no tools

## Command shape tested

```text
claude --safe-mode --no-session-persistence \
  --session-id <fixture-uuid> -p \
  --input-format stream-json \
  --output-format stream-json --verbose --tools ""
```

Input was one JSONL user message sent through stdin. The command was launched
with a timeout and no shell interpolation of the worker command. The first
attempt used `--bare`; that option intentionally disables OAuth/keychain auth
and was discarded from the fixture.

## Observed result

`claude auth status` confirms the local account is logged in. An initial run
hit the account's HTTP 429 session limit, but after reset the corrected
streaming invocation completed successfully and emitted:

1. `system/init` with `session_id`, version, model, empty tools and capabilities;
2. `assistant` text exactly equal to `SPIKE_OK`;
3. terminal `result` with `is_error: false` and `terminal_reason: completed`.

A second fixture sent two JSONL user messages through one process and received
`FIRST` and `SECOND` in order. A third fixture created a persisted session and
successfully resumed it with `--resume <session-id>`, retrieving the marker
stored in the first turn. No repository mutation occurred.

## Decision

**Transport direction: conditional GO for a dedicated headless JSONL adapter.**

The CLI exposes a machine-readable input/output mode and a stable-looking
session identifier in this installed version. This is not yet a production compatibility claim: malformed/duplicate input,
exact permission semantics across CLI versions, signal behavior under an active
request, and process-group cleanup still require dedicated evidence. An opt-in
`claude-jsonl` framing mode now exists in `ProcessWorkerAdapter`, but the
existing default remains generic `process-pipe`.

## Required follow-up

Historical permission evidence was collected with Claude Code `2.1.268` using
`--permission-prompt-tool stdio --permission-mode default --tools Bash`:

- The CLI emitted `control_request` with `request.subtype=can_use_tool`,
  `request_id`, `tool_use_id`, `tool_name=Bash`, original `input`, and
  permission suggestions.
- An allow response must be nested as
  `response.response={behavior:"allow",updatedInput:<original input>}` and
  include the request id/tool use id. The command then executed and returned
  the exact marker.
- A deny response `{behavior:"deny",message:<host reason>}` prevented execution
  and produced a terminal result with a populated `permission_denials` array.
- An earlier probe confirmed that omitting `updatedInput` or placing the
  decision at the wrong envelope level is rejected as an invalid permission
  result.

The exact signal fixture also passed for historical version `2.1.268`: after `system/init`, a group
`SIGTERM` produced exit code `143` with no terminal result; group `SIGINT`
produced exit code `0` and a terminal result with `terminal_reason=
"aborted_streaming"` and `is_error=true`. The new adapter cgroup-v2 fixture
also killed a descendant launched with `detached:true`/`setsid()`.

These results are recorded by:

```bash
npm run spike:permissions
SPIKE_PERMISSION_DECISION=deny npm run spike:permissions
npm run spike:signals
```

Remaining evidence is malformed/duplicate CLI input, no secret leakage in
captured events, and the cgroup startup-attachment window. The current release
also passed a real Claude Code `2.1.270` tmux validation: owned multi-turn
interaction, pause/resume, explicit detach, and identity-bound restart
re-adoption. The adapter-level lifecycle track is now **GO** for the installed
CLI and host; atomic OS process containment remains follow-up work.
