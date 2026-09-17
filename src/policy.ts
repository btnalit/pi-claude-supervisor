import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type PolicyDecision = "allow" | "review" | "deny";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

/**
 * Permission decisions are autonomous for local development. A denial is a
 * hard capability boundary, not a request for a human to approve the next
 * turn. Claude's built-in tools, agents, background tasks and MCP tools are
 * allowed; only the explicit unattended interaction and repository/remote
 * authority boundaries below remain special-cased.
 */
export function evaluatePermission(toolName: string, input: unknown, cwd = process.cwd()): PolicyResult {
  if (toolName === "AskUserQuestion") return { decision: "deny", reason: "interactive questions are converted to ordinary Worker text" };
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const paths = fileToolPaths(input);
    if (paths.length === 0) return { decision: "deny", reason: `${toolName} request has no recognizable file path` };
    const violation = paths.map((path) => ({ path, classification: classifyWritePath(path, cwd) })).find((entry) => entry.classification !== undefined);
    if (violation?.classification === "outside-cwd") return { decision: "deny", reason: `Worker cannot write outside the task working directory: ${violation.path}` };
    if (violation?.classification === "git-metadata") return { decision: "deny", reason: "Worker cannot write Git metadata or protected branch refs" };
    return { decision: "allow", reason: `local Claude file tool is allowed by the task policy: ${toolName}` };
  }
  if (toolName !== "Bash") return { decision: "allow", reason: `local Claude tool is allowed by the task policy: ${toolName}` };
  const command = input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
    ? (input as { command: string }).command
    : "";
  if (!command) return { decision: "deny", reason: "Bash request has no recognizable command" };
  return evaluateCommand("bash", ["-lc", command]);
}

function fileToolPaths(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const value = input as Record<string, unknown>;
  return ["file_path", "filePath", "path", "notebook_path", "notebookPath"]
    .map((key) => value[key])
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0);
}

type WritePathViolation = "outside-cwd" | "git-metadata";

function classifyWritePath(value: string, cwd: string): WritePathViolation | undefined {
  if (value.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) return "git-metadata";
  let root: string;
  try { root = realpathSync(cwd); }
  catch { return "git-metadata"; }
  const raw = value.replaceAll("\\", "/");
  const canonicalRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  let components: string[];
  if (isAbsolute(value)) {
    const prefix = canonicalRoot === "/" ? "/" : `${canonicalRoot}/`;
    if (raw !== canonicalRoot && !raw.startsWith(prefix)) return "outside-cwd";
    components = raw === canonicalRoot ? [] : raw.slice(prefix.length).split("/");
  } else {
    components = raw.split("/");
  }
  const normalized: string[] = [];
  for (const segment of components) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return "outside-cwd";
      normalized.pop();
      continue;
    }
    if (segment.toLowerCase() === ".git") return "git-metadata";
    const candidate = join(root, ...normalized, segment);
    try {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) return "git-metadata";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return "git-metadata";
    }
    normalized.push(segment);
  }
  const absolute = join(root, ...normalized);
  try {
    const info = statSync(absolute);
    // A regular file with multiple links may be an alias for a Git ref or
    // other metadata file even when its pathname contains no `.git` segment.
    if (info.isFile() && info.nlink > 1) return "git-metadata";
    const resolved = realpathSync(absolute);
    if (resolved.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) return "git-metadata";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return "git-metadata";
  }
  return undefined;
}

const deniedPatterns = [
  /\b(?:npm|pnpm|yarn)\b[\s\S]*\bpublish\b/iu,
  /\b(?:curl|wget)\b[\s\S]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request(?:=|\s+)(?:POST|PUT|PATCH|DELETE)|--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE)|(?:^|\s)(?:-d|--data(?:[-a-z]*)(?:=|\s+)|--post-data(?:=|\s+)|--body-data(?:=|\s+)))[\s\S]*https?:\/\/(?:api\.)?(?:github|gitlab|bitbucket|registry\.npmjs)\b/iu,
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

