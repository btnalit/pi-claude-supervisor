import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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

/**
 * Utilities whose effects are fully visible in their static argv. Anything that
 * can run another program from an option (`xargs`, `sort --compress-program`,
 * `env`, `find -exec`, `file -C`) is either absent or has that option rejected.
 */
const ROUTINE_SHELL_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "egrep", "fgrep", "sed", "awk", "cut", "uniq", "wc", "tr",
  "find", "echo", "printf", "pwd", "which", "true", "false", "test", "[", "diff", "stat",
  "basename", "dirname", "realpath", "readlink", "date", "sleep", "timeout", "node", "npm", "tsc", "git",
]);

/** Read-only or local-commit git subcommands whose remaining arguments cannot discard or relocate work. */
const ROUTINE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "blame", "describe", "cat-file", "merge-base",
  "add", "commit", "branch", "tag", "stash",
]);
const ROUTINE_GIT_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--contains", "--merged", "--no-merged", "--no-color"]);
const ROUTINE_GIT_TAG_FLAGS = new Set(["-l", "--list", "-n", "--contains", "--merged", "--no-merged"]);
const ROUTINE_GIT_STASH_SUBCOMMANDS = new Set(["list", "show", "push"]);
const ROUTINE_GIT_GLOBAL_FLAGS = new Set(["--no-pager", "-P", "--no-optional-locks"]);
/** `npm run <script>` executes repository-defined scripts; that is accepted by design because the scripts are reviewed repository content, like `node ./script.js`. */
const ROUTINE_NPM_SUBCOMMANDS = new Set(["test", "run", "ls"]);
const ROUTINE_NODE_FLAG = /^(?:--test(?:-(?:only|name-pattern|skip-pattern|concurrency|timeout|force-exit|coverage|isolation)(?:=.*)?)?|--check|-c|--version|-v|--enable-source-maps|--no-warnings|--experimental-strip-types)$/u;
/** `timeout` is the only transparent wrapper: it runs exactly the static argv that follows its duration. */
const WRAPPER_COMMANDS = new Set(["timeout"]);
const GIT_DRIVER_FLAGS = /^--(?:ext-diff|textconv|no-textconv|exec-path)/u;
const NODE_BUILTIN_REPORTERS = new Set(["spec", "tap", "dot", "junit", "lcov"]);
const NPM_RELOCATING_FLAGS = /^(?:--prefix|-C|--userconfig|--globalconfig|--location|-g|--global|--registry|--cache|--script-shell|--ignore-scripts)(?:=|$)/u;
const FIND_WRITE_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/**
 * A conservative, deterministic classifier for the narrow set of permission
 * requests routine enough for the Supervisor to answer from policy alone,
 * without a Decision Worker model call. It never overturns a policy denial;
 * it only recognizes local read-only and local-dev shapes it can fully
 * account for, and treats anything unrecognized as not routine. Executing
 * repository code (`node ./x.js`, `npm test`, `npm run <script>`) is routine by
 * design: that code is reviewed repository content and can equally be run
 * through the allowed file tools. Inline scripts, network clients, privilege
 * escalation, destructive git operations and any write outside the task cwd
 * are never routine; the Decision Worker judges those.
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
  // Process substitution (<(cmd), >(cmd)) and subshells hide a whole command
  // behind a word the segment scan would otherwise treat as an argument.
  if (hasUnquotedParenthesis(command)) return false;
  const tokens = withoutFdDuplication(lexical.tokens);
  if (!tokens) return false;
  const segments: ShellToken[][] = [[]];
  for (const token of tokens) {
    if (token.operator && SEGMENT_SPLIT_OPERATORS.has(token.value)) {
      segments.push([]);
      continue;
    }
    segments.at(-1)!.push(token);
  }
  if (segments.some((segment) => segment.length === 0)) return false;
  return segments.every((segment) => isRoutineSegment(segment, cwd, 0));
}

/** True when `(` or `)` appears outside single/double quotes and not backslash-escaped. */
function hasUnquotedParenthesis(command: string): boolean {
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === "single") { if (character === "'") quote = undefined; continue; }
    if (quote === "double") {
      if (character === "\\") { index += 1; continue; }
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "\\") { index += 1; continue; }
    if (character === "'") { quote = "single"; continue; }
    if (character === '"') { quote = "double"; continue; }
    if (character === "(" || character === ")") return true;
  }
  return false;
}

