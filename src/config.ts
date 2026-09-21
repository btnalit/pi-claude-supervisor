import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { isPlainRemoteName } from "./policy.ts";
import { redactSensitive } from "./redaction.ts";
import type { PermissionAuthority, RemoteAuthority } from "./types.ts";

const MAX_ENV_FILE_BYTES = 1 * 1024 * 1024;

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
  "PI_CLAUDE_SUPERVISOR_DEADLINE_MS",
  "PI_CLAUDE_SUPERVISOR_DEADLINE_GRACE_MS",
  "PI_CLAUDE_SUPERVISOR_DEADLINE_WARNING_MS",
  "PI_CLAUDE_SUPERVISOR_NO_OUTPUT_TIMEOUT_MS",
  "PI_CLAUDE_SUPERVISOR_REMOTE_AUTHORITY",
  "PI_CLAUDE_SUPERVISOR_REMOTE_NAME",
]);

export function automationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.PI_CLAUDE_SUPERVISOR_MODE?.trim().toLowerCase();
  if (mode !== undefined && mode !== "" && mode !== "auto" && mode !== "manual") throw new Error(`PI_CLAUDE_SUPERVISOR_MODE must be auto or manual: ${env.PI_CLAUDE_SUPERVISOR_MODE}`);
  const legacy = env.PI_CLAUDE_SUPERVISOR_AUTOMATION;
  return mode === "auto" || (legacy !== undefined && readBoolean(legacy, false));
}

export function supervisorTransport(env: NodeJS.ProcessEnv = process.env, automatic = automationEnabled(env)): "process-pipe" | "jsonl" | "tmux" {
  const value = env.PI_CLAUDE_SUPERVISOR_TRANSPORT?.trim().toLowerCase();
  if (value === undefined || value === "") return automatic ? "jsonl" : "process-pipe";
  if (value === "process-pipe" || value === "jsonl" || value === "tmux") return value;
  throw new Error(`PI_CLAUDE_SUPERVISOR_TRANSPORT must be process-pipe, jsonl or tmux: ${env.PI_CLAUDE_SUPERVISOR_TRANSPORT}`);
}

export function cgroupMode(env: NodeJS.ProcessEnv = process.env): "off" | "auto" | "required" {
  const value = env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE?.trim().toLowerCase();
  if (value === undefined || value === "") return "auto";
  if (value === "off" || value === "auto" || value === "required") return value;
  throw new Error(`PI_CLAUDE_SUPERVISOR_CGROUP_MODE must be off, auto or required: ${env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE}`);
}

export function webhookFormat(env: NodeJS.ProcessEnv = process.env): "generic" | "wecom" {
  const value = env.PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "generic") return "generic";
  if (value === "wecom") return "wecom";
  throw new Error(`PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT must be generic or wecom: ${env.PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT}`);
}

export interface AutonomyDefaults {
  unattended: boolean;
  requireLocalCommit: boolean;
  maxDecisionRetries: number;
  permissionAuthority: PermissionAuthority;
  remoteAuthority: RemoteAuthority;
  remoteName: string;
  maxWorkerCostUsd?: number;
}

export function autonomyDefaults(env: NodeJS.ProcessEnv = process.env): AutonomyDefaults {
  return {
    unattended: readBoolean(env.PI_CLAUDE_SUPERVISOR_UNATTENDED, true),
    requireLocalCommit: readBoolean(env.PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT, true),
    maxDecisionRetries: readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES, 2, 0, 10),
    permissionAuthority: readPermissionAuthority(env.PI_CLAUDE_SUPERVISOR_PERMISSION_AUTHORITY),
    remoteAuthority: readRemoteAuthority(env.PI_CLAUDE_SUPERVISOR_REMOTE_AUTHORITY),
    remoteName: readRemoteName(env.PI_CLAUDE_SUPERVISOR_REMOTE_NAME),
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

export const DEFAULT_DEADLINE_MS = 4 * 60 * 60_000;
export const DEFAULT_DEADLINE_GRACE_MS = 30 * 60_000;
export const DEFAULT_DEADLINE_WARNING_MS = 15 * 60_000;
export const DEFAULT_NO_OUTPUT_TIMEOUT_MS = 20 * 60_000;

/**
 * Cumulative wall-clock budget for a task's Worker turns (5 minutes to 7 days);
 * "0" disables the deadline. A duration suffix (`8h`, `90m`, `2h30m`) is
 * accepted as well as plain milliseconds.
 */
export function deadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedDurationWithZeroOptOut(env.PI_CLAUDE_SUPERVISOR_DEADLINE_MS, DEFAULT_DEADLINE_MS, 5 * 60_000, 7 * 24 * 60 * 60_000);
}