function containsRemoteCliMutation(command: string): boolean {
  return /\b(?:gh|glab|hub)\b[\s\S]*(?:\b(?:pr|mr|pull-request)\s+(?:merge|create|close|delete|edit|comment)\b|\b(?:release)\s+(?:create|delete|edit|upload)\b|\bapi\b[\s\S]*(?:-X|--request|--method(?:=|\s+))(?:\s*=?)\s*(?:POST|PUT|PATCH|DELETE)\b)/iu.test(command);
}

function containsRemoteHttpMutation(command: string): boolean {
  const hasHttpClient = /\b(?:curl|wget)\b/iu.test(command);
  const hasMutationFlag = /(?:-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request(?:=|\s+)(?:POST|PUT|PATCH|DELETE)\b|--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE)\b)/iu.test(command)
    || /(?:^|\s)(?:-d\b|--data(?:[-a-z]*)(?:=|\s+)|--post-data(?:=|\s+)|--body-data(?:=|\s+))/iu.test(command);
  const hasProtectedEndpoint = /https:\/\/(?:api\.)?(?:github|gitlab|bitbucket|registry\.npmjs)\b/iu.test(command);
  return hasHttpClient && hasMutationFlag && hasProtectedEndpoint;
}

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
  const hasGhRemote = containsRemoteCliMutation(canonical);
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
  if (/\bgit\b[\s\S]*\b(?:push|merge(?!-)|send-pack|receive-pack|update-ref)\b/iu.test(canonical)
    || /\bgit-(?:send|receive|upload)-pack\b/iu.test(canonical)
    || containsRemoteCliMutation(canonical)) {
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
  if (containsRemoteHttpMutation(canonical)) {
    return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority" };
  }
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

const SEGMENT_SPLIT_OPERATORS = new Set(["|", "&&", "||", ";", "&"]);

const ROUTINE_SHELL_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "egrep", "fgrep", "sed", "awk", "cut", "sort", "uniq", "wc", "tr",
  "find", "xargs", "echo", "printf", "pwd", "which", "env", "true", "false", "test", "[", "diff", "stat", "file",
  "basename", "dirname", "realpath", "readlink", "date", "sleep", "timeout", "node", "npm", "tsc", "git",
]);

const ROUTINE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "rev-list", "branch", "add", "commit", "stash", "restore",
  "switch", "checkout", "ls-files", "blame", "describe", "cat-file", "merge-base", "tag",
]);

