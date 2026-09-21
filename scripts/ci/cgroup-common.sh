#!/usr/bin/env bash
# Shared validation and least-privilege helpers for the CI cgroup gate.
# Callers run with `set -euo pipefail` before sourcing this file.

readonly CI_CGROUP_MOUNT=/sys/fs/cgroup
readonly CI_CGROUP_PREFIX=pi-claude-supervisor-ci-

ci_cgroup_fail() {
  printf 'CI safety gate: %s\n' "$*" >&2
  return 1
}

ci_require_linux() {
  [[ "$(uname -s)" == "Linux" ]] || ci_cgroup_fail 'automatic cgroup tests require Linux'
}

ci_reject_control_path() {
  local path=${1-}
  [[ -n "$path" ]] || ci_cgroup_fail 'cgroup path is empty'
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* && "$path" != *$'\t'* ]] \
    || ci_cgroup_fail 'cgroup path contains control characters'
}

ci_require_cgroup_mount() {
  [[ -d "$CI_CGROUP_MOUNT" ]] || ci_cgroup_fail 'cgroup v2 mount was not found'
  local filesystem_type
  filesystem_type=$(stat -fc '%T' -- "$CI_CGROUP_MOUNT") \
    || ci_cgroup_fail 'could not inspect the cgroup mount'
  [[ "$filesystem_type" == 'cgroup2fs' ]] \
    || ci_cgroup_fail "cgroup v2 mount has unexpected filesystem type: $filesystem_type"
  [[ -r "$CI_CGROUP_MOUNT/cgroup.controllers" ]] \
    || ci_cgroup_fail 'cgroup v2 controllers are not readable'
}

