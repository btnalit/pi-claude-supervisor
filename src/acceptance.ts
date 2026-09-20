import type { AcceptanceCheck, TaskSpec } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REPAIR_ROUNDS = 3;

/** Normalize legacy plain-text tasks into the structured acceptance model. */
export function normalizeTaskSpec(value: unknown, fallbackGoal: string, autonomyDefaults?: Partial<TaskSpec["autonomy"]>): TaskSpec {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("task spec must be a JSON object");
  }
  const source = (value ?? {}) as Record<string, unknown>;
  const goal = typeof source.goal === "string" && source.goal.trim() ? source.goal.trim() : fallbackGoal.trim();
  if (!goal) throw new Error("task goal must not be empty");
  return {
    goal,
    scope: stringList(source.scope, "scope"),
    constraints: stringList(source.constraints, "constraints"),
    forbidden: stringList(source.forbidden, "forbidden"),
    acceptance: normalizeChecks(source.acceptance),
    maxRepairRounds: normalizeRepairRounds(source.maxRepairRounds),
    autonomy: normalizeAutonomy(source.autonomy, autonomyDefaults),
  };
}

export function defaultAcceptanceChecks(): AcceptanceCheck[] {
  return [{
    id: "diff-check",
    name: "git diff check",
    command: "git",
    args: ["diff", "--check"],
    required: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }];
}

function normalizeChecks(value: unknown): AcceptanceCheck[] {
  if (value === undefined) return defaultAcceptanceChecks();
  if (!Array.isArray(value)) throw new Error("task spec acceptance must be an array");
  if (value.length === 0) return defaultAcceptanceChecks();
  const checks = value.map((item, index) => normalizeCheck(item, index));
  const ids = new Set<string>();
  for (const check of checks) {
    if (ids.has(check.id)) throw new Error(`duplicate acceptance check id: ${check.id}`);
    ids.add(check.id);
  }
  return checks;
}

function normalizeCheck(value: unknown, index: number): AcceptanceCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`acceptance[${index}] must be an object`);
  const source = value as Record<string, unknown>;
  const id = typeof source.id === "string" && /^[A-Za-z0-9._-]+$/u.test(source.id.trim())
    ? source.id.trim()
    : `check-${index + 1}`;
  const name = typeof source.name === "string" && source.name.trim() ? source.name.trim() : id;
  const command = typeof source.command === "string" ? source.command.trim() : "";
  if (!command) throw new Error(`acceptance[${index}] command must not be empty`);
  const args = source.args === undefined
    ? []
    : Array.isArray(source.args) && source.args.every((arg) => typeof arg === "string")
      ? source.args.map((arg) => arg)
      : undefined;
  if (!args) throw new Error(`acceptance[${index}] args must be an array of strings`);
  const timeoutValue = source.timeoutMs;
  const timeoutMs = timeoutValue === undefined ? DEFAULT_TIMEOUT_MS : timeoutValue;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60_000) {
    throw new Error(`acceptance[${index}] timeoutMs must be between 1 and 3600000`);
  }
  if (typeof source.required !== "undefined" && typeof source.required !== "boolean") {
    throw new Error(`acceptance[${index}] required must be boolean`);
  }
  return { id, name, command, args, required: source.required !== false, timeoutMs };
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`task spec ${field} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function normalizeRepairRounds(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_REPAIR_ROUNDS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10) throw new Error("maxRepairRounds must be between 0 and 10");
  return value;
}

function normalizeAutonomy(value: unknown, defaults?: Partial<TaskSpec["autonomy"]>): TaskSpec["autonomy"] {
  if (value === undefined) return { unattended: true, requireLocalCommit: true, maxDecisionRetries: 2, permissionAuthority: "hybrid", remoteAuthority: "none", remoteName: "origin" };
  // A spec file that omits these keys must not silently override the operator's
  // environment defaults with hardcoded ones; `defaults` carries them in.
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task spec autonomy must be an object");
  const source = value as Record<string, unknown>;
  if (source.unattended !== undefined && typeof source.unattended !== "boolean") throw new Error("task spec autonomy.unattended must be boolean");
  if (source.requireLocalCommit !== undefined && typeof source.requireLocalCommit !== "boolean") throw new Error("task spec autonomy.requireLocalCommit must be boolean");
  const retries = source.maxDecisionRetries ?? 2;
  if (typeof retries !== "number" || !Number.isSafeInteger(retries) || retries < 0 || retries > 10) throw new Error("task spec autonomy.maxDecisionRetries must be between 0 and 10");
  const authority = source.permissionAuthority ?? "hybrid";
  if (authority !== "policy" && authority !== "hybrid" && authority !== "decision-worker") throw new Error("task spec autonomy.permissionAuthority must be policy, hybrid or decision-worker");
  const remoteAuthority = source.remoteAuthority ?? defaults?.remoteAuthority ?? "none";
  if (remoteAuthority !== "none" && remoteAuthority !== "push" && remoteAuthority !== "pr") throw new Error("task spec autonomy.remoteAuthority must be none, push or pr");
  const remoteName = source.remoteName ?? defaults?.remoteName ?? "origin";
  if (typeof remoteName !== "string" || !/^[A-Za-z0-9._-]+$/u.test(remoteName)) throw new Error("task spec autonomy.remoteName must be a plain remote name");
  const maxWorkerCostUsd = source.maxWorkerCostUsd;
  if (maxWorkerCostUsd !== undefined && (typeof maxWorkerCostUsd !== "number" || !Number.isFinite(maxWorkerCostUsd) || maxWorkerCostUsd <= 0)) throw new Error("task spec autonomy.maxWorkerCostUsd must be a positive number");
  return {
    unattended: source.unattended !== false,
    requireLocalCommit: source.requireLocalCommit !== false,
    maxDecisionRetries: retries,
    permissionAuthority: authority,
    remoteAuthority,
    remoteName,
    ...(maxWorkerCostUsd !== undefined ? { maxWorkerCostUsd } : {}),
  };
}