/**
 * Remove `N>&M`, `>&N`, `N>&-` and `<&N` descriptor duplications, which only
 * re-route existing streams and never name a file. The lexer emits them as
 * `[N] > & M`; any other `&` adjacent to a redirection (e.g. `&> file`) is
 * left in place and fails the ordinary target check.
 */
function withoutFdDuplication(tokens: readonly ShellToken[]): ShellToken[] | undefined {
  const result: ShellToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const redirect = token.operator && (token.value === ">" || token.value === ">>" || token.value === "<") ? token : undefined;
    const ampersand = tokens[index + 1];
    const target = tokens[index + 2];
    if (redirect && ampersand?.operator && ampersand.value === "&" && target && !target.operator && /^(?:\d+|-)$/u.test(target.value)) {
      // An optional leading descriptor number belongs to this redirection.
      const previous = result.at(-1);
      if (previous && !previous.operator && /^\d+$/u.test(previous.value) && result.length > 0) result.pop();
      index += 2;
      continue;
    }
    result.push(token);
  }
  return result;
}

function isRoutineSegment(segment: readonly ShellToken[], cwd: string, depth: number): boolean {
  if (depth > 5) return false;
  if (hasUnsafeRedirection(segment, cwd)) return false;
  const words = segment.filter((token) => !token.operator).map((token) => token.value);
  if (words.length === 0) return false;
  return isRoutineWords(words, cwd, depth);
}

function isRoutineWords(words: readonly string[], cwd: string, depth: number): boolean {
  if (depth > 5) return false;
  const first = words[0]!;
  // A program named by path (./ls, /tmp/x/ls) is an arbitrary executable, not
  // the well-known utility; leave it to the Decision Worker.
  if (/[\\/]/u.test(first)) return false;
  const head = first.toLowerCase();
  if (WRAPPER_COMMANDS.has(head)) {
    const wrapped = unwrapWrapper(head, words.slice(1));
    if (!wrapped || wrapped.length === 0) return false;
    return isRoutineWords(wrapped, cwd, depth + 1);
  }
  if (!ROUTINE_SHELL_COMMANDS.has(head)) return false;
  const rest = words.slice(1);
  // Every path-looking argument (absolute, `..`-escaping, `~`, or the value of
  // a `--flag=path`) must resolve inside the task cwd. This keeps reads of
  // /etc, ~/.ssh or ~/.aws and every option that names an outside file out of
  // the routine set, at the cost of an occasional model call for a sed script
  // that happens to start with `/`.
  if (rest.some((word) => namesPathOutsideCwd(word, cwd))) return false;
  switch (head) {
    case "git": return isRoutineGit(rest, cwd);
    case "npm": return isRoutineNpm(rest);
    case "node": return isRoutineNode(rest, cwd);
    case "tsc": return isRoutineTsc(rest, cwd);
    case "sed": return isRoutineSed(rest);
    case "awk": return !rest.some((word) => word.startsWith("-i") || word === "-f" || word.startsWith("--file") || /[>|]|\bsystem\b|\bgetline\b/u.test(word));
    case "find": return !rest.some((word) => FIND_WRITE_ACTIONS.has(word));
    case "uniq": return rest.filter((word) => !word.startsWith("-")).length <= 1;
    case "date": return !rest.some((word) => word === "-s" || word.startsWith("--set"));
    // --pre runs a preprocessor and -z/--search-zip runs decompressors from PATH.
    case "rg": return !rest.some((word) => word.startsWith("--pre") || word === "-z" || word === "--search-zip" || /^-[a-zA-Z]*z/u.test(word));
    default: return true;
  }
}

