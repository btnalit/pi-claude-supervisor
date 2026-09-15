import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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
const allowedWorkerTools = new Set(["Bash", "Edit", "Glob", "Grep", "Read", "Write", "NotebookEdit"]);

export function evaluatePermission(toolName: string, input: unknown, cwd = process.cwd()): PolicyResult {
  if (toolName === "AskUserQuestion") return { decision: "deny", reason: "interactive questions are converted to ordinary Worker text" };
  if (!allowedWorkerTools.has(toolName)) return { decision: "deny", reason: `Worker tool is outside the automatic allowlist: ${toolName}` };
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const paths = fileToolPaths(input);
    if (paths.length === 0) return { decision: "deny", reason: `${toolName} request has no recognizable file path` };
    if (paths.some((path) => isGitMetadataPath(path, cwd))) return { decision: "deny", reason: "Worker cannot write Git metadata or protected branch refs" };
    return { decision: "allow", reason: `local Claude file tool is allowed by the task policy: ${toolName}` };
  }
  if (toolName !== "Bash") return { decision: "allow", reason: `local Claude tool is allowed by the task policy: ${toolName}` };
  const command = input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
    ? (input as { command: string }).command
    : "";
  if (!command) return { decision: "deny", reason: "Bash request has no recognizable command" };
  if (containsNestedClaude(command)) {
    return { decision: "deny", reason: "Worker cannot start a nested Claude or background Reviewer" };
  }
  return evaluateCommand("bash", ["-lc", command]);
}

function fileToolPaths(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const value = input as Record<string, unknown>;
  return ["file_path", "filePath", "path", "notebook_path", "notebookPath"]
    .map((key) => value[key])
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0);
}

function isGitMetadataPath(value: string, cwd: string): boolean {
  if (value.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) return true;
  let root: string;
  try { root = realpathSync(cwd); }
  catch { return true; }
  const raw = value.replaceAll("\\", "/");
  const canonicalRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  let components: string[];
  if (isAbsolute(value)) {
    const prefix = canonicalRoot === "/" ? "/" : `${canonicalRoot}/`;
    if (raw !== canonicalRoot && !raw.startsWith(prefix)) return true;
    components = raw === canonicalRoot ? [] : raw.slice(prefix.length).split("/");
  } else {
    components = raw.split("/");
  }
  const normalized: string[] = [];
  for (const segment of components) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return true;
      normalized.pop();
      continue;
    }
    if (segment.toLowerCase() === ".git") return true;
    const candidate = join(root, ...normalized, segment);
    try {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
    normalized.push(segment);
  }
  const absolute = join(root, ...normalized);
  try {
    const info = statSync(absolute);
    // A regular file with multiple links may be an alias for a Git ref or
    // other metadata file even when its pathname contains no `.git` segment.
    if (info.isFile() && info.nlink > 1) return true;
    const resolved = realpathSync(absolute);
    if (resolved.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return true;
  }
  return false;
}