/**
 * Close-out window after the deadline: the Worker is asked to finish and the
 * candidate is verified instead of the Worker being stopped outright. "0"
 * restores the immediate stop at the deadline. Up to 24 hours.
 */
export function deadlineGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedDurationWithZeroOptOut(env.PI_CLAUDE_SUPERVISOR_DEADLINE_GRACE_MS, DEFAULT_DEADLINE_GRACE_MS, 60_000, 24 * 60 * 60_000);
}

/** How long before the deadline the Decision Worker is warned (up to 24 hours); "0" disables the warning. */
export function deadlineWarningMs(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedDurationWithZeroOptOut(env.PI_CLAUDE_SUPERVISOR_DEADLINE_WARNING_MS, DEFAULT_DEADLINE_WARNING_MS, 60_000, 24 * 60 * 60_000);
}

/** Stop a Worker that has produced no output for this long (1 minute to 24 hours); "0" disables the check. */
export function noOutputTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedDurationWithZeroOptOut(env.PI_CLAUDE_SUPERVISOR_NO_OUTPUT_TIMEOUT_MS, DEFAULT_NO_OUTPUT_TIMEOUT_MS, 60_000, 24 * 60 * 60_000);
}

const DURATION_UNITS_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

/**
 * Parse a duration such as `8h`, `90m`, `2h30m`, `45s` or plain milliseconds
 * into milliseconds; undefined for anything else (including negative values).
 */
export function parseDurationMs(value: string | undefined): number | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (/^\d+$/u.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/u.test(trimmed)) return undefined;
  let total = 0;
  for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gu)) {
    total += Number(match[1]) * DURATION_UNITS_MS[match[2]];
  }
  const rounded = Math.round(total);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}

