#!/usr/bin/env bash
set -euo pipefail

readonly prefix=${PI_CLAUDE_SUPERVISOR_NPM_PREFIX:-}
readonly runner_temp=${RUNNER_TEMP:-}
if [[ -z "$prefix" ]]; then
  # Selection may have failed before the prefix was exported to later steps.
  exit 0
fi
[[ "$runner_temp" =~ ^/[^/].*$ && "$prefix" =~ ^/[^/].*$ ]] \
  || { printf 'npm prefix cleanup paths are missing or not absolute\n' >&2; exit 1; }
[[ "$prefix" == "$runner_temp"/pi-claude-supervisor-npm-* ]] \
  || { printf 'refusing to clean an unexpected npm prefix: %s\n' "$prefix" >&2; exit 1; }
[[ "$prefix" =~ /pi-claude-supervisor-npm-[A-Za-z0-9_.-]+$ ]] \
  || { printf 'npm prefix contains an unsafe matrix slot: %s\n' "$prefix" >&2; exit 1; }

runner_temp_real=$(/usr/bin/readlink -e -- "$runner_temp")
[[ "$runner_temp_real" == "$runner_temp" && -d "$runner_temp" && ! -L "$runner_temp" ]] \
  || { printf 'RUNNER_TEMP is not a canonical real directory: %s\n' "$runner_temp" >&2; exit 1; }
if [[ ! -e "$prefix" && ! -L "$prefix" ]]; then
  exit 0
fi
[[ -d "$prefix" && ! -L "$prefix" ]] \
  || { printf 'npm prefix is not a real directory: %s\n' "$prefix" >&2; exit 1; }
prefix_real=$(/usr/bin/readlink -e -- "$prefix")
[[ "$prefix_real" == "$prefix" && "$prefix_real" == "$runner_temp_real"/pi-claude-supervisor-npm-* ]] \
  || { printf 'npm prefix is not canonical beneath RUNNER_TEMP: %s\n' "$prefix" >&2; exit 1; }
/usr/bin/rm -rf -- "$prefix"
printf 'Removed npm prefix: %s\n' "$prefix"