const deniedPatterns = [
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

interface ShellToken {
  value: string;
  operator: boolean;
  dynamic: boolean;
}

const protectedBranches = new Set(["main", "master", "trunk", "integration", "develop"]);
const protectedBranchOperations = new Set(["checkout", "switch", "branch", "reset", "restore", "worktree", "update-ref", "symbolic-ref"]);
const remoteOperations = new Set(["push", "merge", "send-pack", "receive-pack", "update-ref"]);

export function evaluateCommand(command: string, args: readonly string[] = []): PolicyResult {
  const normalized = command.trim();
  if (!normalized) return { decision: "deny", reason: "empty command" };
  const lexical = lexShell(normalized);
  if (lexical.error) return { decision: "deny", reason: `command could not be safely parsed: ${lexical.error}` };
  const literalArgs = args.map((value) => ({ value, operator: false, dynamic: false }));
  return evaluateTokens([...lexical.tokens, ...literalArgs], 0);
}

function evaluateRepositoryBoundary(tokens: readonly ShellToken[], canonical: string, depth: number): PolicyResult | undefined {
  const values = tokens.filter((token) => !token.operator).map((token) => token.value);
  const lower = values.map((value) => value.toLowerCase());
  const hasGit = values.some((value) => /(?:^|[\\/])git$/iu.test(value) || /^(?:git-(?:send|receive|upload)-pack)$/iu.test(value));
  const hasGitTransport = lower.some((value) => /^(?:git-(?:send|receive|upload)-pack)$/u.test(value));
  const hasRemoteOperation = lower.some((value) => remoteOperations.has(value));
  const hasGhRemote = lower.some((value) => value === "gh" || value === "glab" || value === "hub")
    && lower.some((value) => value === "api" || value === "release" || value === "pull-request" || value === "pr" || value === "mr");
  const hasPackagePublication = lower.some((value) => value === "npm" || value === "pnpm" || value === "yarn") && lower.includes("publish");
  const hasGitAliasConfiguration = hasGit && lower.some((value) => /^alias\.[^=]*(?:=|$)/u.test(value));
  if (depth < 4) {
    for (const nested of nestedShellCommands(lower, values)) {
      const nestedResult = evaluateCommandInternal(nested, depth + 1);
      if (nestedResult.decision === "deny") return nestedResult;
    }
  }
  const hasDynamicArgument = tokens.some((token) => !token.operator && token.dynamic);
  const hasProtectedBranch = lower.some((value) => protectedBranches.has(value))
    || /(?:^|\s)(?:[^\s]*\.git[\\/]refs[\\/]heads[\\/]|[^\s]*refs[\\/]heads[\\/])(?:main|master|trunk|integration|develop)(?:$|\s)/iu.test(canonical);
  const gitOperation = lower.find((value) => protectedBranchOperations.has(value));

  if (hasDynamicArgument) {
    return { decision: "deny", reason: "dynamic shell arguments cannot be capability-checked safely" };
  }
  if (/\bgit\b[\s\S]*\b(?:push|merge|send-pack|receive-pack|update-ref)\b/iu.test(canonical)
    || /\bgit-(?:send|receive|upload)-pack\b/iu.test(canonical)
    || /\b(?:gh|glab|hub)\b[\s\S]*\b(?:api|pr|mr|pull-request|release)\b/iu.test(canonical)) {
    return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority" };
  }
  if (hasGit && (hasRemoteOperation || hasGitTransport) || hasGhRemote) {
    return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority" };
  }
  if (hasGitAliasConfiguration) {
    return { decision: "deny", reason: "Worker cannot redefine Git command aliases" };
  }
  if (hasGit && gitOperation && hasProtectedBranch) {
    return { decision: "deny", reason: "Worker cannot switch to or mutate a protected integration branch" };
  }
  const directRefWrite = tokens.some((token) => token.operator && (token.value === ">" || token.value === ">>"))
    || ["cp", "echo", "install", "mv", "printf", "sed", "tee"].includes(lower[0] ?? "");
  if (/\.git[\\/](?:HEAD|packed-refs|refs[\\/]heads[\\/])/iu.test(canonical)
    || (directRefWrite && hasProtectedBranch && /refs[\\/]heads[\\/]/iu.test(canonical))) {
    return { decision: "deny", reason: "Worker cannot write protected Git branch refs directly" };
  }
  if (hasPackagePublication) {
    return { decision: "deny", reason: "package publication belongs to the protected release workflow" };
  }
  const unsafePermissionMode = (value: string): boolean => value.replace(/[-_]/gu, "") === "bypasspermissions" || value.replace(/[-_]/gu, "") === "dontask";
  if (lower.some((value) => value.startsWith("--permission-mode=") && unsafePermissionMode(value.slice("--permission-mode=".length)))
    || (lower.includes("--permission-mode") && lower.some((value) => unsafePermissionMode(value)))) {
    return { decision: "deny", reason: "Worker cannot bypass Claude permission prompts" };
  }
  return undefined;
}

function containsNestedClaude(command: string, depth = 0): boolean {
  // Bash can hand an opaque quoted program to Python, Node, eval, env,
  // command, or another interpreter. Once this permission boundary sees a
  // Claude executable reference, fail closed rather than trying to prove which
  // wrapper will eventually exec it. This intentionally rejects harmless prose
  // mentions too; false positives cannot grant a nested Worker capability.
  if (/\b(?:claude(?:\.exe)?|review(?:er)?|code[-_ ]?review|read[-_ ]?only[-_ ]?review|independent[-_ ]?review|codex|cursor(?:-agent)?|aider|opencode|gemini)\b/iu.test(command)) return true;
  if (depth > 4) return false;
  const lexical = lexShell(command);
  if (lexical.error) return true;
  for (const token of lexical.tokens) {
    if (token.operator) continue;
    const executable = token.value.split(/[\\/]/u).at(-1)?.toLowerCase();
    if (executable === "claude" || executable === "claude.exe") return true;
    // Quote concatenation such as c'l'a'u'd'e is normalized by the shell
    // lexer into one token. Recurse into quoted interpreter payloads too.
    if (/\s/u.test(token.value) && containsNestedClaude(token.value, depth + 1)) return true;
  }
  return false;
}

function nestedShellCommands(lower: readonly string[], values: readonly string[]): string[] {
  const nested: string[] = [];
  const shellNames = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh"]);
  for (let index = 0; index < lower.length; index += 1) {
    const executable = lower[index]!.split(/[\\/]/u).at(-1);
    if (executable && shellNames.has(executable)) {
      for (let option = index + 1; option < lower.length; option += 1) {
        if (["-c", "--command"].includes(lower[option]!)) {
          const command = values.slice(option + 1).join(" ").trim();
          if (command) nested.push(command);
          break;
        }
      }
    }
    if (lower[index] === "eval") {
      const command = values.slice(index + 1).join(" ").trim();
      if (command) nested.push(command);
    }
  }
  return nested;
}

function evaluateCommandInternal(command: string, depth: number): PolicyResult {
  const normalized = command.trim();
  if (!normalized) return { decision: "deny", reason: "empty command" };
  const lexical = lexShell(normalized);
  if (lexical.error) return { decision: "deny", reason: `command could not be safely parsed: ${lexical.error}` };
  return evaluateTokens(lexical.tokens, depth);
}

function evaluateTokens(tokens: readonly ShellToken[], depth: number): PolicyResult {
  const canonical = tokens.map((token) => token.value).join(" ").trim();
  if (!canonical) return { decision: "deny", reason: "empty command" };
  const boundary = evaluateRepositoryBoundary(tokens, canonical, depth);
  if (boundary) return boundary;
  if (deniedPatterns.some((pattern) => pattern.test(canonical))) {
    if (/\b(?:curl|wget)\b[\s\S]*(?:github|gitlab|bitbucket|registry\.npmjs)\b/iu.test(canonical)) {
      return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority" };
    }
    if (/\bgit\b[\s\S]*\b(?:checkout|switch|branch|reset|restore|worktree|update-ref|symbolic-ref)\b[\s\S]*\b(?:main|master|trunk|integration|develop)\b/iu.test(canonical)) {
      return { decision: "deny", reason: "Worker cannot switch to or mutate a protected integration branch" };
    }
    if (/\b(?:npm|pnpm|yarn)\b[\s\S]*\bpublish\b/iu.test(canonical)) {
      return { decision: "deny", reason: "package publication belongs to the protected release workflow" };
    }
    return { decision: "deny", reason: "command matches a prohibited destructive pattern" };
  }
  return { decision: "allow", reason: "command is allowed for unattended local development" };
}

function lexShell(input: string): { tokens: ShellToken[]; error?: string } {
  const tokens: ShellToken[] = [];
  let value = "";
  let dynamic = false;
  let started = false;
  let quote: "single" | "double" | undefined;
  const flush = (): void => {
    if (!started) return;
    tokens.push({ value, operator: false, dynamic });
    value = "";
    dynamic = false;
    started = false;
  };
  const pushOperator = (operator: string): void => {
    flush();
    tokens.push({ value: operator, operator: true, dynamic: false });
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const next = input[index + 1];
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else value += character;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      else if (character === "\\" && next === "\n") index += 1;
      else if (character === "\\" && next !== undefined && /[\\"$`]/u.test(next)) { value += next; index += 1; }
      else { value += character; if (character === "$" || character === "`") dynamic = true; }
      started = true;
      continue;
    }
    if (character === "'") { quote = "single"; started = true; continue; }
    if (character === '"') { quote = "double"; started = true; continue; }
    if (character === "\\") {
      if (next === "\n") index += 1;
      else if (next !== undefined) { value += next; index += 1; }
      started = true;
      continue;
    }
    if (/\s/u.test(character)) { flush(); continue; }
    if (character === "$" || character === "`") { dynamic = true; value += character; started = true; continue; }
    // Brace, tilde and pathname expansion can change command names, targets or
    // Git refs after this lexical pass. Treat all unquoted expansion markers as
    // dynamic rather than attempting to model Bash's expansion order.
    if ("*?[]{}~".includes(character)) { dynamic = true; value += character; started = true; continue; }
    if (";&|<>".includes(character)) {
      const operator = next && ((character === "&" && next === "&") || (character === "|" && next === "|") || (character === ">" && next === ">") || (character === "<" && next === "<"))
        ? `${character}${next}`
        : character;
      pushOperator(operator);
      if (operator.length === 2) index += 1;
      continue;
    }
    value += character;
    started = true;
  }
  if (quote) return { tokens, error: "unterminated quote" };
  flush();
  return { tokens };
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
