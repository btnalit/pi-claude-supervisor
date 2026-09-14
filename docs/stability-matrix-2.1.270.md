# Claude Code 2.1.270 stability matrix

Run date: 2026-09-14. The executable was resolved as
`/home/yancao/.local/share/mise/installs/claude/2.1.270/claude` and reported
`2.1.270 (Claude Code)`. Runs used the authenticated local provider and
`scripts/spike-claude-automation.mjs`; no Claude `--resume` was used.

## Required matrix (120 s bounded run)

| Scenario | Runs | Completed + verified | Fail-closed outcomes |
| --- | ---: | ---: | --- |
| ordinary task | 10 | 9 | 1 stopped at the bounded deadline without verification |
| permission handling | 5 | 5 | 0 |
| question handling | 5 | 5 | 0 |

The ordinary outlier was not treated as success: the spike exited non-zero,
kept verification false, and stopped rather than retrying or replaying the task.
This is the intended timeout fail-closed behavior. An earlier question spike also
escalated after invalid Decision Worker output; it was likewise not counted as a
success. The five-run question matrix above was then rerun with a 180 s bound and
all five completed with `verified=true` and zero human interventions.

## Bounded follow-up

Three additional ordinary and three additional question runs with the same
pinned executable and a 180 s bound also completed with `verified=true` and zero
human interventions. These runs support a provider-latency explanation for the
120 s outliers; they do not turn an outlier into a success.

The deterministic replay, acceptance, recovery-state, lease, cleanup and
package checks remain the CI evidence. Authenticated Claude runs are manual
release evidence only.
