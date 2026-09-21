#!/usr/bin/env bash
set -euo pipefail

if [[ "${PI_CLAUDE_SUPERVISOR_FAIL_ON_TEST_SKIP:-0}" == "1" ]]; then
  if [[ "$(uname -s)" != "Linux" ]]; then
    printf '%s\n' 'CI safety gate: automatic cgroup tests require Linux' >&2
    exit 1
  fi
  cgroup=${PI_CLAUDE_SUPERVISOR_CI_CGROUP:-}
  if [[ -z "$cgroup" || ! -d "$cgroup" || ! -w "$cgroup/cgroup.procs" ]]; then
    printf 'CI safety gate: delegated cgroup is unavailable or not writable: %s\n' "${cgroup:-<unset>}" >&2
    exit 1
  fi
  printf '%s\n' "$$" > "$cgroup/cgroup.procs"
fi

exec "$@"
