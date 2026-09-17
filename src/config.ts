import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSensitive } from "./redaction.ts";
import type { PermissionAuthority } from "./types.ts";

const allowed = new Set([
  "PI_CLAUDE_SUPERVISOR_MODE",
  "PI_CLAUDE_SUPERVISOR_AUTOMATION",
  "PI_CLAUDE_SUPERVISOR_TRANSPORT",
  "PI_CLAUDE_SUPERVISOR_TMUX_MODE",
  "PI_CLAUDE_SUPERVISOR_AUTO_INSTALL_HOOKS",
  "PI_CLAUDE_SUPERVISOR_CLOSE_WORKER_ON_COMPLETION",
  "PI_CLAUDE_SUPERVISOR_CGROUP_MODE",
  "PI_CLAUDE_SUPERVISOR_TMUX_SOCKET",
  "PI_CLAUDE_SUPERVISOR_WORKER",
  "PI_CLAUDE_SUPERVISOR_NODE",
  "PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE",
  "PI_CLAUDE_SUPERVISOR_STATE_DIR",
  "PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR",
  "PI_CLAUDE_SUPERVISOR_WORKER_ENV",
  "PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL",
  "PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT",
  "PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_SECRET",
  "PI_CLAUDE_SUPERVISOR_UNATTENDED",
  "PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT",
  "PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES",
  "PI_CLAUDE_SUPERVISOR_PERMISSION_AUTHORITY",
  "PI_CLAUDE_SUPERVISOR_WORKER_MAX_BUDGET_USD",
  "PI_CLAUDE_SUPERVISOR_WORKER_MODEL",
  "PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS",
  "PI_CLAUDE_SUPERVISOR_WORKER_MCP_CONFIG",
  "PI_CLAUDE_SUPERVISOR_DECISION_MODEL",
  "PI_CLAUDE_SUPERVISOR_REVIEWER_MODEL",
  "PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS",
  "PI_CLAUDE_SUPERVISOR_PROGRESS_HEARTBEAT_MS",
  "PI_CLAUDE_SUPERVISOR_DECISION_SESSION_RETENTION_DAYS",
  "PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_BYTES",
  "PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_UNTRACKED_FILES",
  "PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS",
  "PI_CLAUDE_SUPERVISOR_EVENT_LOG_MAX_BYTES",
]);

export interface AutonomyDefaults {
  unattended: boolean;
  requireLocalCommit: boolean;
  maxDecisionRetries: number;
  permissionAuthority: PermissionAuthority;
  maxWorkerCostUsd?: number;
}

export function autonomyDefaults(env: NodeJS.ProcessEnv = process.env): AutonomyDefaults {
  return {
    unattended: readBoolean(env.PI_CLAUDE_SUPERVISOR_UNATTENDED, true),
    requireLocalCommit: readBoolean(env.PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT, true),
    maxDecisionRetries: readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES, 2, 0, 10),
    permissionAuthority: readPermissionAuthority(env.PI_CLAUDE_SUPERVISOR_PERMISSION_AUTHORITY),
    ...(readPositiveNumber(env.PI_CLAUDE_SUPERVISOR_WORKER_MAX_BUDGET_USD) !== undefined ? { maxWorkerCostUsd: readPositiveNumber(env.PI_CLAUDE_SUPERVISOR_WORKER_MAX_BUDGET_USD) } : {}),
  };
}

export function reviewTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS, 600_000, 30_000, 3_600_000);
}

export function eventLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_EVENT_LOG_MAX_BYTES, 64 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024);
}

export function workerModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readTrimmedString(env.PI_CLAUDE_SUPERVISOR_WORKER_MODEL);
}

/** The 200_000 default applies only in automatic mode; "0" is an explicit opt-out that omits --autocompact. */
export function workerAutocompactTokens(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedIntegerWithZeroOptOut(env.PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS, 200_000, 100_000, 1_000_000);
}

export function workerMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readTrimmedString(env.PI_CLAUDE_SUPERVISOR_WORKER_MCP_CONFIG);
}

export function decisionModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readTrimmedString(env.PI_CLAUDE_SUPERVISOR_DECISION_MODEL);
}

export function reviewerModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readTrimmedString(env.PI_CLAUDE_SUPERVISOR_REVIEWER_MODEL);
}

/** "0" is an explicit opt-out that disables Decision Worker session compaction. */
export function decisionCompactionTokens(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedIntegerWithZeroOptOut(env.PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS, 60_000, 10_000, 500_000);
}

export function progressHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_PROGRESS_HEARTBEAT_MS, 60_000, 5_000, 3_600_000);
}

export function decisionSessionRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_DECISION_SESSION_RETENTION_DAYS, 30, 0, 3650);
}

export function evidenceMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_BYTES, 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);
}

export function evidenceMaxUntrackedFiles(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_UNTRACKED_FILES, 512, 16, 10_000);
}

export function loadSupervisorEnvironment(): string | undefined {
  const path = process.env.PI_CLAUDE_SUPERVISOR_ENV_FILE ?? join(homedir(), ".config", "pi-claude-supervisor", "env");
  if (!existsSync(path)) return undefined;
  try {
    const contents = readFileSync(path, "utf8");
    // Best effort: the file is local configuration, never a repository asset.
    try { chmodSync(path, 0o600); } catch { /* read-only filesystems may reject chmod */ }
    for (const line of contents.split(/\r?\n/u)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
      if (!match || !allowed.has(match[1]) || process.env[match[1]] !== undefined) continue;
      const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
      process.env[match[1]] = value;
    }
    return path;
  } catch (error) {
    console.error(`pi-claude-supervisor could not read env file ${String(redactSensitive(path))}: ${String(redactSensitive(error instanceof Error ? error.message : String(error)))}`);
    return undefined;
  }
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (/^(?:1|true|yes|on)$/iu.test(value.trim())) return true;
  if (/^(?:0|false|no|off)$/iu.test(value.trim())) return false;
  return fallback;
}

function readBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

/** Like readBoundedInteger, but the literal "0" is always honored as an opt-out below the normal minimum. */
function readBoundedIntegerWithZeroOptOut(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value !== undefined && value.trim() === "0") return 0;
  return readBoundedInteger(value, fallback, minimum, maximum);
}

function readTrimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readPermissionAuthority(value: string | undefined): PermissionAuthority {
  const normalized = value?.trim().toLowerCase();
  return normalized === "policy" || normalized === "decision-worker" ? normalized : "hybrid";
}

function readPositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** How automatic tmux supervision drives Claude: the real TUI through hooks (default) or the stream-json bridge. */
export function tmuxMode(env: NodeJS.ProcessEnv = process.env): "interactive" | "bridge" {
  return env.PI_CLAUDE_SUPERVISOR_TMUX_MODE?.trim().toLowerCase() === "bridge" ? "bridge" : "interactive";
}

/** Exit the interactive Worker and its tmux session once a task completes; default keeps it open for the operator. */
export function closeWorkerOnCompletion(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolean(env.PI_CLAUDE_SUPERVISOR_CLOSE_WORKER_ON_COMPLETION, false);
}

/** Install the user-level Claude Code hook entries automatically when the interactive tmux mode is configured. */
export function autoInstallHooks(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolean(env.PI_CLAUDE_SUPERVISOR_AUTO_INSTALL_HOOKS, true);
}
