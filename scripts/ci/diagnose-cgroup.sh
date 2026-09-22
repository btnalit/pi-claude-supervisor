#!/usr/bin/env bash
set -u

printf '%s\n' '--- CI automatic-test containment diagnostics ---'
printf 'pid=%s\n' "$$"
printf '%s\n' '/proc/self/cgroup:'
/usr/bin/cat /proc/self/cgroup 2>/dev/null || true
ulimit -a 2>&1 || true

readonly target=${PI_CLAUDE_SUPERVISOR_CI_CGROUP:-}
if [[ ! "$target" =~ ^/sys/fs/cgroup/[^[:space:]]+$ || "$target" == *$'\n'* || "$target" == *$'\r'* || "$target" == *$'\t'* ]]; then
  printf 'delegated cgroup path is missing or malformed: %s\n' "${target:-<empty>}"
  exit 0
fi
if [[ ! -d "$target" || -L "$target" ]]; then
  printf 'delegated cgroup is not a real directory: %s\n' "$target"
  exit 0
fi
printf 'delegated cgroup stat:\n'
/usr/bin/stat -c 'mode=%a uid=%u gid=%g links=%h type=%F path=%n' -- "$target" 2>&1 || true
for name in cgroup.controllers cgroup.subtree_control cgroup.procs cgroup.events cgroup.max.depth cgroup.max.descendants pids.current pids.max memory.current memory.max; do
  path="$target/$name"
  printf '%s: ' "$name"
  if [[ -r "$path" ]]; then
    /usr/bin/head -n 128 -- "$path" 2>&1 || true
  else
    printf '<unreadable>\n'
  fi
done

printf '%s\n' 'tmux processes:'
ps -eo pid=,ppid=,pgid=,stat=,comm=,args= 2>/dev/null | /usr/bin/grep -E '(^|[[:space:]])tmux([[:space:]]|$)' | /usr/bin/head -n 32 || true
for pid in $(pgrep -x tmux 2>/dev/null | /usr/bin/head -n 16); do
  printf 'tmux pid %s cgroup: ' "$pid"
  /usr/bin/cat "/proc/$pid/cgroup" 2>/dev/null || true
done
printf '%s\n' '--- end diagnostics ---'
