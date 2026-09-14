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
  /\bgit\b[\s\S]*\b(?:push|merge|send-pack|receive-pack|update-ref)\b/iu,
  /\bgit-(?:send|receive|upload)-pack\b/iu,
  /\bgh\b[\s\S]*\b(?:api|pr\s+(?:create|merge|close|reopen|edit)|release\b)/iu,
  /\b(?:glab|hub)\b[\s\S]*\b(?:api|mr\s+(?:create|merge|close|reopen|edit)|pull-request|release)\b/iu,
  /\bgit\b[\s\S]*\b(?:checkout|switch|branch|reset|restore|worktree|update-ref|symbolic-ref)\b[\s\S]*\b(?:main|master|trunk|integration|develop)\b/iu,
  /\bgit\b[\s\S]*(?:\$\{?|\$\(|`)[\s\S]*\b(?:checkout|switch|branch|reset|restore|worktree|update-ref|symbolic-ref)\b/iu,
  /\bgit\b[\s\S]*(?:\$\{?|\$\(|`)/iu,
  /\bgit\b[\s\S]*\b(?:update-ref|symbolic-ref)\b[\s\S]*\brefs\/heads\/(?:main|master|trunk|integration|develop)\b/iu,
  /\b(?:npm|pnpm|yarn)\b[\s\S]*\bpublish\b/iu,
  /\b(?:ssh|scp|sftp|rsync)\b/iu,
  /\b(?:curl|wget)\b[\s\S]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE)|https?:\/\/(?:api\.)?(?:github|gitlab|bitbucket|registry\.npmjs)\.)/iu,
  /(?:\$\{?[^\s`}]+\}?|`[^`]*`|\$\([^)]*\))[\s\S]*\b(?:push|merge|publish)\b|\b(?:push|merge|publish)\b[\s\S]*(?:\$\{?[^\s`}]+\}?|`[^`]*`|\$\([^)]*\))/iu,
  /--(?:allow-)?dangerously-skip-permissions\b/iu,
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
    if (/\bgit\b[\s\S]*\b(?:push|merge|send-pack|receive-pack|update-ref)\b|\bgit-(?:send|receive|upload)-pack\b|\b(?:gh|glab|hub)\b[\s\S]*\b(?:api|pr|mr|pull-request|release)\b|\b(?:curl|wget)\b[\s\S]*(?:github|gitlab|bitbucket|registry\.npmjs)\b/iu.test(normalized)) {
      return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority" };
    }
    if (/\bgit\b[\s\S]*\b(?:checkout|switch|branch|reset|restore|worktree|update-ref|symbolic-ref)\b[\s\S]*\b(?:main|master|trunk|integration|develop)\b/iu.test(normalized)) {
      return { decision: "deny", reason: "Worker cannot switch to or mutate a protected integration branch" };
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