function unwrapWrapper(head: string, rest: readonly string[]): string[] | undefined {
  if (head !== "timeout") return undefined;
  const words = [...rest];
  let index = 0;
  // Only the plain `timeout [--foreground] DURATION command...` form is transparent;
  // options with values (-k, -s) shift what the duration is and are not routine.
  while (index < words.length && words[index]!.startsWith("-")) {
    if (words[index] !== "--foreground" && words[index] !== "--preserve-status") return undefined;
    index += 1;
  }
  if (index >= words.length || !/^\d+(?:\.\d+)?[smhd]?$/u.test(words[index]!)) return undefined;
  return words.slice(index + 1);
}

function isRoutineGit(rest: readonly string[], cwd: string): boolean {
  let index = 0;
  while (index < rest.length) {
    const word = rest[index]!;
    if (word === "-C") {
      const target = rest[index + 1];
      if (!target || !isInsideCwdArgument(target, cwd)) return false;
      index += 2;
      continue;
    }
    if (word.startsWith("-")) {
      // -c key=value, --git-dir, --work-tree, --exec-path and other global
      // options relocate or reconfigure git; none are routine.
      if (!ROUTINE_GIT_GLOBAL_FLAGS.has(word)) return false;
      index += 1;
      continue;
    }
    const subcommand = word.toLowerCase();
    if (!ROUTINE_GIT_SUBCOMMANDS.has(subcommand)) return false;
    const args = rest.slice(index + 1);
    // --output writes a file for diff/log/show; --ext-diff/--textconv run
    // configured driver programs. Keep every routine subcommand free of them.
    if (args.some((arg) => arg.startsWith("--output") || arg === "-o" || GIT_DRIVER_FLAGS.test(arg))) return false;
    // Rewriting the tip (--amend, --fixup/--squash for a later autosquash) discards
    // the previous commit's content; a fresh commit is the only routine form.
    if (subcommand === "commit") return !args.some((arg) => /^--(?:amend|fixup|squash)(?:=|$)/u.test(arg));
    if (subcommand === "branch") return args.every((arg) => !arg.startsWith("-") || ROUTINE_GIT_BRANCH_FLAGS.has(arg));
    if (subcommand === "tag") return args.every((arg) => !arg.startsWith("-") || ROUTINE_GIT_TAG_FLAGS.has(arg) || /^-n\d*$/u.test(arg));
    if (subcommand === "stash") {
      const action = args.find((arg) => !arg.startsWith("-"));
      return action === undefined ? args.length === 0 : ROUTINE_GIT_STASH_SUBCOMMANDS.has(action.toLowerCase());
    }
    return true;
  }
  return false;
}

const TSC_PATH_FLAGS = /^--?(?:out|outDir|outFile|declarationDir|tsBuildInfoFile|rootDir|project|p|build|b)$/u;

function isRoutineTsc(rest: readonly string[], cwd: string): boolean {
  // Every flag that names an output or project location must stay inside the
  // task cwd, whether written as `--outDir dir` or `--outDir=dir`.
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]!;
    const equals = word.indexOf("=");
    const flag = equals > 0 ? word.slice(0, equals) : word;
    if (!TSC_PATH_FLAGS.test(flag)) continue;
    const value = equals > 0 ? word.slice(equals + 1) : rest[index + 1];
    if (value === undefined || value.startsWith("-")) continue;
    if (!isInsideCwdArgument(value, cwd)) return false;
    if (equals < 0) index += 1;
  }
  return true;
}

function isRoutineNpm(rest: readonly string[]): boolean {
  const separator = rest.indexOf("--");
  const npmArguments = separator >= 0 ? rest.slice(0, separator) : rest;
  // --prefix/-C/-g/--userconfig... make npm run scripts or read configuration
  // from somewhere other than the task cwd.
  if (npmArguments.some((word) => NPM_RELOCATING_FLAGS.test(word))) return false;
  const subcommand = npmArguments.find((word) => !word.startsWith("-"));
  return subcommand !== undefined && ROUTINE_NPM_SUBCOMMANDS.has(subcommand.toLowerCase());
}