ci_current_cgroup_relative() {
  local relative
  relative=$(awk -F: '$1 == "0" { print $3; exit }' /proc/self/cgroup) \
    || ci_cgroup_fail 'could not read the current cgroup'
  [[ "$relative" == /* ]] || ci_cgroup_fail 'unified cgroup path is missing'
  ci_reject_control_path "$relative"
  local component
  IFS=/ read -r -a components <<< "${relative#/}"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != '.' && "$component" != '..' ]] \
      || ci_cgroup_fail 'unified cgroup path contains an unsafe component'
  done
  printf '%s\n' "$relative"
}

ci_current_cgroup_path() {
  local relative
  relative=$(ci_current_cgroup_relative) || return
  printf '%s%s\n' "$CI_CGROUP_MOUNT" "$relative"
}

# Reject symlink traversal. Cgroup paths are kernel-provided or Supervisor-
# generated, but this check also protects the narrowly scoped privileged calls
# from a changed environment variable or a same-UID replacement race.
ci_assert_no_symlink_path() {
  local path=${1-}
  local allow_missing_final=${2:-0}
  ci_reject_control_path "$path"
  [[ "$path" == "$CI_CGROUP_MOUNT" || "$path" == "$CI_CGROUP_MOUNT"/* ]] \
    || ci_cgroup_fail "cgroup path is outside the cgroup v2 mount: ${path:-<empty>}"

  local current= component
  local -a components=()
  IFS=/ read -r -a components <<< "${path#/}"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != '.' && "$component" != '..' ]] \
      || ci_cgroup_fail 'cgroup path contains an unsafe component'
    current="$current/$component"
    if [[ -L "$current" ]]; then
      ci_cgroup_fail "cgroup path contains a symlink: $current"
    fi
    if [[ ! -e "$current" ]]; then
      if [[ "$allow_missing_final" == '1' && "$current" == "$path" ]]; then
        return 0
      fi
      ci_cgroup_fail "cgroup path component is missing: $current"
    fi
  done
}

ci_assert_cgroup_directory() {
  local path=${1-}
  ci_assert_no_symlink_path "$path"
  [[ -d "$path" ]] || ci_cgroup_fail "cgroup is not a directory: ${path:-<empty>}"
  local canonical
  canonical=$(readlink -e -- "$path") || ci_cgroup_fail "could not resolve cgroup path: $path"
  [[ "$canonical" == "$path" ]] || ci_cgroup_fail "cgroup path changed during validation: $path"
}

ci_expected_cgroup_name() {
  local job=${GITHUB_JOB:-local}
  local run=${GITHUB_RUN_ID:-manual}
  local attempt=${GITHUB_RUN_ATTEMPT:-1}
  local name="${CI_CGROUP_PREFIX}${job}-${run}-${attempt}"
  name=${name//[^A-Za-z0-9_.-]/-}
  printf '%s\n' "$name"
}

ci_assert_owned_target() {
  local target=${1-}
  local parent=${2-}
  ci_assert_cgroup_directory "$parent"
  ci_assert_cgroup_directory "$target"
  local expected
  expected=$(ci_expected_cgroup_name)
  [[ "$target" == "$parent/$expected" ]] \
    || ci_cgroup_fail "delegated cgroup is not the prepared direct child: $target"
  [[ "$(basename -- "$target")" == "$expected" ]] \
    || ci_cgroup_fail "delegated cgroup has an unexpected name: $target"
  for file in cgroup.procs cgroup.events cgroup.kill; do
    [[ -e "$target/$file" ]] || ci_cgroup_fail "delegated cgroup control is missing: $file"
  done
}

ci_assert_new_target() {
  local target=${1-}
  local parent=${2-}
  ci_assert_cgroup_directory "$parent"
  ci_reject_control_path "$target"
  [[ "$target" == "$parent/$(ci_expected_cgroup_name)" ]] \
    || ci_cgroup_fail "new delegated cgroup is not the expected direct child: $target"
  ci_assert_no_symlink_path "$target" 1
  [[ ! -e "$target" && ! -L "$target" ]] \
    || ci_cgroup_fail "delegated cgroup already exists: $target"
}

ci_root_command() {
  [[ -x /usr/bin/sudo ]] || return 127
  /usr/bin/sudo -n "$@"
}

# The privileged fallback is deliberately limited to a single cgroupfs write.
# Never pass a shell or a command string to sudo from these helpers.
ci_write_cgroup_value() {
  local path=${1-}
  local value=${2-}
  if printf '%s\n' "$value" > "$path" 2>/dev/null; then
    return 0
  fi
  [[ -x /usr/bin/tee ]] || return 1
  printf '%s\n' "$value" | ci_root_command /usr/bin/tee -- "$path" >/dev/null
}

ci_move_self_to_cgroup() {
  local target=${1-}
  ci_write_cgroup_value "$target/cgroup.procs" "$$"
}

ci_verify_self_in_cgroup() {
  local target=${1-}
  local actual
  actual=$(ci_current_cgroup_path) || return
  [[ "$actual" == "$target" ]] \
    || ci_cgroup_fail "current process did not join the delegated cgroup: $actual"
}

ci_remove_empty_cgroup() {
  local target=${1-}
  if rmdir -- "$target" 2>/dev/null; then
    return 0
  fi
  ci_root_command /usr/bin/rmdir -- "$target"
}

ci_remove_empty_descendant_cgroups() {
  local target=${1-}
  local descendant
  local -a descendants=()
  # cgroup.kill empties descendants but does not remove their directories.
  # Enumerate deepest-first and remove only cgroup directories below the
  # already validated target; never use recursive filesystem deletion here.
  mapfile -d '' descendants < <(find -P "$target" -mindepth 1 -type d -depth -print0)
  for descendant in "${descendants[@]}"; do
    [[ "$descendant" == "$target"/* ]] \
      || ci_cgroup_fail "cgroup descendant escaped its parent: $descendant"
    [[ ! -e "$descendant" && ! -L "$descendant" ]] && continue
    ci_assert_cgroup_directory "$descendant"
    ci_remove_empty_cgroup "$descendant" \
      || ci_cgroup_fail "could not remove empty child cgroup: $descendant"
  done
}
