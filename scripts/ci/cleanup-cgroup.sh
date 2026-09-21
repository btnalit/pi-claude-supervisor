#!/usr/bin/env bash
set -euo pipefail

cgroup=${PI_CLAUDE_SUPERVISOR_CI_CGROUP:-}
if [[ -z "$cgroup" && "$(uname -s)" != "Linux" ]]; then
  exit 0
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/cgroup-common.sh"
ci_require_linux
ci_require_cgroup_mount
parent=$(ci_current_cgroup_path)

# If setup failed after creating the child but before appending GITHUB_ENV, the
# deterministic job name still lets cleanup find exactly that direct child.
if [[ -z "$cgroup" ]]; then
  cgroup="$parent/$(ci_expected_cgroup_name)"
fi
# A missing target means setup never completed (or cleanup already succeeded).
# Any present target must still be the exact direct child prepared for this job.
ci_reject_control_path "$cgroup"
if [[ ! -e "$cgroup" && ! -L "$cgroup" ]]; then
  exit 0
fi
ci_assert_owned_target "$cgroup" "$parent"

# Kill only the prepared cgroup. Root is used only for the cgroup.kill write if
# the runner did not delegate file ownership; recursive deletion is forbidden.
if ! ci_write_cgroup_value "$cgroup/cgroup.kill" 1; then
  ci_cgroup_fail "could not kill delegated cgroup members: $cgroup"
fi

# cgroup.kill is synchronous for the cgroup's members, but wait briefly for
# cgroupfs to report empty before attempting the non-recursive removal.
for _ in {1..50}; do
  if grep -qx 'populated 0' "$cgroup/cgroup.events" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

ci_assert_owned_target "$cgroup" "$parent"
if ! grep -qx 'populated 0' "$cgroup/cgroup.events" 2>/dev/null; then
  ci_cgroup_fail "delegated cgroup is still populated: $cgroup"
fi
ci_remove_empty_descendant_cgroups "$cgroup"
ci_remove_empty_cgroup "$cgroup"
printf 'Removed delegated cgroup: %s\n' "$cgroup"
