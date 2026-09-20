import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
export interface PermissionPolicyOptions {
  /** Extra directories the Worker may write to (Claude's per-session scratchpad); each must be an absolute path. */
  writeRoots?: readonly string[];
}

export function evaluatePermission(toolName: string, input: unknown, cwd = process.cwd(), options: PermissionPolicyOptions = {}): PolicyResult {
  if (toolName === "AskUserQuestion") return { decision: "deny", reason: "interactive questions are converted to ordinary Worker text" };
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const paths = fileToolPaths(input);
    if (paths.length === 0) return { decision: "deny", reason: `${toolName} request has no recognizable file path` };
    const violation = paths.map((path) => ({ path, classification: classifyWritePath(path, cwd, options.writeRoots) })).find((entry) => entry.classification !== undefined);
    if (violation?.classification === "outside-cwd") {
      // Only name an alternative the Worker actually has: writeRoots is empty
      // for a bridge Worker and before an adopted session's first hook event.
      const alternatives = (options.writeRoots ?? []).length > 0 ? `; scratch work may go under ${(options.writeRoots ?? []).join(", ")}` : "";
      return { decision: "deny", reason: `Worker cannot write outside the task working directory: ${violation.path}${alternatives}` };
    }
    if (violation?.classification === "git-metadata") return { decision: "deny", reason: "Worker cannot write Git metadata or protected branch refs" };
    return { decision: "allow", reason: `local Claude file tool is allowed by the task policy: ${toolName}` };
  }
  if (toolName !== "Bash") return { decision: "allow", reason: `local Claude tool is allowed by the task policy: ${toolName}` };
  const command = input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
    ? (input as { command: string }).command
    : "";
  if (!command) return { decision: "deny", reason: "Bash request has no recognizable command" };
  // Lex the command itself: wrapping it as a literal `bash -lc` argument would
  // hide its structure (heredoc bodies, dynamic words) from the token checks.
  return evaluateCommand(command);
}

function fileToolPaths(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const value = input as Record<string, unknown>;
  return ["file_path", "filePath", "path", "notebook_path", "notebookPath"]
    .map((key) => value[key])
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0);
}

type WritePathViolation = "outside-cwd" | "git-metadata";

/**
 * `realpath` of the deepest ancestor that exists, with the not-yet-created tail
 * re-appended. Plain `realpathSync` throws for a directory the Worker is about
 * to create, and the caller cannot tell that apart from a hostile path.
 */
function resolveExistingPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...[...missing].reverse()); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return resolve(path);
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function classifyWritePath(value: string, cwd: string, writeRoots: readonly string[] = []): WritePathViolation | undefined {
  if (value.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) return "git-metadata";
  // A path inside an extra write root (Claude's own scratchpad) is judged
  // against that root instead of the cwd, with the same symlink/metadata rules.
  for (const root of writeRoots) {
    if (!isAbsolute(root) || !isAbsolute(value)) continue;
    // Resolve both sides before comparing: a write root reached through a
    // symlinked ancestor (a dotfile-managed ~/.claude, /var on macOS) would
    // otherwise be judged outside itself. The final component stays unresolved
    // so the per-segment symlink and `.git` checks below still see it.
    const resolvedRoot = resolveExistingPath(root);
    const resolvedValue = join(resolveExistingPath(dirname(value)), basename(value));
    const rel = relative(resolvedRoot, resolvedValue);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    return classifyWritePath(resolvedValue, resolvedRoot);
  }
  // A write root need not exist yet: Claude creates its memory directory on
  // the first write, and failing closed there denied the very write the
  // outside-cwd message points at.
  const root = resolveExistingPath(cwd);
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
  // `publish` must be the subcommand; a later argument that merely contains the
  // word (scripts/publish-package.mjs) is not a publication.
  /\b(?:npm|pnpm|yarn)\b(?:\s+-\S+)*\s+publish\b/iu,
  /\b(?:curl|wget)\b[\s\S]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request(?:=|\s+)(?:POST|PUT|PATCH|DELETE)|--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE)|(?:^|\s)(?:-d|--data(?:[-a-z]*)(?:=|\s+)|--post-data(?:=|\s+)|--body-data(?:=|\s+)))[\s\S]*https?:\/\/(?:api\.)?(?:github|gitlab|bitbucket|registry\.npmjs)\b/iu,
  /--(?:allow-)?dangerously-skip-permissions\b/iu,
  /--permission-mode\s+(?:bypasspermissions|dontask)\b/iu,
  // Only the filesystem root itself; `rm -rf /abs/path/dist` is ordinary local work.
  /\brm\s+(?:-\S+\s+)*\/+(?:\*|\s|$)/iu,
  /\bmkfs(?:\.|\s)/iu,
  /\bdd\s+if=/iu,
  /:\(\)\s*\{\s*:\|/u,
  /\b(shutdown|reboot|poweroff)\b/iu,
];

