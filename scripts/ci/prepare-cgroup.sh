#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "${BASH_SOURCE[0]}")/cgroup-common.sh"

ci_require_linux
ci_require_cgroup_mount
parent=$(ci_current_cgroup_path)
ci_assert_cgroup_directory "$parent"
name=$(ci_expected_cgroup_name)
cgroup="$parent/$name"
ci_assert_new_target "$cgroup" "$parent"

# The runner normally owns a delegated parent. If it does not, root may create
# this one cgroup only; the workload itself is never executed through sudo.
if ! mkdir -- "$cgroup" 2>/dev/null; then
  ci_root_command /bin/mkdir -- "$cgroup" \
    || ci_cgroup_fail "could not create delegated cgroup: $cgroup"
fi

# Revalidate the exact path after creation, then delegate the directory and
# cgroup controls so the workload can create its own child boundaries.
ci_assert_owned_target "$cgroup" "$parent"
ci_delegate_cgroup "$cgroup"
ci_probe_nested_cgroup "$cgroup"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'PI_CLAUDE_SUPERVISOR_CI_CGROUP=%s\n' "$cgroup" >> "$GITHUB_ENV"
else
  printf 'export PI_CLAUDE_SUPERVISOR_CI_CGROUP=%q\n' "$cgroup"
fi
printf 'Prepared delegated cgroup: %s\n' "$cgroup"
