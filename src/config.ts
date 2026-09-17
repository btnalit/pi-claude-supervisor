import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSensitive } from "./redaction.ts";

const allowed = new Set([
  "PI_CLAUDE_SUPERVISOR_MODE",
  "PI_CLAUDE_SUPERVISOR_AUTOMATION",
  "PI_CLAUDE_SUPERVISOR_TRANSPORT",
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
  "PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS",
  "PI_CLAUDE_SUPERVISOR_EVENT_LOG_MAX_BYTES",
]);

export interface AutonomyDefaults {
  unattended: boolean;
  requireLocalCommit: boolean;
  maxDecisionRetries: number;
}

export function autonomyDefaults(env: NodeJS.ProcessEnv = process.env): AutonomyDefaults {
  return {
    unattended: readBoolean(env.PI_CLAUDE_SUPERVISOR_UNATTENDED, true),
    requireLocalCommit: readBoolean(env.PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT, true),
    maxDecisionRetries: readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES, 2, 0, 10),
  };
}

export function reviewTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS, 600_000, 30_000, 3_600_000);
}

export function eventLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedInteger(env.PI_CLAUDE_SUPERVISOR_EVENT_LOG_MAX_BYTES, 64 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024);
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