/** Format milliseconds as a compact duration (`2h13m`, `45s`, `0s`) for status lines and notices. */
export function formatDurationMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 && total < 600 ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export function loadSupervisorEnvironment(): string | undefined {
  const path = process.env.PI_CLAUDE_SUPERVISOR_ENV_FILE ?? join(homedir(), ".config", "pi-claude-supervisor", "env");
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("owned by another user");
    if (info.nlink > 1) throw new Error("hard-link alias");
    if (info.size > MAX_ENV_FILE_BYTES) throw new Error("exceeds the safe size limit");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`pi-claude-supervisor could not inspect env file ${redactSensitive(path)}: ${redactSensitive(error instanceof Error ? error.message : String(error))}`);
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("secure Supervisor env-file opening is unavailable");
  let fd: number | undefined;
  let contents: string;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || info.nlink > 1 || info.size > MAX_ENV_FILE_BYTES) {
      throw new Error("env file changed to an unsafe regular-file state");
    }
    // Do not silently downgrade a configuration file whose permissions cannot
    // be tightened; an unsafe env file must be fixed explicitly.
    fchmodSync(fd, 0o600);
    contents = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
  } catch (error) {
    if (error instanceof Error && /valid UTF-8/u.test(error.message)) throw error;
    throw new Error(`pi-claude-supervisor could not securely read env file ${redactSensitive(path)}: ${redactSensitive(error instanceof Error ? error.message : String(error))}`, { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const parsed = new Map<string, string>();
  for (const [lineNumber, line] of contents.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/u);
    if (!match || !allowed.has(match[1]!)) throw new Error(`invalid Supervisor env entry at ${redactSensitive(path)}:${lineNumber + 1}`);
    if (parsed.has(match[1]!)) throw new Error(`duplicate Supervisor env entry ${match[1]} at ${redactSensitive(path)}:${lineNumber + 1}`);
    let value = match[2]!.trim();
    if (value.startsWith("\"") || value.startsWith("'")) {
      const quote = value[0]!;
      if (value.length < 2 || value.at(-1) !== quote) throw new Error(`unterminated Supervisor env value ${match[1]} at ${redactSensitive(path)}:${lineNumber + 1}`);
      value = value.slice(1, -1);
    } else if (/['"]|\s+#/u.test(value)) {
      throw new Error(`invalid Supervisor env value ${match[1]} at ${redactSensitive(path)}:${lineNumber + 1}`);
    }
    parsed.set(match[1]!, value);
  }
  for (const [name, value] of parsed) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  return path;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (/^(?:1|true|yes|on)$/iu.test(normalized)) return true;
  if (/^(?:0|false|no|off)$/iu.test(normalized)) return false;
  throw new Error(`invalid boolean Supervisor configuration value: ${value}`);
}

function readBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (normalized !== "" && Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  throw new Error(`Supervisor configuration integer must be between ${minimum} and ${maximum}: ${value}`);
}

/** Like readBoundedInteger, but the literal "0" is always honored as an opt-out below the normal minimum. */
function readBoundedIntegerWithZeroOptOut(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value !== undefined && value.trim() === "0") return 0;
  return readBoundedInteger(value, fallback, minimum, maximum);
}

/** Like readBoundedIntegerWithZeroOptOut, but also accepts a duration suffix (`8h`, `90m`). */
function readBoundedDurationWithZeroOptOut(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = parseDurationMs(value);
  // "0", "0m", "0h": any zero duration is the opt-out, not a below-minimum typo.
  if (parsed === 0) return 0;
  if (parsed !== undefined && parsed >= minimum && parsed <= maximum) return parsed;
  throw new Error(`Supervisor configuration duration must be ${minimum}..${maximum} ms or 0: ${value}`);
}

function readTrimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Remote authority never defaults on: an unset or unrecognised value keeps the Worker local. */
function readRemoteAuthority(value: string | undefined): RemoteAuthority {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "none") return "none";
  if (normalized === "push" || normalized === "pr") return normalized;
  // A typo must not silently switch the publish phase off: a task would then
  // end at a bare "candidate is ready" with no shortfall to explain it.
  throw new Error(`PI_CLAUDE_SUPERVISOR_REMOTE_AUTHORITY must be none, push or pr: ${value?.trim()}`);
}

function readRemoteName(value: string | undefined): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return "origin";
  // A typo must not silently redirect where a publish goes; the spec validator
  // throws for the same input, so this fails the same way instead of guessing.
  if (!isPlainRemoteName(trimmed)) throw new Error(`PI_CLAUDE_SUPERVISOR_REMOTE_NAME must be a plain remote name: ${trimmed}`);
  return trimmed;
}

function readPermissionAuthority(value: string | undefined): PermissionAuthority {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return "hybrid";
  if (normalized === "policy" || normalized === "decision-worker") return normalized;
  throw new Error(`PI_CLAUDE_SUPERVISOR_PERMISSION_AUTHORITY must be hybrid, policy or decision-worker: ${value}`);
}

function readPositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  if (value.trim() !== "" && Number.isFinite(parsed) && parsed > 0) return parsed;
  throw new Error(`Supervisor configuration value must be a positive number: ${value}`);
}

/** How automatic tmux supervision drives Claude: the real TUI through hooks (default) or the stream-json bridge. */
export function tmuxMode(env: NodeJS.ProcessEnv = process.env): "interactive" | "bridge" {
  const value = env.PI_CLAUDE_SUPERVISOR_TMUX_MODE?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "interactive") return "interactive";
  if (value === "bridge") return "bridge";
  throw new Error(`PI_CLAUDE_SUPERVISOR_TMUX_MODE must be interactive or bridge: ${env.PI_CLAUDE_SUPERVISOR_TMUX_MODE}`);
}

/** Exit the interactive Worker and its tmux session once a task completes; default keeps it open for the operator. */
export function closeWorkerOnCompletion(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolean(env.PI_CLAUDE_SUPERVISOR_CLOSE_WORKER_ON_COMPLETION, false);
}

/** Install the user-level Claude Code hook entries automatically when the interactive tmux mode is configured. */
export function autoInstallHooks(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolean(env.PI_CLAUDE_SUPERVISOR_AUTO_INSTALL_HOOKS, true);
}
