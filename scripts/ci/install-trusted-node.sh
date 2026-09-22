#!/usr/bin/env bash
set -euo pipefail

# setup-node's toolcache is runner-owned and may fail Supervisor's executable
# trust checks. Copy only the selected runtime into a root-owned, per-job,
# non-writable directory using bounded sudo. The workload and npm remain
# unprivileged; the directory is removed by the matching always-run cleanup.
readonly trusted_base=/usr/local/lib/pi-claude-supervisor-ci
readonly job=${GITHUB_JOB:-}
readonly run_id=${GITHUB_RUN_ID:-}
readonly run_attempt=${GITHUB_RUN_ATTEMPT:-}
[[ "$job" =~ ^[A-Za-z0-9_.-]+$ && "$run_id" =~ ^[0-9]+$ && "$run_attempt" =~ ^[0-9]+$ ]] \
  || { printf 'GitHub job identity is missing or malformed\n' >&2; exit 1; }
readonly trusted_dir="$trusted_base/${job}-${run_id}-${run_attempt}"
readonly trusted_node="$trusted_dir/node"

assert_private_root_directory() {
  local path=${1-}
  [[ -d "$path" && ! -L "$path" ]] \
    || { printf 'trusted Node path is not a real directory: %s\n' "$path" >&2; exit 1; }
  local fields uid mode links type
  fields=$(/usr/bin/stat -c '%u %a %h %F' -- "$path")
  read -r uid mode links type <<< "$fields"
  [[ "$uid" == 0 && "$type" == 'directory' && "$mode" =~ ^[0-7]+$ ]] \
    || { printf 'trusted Node directory has unsafe identity: %s\n' "$fields" >&2; exit 1; }
  (( (8#$mode & 18) == 0 )) \
    || { printf 'trusted Node directory is group/world writable: %s\n' "$path" >&2; exit 1; }
}

# The fixed parent is created only by root and must never be followed through a
# pre-existing link or an untrusted directory. A pre-existing unsafe directory
# is rejected rather than repaired in place.
if [[ -L "$trusted_base" || -e "$trusted_base" ]]; then
  assert_private_root_directory "$trusted_base"
else
  /usr/bin/sudo -n /usr/bin/install -d -o root -g root -m 0755 -- "$trusted_base"
  assert_private_root_directory "$trusted_base"
fi

# A repeated invocation in one job may reuse its own validated directory; a
# different job/run gets a distinct path, so stale contents cannot be mistaken
# for the current runtime.
if [[ -L "$trusted_dir" || -e "$trusted_dir" ]]; then
  assert_private_root_directory "$trusted_dir"
else
  /usr/bin/sudo -n /usr/bin/install -d -o root -g root -m 0755 -- "$trusted_dir"
  assert_private_root_directory "$trusted_dir"
fi

node_source=$(command -v node || true)
[[ "$node_source" == /* ]] || { printf 'node was not resolved to an absolute path\n' >&2; exit 1; }
node_source=$(/usr/bin/readlink -e -- "$node_source")
[[ "$node_source" =~ ^/opt/hostedtoolcache/node/[0-9][^/]*/x64/bin/node$ ]] \
  || { printf 'Node did not come from the pinned setup-node toolcache: %s\n' "$node_source" >&2; exit 1; }
[[ -f "$node_source" && -x "$node_source" ]] \
  || { printf 'resolved Node runtime is not an executable regular file: %s\n' "$node_source" >&2; exit 1; }
source_stat=$(/usr/bin/stat -c '%u %a %h %F' -- "$node_source")
read -r source_uid source_mode source_links source_type <<< "$source_stat"
runner_uid=$(id -u)
[[ ("$source_uid" == "$runner_uid" || "$source_uid" == 0) && "$source_links" == 1 && "$source_type" == 'regular file' && "$source_mode" =~ ^[0-7]+$ ]] \
  || { printf 'setup-node runtime has unsafe identity: %s\n' "$source_stat" >&2; exit 1; }
(( (8#$source_mode & 18) == 0 )) \
  || { printf 'setup-node runtime is group/world writable: %s\n' "$node_source" >&2; exit 1; }

source_hash=$(/usr/bin/sha256sum -- "$node_source" | /usr/bin/awk '{print $1}')
[[ "$source_hash" =~ ^[[:xdigit:]]{64}$ ]] \
  || { printf 'could not hash the selected Node runtime: %s\n' "$node_source" >&2; exit 1; }

/usr/bin/sudo -n /usr/bin/install -o root -g root -m 0755 -- "$node_source" "$trusted_node"

assert_private_root_directory "$trusted_base"
assert_private_root_directory "$trusted_dir"
trusted_real=$(/usr/bin/readlink -e -- "$trusted_node")
[[ "$trusted_real" == "$trusted_node" ]] \
  || { printf 'trusted Node path changed during installation: %s\n' "$trusted_node" >&2; exit 1; }
trusted_hash=$(/usr/bin/sha256sum -- "$trusted_node" | /usr/bin/awk '{print $1}')
[[ "$trusted_hash" == "$source_hash" ]] \
  || { printf 'trusted Node copy failed identity verification: %s\n' "$trusted_node" >&2; exit 1; }

trusted_stat=$(/usr/bin/stat -c '%u %a %h %F' -- "$trusted_node")
read -r trusted_uid trusted_mode trusted_links trusted_type <<< "$trusted_stat"
[[ "$trusted_uid" == 0 && "$trusted_links" == 1 && "$trusted_type" == 'regular file' && "$trusted_mode" =~ ^[0-7]+$ ]] \
  || { printf 'trusted Node copy has unsafe identity: %s\n' "$trusted_stat" >&2; exit 1; }
(( (8#$trusted_mode & 18) == 0 )) \
  || { printf 'trusted Node copy is group/world writable: %s\n' "$trusted_node" >&2; exit 1; }

# The path is exported only to later unprivileged steps. Prepending the same
# directory also makes npm's /usr/bin/env node shebang use this verified copy,
# so process.execPath is trusted in runtime tests too.
printf 'PI_CLAUDE_SUPERVISOR_NODE=%s\n' "$trusted_node" >> "${GITHUB_ENV:?GITHUB_ENV is required}"
printf '%s\n' "$trusted_dir" >> "${GITHUB_PATH:?GITHUB_PATH is required}"
printf 'Installed verified Node helper: %s (sha256 %s)\n' "$trusted_node" "$trusted_hash"
