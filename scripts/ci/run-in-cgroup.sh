#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -gt 0 ]] || { printf '%s\n' 'CI safety gate: no workload command was supplied' >&2; exit 1; }

if [[ "${PI_CLAUDE_SUPERVISOR_FAIL_ON_TEST_SKIP:-0}" != "1" ]]; then
  exec -- "$@"
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/cgroup-common.sh"

ci_require_linux
ci_require_cgroup_mount
parent=$(ci_current_cgroup_path)
cgroup=${PI_CLAUDE_SUPERVISOR_CI_CGROUP:-}
[[ -n "$cgroup" ]] || ci_cgroup_fail 'delegated cgroup is unavailable: PI_CLAUDE_SUPERVISOR_CI_CGROUP is unset'
ci_assert_owned_target "$cgroup" "$parent"

# Move this wrapper PID, not a child shell, before exec. The direct write is
# preferred; the noninteractive sudo fallback is restricted to `tee` writing
# this already-validated cgroup.procs file and never wraps the workload.
if ! ci_move_self_to_cgroup "$cgroup"; then
  ci_cgroup_fail "could not attach wrapper PID to delegated cgroup: $cgroup"
fi
ci_verify_self_in_cgroup "$cgroup"
exec -- "$@"