function isRoutineNode(rest: readonly string[], cwd: string): boolean {
  // Inline evaluation (-e/-p/--eval=/--print=/--input-type) and module
  // preloading (-r/--require/--import) run ad-hoc code; only a script inside
  // the task cwd, with a small set of harmless flags, is routine.
  let sawScript = false;
  for (const word of rest) {
    if (sawScript) continue; // arguments to the script itself
    if (word.startsWith("-")) {
      if (word === "--") continue;
      // A custom reporter is a module loaded by path; only the built-in names are routine.
      if (word.startsWith("--test-reporter=")) { if (!NODE_BUILTIN_REPORTERS.has(word.slice("--test-reporter=".length))) return false; continue; }
      if (!ROUTINE_NODE_FLAG.test(word)) return false;
      continue;
    }
    if (!isInsideCwdArgument(word, cwd)) return false;
    sawScript = true;
  }
  return sawScript || rest.some((word) => /^--test/u.test(word));
}

function isRoutineSed(rest: readonly string[]): boolean {
  let expectExpression = false;
  for (const word of rest) {
    if (expectExpression) {
      if (sedScriptWritesFiles(word)) return false;
      expectExpression = false;
      continue;
    }
    if (word === "-e" || word === "--expression") { expectExpression = true; continue; }
    if (word.startsWith("-")) {
      if (!/^-(?:n|E|r|s|z|u|-quiet|-silent|-regexp-extended|-separate|-null-data)$/u.test(word)) return false;
      continue;
    }
    // The first positional word is the script when no -e was given; a script
    // is never an existing path we can distinguish here, so check it as well.
    if (sedScriptWritesFiles(word)) return false;
  }
  return true;
}

/** sed's `w`/`W` commands and the `s///w file` flag write files; `r`/`R` read arbitrary files and `e` executes. Refuse any script containing them. */
function sedScriptWritesFiles(script: string): boolean {
  return /(?:^|[;{}\s])[wWrRe]\s*[^\s]|\/[gIp\d]*[we]/u.test(script);
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
  if (target === "/dev/null") return false; // the one device sink that discards rather than writes
  if (target.startsWith("/dev/") || target.startsWith("~") || target.startsWith("&")) return true;
  // The same check the Write/Edit tools get: inside the cwd after resolving
  // `..`, not Git metadata, and not through a symlink or hard link out of it.
  return classifyWritePath(target, cwd) !== undefined;
}

/** True for an argument that names a filesystem location outside the task cwd (or ~), including `--flag=path` values. */
function namesPathOutsideCwd(word: string, cwd: string): boolean {
  const value = word.startsWith("--") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
  if (value === "/dev/null") return false;
  if (value.startsWith("~")) return true;
  const pathLike = value.startsWith("/") || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value);
  if (pathLike && !isInsideCwd(value, cwd)) return true;
  // An argument that exists on disk may be (or pass through) a symlink that
  // leaves the cwd; compare real paths. A non-existent argument is a pattern or
  // a literal and needs no check.
  if (value.startsWith("-") || value === "") return false;
  let root: string;
  try { root = realpathSync(cwd); }
  catch { return true; }
  // Resolve the nearest existing ancestor so a symlinked directory component
  // (`link/new-file`) is caught even when the leaf does not exist yet.
  let candidate = resolve(cwd, value);
  while (true) {
    try {
      const real = realpathSync(candidate);
      const rel = relative(root, real);
      return rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      const relParent = relative(cwd, parent);
      if (relParent === "" ) return false; // reached the cwd itself: nothing left to resolve
      candidate = parent;
    }
  }
}

function isInsideCwdArgument(pathValue: string, cwd: string): boolean {
  if (pathValue.startsWith("~")) return false;
  const value = pathValue.includes("=") && pathValue.startsWith("--") ? pathValue.slice(pathValue.indexOf("=") + 1) : pathValue;
  return isInsideCwd(value, cwd);
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
