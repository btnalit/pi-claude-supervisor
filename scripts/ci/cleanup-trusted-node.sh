#!/usr/bin/env bash
set -euo pipefail

readonly trusted_base=/usr/local/lib/pi-claude-supervisor-ci
readonly job=${GITHUB_JOB:-}
readonly run_id=${GITHUB_RUN_ID:-}
readonly run_attempt=${GITHUB_RUN_ATTEMPT:-}
if [[ -z "${PI_CLAUDE_SUPERVISOR_NODE:-}" && -z "$job$run_id$run_attempt" ]]; then
  # The cleanup step can also run outside GitHub Actions; with no identity and
  # no exported helper there is no path that can be safely derived.
  exit 0
fi
[[ "$job" =~ ^[A-Za-z0-9_.-]+$ && "$run_id" =~ ^[0-9]+$ && "$run_attempt" =~ ^[0-9]+$ ]] \
  || { printf 'GitHub job identity is missing or malformed\n' >&2; exit 1; }
readonly expected_node="$trusted_base/${job}-${run_id}-${run_attempt}/node"
trusted_node=${PI_CLAUDE_SUPERVISOR_NODE:-$expected_node}
[[ "$trusted_node" == "$expected_node" ]] \
  || { printf 'refusing to clean an unexpected Node path: %s\n' "$trusted_node" >&2; exit 1; }
readonly trusted_dir=${trusted_node%/node}

if [[ ! -e "$trusted_node" && ! -L "$trusted_node" ]]; then
  # A failed install may have left an empty per-job directory. It is safe to
  # remove only that exact directory, never its parent or descendants.
  if [[ -d "$trusted_dir" && ! -L "$trusted_dir" ]]; then
    /usr/bin/sudo -n /usr/bin/rmdir -- "$trusted_dir"
  fi
  exit 0
fi
[[ ! -L "$trusted_node" ]] \
  || { printf 'refusing to remove a symlinked Node path: %s\n' "$trusted_node" >&2; exit 1; }
trusted_real=$(/usr/bin/readlink -e -- "$trusted_node")
[[ "$trusted_real" == "$trusted_node" ]] \
  || { printf 'trusted Node path is not canonical: %s\n' "$trusted_node" >&2; exit 1; }
[[ -d "$trusted_dir" && ! -L "$trusted_dir" ]] \
  || { printf 'trusted Node parent is not a real directory: %s\n' "$trusted_dir" >&2; exit 1; }

/usr/bin/sudo -n /usr/bin/rm -f -- "$trusted_node"
/usr/bin/sudo -n /usr/bin/rmdir -- "$trusted_dir"
printf 'Removed verified Node helper: %s\n' "$trusted_node"
