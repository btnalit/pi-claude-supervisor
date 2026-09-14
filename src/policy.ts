export type PolicyDecision = "allow" | "review" | "deny";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

/**
 * Permission decisions are autonomous for local development. A denial is a
 * hard capability boundary, not a request for a human to approve the next
 * turn. AskUserQuestion is denied so the Worker can restate the question as
 * ordinary text and the Decision Worker can answer it from task evidence.
 */
export function evaluatePermission(toolName: string, input: unknown): PolicyResult {
  if (toolName === "AskUserQuestion") return { decision: "deny", reason: "interactive questions are converted to ordinary Worker text" };
  if (toolName !== "Bash") return { decision: "allow", reason: `local Claude tool is allowed by the task policy: ${toolName}` };
  const command = input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
    ? (input as { command: string }).command
    : "";
  if (!command) return { decision: "deny", reason: "Bash request has no recognizable command" };
  return evaluateCommand("bash", ["-lc", command]);
}

const deniedPatterns = [
  // The Worker may develop and commit locally, but it never receives the
  // authority to write to a remote repository or integrate into main.
  /\bgit\b[\s\S]*\b(?:push|merge)\b/iu,
  /\bgh\b[\s\S]*\bpr\s+(?:create|merge|close|reopen|edit)\b/iu,
  /\bgit\b[\s\S]*\b(?:checkout|switch)\b[\s-]+(?:main|master|trunk|integration|develop)\b/iu,
  /\b(?:npm|pnpm|yarn)\b[\s\S]*\bpublish\b/iu,
  /--dangerously-skip-permissions\b/iu,
  /--permission-mode\s+(?:bypasspermissions|dontask)\b/iu,
  /\brm\s+-rf\s+\//iu,
  /\bmkfs(?:\.|\s)/iu,
  /\bdd\s+if=/iu,
  /:\(\)\s*\{\s*:\|/u,
  /\b(shutdown|reboot|poweroff)\b/iu,
];

export function evaluateCommand(command: string, args: readonly string[] = []): PolicyResult {
  const normalized = [command, ...args].join(" ").trim();
  if (!normalized) return { decision: "deny", reason: "empty command" };
  if (deniedPatterns.some((pattern) => pattern.test(normalized))) {
    if (/\bgit\b[\s\S]*\b(?:push|merge)\b|\bgh\b[\s\S]*\bpr\s+(?:create|merge|close|reopen|edit)\b/iu.test(normalized)) {
      return { decision: "deny", reason: "Worker has no remote push or main/integration merge authority" };
    }
    if (/\bgit\b[\s\S]*\b(?:checkout|switch)\b[\s-]+(?:main|master|trunk|integration|develop)\b/iu.test(normalized)) {
      return { decision: "deny", reason: "Worker cannot switch to a protected integration branch" };
    }
    if (/\b(?:npm|pnpm|yarn)\b[\s\S]*\bpublish\b/iu.test(normalized)) {
      return { decision: "deny", reason: "package publication belongs to the protected release workflow" };
    }
    return { decision: "deny", reason: "command matches a prohibited destructive pattern" };
  }
  return { decision: "allow", reason: "command is allowed for unattended local development" };
}

/**
 * Keep the approval argument for persisted v0.5.x records and embedding API
 * compatibility. It is intentionally not required for local review patterns;
 * only hard-denied capability boundaries fail this assertion.
 */
export function assertSafeWorkerCommand(
  command: string,
  args: readonly string[] = [],
  _approval?: { actor: "human"; reason: string },
): void {
  const result = evaluateCommand(command, args);
  if (result.decision === "deny") {
    throw new Error(`Worker command blocked by policy (deny): ${result.reason}`);
  }
}