interface ShellToken {
  value: string;
  operator: boolean;
  dynamic: boolean;
  /** A quoted heredoc body: literal text whose meaning depends on the command that consumes it. */
  data?: boolean;
}

const protectedBranches = new Set(["main", "master", "trunk", "integration", "develop"]);
/**
 * Commands whose dynamic arguments could carry a boundary-crossing action or
 * execute arbitrary expanded text: the repository, package, network and
 * nested-worker surfaces, plus interpreters, runners and the catastrophe guards.
 */
const DYNAMIC_SENSITIVE_COMMANDS = new Set([
  "git", "gh", "glab", "hub", "npm", "pnpm", "yarn", "npx", "curl", "wget", "ssh", "scp", "rsync", "sftp", "claude",
  "eval", "exec", "source", "sh", "bash", "zsh", "dash", "ksh", "fish", "xargs", "env", "sudo", "su", "doas",
  "timeout", "time", "nice", "nohup", "command", "builtin", "watch", "setsid", "strace", "ltrace", "stdbuf", "flock",
  "unshare", "nsenter", "chroot", "script", "parallel", "expect", "ionice", "chrt", "taskset", "crontab", "at", "batch",
  "systemd-run", "dd", "mkfs", "shred",
]);
/** `find` runs its `-exec`/`-ok` argv and so joins the sensitive set when one is present. */
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** Commands that only store or display their input; a quoted heredoc fed to one never executes. */
const DATA_SINK_COMMANDS = new Set([
  "cat", "tee", "head", "tail", "grep", "rg", "wc", "sort", "uniq", "cut", "tr", "diff", "less", "more", "base64",
  "md5sum", "sha1sum", "sha256sum", "jq", "column", "fold", "paste", "comm", "cmp", "od", "hexdump", "xxd", "nl", "tac", "rev",
  "echo", "printf",
]);
const SHELL_NAMES = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh"]);
/** Shell words after which the next word is again in command position. */
const COMMAND_POSITION_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "(", "{", "time", "exec", "command", "builtin", "nohup", "sudo", "doas"]);
/** Rewriting a protected ref's identity directly; `checkout`/`switch`/`restore`/`worktree` are read-only uses of a branch name and are not included. */
const protectedBranchRewriteOperations = new Set(["reset", "update-ref", "symbolic-ref"]);
/** `branch` only rewrites or deletes a protected branch when combined with one of these flags. */
const protectedBranchDeleteOrMoveFlags = new Set(["-d", "-m", "-f", "--force", "--delete", "--move"]);
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
  const hasRewriteOperation = lower.some((value) => protectedBranchRewriteOperations.has(value));
  const hasBranchDeleteOrMove = lower.includes("branch") && lower.some((value) => protectedBranchDeleteOrMoveFlags.has(value));
  // `checkout -B main` / `switch -C main` reset the protected ref like `branch -f main`.
  const rawValues = tokens.filter((token) => !token.operator).map((token) => token.value);
  const hasForcedBranchCreate = (lower.includes("checkout") && rawValues.includes("-B"))
    || (lower.includes("switch") && (rawValues.includes("-C") || rawValues.includes("--force-create")));

  // An argument the lexer cannot see through matters only where it could reach
  // the boundary: a repository, package, network or remote-shell command, or an
  // interpreter that would execute the expanded text, in the same statement.
  // Dynamic text in an ordinary local command (`for f in …; echo "$f"`) or in
  // another statement (`npm test; echo "exit $?"`) is Claude's own business.
  if ((hasDynamicArgument && hasDynamicCommandName(tokens)) || segmentsOf(tokens).some((segment) => hasDynamicSensitiveArgument(segment))) {
    return { decision: "deny", reason: "a repository, package, network or shell command with a dynamic argument cannot be capability-checked; substitute the literal value for the shell variable so the command can be read, or use the Write/Edit tools when the intent is to change a file" };
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
  if (hasGit && (hasRewriteOperation || hasBranchDeleteOrMove || hasForcedBranchCreate) && hasProtectedBranch) {
    return { decision: "deny", reason: "Worker cannot rewrite or delete a protected integration branch" };
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

/** The statements of a command, split on `;`, `&&`, `||`, `|` and `&`. */
function segmentsOf(tokens: readonly ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = [[]];
  for (const token of tokens) {
    if (token.operator && SEGMENT_SPLIT_OPERATORS.has(token.value)) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  return segments.filter((segment) => segment.length > 0);
}

/** True when one statement combines a dynamic word with a command whose dynamic argument could reach the boundary. */
function hasDynamicSensitiveArgument(segment: readonly ShellToken[]): boolean {
  // A leading `NAME=value` prefix sets the environment and a redirection
  // target names a file; neither reaches the command's argv, so
  // `npm_config_cache=$TMPDIR/x npm run check` and `git show HEAD:f > $OLD/f`
  // are literal commands.
  const words: ShellToken[] = [];
  let afterRedirect = false;
  for (const token of segment) {
    if (token.operator) { afterRedirect = [">", ">>", "<", "<<<"].includes(token.value); continue; }
    if (!afterRedirect) words.push(token);
    afterRedirect = false;
  }
  let argvStart = 0;
  while (argvStart < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[argvStart]!.value)) argvStart += 1;
  if (!words.slice(argvStart).some((token) => token.dynamic)) return false;
  const values = words.map((token) => token.value);
  const lower = values.map((value) => value.toLowerCase());
  const executables = lower.map((value) => value.split(/[\\/]/u).at(-1) ?? value);
  const canonical = values.join(" ");
  return values.some((value) => /(?:^|[\\/])git$/iu.test(value) || /^git-(?:send|receive|upload)-pack$/iu.test(value))
    || containsRemoteCliMutation(canonical)
    || (lower.some((value) => value === "npm" || value === "pnpm" || value === "yarn") && lower.includes("publish"))
    || executables.some((executable) => DYNAMIC_SENSITIVE_COMMANDS.has(executable))
    || (executables.includes("find") && lower.some((value) => FIND_EXEC_ACTIONS.has(value)));
}

/** A dynamic word in command position (`$CMD …`, `; $CMD`, `do . $file`) could name anything. */
function hasDynamicCommandName(tokens: readonly ShellToken[]): boolean {
  let commandPosition = true;
  for (const token of tokens) {
    if (token.operator) {
      commandPosition = SEGMENT_SPLIT_OPERATORS.has(token.value);
      continue;
    }
    if (!commandPosition) continue;
    // `VAR=value cmd` keeps the following word in command position; the value itself is data.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token.value)) continue;
    if (token.dynamic) return true;
    const word = token.value.toLowerCase().replace(/^\(+/u, "") || "(";
    if (word === "." || word === "source") return true;
    if (COMMAND_POSITION_KEYWORDS.has(word)) continue;
    commandPosition = false;
  }
  return false;
}

function nestedShellCommands(lower: readonly string[], values: readonly string[]): string[] {
  const nested: string[] = [];
  for (let index = 0; index < lower.length; index += 1) {
    const executable = lower[index]!.split(/[\\/]/u).at(-1);
    if (executable && SHELL_NAMES.has(executable)) {
      for (let option = index + 1; option < lower.length; option += 1) {
        // `-c`, `--command`, or a combined short option such as `-lc` / `-ec`.
        if (lower[option] === "--command" || /^-[a-z]*c[a-z]*$/u.test(lower[option]!)) {
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

function evaluateTokens(rawTokens: readonly ShellToken[], depth: number): PolicyResult {
  const { tokens: dataResolved, embedded } = resolveDataTokens(rawTokens);
  const tokens = resolveLiteralBindings(dataResolved);
  if (depth < 4) {
    for (const body of embedded) {
      const nestedResult = evaluateCommandInternal(body, depth + 1);
      if (nestedResult.decision === "deny") return nestedResult;
    }
  }
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
    if (/\bgit\b[\s\S]*\b(?:reset|update-ref|symbolic-ref)\b[\s\S]*\b(?:main|master|trunk|integration|develop)\b/iu.test(canonical)
      || /\bgit\b[\s\S]*\bbranch\b[\s\S]*(?:^|\s)(?:-d|-m|-f|--force|--delete|--move)\b[\s\S]*\b(?:main|master|trunk|integration|develop)\b/iu.test(canonical)) {
      return { decision: "deny", reason: "Worker cannot rewrite or delete a protected integration branch" };
    }
    if (/\b(?:npm|pnpm|yarn)\b(?:\s+-\S+)*\s+publish\b/iu.test(canonical)) {
      return { decision: "deny", reason: "package publication belongs to the protected release workflow" };
    }
    return { decision: "deny", reason: "command matches a prohibited destructive pattern" };
  }
  return { decision: "allow", reason: "command is allowed for unattended local development" };
}

/**
 * `NAME=literal` and `for NAME in literal…` bind a name to text the policy can
 * see, so a later `$NAME` is not an unseen argument: `for c in 5dae138 feff500;
 * do git show $c; done` and `S=/tmp/x && cat > $S/log` are literal commands.
 * Every bound value is substituted (a loop over `status push` yields
 * `git status push …`, which the boundary checks still catch), and a name
 * rebound to dynamic text is forgotten again.
 */
function resolveLiteralBindings(tokens: readonly ShellToken[]): ShellToken[] {
  const bindings = new Map<string, string>();
  const resolved: ShellToken[] = [];
  const substitute = (token: ShellToken): ShellToken => {
    if (token.operator || token.data || !token.dynamic || bindings.size === 0) return token;
    const value = token.value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu, (match, name: string) => bindings.get(name) ?? match);
    if (value === token.value) return token;
    const dynamic = /[$`*?[\]{}~]/u.test(value) && !/^[[\]{}]+$/u.test(value);
    return { ...token, value, dynamic };
  };
  let commandPosition = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = substitute(tokens[index]!);
    resolved.push(token);
    if (token.operator) { commandPosition = SEGMENT_SPLIT_OPERATORS.has(token.value); continue; }
    const word = token.value;
    if (commandPosition) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(word);
      if (assignment) {
        if (token.dynamic) bindings.delete(assignment[1]!);
        else bindings.set(assignment[1]!, assignment[2]!);
        continue;
      }
      if (word.toLowerCase() === "for") {
        const name = tokens[index + 1]?.value;
        const inWord = tokens[index + 2]?.value.toLowerCase();
        if (name && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && inWord === "in") {
          const values: string[] = [];
          let cursor = index + 3;
          let literal = true;
          for (; cursor < tokens.length; cursor += 1) {
            const item = tokens[cursor]!;
            if (item.operator || item.value.toLowerCase() === "do") break;
            const substituted = substitute(item);
            if (substituted.dynamic || substituted.data) literal = false;
            values.push(substituted.value);
          }
          if (literal && values.length > 0) bindings.set(name, values.join(" "));
          else bindings.delete(name);
        }
      }
      if (!COMMAND_POSITION_KEYWORDS.has(word.toLowerCase())) commandPosition = false;
    }
  }
  return resolved;
}

/**
 * A quoted heredoc body means whatever its consumer makes of it. Fed to a shell
 * (`bash <<'EOF'`, `cat <<'EOF' | sh`, `eval "$(cat <<'EOF' …)"`) it is a
 * command and is evaluated as one; fed to a pure data sink (`cat > file`,
 * `git commit -m`) it is text the boundary never needs to see; fed to anything
 * else it stays in the command as literal words for the pattern checks.
 */
function resolveDataTokens(tokens: readonly ShellToken[]): { tokens: ShellToken[]; embedded: string[] } {
  if (!tokens.some((token) => token.data)) return { tokens: [...tokens], embedded: [] };
  const segments: { tokens: ShellToken[]; joiner?: string }[] = [{ tokens: [] }];
  for (const token of tokens) {
    if (token.operator && SEGMENT_SPLIT_OPERATORS.has(token.value)) {
      segments.at(-1)!.joiner = token.value;
      segments.push({ tokens: [] });
      continue;
    }
    segments.at(-1)!.tokens.push(token);
  }
  const commandOf = (segment: readonly ShellToken[]): { name: string; words: string[] } | undefined => {
    let afterRedirect = false;
    let name: string | undefined;
    const words: string[] = [];
    for (const token of segment) {
      if (token.operator) { afterRedirect = [">", ">>", "<", "<<", "<<<"].includes(token.value); continue; }
      const skip = afterRedirect;
      afterRedirect = false;
      if (skip || token.data) continue;
      const word = token.value.toLowerCase();
      if (name === undefined) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token.value) || COMMAND_POSITION_KEYWORDS.has(word)) continue;
        name = word.replace(/^\(+/u, "").split(/[\\/]/u).at(-1) ?? word;
      }
      words.push(word);
    }
    return name === undefined ? undefined : { name, words };
  };
  const resolved: ShellToken[] = [];
  const embedded: string[] = [];
  segments.forEach((segment, index) => {
    const bodies = segment.tokens.filter((token) => token.data);
    if (bodies.length === 0) {
      resolved.push(...segment.tokens, ...(segment.joiner ? [{ value: segment.joiner, operator: true, dynamic: false }] : []));
      return;
    }
    const consumers: { name: string; words: string[] }[] = [];
    for (let cursor = index; cursor < segments.length; cursor += 1) {
      const command = commandOf(segments[cursor]!.tokens);
      if (command) consumers.push(command);
      if (segments[cursor]!.joiner !== "|") break;
    }
    const shellConsumer = consumers.some((consumer) => SHELL_NAMES.has(consumer.name) || consumer.name === "eval" || consumer.name === "source" || consumer.name === ".");
    const sinkOnly = consumers.length > 0 && consumers.every((consumer) => DATA_SINK_COMMANDS.has(consumer.name) || (consumer.name === "git" && consumer.words.includes("commit")));
    if (shellConsumer) embedded.push(...bodies.map((token) => token.value));
    const kept = shellConsumer || sinkOnly ? segment.tokens.filter((token) => !token.data) : segment.tokens.map((token) => ({ ...token, data: false }));
    resolved.push(...kept, ...(segment.joiner ? [{ value: segment.joiner, operator: true, dynamic: false }] : []));
  });
  return { tokens: resolved, embedded };
}

/**
 * `$(cat <<'EOF' … EOF\n)` inside double quotes: Claude Code's commit-message
 * idiom. With a quoted delimiter nothing in the body expands or runs, so the
 * whole substitution is literal data.
 */
const LITERAL_CAT_HEREDOC = /^\$\(\s*cat\s+<<-?\s*(['"])([^'"\s]+)\1[ \t]*\n(?:([\s\S]*?)\n)?[ \t]*\2[ \t]*\n?\s*\)/u;

function lexShell(input: string): { tokens: ShellToken[]; error?: string } {
  const tokens: ShellToken[] = [];
  let value = "";
  let dynamic = false;
  let started = false;
  let tokenQuoted = false;
  let tokenData = false;
  let quote: "single" | "double" | undefined;
  // Heredocs: the word after `<<` names the delimiter; the body starts on the
  // next line and ends at a line equal to it. A quoted delimiter makes the body
  // pure data, which the boundary never needs to see.
  let expectDelimiter: { stripTabs: boolean } | undefined;
  const pendingHeredocs: { delimiter: string; quoted: boolean; stripTabs: boolean }[] = [];
  const flush = (): void => {
    if (!started) return;
    // A bare `[`, `[[`, `]`, `]]`, `{` or `}` is shell syntax, not an expansion.
    if (/^[[\]{}]+$/u.test(value)) dynamic = false;
    if (expectDelimiter) {
      pendingHeredocs.push({ delimiter: value, quoted: tokenQuoted, stripTabs: expectDelimiter.stripTabs });
      expectDelimiter = undefined;
      dynamic = false;
    }
    tokens.push({ value, operator: false, dynamic, ...(tokenData ? { data: true } : {}) });
    value = "";
    dynamic = false;
    started = false;
    tokenQuoted = false;
    tokenData = false;
  };
  const pushOperator = (operator: string): void => {
    flush();
    tokens.push({ value: operator, operator: true, dynamic: false });
  };
  /** Consume the heredoc bodies that start after the newline at `newlineIndex`; returns the index to resume lexing at. */
  const consumeHeredocs = (newlineIndex: number): number => {
    let position = newlineIndex + 1;
    for (const heredoc of pendingHeredocs.splice(0)) {
      const bodyLines: string[] = [];
      let terminated = false;
      while (position <= input.length) {
        const lineEnd = input.indexOf("\n", position);
        const line = input.slice(position, lineEnd === -1 ? input.length : lineEnd);
        position = lineEnd === -1 ? input.length + 1 : lineEnd + 1;
        if ((heredoc.stripTabs ? line.replace(/^\t+/u, "") : line) === heredoc.delimiter) { terminated = true; break; }
        bodyLines.push(line);
      }
      const body = bodyLines.join("\n");
      // A quoted delimiter suppresses expansion: the body is data for its
      // consumer. An unquoted one expands, so the body is an ordinary argument.
      tokens.push(heredoc.quoted ? { value: body, operator: false, dynamic: false, data: true } : { value: body, operator: false, dynamic: /[$`]/u.test(body) });
      if (!terminated) break;
    }
    return Math.min(position, input.length);
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
      else if (character === "$") {
        const literal = LITERAL_CAT_HEREDOC.exec(input.slice(index));
        if (literal) { value += literal[3] ?? ""; tokenData = true; index += literal[0].length - 1; }
        else { value += character; dynamic = true; }
      }
      else { value += character; if (character === "`") dynamic = true; }
      started = true;
      continue;
    }
    if (character === "'") { quote = "single"; started = true; tokenQuoted = true; continue; }
    if (character === '"') { quote = "double"; started = true; tokenQuoted = true; continue; }
    if (character === "\\") {
      if (next === "\n") index += 1;
      else if (next !== undefined) { value += next; index += 1; }
      started = true;
      continue;
    }
    // A comment runs to the end of the line.
    if (character === "#" && !started) {
      const lineEnd = input.indexOf("\n", index);
      index = (lineEnd === -1 ? input.length : lineEnd) - 1;
      continue;
    }
    // A newline ends the statement. Any pending heredoc bodies belong to the
    // statement just lexed, so they are emitted before the separator.
    if (character === "\n") {
      flush();
      expectDelimiter = undefined;
      if (pendingHeredocs.length > 0) index = consumeHeredocs(index) - 1;
      const last = tokens.at(-1);
      if (last && !(last.operator && SEGMENT_SPLIT_OPERATORS.has(last.value))) pushOperator(";");
      continue;
    }
    if (/\s/u.test(character)) { flush(); continue; }
    if (character === "$" || character === "`") { dynamic = true; value += character; started = true; continue; }
    // Brace, tilde and pathname expansion can change command names, targets or
    // Git refs after this lexical pass. Treat all unquoted expansion markers as
    // dynamic rather than attempting to model Bash's expansion order.
    // A tilde expands only at the start of a word (or of an assignment value);
    // `HEAD~1` and `a~b` are literal text.
    if (character === "~") { if (value === "" || /[=:]$/u.test(value)) dynamic = true; value += character; started = true; continue; }
    if ("*?[]{}".includes(character)) { dynamic = true; value += character; started = true; continue; }
    if (";&|<>".includes(character)) {
      if (character === "<" && next === "<") {
        const third = input[index + 2];
        if (third === "<") { pushOperator("<<<"); index += 2; continue; }
        const stripTabs = third === "-";
        pushOperator("<<");
        expectDelimiter = { stripTabs };
        index += stripTabs ? 2 : 1;
        continue;
      }
      const operator = next && ((character === "&" && next === "&") || (character === "|" && next === "|") || (character === ">" && next === ">"))
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
export function isRoutinePermission(toolName: string, input: unknown, cwd: string, options: PermissionPolicyOptions = {}): boolean {
  const policyResult = evaluatePermission(toolName, input, cwd, options);
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
