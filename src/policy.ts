export type PolicyDecision = "allow" | "review" | "deny";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

export function evaluatePermission(toolName: string, input: unknown): PolicyResult {
  if (toolName === "AskUserQuestion") return { decision: "review", reason: "Claude requested an interactive product decision" };
  if (toolName !== "Bash") return { decision: "review", reason: `unknown Claude tool requires review: ${toolName}` };
  const command = input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
    ? (input as { command: string }).command
    : "";
  if (!command) return { decision: "review", reason: "Bash request has no recognizable command" };
  return evaluateCommand("bash", ["-lc", command]);
}

const deniedPatterns = [
  /--dangerously-skip-permissions\b/iu,
  /--permission-mode\s+(?:bypasspermissions|dontask)\b/iu,
  /\brm\s+-rf\s+\//iu,
  /\bmkfs(?:\.|\s)/iu,
  /\bdd\s+if=/iu,
  /:\(\)\s*\{\s*:\|/u,
  /\b(shutdown|reboot|poweroff)\b/iu,
];

const reviewPatterns = [
  /\bgit\s+push\b/iu,
  /\bgit\s+reset\s+--hard\b/iu,
  /\bgit\s+(merge|rebase)\b/iu,
  /\b(npm|pnpm|yarn)\s+publish\b/iu,
  /\b(curl|wget)\b.*\|\s*(?:\/[\w./-]+\/)?(?:sh|bash|zsh)\b/iu,
  /\b(chmod|chown)\b/iu,
];

export function evaluateCommand(command: string, args: readonly string[] = []): PolicyResult {
  const normalized = [command, ...args].join(" ").trim();
  if (!normalized) return { decision: "deny", reason: "empty command" };
  if (deniedPatterns.some((pattern) => pattern.test(normalized))) {
    return { decision: "deny", reason: "command matches a prohibited destructive pattern" };
  }
  if (reviewPatterns.some((pattern) => pattern.test(normalized))) {
    return { decision: "review", reason: "command requires explicit human approval" };
  }
  return { decision: "allow", reason: "command is outside the default high-risk set" };
}

export function assertSafeWorkerCommand(
  command: string,
  args: readonly string[] = [],
  approval?: { actor: "human"; reason: string },
): void {
  const result = evaluateCommand(command, args);
  if (result.decision === "deny") {
    throw new Error(`Worker command blocked by policy (deny): ${result.reason}`);
  }
  if (result.decision === "review" && (!approval || approval.actor !== "human" || !approval.reason.trim())) {
    throw new Error(`Worker command blocked by policy (review): ${result.reason}`);
  }
}
