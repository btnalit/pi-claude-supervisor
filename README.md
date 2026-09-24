# pi-claude-supervisor

[![CI](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/pi-claude-supervisor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-claude-supervisor)](https://www.npmjs.com/package/pi-claude-supervisor)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English · [简体中文](README.cn.md)

## What it is

pi-claude-supervisor is a standard [Pi](https://pi.dev) agent extension package that
supervises Claude Code for unattended local development. Pi owns the task's
lifecycle, state machine, policy decisions, acceptance checks, and an
independent Review step; Claude Code is the Worker that does the editing. The
extension is a single `pi install`: Pi discovers and loads it itself, there is
no separate build or binary, and there is nothing to configure inside Pi
beyond environment variables.

There is a hard boundary the Worker can never cross, regardless of its own
permission settings: it may not push to a remote, merge into `main` or an
integration branch, open a pull request, or run a remote CLI mutation;
`.git` metadata writes and destructive rewrites of protected branches are
denied outright. Everything else — edits, tests, shell commands, local
commits — follows the policy you configure. The extension itself never
merges, deploys, releases, or publishes anything at runtime.

How the loop works, once a task starts:

- The Worker works a turn; when it stops (`turn_completed`), Pi's Decision
  Worker — a persistent Pi session with read-only tools — chooses to
  continue, redirect, answer a question, verify, stop, or park the task.
- `verify` runs the acceptance checks (the default `git diff --check`, or the
  checks from a `--spec` file).
- An independent Reviewer — a fresh, read-only Pi session — returns pass,
  revise, or human.
- `revise` sends the Worker a bounded repair turn (up to `maxRepairRounds`);
  a pass promotes the work to a `completed` candidate.
- Unresolvable work is parked as `blocked` (a non-publishable candidate, not
  a crash); crashes and timeouts become `failed`.
- Every terminal state emits a candidate notice, in the Pi UI and optionally
  to a webhook (WeCom or generic JSON, with retries).

## Quick start

Requirements: Pi 0.85+, Node.js 22.19+, Claude Code 2.1.270+ (interactive
hooks verified on 2.1.273), Linux for the cgroup and tmux features.

Install it like any other Pi extension:

```text
pi install npm:pi-claude-supervisor
```

That's the whole installation — Pi loads the package's `./src/index.ts`
extension directly and registers the `/supervise` command. Configuration is
environment variables only, set before starting Pi (or in
`~/.config/pi-claude-supervisor/env`):

```bash
export PI_CLAUDE_SUPERVISOR_MODE=auto
export PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux
# Optional: candidate/failure notifications
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL='https://example.invalid/webhook'
export PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT=generic
```

Then, inside any Pi session:

```text
/supervise start implement the requested change
/supervise adopt-tmux my-tmux-session implement the requested change
/supervise start --deadline 8h a large multi-worktree change
```

Both accept `--spec <file>` and `--deadline <duration>` (`8h`, `90m`, `0` for
no deadline) ahead of the task text.
Watch a task with `/supervise status <task-id>` or `/supervise sessions`; for
a tmux transport, attach directly with the `tmux -S <socket> attach -t
<session>` command each of these prints. `/supervise stop <task-id>` closes
the task; on the interactive tmux transport a completed task instead leaves
the session open for you by default (see below).

## Modes and transports

`PI_CLAUDE_SUPERVISOR_MODE=auto` (or `PI_CLAUDE_SUPERVISOR_AUTOMATION=1`)
enables automatic supervision — the Decision Worker/Reviewer loop above.
Without it, `/supervise` still exposes its commands, but a Worker runs
without that loop.

| Transport | `TRANSPORT` | `TMUX_MODE` | What the Worker runs as | Use it when |
| --- | --- | --- | --- | --- |
| Interactive tmux | `tmux` | `interactive` (default) | The real, unmodified Claude Code TUI in a tmux pane, driven by Claude Code hooks | You want to watch or occasionally type into the exact session Claude uses |
| Headless JSONL | `jsonl` (default in `auto` mode) | – | `claude -p --input-format stream-json`, no terminal | Every permission-relevant command must be visible to the Supervisor |
| tmux bridge | `tmux` | `bridge` | Claude's stream-json protocol, rendered into a tmux pane | A visible pane with the older structured (pre-hook) transport |
| Manual (process-pipe) | `process-pipe` (default when `MODE` is unset) | – | The worker's stdin/stdout as plain text | Exposing the commands without automatic supervision |

## Interactive tmux mode (hooks)

`PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux` defaults to running the real,
unmodified Claude Code TUI in the tmux pane — the same interface you would
see running `claude` yourself — instead of the structured stream-json
bridge. You can attach to the printed `attach=...` command at any time and
watch, or type into the session yourself; Pi reports its events through
Claude Code's own hooks rather than scraping the screen.

When the extension loads with `PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux` in
interactive mode (the default `TMUX_MODE`), it automatically installs a small
relay command for the eight Claude Code hook events it uses into
`~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) — idempotent,
and announced once in the Pi UI. Set
`PI_CLAUDE_SUPERVISOR_AUTO_INSTALL_HOOKS=0` to opt out; `/supervise
uninstall-hooks` removes the entry, and `/supervise install-hooks` remains
available to install it by hand. The relay is a ~1ms no-op in any Claude
session no Supervisor is listening for. An owned `/supervise start` does not
depend on this at all — it passes its own `--settings` file — but
`/supervise adopt-tmux` runs inside your normal Claude Code configuration and
needs the relay installed there.

```text
/supervise start <task>
/supervise adopt-tmux <tmux-session> <task>
```

Pi intervenes when Claude stops a turn (`Stop`; an API/model failure mid-turn
arrives as `StopFailure` and is treated as an errored turn the Decision
Worker can retry, and a minute of idle prompt with no stop signal closes the
turn as a safety net), when Claude is about to show you a real permission
prompt (only then — every ordinary tool call is otherwise left to your own
Claude Code permission mode), when Claude asks `AskUserQuestion` (the
Decision Worker picks an answer and Claude continues with it as ordinary
text, exactly as in headless mode), and when the session exits. Before that
prompt, a `PreToolUse` veto point only ever denies a known direct remote
push/merge/PR or other destructive/protected-branch operation (or forwards an
`AskUserQuestion`); it never second-guesses a normal edit, read, or local
command — those reach your own permission mode with no decision from Pi at
all.

**What this means for the boundary.** Interactive mode deliberately skips the
headless-mode check that refuses inherited `Bash` pre-authorization or an
`auto`/`bypassPermissions` mode in your Claude settings: your own
configuration governs what Claude may do without asking, exactly as when you
run Claude yourself. Anything your settings already allow never reaches the
Decision Worker; its judgment applies only where Claude would have asked
*you*. The hard boundary (remote push/merge/PR, remote CLI mutation, `.git`
writes, destructive protected-branch rewrites) is enforced by `PreToolUse`
regardless of permission mode — verified against `auto` mode on Claude Code
2.1.273 — and is the only guarantee this mode makes beyond your own
settings. Use headless (`bridge`) mode when every `Bash` call must be visible
to the Supervisor.

**Adopting an idle session.** `adopt-tmux` types the task into the session
only when Claude is idle at its prompt; a session caught mid-turn keeps its
current work and is judged on its next `Stop` instead.

**Human coexistence.** If you type into the attached session, automation
pauses (`human_takeover`, visible as a warning) until you run `/supervise
resume-auto <task-id>`; the turn that completed while you were driving is
replayed to the Decision Worker at that point, so nothing already finished is
lost. If you type and walk away, the pause lifts on its own once the Worker has
sat idle for `HUMAN_IDLE_RESUME_MS` (default 30 minutes) after both your last
prompt and the end of your last turn (`automation_auto_resumed`); a turn left
waiting mid-way (a Claude dialog, say) is reported once instead. An explicit
`/supervise takeover`, and a recovered task until you resume it, waits for
`resume-auto`.

**Completion hands the session back.** Unlike other transports, a completed
task by default disconnects Pi from the session instead of closing it, so you
can keep working in the same window or review what Claude did; `/supervise
stop <task-id>` closes it explicitly, and a blocked or failed candidate still
stops the Worker as usual. Set
`PI_CLAUDE_SUPERVISOR_CLOSE_WORKER_ON_COMPLETION=1` to restore the old
close-on-completion behavior. The hand-back is clean, not a bare disconnect:
before reporting the candidate ready, Pi moves every process out of its
private cgroup into its parent (instead of killing them) and stops the
guardian process, and the tmux server and pane are left alone — the session
survives a Pi restart with nothing left owing it. Afterward it is an ordinary
tmux session with no Supervisor attached; `tmux -S <socket> attach -t
<session>` reaches it directly, and `/supervise adopt-tmux` can babysit it
again exactly as it would any other externally created session.

**Cost accounting limits.** The TUI's `Stop` hook has no `total_cost_usd` or
token `usage` (that only comes from Claude's own `result` stream-json record,
which the TUI does not emit), so cost tracking in interactive mode only
counts turns, not dollars; `--max-budget-usd` is also unavailable (Claude
Code only enforces it under `-p`) and is not passed to an interactive launch.
Set `autonomy.maxWorkerCostUsd` expecting it to have no effect in interactive
mode, or use bridge/jsonl mode when a hard cost cap matters.

**Trust dialog.** The very first time Claude Code runs in a given directory
it shows its own one-time "do you trust this folder" dialog before any hook
fires. For a session that `/supervise start` launched, the launcher accepts
it automatically — only when the pane's directory is the task directory. An
adopted session was started by you, so you already answered it.

## Headless mode (JSONL)

`PI_CLAUDE_SUPERVISOR_TRANSPORT=jsonl` runs Claude as `claude -p
--input-format stream-json`, with no terminal at all; it is the default
transport once `PI_CLAUDE_SUPERVISOR_MODE=auto` is set. Every permission
request Claude makes is answered by the Supervisor — the deny list, routine
in-cwd edits, and read-only/local-dev shell commands are answered by policy
alone, and everything else goes to the Decision Worker. `worker_usage`
events carry full token and cost accounting from Claude's own `result`
records, so `--max-budget-usd` and the token/cost reporting below both work
as expected. Use this transport when nothing should ever run without the
Supervisor being able to see it, or when you don't need to attach.

## Safety boundary

- Always denied, regardless of policy or permission mode: remote push,
  merge/PR into `main` or an integration branch, other remote CLI mutations,
  `.git` metadata writes, and destructive rewrites of protected branches
  (`reset`, `update-ref`, `symbolic-ref`, or a delete/move/force `branch`).
  A shell argument the policy cannot see through (`$VAR`, `$(…)`, a glob)
  is vetoed, best-effort, only on the commands where it could reach that
  boundary — git, gh, npm/pnpm/yarn, curl/wget/ssh, a nested `claude`, or an
  interpreter/runner such as `eval`, `sh -c`, `xargs`, `find -exec`. A quoted
  heredoc body is judged by its consumer: a shell runs it, `cat > file` or
  `git commit -m` stores it. Everything else (`for f in …; do echo "$f"`,
  `rm -rf ./dist`, a Write to Claude's own scratchpad) follows the configured
  policy — Claude's own permission mode governs it, as when you run Claude.
- `autonomy.permissionAuthority` (`policy` | `hybrid` default |
  `decision-worker`) controls who answers a permission request — every
  request in headless mode, and in interactive tmux mode only those Claude
  would otherwise have shown you as a prompt: `hybrid` answers routine
  in-cwd edits and local read-only/dev shell commands from policy alone, and
  sends every ambiguous request to the Decision Worker (a policy denial is
  always applied directly).
- **Baseline, not branch.** Any branch, including `main`, may be supervised;
  the candidate only has to descend from the recorded baseline commit
  (`merge-base --is-ancestor`). A branch change mid-task is recorded
  (`worker_branch_changed`), not rejected, and a candidate on a protected
  branch is reported in its notice (`branch`, `protectedBranch`), not parked.
  `checkout`/`switch` onto `main` is allowed; only a destructive rewrite of a
  protected branch name is denied. Claude Code's own "branch first if you're
  on the default branch" guidance is advisory, not enforced.
- Worker commands launch without a shell. Automatic mode admits only the bare
  `claude` command name and pins an operator-owned, non-writable executable
  path (`PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE` to pin one explicitly).
- On Linux, a cgroup v2 boundary cleans up every descendant, including
  `setsid()` descendants; `required` mode fails closed instead of falling
  back.
- A wall-clock deadline (4 hours by default, `--deadline 8h` per task or
  `DEADLINE_MS`) bounds a task. Reaching it does not kill the work: the
  Decision Worker is warned ahead of time (`DEADLINE_WARNING_MS`, 15 min) and
  told to steer the Worker to a wrap-up, and once the deadline passes a
  close-out window opens (`DEADLINE_GRACE_MS`, 30 min) in which an idle Worker
  is verified and reviewed instead of stopped, a `wait` decision is no longer
  honored, and a repair round tells the Worker how long it has left. Only when
  the close-out window has also elapsed is the Worker stopped outright
  (`worker_watchdog_timeout`), and on an adopted interactive session that stop
  is a release: Claude keeps running, unsupervised. The close-out belongs to
  automatic tasks; a manual task is stopped at the deadline as before, and
  `DEADLINE_GRACE_MS=0` restores that for automatic ones too. A 20-minute
  no-output watchdog (`NO_OUTPUT_TIMEOUT_MS`, counted from the Worker's last
  output or the Supervisor's last message to it) stops a Worker that falls
  silent mid-turn; an automatic Worker that is merely idle that long (waiting on
  background work that never came back) is verified instead
  (`worker_idle_timeout`), and a Worker under human takeover is never timed out.
- Acceptance checks, evidence collection, and the Reviewer share an abort
  signal, so a stop or shutdown does not wait for a full command or model
  timeout.
- Only one cwd lease is held per task; concurrent tasks need separate
  worktrees.

## Publishing a verified candidate

By default a task ends at a **verified local candidate**: acceptance and the
independent Reviewer pass, and the Worker never had remote authority at any
point. `REMOTE_AUTHORITY=push` (or `--remote push`) adds a **publish phase**
after that verdict: the Supervisor records the verified commit, grants a narrow
one-shot authority, and asks the Worker to push its own branch. `pr` also lets
it open a pull request. The Worker performs the push — the Supervisor never
does — and the Supervisor then confirms it read-only (`git ls-remote`, and
`gh pr list` for `pr`) before completing the task; the candidate notice carries
the pull request URL. A publish that cannot be confirmed blocks the candidate,
which stays deliverable locally.

The grant is deliberately unforgiving, and both commands are matched literally —
an option nobody reviewed is refused rather than assumed harmless. It admits
exactly `git -C '<task directory>' -c core.hooksPath=/dev/null -c push.followTags=false push <remote> <verified commit>:refs/heads/<branch>`,
with no other option. The refspec names the **verified commit**, not the branch:
git pushes exactly that object, so a commit the Worker makes during the publish
turn stays local ("Everything up-to-date") instead of riding the grant. `-C` is
**required, absolute and byte for byte the task directory** — no normalization,
no realpath — because Claude's Bash tool keeps its working directory between
calls and `cd` is ordinary local work, so without it the grant could be spent
in any other clone, and every looser comparison had a spelling the Supervisor
resolved one way and git another (`.` against the Supervisor's cwd,
`/proc/self/cwd`, and `<cwd>/link/..`, which Node's own realpath collapses
lexically while the kernel follows the link). The instruction spells the exact
directory, so no other spelling is needed. The hooks path is **pinned** on that one command so no
`pre-push` hook a Worker could have installed (by any door: `git init
--template=`, an archive, a `chmod`) runs inside the granted push with the
Worker's credentials, and `push.followTags=false` is pinned so a
`followTags=true` set through any file the policy never sees cannot make the
one push also plant a tag the grant never named (a tag is what release
automation keys on). Both are ref and hook selection, not transport, so they
override no legitimate per-repository setting. For `pr` a `gh pr create --repo <pinned remote URL>
--head <candidate branch> …` limited to title, body, base, draft, assignee and
label: the pull request opens in the granted remote's repository, full stop —
without `--repo`, gh picks a base repository from the remotes (`upstream` on a
fork) that the grant never named and the confirmation never reads. The
repository is the `host/owner/repo` behind the remote's URL (an SSH-config host
alias is translated through `ssh -G`, as gh does); a remote whose URL is not
one — a local path, an alias with no translation — gets no `pr` grant. Every
word the grant supplies is shell-quoted, so a branch named `feat/$ticket` still
round-trips through the policy.

The grant is only issued for a commit that *is* the verified tree: the working
tree must be clean (untracked files included — a new file may be part of the
verified behavior), and HEAD must not have moved since the evidence the Reviewer
judged was read. The repository's Git directory must be its own `.git` or a linked worktree's
`.git/worktrees/<name>` (not a `--separate-git-dir` pointer). A dirty tree first costs a repair round asking the Worker to
commit what belongs to the candidate; only when none is left, or when HEAD
moved, does the task end at the local candidate with a `not published:` reason
instead of a grant. A remote that cannot be reached at confirmation time leaves
the publish *unconfirmed* (the candidate stays deliverable), never "refuted".

Refused with or without a grant: every push option (`-u`, `--force`,
`--force-with-lease`, `--delete`, `--mirror`, `--all`, `--tags`, `--no-verify`,
`--push-option`, `--receive-pack`, …), any `-c` but the two pins (in that order), a
branch or `HEAD` as the refspec source, a bare `git push`, another remote,
branch or commit, a protected branch, a shell wrapper (`sh -c`, and a heredoc
piped into a shell), a dynamic word, a second statement, `git push` without
`-C`, a `-C` that is not the task directory byte for byte (another directory, a
relative path, `/proc/self/cwd`, a symlink or `..` inside it),
`gh pr create` without `--repo <pinned URL>` or without `--head <candidate
branch>` (a `--head` swallowed as another option's value does not count),
`gh pr create --body-file/-F/--template` (which would post the contents of an
arbitrary local file), `--web`, another `--repo`, `gh pr merge`, `gh api`,
`gh release` and `npm publish`. Changing the repository's remotes (`git remote
set-url|add|rename|…`, behind git's own `--git-dir`/`--work-tree` options or
`remote`'s own `-v` too) is denied outright, and so is reconfiguring where a
push goes or what runs during it — `git config` writes to `remote.*`,
`url.*.insteadOf`, `push.*`, `credential.*`, `http.*`, `include.path`/
`includeIf.*`, `init.*`, `core.sshCommand` or `core.hooksPath`, `git config
--edit`, `git init --template=…`, `git init|clone --separate-git-dir=…`, and any statement that names `.git/config` or
`.git/hooks` unless it plainly only reads (`cat`, `grep`, `ls`, …) — so the
granted remote cannot be repointed underneath the confirmation, which pins both
the fetch and the push URL and scrubs `GIT_DIR`/`GIT_CONFIG_*` from its own
environment. Behind all of that sits one rule the text guards do not need:
the remote's resolved fetch and push URLs — **every** one of them
(`git remote get-url --all` / `--push --all`; git pushes to each `pushurl`,
not only the first it prints), rewrites applied — are recorded when the task
**starts**, before the Worker runs a command, and required unchanged both
when the grant is issued *and* at the moment the granted push is authorized.
So a `pushInsteadOf`, `pushurl` or extra destination added during the task by
*any* means (`~/.gitconfig`, a script, an include the policy never saw), even
as the first command of the publish turn, refuses the push and revokes the
grant, while an operator's pre-existing rewrite, already in the baseline, is
not. A recovered task keeps its recorded baseline and never takes a new one;
a remote that could not be resolved at the first start is recorded as such and
never granted. This is a policy over the command text: a script the Worker writes
and runs is outside what it can see, as [autonomy-target.md](docs/autonomy-target.md)
says of every text-level rule; absolute isolation is the host boundary's job.

The grant is **one-shot**: it is revoked the moment the publish turn completes,
not when the next decision arrives, and it is pinned to the remote's URL as well
as its name. A Worker that changes the tree during that turn voids it and is
re-verified in full — an edit left uncommitted counts as a change, exactly like a new
commit; because the grant named the commit, the notice can say whether the
verified commit landed before the tree moved on. Before verification a refused push says the grant is coming
rather than leaving the Worker to guess, and a task that ends without a
confirmed publish says so in its candidate notice instead of reporting a bare
"ready".

## Task specs

`--spec file.json` accepts:

```json
{
  "goal": "Implement the requested change",
  "scope": ["src/"],
  "constraints": ["Keep the public API compatible"],
  "forbidden": ["Do not publish artifacts"],
  "acceptance": [
    { "id": "tests", "name": "tests", "command": "npm", "args": ["test"], "required": true, "timeoutMs": 120000 }
  ],
  "maxRepairRounds": 3,
  "autonomy": {
    "unattended": true,
    "requireLocalCommit": true,
    "maxDecisionRetries": 4,
    "permissionAuthority": "hybrid",
    "maxWorkerCostUsd": 20
  }
}
```

Checks always run with argv, never through a shell. A plain-text task (no
`--spec`) becomes a `goal` with the default `git diff --check` acceptance
check (120s timeout) and the env autonomy defaults below.

## Configuration reference

Environment variables (or `~/.config/pi-claude-supervisor/env`), all prefixed
`PI_CLAUDE_SUPERVISOR_`; see `.env.example` for a template. The env file takes
`KEY=value` lines, optionally prefixed with `export ` and followed by a
` # comment`. A numeric, duration or boolean value that is out of range or
unparsable keeps the default and is reported once as a
`pi-claude-supervisor: ignoring …` warning.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODE` | unset (manual) | `auto` enables automatic supervision (Decision Worker + Reviewer loop) |
| `AUTOMATION` | unset | `1` is equivalent to `MODE=auto` |
| `TRANSPORT` | `jsonl` in auto mode, `process-pipe` otherwise | `jsonl` \| `tmux` \| `process-pipe` (manual only) |
| `TMUX_MODE` | `interactive` | `interactive` (real TUI via hooks) \| `bridge` (stream-json in a pane) |
| `AUTO_INSTALL_HOOKS` | `true` | Interactive tmux mode only: automatically install the hook relay into the user's Claude settings on load; `0` opts out |
| `CLOSE_WORKER_ON_COMPLETION` | `false` | Interactive tmux only: close the Worker/session on completion instead of leaving it open |
| `CGROUP_MODE` | `auto` | `off` \| `auto` \| `required`; automatic mode always uses `required` on Linux; `required` is rejected for a manual (non-automatic) tmux Worker |
| `TMUX_SOCKET` | unset (default tmux server) | Socket path for adopting a non-default tmux server |
| `WORKER` | `claude` | Worker command; may include arguments |
| `NODE` | unset (resolved from `PATH`) | Explicit `node` executable path, for a Bun-compiled Pi |
| `TRUSTED_CLAUDE` | unset | Pins the expected resolved Claude executable identity explicitly |
| `STATE_DIR` | `~/.pi/agent/claude-supervisor` | Supervisor state directory |
| `CWD_LEASE_DIR` | `<state>/cwd-leases` | Shared cwd-lease registry directory |
| `WORKER_ENV` | unset | Comma-separated list of env vars to pass through to manual workers |
| `HUMAN_WEBHOOK_URL` | unset | Outbound candidate/failure notification endpoint |
| `HUMAN_WEBHOOK_FORMAT` | `generic` | `wecom` \| `generic` |
| `HUMAN_WEBHOOK_SECRET` | unset | HMAC signing secret; sent as the `x-pi-supervisor-signature` header |
| `UNATTENDED` | `true` | Task runs without a synchronous human callback |
| `REQUIRE_LOCAL_COMMIT` | `true` | Require a local commit on the candidate's branch before completion |
| `MAX_DECISION_RETRIES` | `4` (0–10) | Retries of a Decision Worker call that times out or fails for a reason waiting does not fix (a prompt that is too long, a corrupted session); waits 15s, 45s, then 60s. A transient provider or network outage (429/529, 5xx, resets) on a completed turn is waited out instead, one attempt a minute; rejected credentials, billing and a missing model park at once |
| `PERMISSION_AUTHORITY` | `hybrid` | `policy` \| `hybrid` \| `decision-worker` |
| `REMOTE_AUTHORITY` | `none` | `none` \| `push` \| `pr`; grants the publish phase after verification passes. `--remote` overrides it per task |
| `REMOTE_NAME` | `origin` | The single remote a publish grant may name |
| `WORKER_MAX_BUDGET_USD` | unset | Hard cap passed as `--max-budget-usd`; unavailable to interactive tmux |
| `WORKER_MODEL` | unset (Claude's own default) | `--model` for the Claude Worker |
| `WORKER_AUTOCOMPACT_TOKENS` | `200000` in automatic mode | Per-turn context bound; `0` keeps Claude's own default |
| `WORKER_MCP_CONFIG` | unset | Path passed as `--strict-mcp-config --mcp-config`, restricting the Worker's MCP servers |
| `DECISION_MODEL` | unset (Pi's default) | `provider/model-id` for the Pi Decision Worker, as listed by Pi |
| `REVIEWER_MODEL` | unset (Pi's default) | `provider/model-id` for the independent Reviewer |
| `DECISION_COMPACT_TOKENS` | `60000` | Proactively compacts the persistent Decision Worker session past this size; `0` disables it |
| `PROGRESS_HEARTBEAT_MS` | `60000` | Minimum interval between repeated progress notifications for the same phase |
| `DECISION_SESSION_RETENTION_DAYS` | `30` | Prunes closed Decision Worker session records older than this; `0` keeps forever |
| `EVIDENCE_MAX_BYTES` | `1048576` (1 MiB) | Maximum repository evidence bytes collected per task |
| `EVIDENCE_MAX_UNTRACKED_FILES` | `512` | Maximum untracked files collected as evidence per task |
| `REVIEW_TIMEOUT_MS` | `10m` (30s–1h) | Total independent Reviewer budget per round; a provider error is retried with a fresh session while budget remains |
| `DEADLINE_MS` | `4h` | Wall-clock budget per task, measured from its start — time Pi was down counts too, so `recover --extend` grants a fresh budget (`8h`, `90m`, `2h30m` or ms; 5m–7d); `0` (or `0m`) disables it; `--deadline` overrides it per task |
| `DEADLINE_GRACE_MS` | `30m` | Close-out window after the deadline for automatic tasks: an idle Worker is verified instead of stopped; `0` restores the immediate stop |
| `DEADLINE_WARNING_MS` | `15m` | How long before the deadline the Decision Worker is warned and re-asked; `0` disables the warning |
| `NO_OUTPUT_TIMEOUT_MS` | `20m` | Stop a Worker that has produced no output for this long; `0` disables the check |
| `HUMAN_IDLE_RESUME_MS` | `30m` | After you type into a supervised session, resume automation once the Worker has been idle this long after your last prompt and the end of your last turn (1 minute to 24 hours); `0` keeps the pause until `resume-auto`. Never applies to an explicit takeover |
| `EVENT_LOG_MAX_BYTES` | `67108864` (64 MiB) | Rotates `events.jsonl` at this size; 5 rotated files are kept |

## Recovery, leases and state

After an unclean Pi restart, `/supervise sessions` lists recoverable tasks;
`/supervise recover [--takeover] <task-id>` restores the Decision Worker
context and starts a new Claude Worker. It never silently resumes or
duplicates work. Add `--takeover` only once the lease proves the old
Worker's process group is gone and its cgroup is a real, readable empty
boundary (and, for tmux, that the private tmux session is also gone);
missing or unverifiable evidence is refused rather than reclaimed.
`/supervise recover` does not persist whether the original task was
interactive — it derives that from the current `TRANSPORT`/`TMUX_MODE`
configuration at recovery time, so do not change either between starting a
task and recovering it.

A task that stopped at its wall-clock deadline is listed with `deadline=expired
… ago`. Plain `recover` refuses it; `recover --takeover --extend <duration>
<task-id>` grants that much budget from now (the recovered Supervisor persists
the new deadline), and `--extend 0` opens the close-out at once, so the fresh
Worker's first watchdog tick verifies and reviews the repository as it stands
and any repair round tells it how long it has. With `--extend` the recovered
task goes straight back to automation: a real extension sends the fresh Worker a
continuation of the original task (telling it to inspect the earlier work first),
and `--extend 0` needs none. A plain `recover` still leaves the Worker idle under
takeover — send it a continuation, then `resume-auto`. A record nobody will recover is
dropped with `/supervise discard <task-id>` (its session file is kept until
retention pruning).

Every task holds one cwd lease under `CWD_LEASE_DIR`; concurrent tasks need
separate worktrees. A lease record that cannot be read (corrupt JSON,
unexpected shape) is quarantined instead of blocking other lookups, and
`/supervise sessions` lists the current quarantined records so an operator
can inspect and clean them up.

Events are append-only JSONL in `<STATE_DIR>/events.jsonl`, with
`worker_output` size-capped and the log rotated past `EVENT_LOG_MAX_BYTES`.
The Decision Worker session for each task is persisted as its own JSONL file
under the state directory, pruned by `DECISION_SESSION_RETENTION_DAYS`.

## Notifications

Every terminal state (`completed`, `blocked`, `failed`) emits a candidate
notice in the Pi UI and, if `HUMAN_WEBHOOK_URL` is set, to a webhook in
either `wecom` or `generic` JSON form, signed with `HUMAN_WEBHOOK_SECRET`
when set. A parked candidate that asked a question sends a separate "needs
you" notice; a human takeover (you typed into the session) only shows an
in-UI hint, since you are already there. Either notice includes an
`attach` field with the literal `tmux -S <socket> attach -t <session>`
command when it concerns a tmux session, and a usage summary
(`CandidateNotice.usage`: cost, worker turns/tokens, Pi tokens, decision and
reviewer call counts). Webhook delivery retries transient errors (network,
429/5xx). Notifications are outbound-only: receiving one does not grant any
approval, and a webhook cannot push commands back into Pi — use `/supervise
send`/`approve`/`takeover` for that.

## Token usage and cost controls

Measured on one real unattended review task (29 minutes wall clock):

| Component | Turns/calls | Tokens | Cost |
| --- | --- | --- | --- |
| Claude Code Worker | 70 turns | 15.5M cache-read + 370k cache-write + 100k output | $18.46 |
| Pi Decision Worker | 30 model calls | ~1.0M (91k uncached + 914k cache-read) | $0.04 |

Almost all of the money goes to the Worker, not the Supervisor's own Decision
Worker or Reviewer calls. In this run the Worker averaged ~220k tokens of
context per turn because it ran as a single long `-p` session under a
1M-token window that never compacted; a trivial Claude Code turn costs
roughly 24k prompt tokens for its system prompt alone, regardless of which
MCP servers are configured. Of the 30 Decision Worker calls, 28 were
permission requests, and the Decision Worker overrode the deterministic
policy 4 times (denying downloads and writes outside the task directory) —
this is why `hybrid` is the default `permissionAuthority`, not `policy`.
Replaying those 28 requests through the shipped `isRoutinePermission`
classifier answers 4 of them locally; that task was dominated by inline
`node -e` scripts and `$(...)` substitutions, which are never routine. An
ordinary implementation task is mostly in-cwd `Edit`/`Write`, `npm test` and
`git status/diff/add/commit`, all of which are routine, so its Decision
Worker call count drops much further.

Knobs, with their defaults and trade-offs:

- `PERMISSION_AUTHORITY` (`policy` | `hybrid` default | `decision-worker`):
  `hybrid` answers routine in-cwd file edits and local read-only/dev shell
  commands from the deterministic policy alone (`isRoutinePermission` in
  `src/policy.ts`) and still sends every ambiguous request, and every policy
  denial, to the Decision Worker. This mainly buys latency and a smaller
  Decision Worker context, not dollars: the 30 calls above already cost
  $0.04.
- `WORKER_MODEL` / `--model`: roughly a 5x price difference between Opus- and
  Sonnet-class models. This is the single largest lever on the actual bill,
  and it is the operator's choice; the Supervisor does not pick it for you.
- `WORKER_AUTOCOMPACT_TOKENS` (default 200000 in automatic mode; `0` keeps
  Claude's own default): bounds context per Worker turn so a long session
  does not keep accumulating ~220k-token turns. Worth tens of percent, at
  the cost of some context quality.
- `WORKER_MAX_BUDGET_USD` / `autonomy.maxWorkerCostUsd`: a hard cap passed to
  Claude as `--max-budget-usd` and re-checked by the Supervisor against the
  cumulative Worker `result` cost. It is a cap, not a saving; a task that
  hits it is parked with its evidence.
- `WORKER_MCP_CONFIG` (`--strict-mcp-config --mcp-config`): restricts the
  Worker to only the listed MCP servers. It bounds what the Worker can
  reach, not the ~24k-token fixed overhead of an ordinary turn.
- `DECISION_MODEL` / `REVIEWER_MODEL` (`provider/model-id`, for example
  `anthropic/claude-haiku-4-5-20251001`): the Pi Decision Worker and
  Reviewer models. Pi-side usage was already a few cents in this run, so a
  cheaper model here mostly buys latency, not headline savings.
- `DECISION_COMPACT_TOKENS` (default 60000; `0` disables): proactively
  compacts the persistent Decision Worker session once its estimated context
  passes this threshold, and re-sends the startup instructions once on the
  next prompt after compaction.

The Supervisor records what it spends rather than estimating it after the
fact: every Worker `result` record becomes a `worker_usage` event, every
Decision Worker/Reviewer model call becomes a `pi_usage` event, and both
accumulate into `session.usage` (`SupervisorTokenUsage`). `/supervise status
<task-id>` prints a `cost=… workerTurns=… workerTokens=… piTokens=…
decisionCalls=… reviewerCalls=…` summary; progress notifications carry
`SupervisorProgress.costUsd`/`.piTokens`, and a candidate notification
carries the same summary through `CandidateNotice.usage`, which the generic
webhook serialises as a numeric `usage` object and the WeCom format renders
as two extra lines.

None of this changes what a task actually costs beyond the Worker model and
budget choice; the Supervisor-side changes here mainly cut Decision Worker
tokens and latency, which were cents to begin with. For a cost-sensitive
unattended run, a reasonable starting point is a Sonnet-class `WORKER_MODEL`,
an explicit `WORKER_MAX_BUDGET_USD` per task, the default `hybrid` permission
authority, and a Haiku-class `DECISION_MODEL`.

## Development

Contributing to the extension itself (not required to use it):

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm run test:pi
npm run test:install
```

Some tests validate the trusted-executable and protected-branch boundaries
against the real checkout, so they must run from a non-protected branch and
from a path that is not group/world-writable.

See [architecture](docs/architecture.md), [testing](docs/testing.md), and
[releasing](docs/releasing.md) for more detail; `docs/autonomy-target.md`
records the confirmed unattended-development target this project is built
around, and [`docs/optimization-roadmap.md`](docs/optimization-roadmap.md) (in
Chinese) proposes the post-0.9.2 optimization roadmap.

## License

MIT. See [LICENSE](LICENSE).