const ROUTINE_NPM_SUBCOMMANDS = new Set(["test", "run", "ls"]);
const WRAPPER_COMMANDS = new Set(["xargs", "timeout", "env"]);
const NODE_INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
const NODE_INLINE_RISK = /\bhttps?\b|\bnet\b|\bchild_process\b|fetch\(/iu;

/**
 * A conservative, deterministic classifier for the narrow set of permission
 * requests routine enough for the Supervisor to answer from policy alone,
 * without a Decision Worker model call. It never overturns a policy denial;
 * it only recognizes local read-only and local-dev shapes it can fully
 * account for, and treats anything unrecognized as not routine.
 */
export function isRoutinePermission(toolName: string, input: unknown, cwd: string): boolean {
  const policyResult = evaluatePermission(toolName, input, cwd);
  if (policyResult.decision === "deny") return false;
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") return true;
  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep" || toolName === "LS" || toolName === "TodoWrite") return true;
  if (toolName === "Bash") {
    const command = input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
      ? (input as { command: string }).command
      : "";
    return command ? isRoutineShellCommand(command, cwd) : false;
  }
  // WebFetch, WebSearch, Task, mcp__* tools and any unrecognized tool name.
  return false;
}

function isRoutineShellCommand(command: string, cwd: string): boolean {
  // A newline can carry a heredoc body, a second statement, or other content
  // this single-line lexer never sees; treat any multi-line command as
  // unrecognized rather than reasoning about what follows the first line.
  if (/[\r\n]/u.test(command)) return false;
  const lexical = lexShell(command.trim());
  if (lexical.error) return false;
  if (lexical.tokens.some((token) => !token.operator && token.dynamic)) return false;
  const segments: ShellToken[][] = [[]];
  for (const token of lexical.tokens) {
    if (token.operator && SEGMENT_SPLIT_OPERATORS.has(token.value)) {
      segments.push([]);
      continue;
    }
    segments.at(-1)!.push(token);
  }
  if (segments.some((segment) => segment.length === 0)) return false;
  return segments.every((segment) => isRoutineSegment(segment, cwd, command, 0));
}

function isRoutineSegment(segment: readonly ShellToken[], cwd: string, rawCommand: string, depth: number): boolean {
  if (depth > 5) return false;
  if (hasUnsafeRedirection(segment, cwd)) return false;
  const words = segment.filter((token) => !token.operator).map((token) => token.value);
  if (words.length === 0) return false;
  return isRoutineWords(words, cwd, rawCommand, depth);
}

function isRoutineWords(words: readonly string[], cwd: string, rawCommand: string, depth: number): boolean {
  if (depth > 5) return false;
  const head = words[0]!.split(/[\\/]/u).at(-1)!.toLowerCase();
  if (WRAPPER_COMMANDS.has(head)) {
    const wrapped = unwrapWrapper(head, words.slice(1));
    if (wrapped.length === 0) return false;
    return isRoutineWords(wrapped, cwd, rawCommand, depth + 1);
  }
  if (!ROUTINE_SHELL_COMMANDS.has(head)) return false;
  if (head === "git") return isRoutineGitSubcommand(words.slice(1));
  if (head === "npm") return isRoutineNpmSubcommand(words.slice(1));
  if (head === "node") return isRoutineNode(words.slice(1), cwd, rawCommand);
  return true;
}

function unwrapWrapper(head: string, rest: readonly string[]): string[] {
  const words = [...rest];
  let index = 0;
  if (head === "timeout") {
    while (index < words.length && words[index]!.startsWith("-")) index += 1;
    if (index < words.length) index += 1; // the duration argument
    return words.slice(index);
  }
  if (head === "env") {
    while (index < words.length && (words[index]!.startsWith("-") || /^[A-Za-z_]\w*=/u.test(words[index]!))) index += 1;
    return words.slice(index);
  }
  // xargs
  while (index < words.length && words[index]!.startsWith("-")) index += 1;
  return words.slice(index);
}

function isRoutineGitSubcommand(rest: readonly string[]): boolean {
  let index = 0;
  while (index < rest.length) {
    const word = rest[index]!;
    if (word === "-C" || word === "-c") { index += 2; continue; }
    if (word.startsWith("-")) { index += 1; continue; }
    return ROUTINE_GIT_SUBCOMMANDS.has(word.toLowerCase());
  }
  return false;
}

function isRoutineNpmSubcommand(rest: readonly string[]): boolean {
  const subcommand = rest.find((word) => !word.startsWith("-"));
  return subcommand !== undefined && ROUTINE_NPM_SUBCOMMANDS.has(subcommand.toLowerCase());
}

function isRoutineNode(rest: readonly string[], cwd: string, rawCommand: string): boolean {
  // An inline-eval flag can appear after other flags or a preloaded module
  // (`node -r ./x.js -e '...'`); check for it across the whole argument list
  // before treating an earlier non-flag word as an ordinary script path.
  if (rest.some((word) => NODE_INLINE_FLAGS.has(word))) return !NODE_INLINE_RISK.test(rawCommand);
  for (const word of rest) {
    if (!word.startsWith("-")) return !isAbsolute(word) || isInsideCwd(word, cwd);
  }
  return false;
}

function hasUnsafeRedirection(segment: readonly ShellToken[], cwd: string): boolean {
  for (let index = 0; index < segment.length; index += 1) {
    const token = segment[index]!;
    if (token.operator && (token.value === ">" || token.value === ">>")) {
      const target = segment[index + 1];
      if (!target || target.operator) return true;
      if (isUnsafeRedirectTarget(target.value, cwd)) return true;
    }
  }
  return false;
}

function isUnsafeRedirectTarget(target: string, cwd: string): boolean {
  if (target.startsWith("/dev/")) return true;
  if (target.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) return true;
  if (!isAbsolute(target)) return false;
  return !isInsideCwd(target, cwd);
}

function isInsideCwd(pathValue: string, cwd: string): boolean {
  const resolved = resolve(cwd, pathValue);
  const rel = relative(cwd, resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
