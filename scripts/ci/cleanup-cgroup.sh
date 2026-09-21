#!/usr/bin/env bash
set -euo pipefail

cgroup=${PI_CLAUDE_SUPERVISOR_CI_CGROUP:-}
if [[ -z "$cgroup" || ! -d "$cgroup" ]]; then exit 0; fi

printf '1\n' > "$cgroup/cgroup.kill" 2>/dev/null || sudo sh -c 'printf "1\n" > "$1/cgroup.kill"' sh "$cgroup" || true
rmdir "$cgroup" 2>/dev/null || sudo rmdir "$cgroup" 2>/dev/null || true
