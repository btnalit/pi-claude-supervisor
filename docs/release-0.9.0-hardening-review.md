# 0.9.0 Hardening Review and Evidence

## Scope

- Comparison baseline: `36e144a8d71f03e0367fbae5925044956b8f1e62` (PR #60 release baseline).
- Reviewed candidate branch: `security-hardening-r0-r8`.
- Committed review head before the hosted tmux follow-up delta: `ed9f682` (`fix: attach tmux server to worker cgroup`).
- Current local review head: `bff6422` (`fix: guard tmux bootstrap parent death`).
- No release tag is used as the baseline; the exact commit above is the authority.

The candidate includes the R0–R8 hardening delta plus the follow-up review fixes. This
review record is committed in the candidate commit at `HEAD`; that exact commit must still
be revalidated by hosted CI before publication.

## Independent review disposition

Four fresh review lanes were requested against the baseline-to-head scope:

- **Lifecycle/runtime** (`705f3f5e-7c7c-44fe-b9fb-5facace18aed`): found and fixed
  verification cancellation being armed too late, partial verification-cgroup directory
  leakage, and propagation of the internal verification-cgroup path to acceptance commands.
- **Scope/CI/docs** (`f5112bfa-7bd8-4569-9e12-a6b61a011722`): confirmed the trusted-Node
  helper is present in the candidate delta; identified the need for protected CI ownership,
  branch-contract reconciliation, explicit npm authentication validation, and immutable
  release uploads. The candidate adds `.github/CODEOWNERS`, reconciles the branch contract,
  validates `NPM_AUTH_MODE`, and removes `gh release upload --clobber`.
- **Cross-seam challenge** (`2e75b417-83df-496e-9b4b-d49f5d6473d6`): no additional
  concrete cross-boundary finding; same-UID pathname/process races and URL/host identity
  limitations remain documented residuals.
- **Security-boundaries** (`dc67c68e-349f-4a44-bfc1-2e56894b79f6`): timed out without a
  report. Its absence is not treated as a passing review; the parent review and targeted
  regression tests are retained as the available evidence.

## Candidate changes covered by this review

- Supervisor Git pins command-executing local configuration and verifies that Git's reported
  worktree is the canonical task directory.
- Hook runtime and Claude settings paths reject unsafe writable/owned ancestors and clean up
  post-bind failures without unlinking an unowned socket.
- Verification commands arm cancellation before cgroup setup, remove failed setup directories,
  report cleanup failures, and do not pass the internal cgroup capability to the command.
- Worker cgroup cleanup is bottom-up and non-recursive.
- CI uses a per-run, hash-verified, root-owned Node copy instead of `/usr/bin/node`, exports it
  for later steps, and always removes the exact validated path, including setup-failure cleanup.
- Release publication requires an explicit `NPM_AUTH_MODE` (`oidc` or `token`) with the matching
  credential path; release assets cannot be overwritten in place.
- `.github/CODEOWNERS` covers workflows, the gate and test runner, CI helpers, release scripts,
  package metadata and Release Please configuration. The live GitHub ruleset must require those
  code-owner reviews and the `CI / Quality gate` status; repository files cannot prove that
  external setting by themselves.
- Automatic owned tmux starts its private server through a trusted Node wrapper that self-attaches
  before executing tmux. Distro tmux systemd-cgroup variables are removed only from the tmux
  client/server environment; the bridge and interactive launcher restore them for Claude. Startup
  verifies the pane and nested Claude process remain in the Worker cgroup; the startup wrapper and
placeholder also monitor parent death during the handoff window.

## Local validation

Latest candidate evidence was collected on Node `v26.8.2` / npm `11.19.1`:

- `npm run typecheck` — passed.
- `npm test` — **406 passed, 0 failed, 0 skipped**.
- `node --test src/command-runner.test.ts src/hooks/server.test.ts src/worker/environment.test.ts src/worker/process-adapter.test.ts src/verifier.test.ts` — **73 passed**.
- `npm run check:package` — passed; the package manifest contained the expected published files.
- `npm run check:docs` — passed.
- `npm run check:automation` — passed.
- `npm run build` — passed; release manifest, SHA-256 and npm integrity metadata generated.
- `npm audit --audit-level=high` — passed; 0 vulnerabilities.
- `npm run test:pi` — passed.
- `npm run test:install` — passed with the native npm installation smoke test.
- `bash -n scripts/ci/*.sh scripts/check-workflows.sh` and `git diff --check` — passed.
- Invalid `NPM_AUTH_MODE` execution — failed closed before publication.
- Real cgroup containment and verification cleanup tests — passed in the writable local cgroup.

The full `npm run check` matrix was also run; one tmux timing assertion failed once under
load, the bounded wait was made more tolerant, and the subsequent complete `npm test` run
passed with no skips. Hosted Node 22.19/24, npm 10/12, passwordless `sudo -n`, and GitHub
Actions evidence remain required because they cannot be substituted by local runs. After the tmux containment follow-up, Node 26 again passed all 406 tests with zero skips; Node 22 with both tmux 3.4 and the distro systemd-integrated tmux passed the focused structured, nested-child, and interactive containment tests.

## Hosted failure and release blockers

Hosted runs `35691121119`, `35695320060`, and `35697564853` passed policy, package, and Pi
integration jobs but failed all Node/npm matrix jobs during automatic tmux startup. The latest
diagnostics classified the failure as `tmux bootstrap could not join its Worker cgroup: EACCES`
after the tmux server itself had been moved. This was not characterized as a matrix collision.
Commit `bff6422` changes startup to self-attach the server before pane creation, disables distro
tmux's transient systemd pane scopes for the tmux process only, and fails closed if pane or
nested-child cgroup membership is not confirmed. A fresh hosted run is still required.

Do not merge or release until all of the following are independently evidenced:

1. Hosted CI passes the exact current candidate commit on Node 22.19 and 24, npm 10 and 12,
   including the trusted-Node installation/cleanup and delegated cgroup jobs, with zero skips.
2. The live `main` ruleset requires the pinned `CI / Quality gate`, code-owner approval for
   `.github/CODEOWNERS` paths, latest-push approval, stale-review dismissal, and no bypass.
   Local checks cannot verify this; use an authenticated GitHub API audit.
3. The same-UID filesystem/process TOCTOU residual remains accepted for this trusted local-worker
   threat model. The Supervisor's identity checks fail closed for the cross-user/replacement
   cases they can observe, but are not OS privilege separation.
4. Nested Claude, plugins, MCP servers and custom helpers retain intentional full local
   capabilities; an independent host/repository boundary is still required for absolute remote
   or main-branch enforcement. URL pinning also does not attest DNS or SSH host identity.
