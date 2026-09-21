#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  printf '%s\n' 'CI safety gate: automatic cgroup tests require Linux' >&2
  exit 1
fi

parent=$(awk -F: '$1 == "0" { print "/sys/fs/cgroup" $3; exit }' /proc/self/cgroup)
if [[ -z "$parent" || ! -d "$parent" ]]; then
  printf '%s\n' 'CI safety gate: cgroup v2 parent was not found' >&2
  exit 1
fi

name="pi-claude-supervisor-ci-${GITHUB_JOB:-local}-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
name=${name//[^A-Za-z0-9_.-]/-}
cgroup="$parent/$name"
owner="$(id -u):$(id -g)"

if [[ ! -e "$cgroup" ]]; then
  mkdir "$cgroup" 2>/dev/null || sudo mkdir "$cgroup"
fi
chown "$owner" "$cgroup" "$cgroup/cgroup.procs" "$cgroup/cgroup.kill" "$cgroup/cgroup.events" 2>/dev/null \
  || sudo chown "$owner" "$cgroup" "$cgroup/cgroup.procs" "$cgroup/cgroup.kill" "$cgroup/cgroup.events"

if [[ ! -w "$cgroup/cgroup.procs" ]]; then
  printf 'CI safety gate: delegated cgroup is not writable: %s\n' "$cgroup" >&2
  exit 1
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'PI_CLAUDE_SUPERVISOR_CI_CGROUP=%s\n' "$cgroup" >> "$GITHUB_ENV"
else
  printf 'export PI_CLAUDE_SUPERVISOR_CI_CGROUP=%q\n' "$cgroup"
fi
printf 'Prepared delegated cgroup: %s\n' "$cgroup"
