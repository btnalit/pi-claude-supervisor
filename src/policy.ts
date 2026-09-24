import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

export type PolicyDecision = "allow" | "review" | "deny";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  /**
   * Set on a denial of the remote-repository boundary itself — a push, merge,
   * pull request or remote mutation — so the Supervisor's publish hint answers
   * that refusal and not an unrelated denial (an HTTP mutation, an outside-cwd
   * write) that happens to share words with it.
   */
  boundary?: "remote";
  /**
   * Set only when a live publish grant admitted the command. The Supervisor
   * issued that grant itself, so the request is answered locally rather than
   * routed to a Decision Worker whose standing rule is to refuse a push.
   */
  granted?: true;
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
  /** A publish-phase grant; absent (the default) keeps the Worker with no remote authority at all. */
  remote?: RemoteGrant;
}

/**
 * Narrow, time-boxed remote authority for the publish phase. The Supervisor
 * issues it only after its own acceptance and Reviewer passed, and only for the
 * verified candidate's own branch, so an unverified Worker can never reach a
 * remote. `pr` implies `push`.
 */
export interface RemoteGrant {
  authority: "push" | "pr";
  /** The single remote the grant covers, e.g. `origin`. */
  remoteName: string;
  /** The candidate branch the verified commit is published to; a pull request must name it with `--head`. */
  branch: string;
  /**
   * The verified commit. A granted push must name it as the refspec source
   * (`<head>:refs/heads/<branch>`), so a commit made after verification can
   * never ride the grant: git pushes exactly that object or nothing.
   */
  head: string;
  /** The task working directory; a granted push must name it with an absolute `-C`, so the grant cannot be spent in another clone. */
  cwd: string;
  /**
   * The granted remote's repository as `host/owner/repo`, resolved from its
   * fetch URL when the grant was issued (an SSH-config host alias translated
   * the way gh translates it). Under `pr` a pull request must name it with
   * `--repo`: gh otherwise resolves a base repository from the remotes and
   * prefers `upstream` on a fork, which is not the repository the grant named
   * and not the one the confirmation reads. A pull request opens in the
   * granted remote's repository, full stop.
   */
  repository?: string;
}

/** A full git object id (SHA-1 or SHA-256), lowercase or not. One test for the grant, the evidence and the baseline. */
export function isCommitId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/iu.test(value);
}

/** A remote name git accepts verbatim; anything else could be an option or a path. One test for the env default and the spec. */
export function isPlainRemoteName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/u.test(value);
}

/** The hooks path the granted push must carry, so no hook a Worker could have installed runs inside the one granted command. */
export const GRANTED_HOOKS_PATH = "/dev/null";
/**
 * The `-c` settings the granted push must carry, in this order: the hooks path
 * (no installed hook runs inside the command) and `push.followTags=false` (no
 * annotated tag rides along — `push.followTags=true` set through a file the
 * policy never sees would otherwise make the one granted push also plant a
 * tag the grant never named, and a tag is what release automation keys on).
 * Both are ref/hook selection, not transport, so pinning them overrides no
 * legitimate per-repository setting.
 */
export const GRANTED_PUSH_SETTINGS = [`core.hooksPath=${GRANTED_HOOKS_PATH}`, "push.followTags=false"] as const;

/**
 * A word quoted for a POSIX shell: plain words pass through, anything else is
 * single-quoted with embedded quotes escaped. The one quoter for the hook
 * relay, the tmux attach hint and the publish instruction, which must all
 * produce what the policy's lexer reads back as a single literal token.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_.\/-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * The one push a grant admits, spelled the way `permittedRemoteCommand` reads
 * it. Kept beside the parser so the instruction the Supervisor sends and the
 * shape the policy accepts cannot drift apart. Every word the grant supplies
 * is shell-quoted — the directory for a space, the refspec and branch because
 * a legal branch name may carry `$`, `{}` or a quote that the lexer would
 * otherwise read as dynamic — the hooks path is pinned so no `pre-push` runs,
 * and the verified commit is the refspec source.
 */
export function publishCommand(grant: RemoteGrant): string {
  return `git -C ${shellQuote(grant.cwd)} ${GRANTED_PUSH_SETTINGS.map((setting) => `-c ${setting}`).join(" ")} push ${shellQuote(grant.remoteName)} ${shellQuote(`${grant.head}:refs/heads/${grant.branch}`)}`;
}

/** The one `gh pr create` prefix a `pr` grant admits; the Worker appends its title and body. */
export function pullRequestCommand(grant: RemoteGrant): string {
  return `gh pr create --repo ${shellQuote(grant.repository ?? "")} --head ${shellQuote(grant.branch)}`;
}
/**
 * The only options a granted `gh pr create` may carry. An allowlist, because an
 * unlisted option is how a grant leaks: `--body-file`/`-F`/`--template` post the
 * contents of an arbitrary local file, `-H` retargets the head branch, and `-w`
 * is `--web`.
 */
const ALLOWED_PR_CREATE_OPTIONS = new Set(["-t", "--title", "-b", "--body", "-B", "--base", "--draft", "-d", "--fill", "--fill-first", "-a", "--assignee", "-l", "--label", "-H", "--head", "-R", "--repo"]);
/** `gh pr create` options that take a value; the value is the next word. */
const PR_CREATE_VALUE_OPTIONS = new Set(["-t", "--title", "-b", "--body", "-B", "--base", "-a", "--assignee", "-l", "--label", "-H", "--head", "-R", "--repo"]);

export function evaluatePermission(toolName: string, input: unknown, cwd = process.cwd(), options: PermissionPolicyOptions = {}): PolicyResult {
  if (toolName === "AskUserQuestion") return { decision: "deny", reason: "interactive questions are converted to ordinary Worker text" };
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const paths = fileToolPaths(input);
    if (paths.length === 0) return { decision: "deny", reason: `${toolName} request has no recognizable file path` };
    const violation = paths.map((path) => ({ path, classification: classifyWritePath(path, cwd, options.writeRoots) })).find((entry) => entry.classification !== undefined);
    if (violation?.classification === "outside-cwd") {
      // Only name an alternative the Worker actually has: writeRoots is empty
      // for a bridge Worker and before an adopted session's first hook event.
      const alternatives = (options.writeRoots ?? []).length > 0 ? `; writes are also allowed under ${(options.writeRoots ?? []).join(", ")}` : "";
      return { decision: "deny", reason: `Worker cannot write outside the task working directory: ${violation.path}${alternatives}` };
    }
    if (violation?.classification === "cwd-missing") return { decision: "deny", reason: `the task working directory no longer exists, so nothing can be written under it: ${violation.path}` };
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
  const result = evaluateCommand(command, [], options.remote);
  if (result.decision === "deny") return result;
  const floor = deleteFloorViolation(command, cwd, { writeRoots: options.writeRoots ?? [] });
  return floor ? { decision: "deny", reason: floor } : result;
}

export interface DeleteFloorOptions {
  /** Extra directories the task may write (and so delete) in. */
  writeRoots?: readonly string[];
  /** Shared scratch roots; defaults to the OS temp directory and /tmp. */
  tempRoots?: readonly string[];
}

/**
 * The delete floor: the one line that holds whatever else is relaxed, so no
 * authority mode (policy, hybrid, Decision Worker) can let a Bash command
 * delete or move something outside the task. It is read fail-closed: every
 * word of a statement that names a delete or move (`rm`, `rmdir`, `unlink`,
 * `shred`, `mv`, `rimraf`), and `find -delete`/`-exec rm`, `git clean`,
 * `rsync --delete`, counts wherever it stands, so any wrapper (`sudo`,
 * `busybox`, `env -i`, a function or `case` body) is seen through without a
 * table of its options. Only text commands (`echo`, `grep`, …), interpreters
 * and tools whose own `rm` subcommand is not a file delete (`git rm`, `npm rm`,
 * `docker rm`) end the scan. Quoted scripts that mention a delete (`sh -lc
 * '…'`, `watch '…'`, `trap '…'`), text piped into a shell, and the bodies of
 * `$(…)`, backticks and `<(…)` are judged as scripts of their own; past the
 * nesting limit a delete is refused outright. A target is refused when it
 * - is not literal (a variable, a command substitution), follows a `cd` that
 *   cannot be resolved, or comes from input (`xargs`, `parallel`);
 * - resolves outside the task directory, its extra write roots and the temp
 *   directory, or is one of those roots itself (or a glob across its top);
 * - is the task directory itself, or any directory that contains it;
 * - is a glob over hidden entries (`.*` would take `.git`), a glob followed by
 *   `..`, or a `find` over the whole task tree whose filter could reach `.git`;
 * - is Git's own store (`.git` or anything in it, bar a stale `*.lock`).
 * Brace alternatives are expanded and judged one by one; literal globs, names
 * bound to literal text or to `$(mktemp …)`, and `$HOME`/`$TMPDIR`/`$PWD` are
 * judged like the paths they spell. `git gc --prune`, `git prune` and `git
 * reflog expire/delete` are refused too: with no remote authority the local
 * commits are the only copy. Returns the reason, or undefined. Interpreters
 * (`python -c "shutil.rmtree(...)"`, a script file) and overwrites (`cp`,
 * `ln -sf`, `>`) remain outside what this floor reads.
 */
export function deleteFloorViolation(command: string, cwd: string, options: DeleteFloorOptions = {}): string | undefined {
  const roots = deleteFloorRoots(cwd, options.writeRoots ?? [], options.tempRoots ?? [tmpdir(), "/tmp"]);
  return floorScript(command, cwd, roots, new Map(), 0);
}

interface FloorRoots { cwd: string; others: string[] }

const FLOOR_MAX_DEPTH = 6;
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "mv", "rimraf"]);
const DELETE_WORD = /(?:^|[^A-Za-z0-9_.-])(?:rm|rmdir|unlink|shred|mv|rimraf)(?:[^A-Za-z0-9_.-]|$)|-delete\b|--delete\b/u;
/** Commands whose words are text, code in another language, or their own `rm` subcommand: the scan stops at them. */
const FLOOR_STOP_COMMANDS = new Set([
  // DATA_SINK_COMMANDS is declared further down, so its words are repeated here.
  "cat", "tee", "head", "tail", "grep", "rg", "wc", "sort", "uniq", "cut", "tr", "diff", "less", "more", "base64", "md5sum",
  "sha1sum", "sha256sum", "jq", "column", "fold", "paste", "comm", "cmp", "od", "hexdump", "xxd", "nl", "tac", "rev", "echo", "printf",
  "egrep", "fgrep", "ag", "ack", "man", "which", "type", "whatis", "apropos", "info", "help", "tldr", "alias", "logger", "yq",
  "python", "python2", "python3", "node", "deno", "perl", "ruby", "php", "lua", "awk", "gawk", "mawk", "sed", "Rscript",
  "npm", "pnpm", "yarn", "bun", "docker", "podman", "nerdctl", "kubectl", "helm", "conda", "mamba", "micromamba", "brew",
  "pip", "pip3", "uv", "poetry", "cargo", "go", "gh", "hg", "svn", "jj", "dvc", "aws", "gsutil", "gcloud", "az", "mc",
  "rclone", "s3cmd", "snap", "flatpak", "apt", "apt-get", "dnf", "yum", "zypper", "pacman", "systemctl", "ssh", "scp",
]);
/** Git subcommands that run shell text they are given. */
const GIT_SHELL_SUBCOMMANDS = new Set(["rebase", "submodule", "bisect", "filter-branch", "filter-repo"]);
const REDIRECT_OPERATORS = new Set([">", ">>", "<", "<<", ">|", "&>", ">&"]);
/** Entries under `.git` a find filter must not be able to match. */
const GIT_STORE_PROBES = [".git", ".git/HEAD", ".git/index", ".git/config", ".git/packed-refs", ".git/objects", ".git/objects/ab/cdef0123",
  ".git/objects/pack/pack-1.pack", ".git/refs/heads/main", ".git/hooks/pre-commit", ".git/logs/HEAD"];

function floorScript(command: string, start: string | undefined, roots: FloorRoots, inherited: ReadonlyMap<string, string>, depth: number): string | undefined {
  if (depth >= FLOOR_MAX_DEPTH) {
    return DELETE_WORD.test(command) ? "Worker cannot delete through commands nested this deep; flatten the command" : undefined;
  }
  const lexical = lexShell(command.trim());
  // At the top an unparsable command is already refused by evaluateCommand;
  // nested text that does not parse cannot be read, so a delete in it is refused.
  if (lexical.error) return depth > 0 && DELETE_WORD.test(command) ? "Worker cannot delete through a script the policy cannot parse" : undefined;
  const bindings = floorBindings(command, lexical.tokens, inherited);
  const nested = (body: string, directory: string | undefined): string | undefined => floorScript(body, directory, roots, bindings, depth + 1);
  for (const body of substitutionBodies(command)) {
    const violation = nested(body, start);
    if (violation) return violation;
  }
  const { tokens: dataResolved, embedded } = resolveDataTokens(lexical.tokens);
  for (const body of embedded) {
    const violation = nested(body, start);
    if (violation) return violation;
  }
  const tokens = resolveLiteralBindings(applyFloorBindings(dataResolved, bindings));
  const segments = floorSegments(tokens);
  // The directory each statement runs in, as far as a static reading can
  // tell; undefined once a `cd` it cannot resolve has run.
  let directory = start;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const words = segmentWords(segment.tokens);
    let first = 0;
    while (first < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[first]!.value) || FLOOR_KEYWORDS.has(words[first]!.value))) first += 1;
    if (first >= words.length) continue;
    const head = floorCommandName(words[first]!);
    // Text piped into a shell is a script.
    const intoShell = segment.joiner === "|" && SHELL_NAMES.has(floorCommandName(segmentWords(segments[index + 1]?.tokens ?? [])[0]) ?? "");
    if (intoShell) {
      const violation = nested(words.slice(first + 1).map((word) => word.value).join(" "), directory);
      if (violation) return violation;
    }
    // A quoted argument that mentions a delete is a script for whatever runs it
    // (`sh -lc`, `watch`, `trap`, `su -c`), unless the command only reads text.
    const readsText = head !== undefined && FLOOR_STOP_COMMANDS.has(head)
      || (head === "git" && !words.slice(first + 1).some((word) => GIT_SHELL_SUBCOMMANDS.has(word.value)));
    if (!readsText) {
      for (const word of words.slice(first + 1)) {
        if (/\s/u.test(word.value) && DELETE_WORD.test(word.value)) {
          const violation = nested(word.value, directory);
          if (violation) return violation;
        }
      }
    }
    let local = directory;
    for (let cursor = first; cursor < words.length; cursor += 1) {
      const word = words[cursor]!;
      const name = floorCommandName(word);
      if (name === undefined) continue;
      if (name === "cd" || name === "pushd") { directory = resolveCd(words.slice(cursor + 1), directory); break; }
      if (name === "popd") { directory = undefined; break; }
      if (FLOOR_STOP_COMMANDS.has(name)) break;
      // `env -C DIR` and `sudo -D DIR` run the command elsewhere.
      if (name === "env" || name === "sudo") {
        const next = words[cursor + 1]?.value;
        const flags = name === "env" ? ["-C", "--chdir"] : ["-D", "--chdir"];
        if (next !== undefined && flags.includes(next)) local = resolveCd(words.slice(cursor + 2, cursor + 3), local);
        else if (next?.startsWith("--chdir=")) local = resolveCd([{ ...words[cursor + 1]!, value: next.slice("--chdir=".length) }], local);
        continue;
      }
      if (name === "xargs" || name === "parallel") {
        const inner = words.slice(cursor + 1).find((later) => DELETE_COMMANDS.has(floorCommandName(later) ?? ""));
        if (inner) return `Worker cannot ${floorCommandName(inner)} targets taken from input (${name}); name the paths, or use find -delete inside the task directory`;
        break;
      }
      const args = words.slice(cursor + 1).map((arg) => (/^(?:\$\(|<\(|>\(|\(|`)/u.test(word.value) ? { ...arg, value: arg.value.replace(/[)`]+$/u, "") } : arg));
      const found = deleteTargets(name, args);
      if (found) {
        for (const target of found.targets) {
          const violation = judgeDeleteTarget(target, local, roots, name, found.contentsOnly);
          if (violation) return violation;
        }
      }
      if (found || DELETE_COMMANDS.has(name) || name === "find" || name === "git" || name === "rsync") break;
    }
  }
  return undefined;
}

const FLOOR_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "(", "{", "}", "done", "fi", "esac"]);

function deleteFloorRoots(cwd: string, writeRoots: readonly string[], tempRoots: readonly string[]): FloorRoots {
  const canonical = (path: string): string => {
    try { return realpathSync.native(path); } catch { return resolve(path); }
  };
  const others = [...writeRoots, ...tempRoots].filter((root) => isAbsolute(root)).map(canonical);
  return { cwd: canonical(cwd), others: [...new Set(others)] };
}

/** Statements split at `|`, `&&`, `||`, `;` and `&`, each with the operator that follows it. */
function floorSegments(tokens: readonly ShellToken[]): { tokens: ShellToken[]; joiner?: string }[] {
  const segments: { tokens: ShellToken[]; joiner?: string }[] = [{ tokens: [] }];
  for (const token of tokens) {
    if (token.operator && SEGMENT_SPLIT_OPERATORS.has(token.value)) {
      segments.at(-1)!.joiner = token.value;
      segments.push({ tokens: [] });
      continue;
    }
    segments.at(-1)!.tokens.push(token);
  }
  return segments;
}

/** A statement's words: no operators, quoted heredoc data or redirection targets (a process substitution and a here-string stay). */
function segmentWords(segment: readonly ShellToken[]): ShellToken[] {
  const words: ShellToken[] = [];
  let skipNext = false;
  for (const token of segment) {
    if (token.operator) { skipNext = REDIRECT_OPERATORS.has(token.value); continue; }
    const skip = skipNext && !token.value.startsWith("(");
    skipNext = false;
    if (skip || token.data) continue;
    words.push(token);
  }
  return words;
}

/** The command a word would run: the basename, with a leading `(`, `$(`, `<(`, backtick or `{` and trailing `)`/`;` stripped. */
function floorCommandName(token: ShellToken | undefined): string | undefined {
  if (!token || token.operator) return undefined;
  const bare = token.value.replace(/^(?:\$\(|<\(|>\(|[({`])+/u, "").replace(/[)`;]+$/u, "");
  const name = bare.split(/[\\/]/u).at(-1);
  return name ? name.toLowerCase() : undefined;
}

/** The bodies of `$(…)`, `<(…)`, `>(…)` and backticks outside single quotes. */
function substitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  let single = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\\" && !single) { index += 1; continue; }
    if (character === "'") { single = !single; continue; }
    if (single) continue;
    if (character === "`") {
      const close = command.indexOf("`", index + 1);
      if (close < 0) break;
      bodies.push(command.slice(index + 1, close));
      index = close;
      continue;
    }
    if (character === "(" && index > 0 && "$<>".includes(command[index - 1]!)) {
      let level = 1;
      let cursor = index + 1;
      for (; cursor < command.length && level > 0; cursor += 1) {
        if (command[cursor] === "(") level += 1;
        else if (command[cursor] === ")") level -= 1;
      }
      bodies.push(command.slice(index + 1, level === 0 ? cursor - 1 : cursor));
      index = cursor - 1;
    }
  }
  return bodies;
}

/**
 * Names whose value the floor can still tell: `NAME=$(mktemp …)` is a fresh
 * entry under the temp directory, `for NAME in *.tmp` is that glob, and
 * `$HOME`/`$TMPDIR` are the process's own — each only while the command
 * does not assign the name again.
 */
function floorBindings(command: string, tokens: readonly ShellToken[], inherited: ReadonlyMap<string, string>): Map<string, string> {
  const bindings = new Map(inherited);
  const assignedOnce = (name: string): boolean => (command.match(new RegExp(`(?:^|[^A-Za-z0-9_])${name}=`, "gu")) ?? []).length <= 1
    && !new RegExp(`\\b(?:read|for|local|declare|typeset|export)\\b[^;&|\\n]*\\b${name}\\b(?!=)`, "u").test(command.replace(new RegExp(`\\bfor\\s+${name}\\s+in\\b`, "u"), ""));
  for (const [name, value] of [["HOME", homedir()], ["TMPDIR", tmpdir()]] as const) {
    if (!bindings.has(name) && !new RegExp(`(?:^|[^A-Za-z0-9_])${name}=|\\b(?:read|for|export)\\b[^;&|\\n]*\\b${name}\\b`, "u").test(command)) bindings.set(name, value);
  }
  for (const match of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=["']?\$\(\s*mktemp\b([^)]*)\)/gu)) {
    const name = match[1]!;
    if (!assignedOnce(name)) { bindings.delete(name); continue; }
    const words = match[2]!.trim().split(/\s+/u).filter(Boolean);
    let directory: string | undefined = tmpdir();
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!;
      if (word === "-p" || word === "--tmpdir") directory = words[index + 1];
      else if (word.startsWith("--tmpdir=")) directory = word.slice("--tmpdir=".length);
      else if (!word.startsWith("-") && word.includes("/")) directory = dirname(word);
      if (word === "-p") index += 1;
    }
    if (directory !== undefined && /^\$\{?TMPDIR\}?(?=\/|$)/u.test(directory)) directory = tmpdir() + directory.replace(/^\$\{?TMPDIR\}?/u, "");
    if (directory === undefined || !isAbsolute(directory) || /[$`*?[{~]/u.test(directory)) bindings.delete(name);
    else bindings.set(name, join(directory, `mktemp-${name}`));
  }
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index]!.value !== "for" || tokens[index + 2]!.value !== "in") continue;
    const name = tokens[index + 1]!.value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    const items: string[] = [];
    let literal = true;
    for (let cursor = index + 3; cursor < tokens.length; cursor += 1) {
      const item = tokens[cursor]!;
      if (item.operator || item.value === "do") break;
      if (item.data || /[$`]/u.test(item.value)) literal = false;
      items.push(item.value);
    }
    if (literal && items.some((item) => /[*?[]/u.test(item)) && assignedOnce(name)) bindings.set(name, items.join(" "));
  }
  return bindings;
}

function applyFloorBindings(tokens: readonly ShellToken[], bindings: ReadonlyMap<string, string>): ShellToken[] {
  if (bindings.size === 0) return [...tokens];
  return tokens.map((token) => {
    if (token.operator || token.data || !token.dynamic) return token;
    const value = token.value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?=+][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
      (match, braced: string | undefined, bare: string | undefined) => bindings.get(braced ?? bare ?? "") ?? match);
    if (value === token.value) return token;
    return { ...token, value, dynamic: /[$`*?[\]{}~]/u.test(value) };
  });
}

/** The directory a `cd`/`pushd` leads to, or undefined when a static reading cannot tell. */
function resolveCd(args: readonly ShellToken[], directory: string | undefined): string | undefined {
  const target = args.find((token) => !token.value.startsWith("-") || token.value === "-");
  if (!target) return homedir();
  if (target.value === "-") return undefined;
  const value = target.value.replace(/[)`;]+$/u, "");
  let literal = value;
  if (target.dynamic) {
    if (literal === "~" || literal.startsWith("~/")) literal = homedir() + literal.slice(1);
    if (/[$`*?[{~]/u.test(literal)) return undefined;
  }
  if (isAbsolute(literal)) return resolve(literal);
  return directory === undefined ? undefined : resolve(directory, literal);
}

/**
 * What a command would delete or move away. `contentsOnly` marks a target
 * whose own directory survives (a filtered find, `git clean -C`), so a start at
 * the task directory itself is fine.
 */
function deleteTargets(name: string, args: readonly ShellToken[]): { targets: ShellToken[]; contentsOnly?: boolean } | undefined {
  if (DELETE_COMMANDS.has(name)) {
    const targets: ShellToken[] = [];
    let options = true;
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      if (options && token.value === "--") { options = false; continue; }
      if (options && token.value.startsWith("-") && token.value !== "-") {
        // `mv -t DIR` / `--target-directory=DIR` names the destination.
        if (name === "mv" && (token.value === "-t" || token.value === "--target-directory")) {
          const next = args[index + 1];
          if (next) targets.push(next);
          index += 1;
        } else if (name === "mv" && token.value.startsWith("--target-directory=")) {
          targets.push({ ...token, value: token.value.slice("--target-directory=".length) });
        } else if (name === "shred" && ["-n", "-s", "--iterations", "--size"].includes(token.value)) {
          index += 1;
        }
        continue;
      }
      targets.push(token);
    }
    return { targets };
  }
  if (name === "find") {
    const expression = args.findIndex((token) => /^[-(!]/u.test(token.value));
    const starts = expression < 0 ? [...args] : args.slice(0, expression);
    const rest = expression < 0 ? [] : args.slice(expression);
    const deletes = rest.some((token, index) => token.value === "-delete"
      || (FIND_EXEC_ACTIONS.has(token.value) && DELETE_COMMANDS.has(floorCommandName(rest[index + 1]) ?? "")));
    if (!deletes) return undefined;
    const startValues = starts.length > 0 ? starts.map((token) => token.value) : ["."];
    // A filter keeps the start directory only when every branch of the
    // expression passes it and it cannot match Git's own store.
    const branches = rest.some((token) => ["!", "-not", "-o", "-or", ","].includes(token.value));
    const filters = rest.flatMap((token, index) => (FIND_NAME_FILTERS.has(token.value) ? [{ kind: token.value, pattern: rest[index + 1]?.value }] : []));
    const contentsOnly = !branches && filters.length > 0 && filters.every(({ kind, pattern }) => pattern !== undefined && !findFilterReachesGit(kind, pattern, startValues));
    return { targets: starts.length > 0 ? starts : [{ value: ".", operator: false, dynamic: false }], contentsOnly };
  }
  if (name === "rsync") {
    const words = args.map((token) => token.value);
    const removesSources = words.includes("--remove-source-files");
    if (!removesSources && !words.some((word) => word.startsWith("--delete"))) return undefined;
    // A `host:path` operand is remote and outside this floor.
    const operands = args.filter((token) => !token.value.startsWith("-") && !/^[^/]*:/u.test(token.value));
    const destination = args.filter((token) => !token.value.startsWith("-")).at(-1);
    const targets = removesSources ? operands : operands.filter((token) => token === destination);
    return { targets };
  }
  if (name === "git") {
    const words = args.map((token) => token.value.toLowerCase());
    const subcommand = gitSubcommandIndexOf(words);
    const verb = words[subcommand];
    if (verb === "prune" || (verb === "gc" && words.slice(subcommand + 1).some((word) => word.startsWith("--prune")))
      || (verb === "reflog" && ["expire", "delete"].includes(words[subcommand + 1] ?? ""))) {
      return { targets: [{ value: ".git", operator: false, dynamic: false }] };
    }
    // `git clean` deletes untracked files of the work tree it is pointed at.
    if (verb === "clean") {
      const targets: ShellToken[] = [];
      for (let index = 0; index < subcommand; index += 1) {
        const word = args[index]!;
        if (["-C", "--work-tree"].includes(word.value) && args[index + 1]) targets.push(args[index + 1]!);
        else if (word.value.startsWith("--work-tree=")) targets.push({ ...word, value: word.value.slice("--work-tree=".length) });
      }
      return targets.length > 0 ? { targets, contentsOnly: true } : undefined;
    }
    // A forced worktree removal throws away its uncommitted files.
    if (verb === "worktree" && words[subcommand + 1] === "remove" && words.some((word) => word === "-f" || word === "--force")) {
      const path = args.slice(subcommand + 2).find((token) => !token.value.startsWith("-"));
      return path ? { targets: [path] } : undefined;
    }
  }
  return undefined;
}

/** True when a find name/path/regex filter could select `.git` or a file inside it. */
function findFilterReachesGit(kind: string, pattern: string, starts: readonly string[]): boolean {
  if (kind === "-name" || kind === "-iname") return GIT_STORE_PROBES.some((probe) => globMatches(pattern, probe.split("/").at(-1)!));
  const candidates = GIT_STORE_PROBES.flatMap((probe) => ["./", ...starts.map((start) => `${start.replace(/\/+$/u, "")}/`)].map((prefix) => `${prefix}${probe}`));
  let matcher: RegExp;
  try {
    if (kind === "-regex" || kind === "-iregex") matcher = new RegExp(`^(?:${pattern})$`, kind === "-iregex" ? "iu" : "u");
    else {
      // find's -path wildcards also match `/`.
      const source = pattern.replace(/[.+^${}()|\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".");
      matcher = new RegExp(`^${source}$`, kind === "-ipath" || kind === "-iwholename" ? "iu" : "u");
    }
  } catch { return true; }
  return candidates.some((candidate) => matcher.test(candidate));
}

/** Index of git's subcommand in its argv, after global options such as `-C dir` and `-c k=v`. */
function gitSubcommandIndexOf(words: readonly string[]): number {
  let index = 0;
  while (index < words.length && words[index]!.startsWith("-")) {
    index += ["-c", "-C", "--git-dir", "--work-tree", "--namespace"].includes(words[index]!) ? 2 : 1;
  }
  return index;
}

/** Brace expansion is textual: every alternative a word can spell, or undefined past a sane count. `{a..z}` ranges stand for a wildcard. */
function expandBraces(word: string): string[] | undefined {
  const results: string[] = [];
  const pending = [word];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const group = firstBraceGroup(current);
    if (!group) { results.push(current); continue; }
    for (const part of group.parts) pending.push(current.slice(0, group.start) + part + current.slice(group.end + 1));
    if (pending.length + results.length > 256) return undefined;
  }
  return results;
}

function firstBraceGroup(word: string): { start: number; end: number; parts: string[] } | undefined {
  for (let start = word.indexOf("{"); start >= 0; start = word.indexOf("{", start + 1)) {
    let level = 0;
    const commas: number[] = [];
    let end = -1;
    for (let cursor = start; cursor < word.length; cursor += 1) {
      const character = word[cursor];
      if (character === "{") level += 1;
      else if (character === "}") { level -= 1; if (level === 0) { end = cursor; break; } }
      else if (character === "," && level === 1) commas.push(cursor);
    }
    if (end < 0) return undefined;
    const inner = word.slice(start + 1, end);
    if (commas.length > 0) {
      const bounds = [start, ...commas, end];
      return { start, end, parts: bounds.slice(0, -1).map((bound, index) => word.slice(bound + 1, bounds[index + 1])) };
    }
    if (/^[^{}]+\.\.[^{}]+$/u.test(inner)) return { start, end, parts: ["*"] };
  }
  return undefined;
}

function judgeDeleteTarget(target: ShellToken, directory: string | undefined, roots: FloorRoots, name: string, contentsOnly = false): string | undefined {
  const verb = name === "mv" ? "move" : name === "git" ? "prune" : "delete";
  let value = target.value;
  let dynamic = target.dynamic;
  if (directory !== undefined && /\$(?:\{PWD\}|PWD(?![A-Za-z0-9_]))/u.test(value)) {
    value = value.replace(/\$(?:\{PWD\}|PWD(?![A-Za-z0-9_]))/gu, directory);
    dynamic = /[$`*?[\]{}~]/u.test(value);
  }
  const alternatives = dynamic && value.includes("{") ? expandBraces(value) : [value];
  if (!alternatives) return `Worker cannot ${verb} a brace expansion this large (${target.value}); name the paths`;
  for (const alternative of alternatives) {
    // A value bound from a loop or a split word holds several paths.
    for (const part of alternative.split(/\s+/u).filter(Boolean)) {
      const violation = judgeDeletePath(part, dynamic, target.value, directory, roots, name, verb, contentsOnly);
      if (violation) return violation;
    }
  }
  return undefined;
}

function judgeDeletePath(path: string, dynamic: boolean, shown: string, directory: string | undefined, roots: FloorRoots, name: string, verb: string, contentsOnly: boolean): string | undefined {
  let literal = path;
  if (dynamic) {
    if (literal === "~" || literal.startsWith("~/")) literal = homedir() + literal.slice(1);
    if (/[$`]/u.test(literal) || literal.startsWith("~")) return `Worker cannot ${verb} a path that is only known at run time (${shown}); name it literally`;
  }
  if (!isAbsolute(literal) && directory === undefined) return `Worker cannot ${verb} a relative path after a cd the policy cannot follow (${shown})`;
  // A glob is judged by the literal directory before it; what follows must not
  // climb out (`*/../..`), reach hidden entries (`.*` would take `.git`) or name `.git`.
  const segments = literal.split("/");
  const globAt = dynamic ? segments.findIndex((segment) => /[*?[]/u.test(segment)) : -1;
  if (globAt >= 0) {
    for (const segment of segments.slice(globAt)) {
      if (segment === "..") return `Worker cannot ${verb} through a glob followed by .. (${shown})`;
      if (segment === ".git") return `Worker cannot ${verb} Git's own store (${shown}); with no remote authority the local commits are the only copy`;
      if (/[*?[]/u.test(segment) && (segment.startsWith(".") || /^\[[^\]]*\./u.test(segment))) return `Worker cannot ${verb} hidden entries with a glob (${shown})`;
    }
  }
  const base = globAt < 0 ? literal : (segments.slice(0, globAt).join("/") || (literal.startsWith("/") ? "/" : "."));
  const resolved = resolveForDelete(resolve(directory ?? "/", base), globAt < 0 && !literal.endsWith("/"));
  // Checked first: a task under a shared root (/tmp) must still not take its own parent.
  if (roots.cwd.startsWith(resolved === "/" ? "/" : `${resolved}/`)) return `Worker cannot ${verb} a directory that contains the task (${shown})`;
  const within = (root: string): boolean => resolved === root || resolved.startsWith(root === "/" ? "/" : `${root}/`);
  if (resolved.split("/").includes(".git")) {
    // A lock left by an interrupted git command is routine to clear.
    const staleLock = globAt < 0 && (name === "rm" || name === "unlink") && within(roots.cwd) && resolved.endsWith(".lock");
    if (!staleLock) return `Worker cannot ${verb} Git's own store (${shown}); with no remote authority the local commits are the only copy`;
  }
  if (within(roots.cwd)) {
    if (resolved === roots.cwd && globAt < 0 && !contentsOnly) {
      return name === "find"
        ? `Worker cannot delete the whole task tree with find (${shown}); it would take .git too — filter with -name/-path`
        : `Worker cannot ${verb} the task directory itself (${shown})`;
    }
    return undefined;
  }
  const other = roots.others.find(within);
  if (other !== undefined) {
    if (resolved === other) return `Worker cannot ${verb} ${globAt < 0 ? "a whole" : "everything at the top of a"} shared directory (${shown})`;
    return undefined;
  }
  return `Worker cannot ${verb} outside the task directory (${shown})`;
}

/**
 * The real location a delete acts on: the parent resolved through symlinks
 * with the last name kept as written (`rm link` removes the link, not its
 * target), or the whole path when it is a directory to be followed.
 */
function resolveForDelete(absolute: string, keepLast: boolean): string {
  const normalized = resolve(absolute);
  const canonical = (path: string): string => {
    let current = path;
    const missing: string[] = [];
    for (;;) {
      try { return join(realpathSync.native(current), ...[...missing].reverse()); }
      catch {
        const parent = dirname(current);
        if (parent === current) return path;
        missing.push(basename(current));
        current = parent;
      }
    }
  };
  if (!keepLast || normalized === "/") return canonical(normalized);
  return join(canonical(dirname(normalized)), basename(normalized));
}

function fileToolPaths(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const value = input as Record<string, unknown>;
  return ["file_path", "filePath", "path", "notebook_path", "notebookPath"]
    .map((key) => value[key])
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0);
}

type WritePathViolation = "outside-cwd" | "git-metadata" | "cwd-missing";

/**
 * `realpath` of the deepest ancestor that exists, with the not-yet-created tail
 * re-appended. Plain `realpathSync` throws for a directory the Worker is about
 * to create, and the caller cannot tell that apart from a hostile path. Used
 * for the write roots only: a task cwd that does not exist is refused, not
 * tolerated (see `classifyWritePath`).
 */
function resolveExistingPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(current), ...[...missing].reverse()); }
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

/**
 * The part of `value` below `root`, taken by raw string prefix rather than
 * `path.relative`, which normalizes `link/../x` to `x` before the per-segment
 * walk could see the symlink. Tried against both spellings of the root — the
 * one the caller gave and its real path — so a root reached through a
 * symlinked ancestor (a dotfile-managed ~/.claude, /var on macOS) matches
 * however the Worker spelled it. Undefined when the value is not under the root.
 */
function pathBelow(value: string, roots: readonly string[]): string | undefined {
  const raw = value.replaceAll("\\", "/");
  for (const root of roots) {
    const canonical = root.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
    const prefix = canonical === "/" ? "/" : `${canonical}/`;
    if (raw === canonical) return "";
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return undefined;
}

function classifyWritePath(value: string, cwd: string, writeRoots: readonly string[] = []): WritePathViolation | undefined {
  if (value.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) return "git-metadata";
  // A path inside an extra write root (Claude's own scratchpad or memory
  // directory) is judged against that root instead of the cwd, with the same
  // per-segment symlink and metadata rules. A root need not exist yet: Claude
  // creates its memory directory on the first write, and failing closed there
  // denied the very write the outside-cwd message points at. Each root is
  // resolved once; the walk below never re-resolves it.
  if (isAbsolute(value)) {
    for (const root of writeRoots) {
      if (!isAbsolute(root)) continue;
      const resolvedRoot = resolveExistingPath(root);
      const below = pathBelow(value, [root, resolvedRoot]);
      if (below === undefined) continue;
      return walkWritePath(below, resolvedRoot);
    }
  }
  // The task cwd itself is resolved fail-closed: a cwd that no longer exists
  // (deleted, or its mount gone) must not have its writes allowed on whatever
  // filesystem now sits there, which the Write tool's `mkdir -p` would create.
  let root: string;
  try { root = realpathSync.native(cwd); }
  catch { return "cwd-missing"; }
  if (isAbsolute(value)) {
    const below = pathBelow(value, [cwd, root]);
    if (below === undefined) return "outside-cwd";
    return walkWritePath(below, root);
  }
  return walkWritePath(value, root);
}

/**
 * Walk a path relative to an already-resolved root one segment at a time,
 * refusing `..` that would climb out, any `.git` segment, and any segment that
 * is (or fails to be inspected as) a symlink — the kernel would follow it out
 * of the root even though the pathname stays inside.
 */
function walkWritePath(relativePath: string, root: string): WritePathViolation | undefined {
  const normalized: string[] = [];
  for (const segment of relativePath.replaceAll("\\", "/").split("/")) {
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
    const resolved = realpathSync.native(absolute);
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
 * Branch names that are never published: the integration names themselves and
 * any `<prefix>/main|master|integration`. One predicate for both layers — the
 * Supervisor consults it before issuing a grant, and the policy consults it
 * again before honoring one — so neither can admit what the other refuses.
 */
export function isProtectedBranch(branch: string): boolean {
  return /^(?:main|master|trunk|integration|develop)$/iu.test(branch) || /(?:^|\/)(?:main|master|integration)$/iu.test(branch);
}

/**
 * True when both paths name the same directory once the kernel has resolved
 * them. `whenMissing` says what a path that does not exist means: `false` for a
 * boundary check (a grant must never compare equal to nothing), `lexical` for
 * a shape check on paths that may not exist yet.
 */
export function sameDirectory(first: string, second: string, whenMissing: "false" | "lexical" = "false"): boolean {
  // The native realpath, not Node's JavaScript one: the latter collapses a
  // trailing `..` lexically even after a symlink, and disagrees with the
  // kernel for exactly the paths a boundary check exists to catch.
  try { return realpathSync.native(first) === realpathSync.native(second); }
  catch { return whenMissing === "lexical" ? resolve(first) === resolve(second) : false; }
}

/**
 * The one shape a granted publish may take. Everything is matched literally:
 * the policy is static, so it cannot resolve `HEAD`, a variable or a second
 * statement, and refuses rather than guess. Returns undefined when the command
 * is not a permitted publish, leaving the ordinary denials to answer.
 */
function permittedRemoteCommand(tokens: readonly ShellToken[], grant: RemoteGrant): PolicyResult | undefined {
  // A single statement only: `git push origin x && rm -rf /` must never pass.
  if (tokens.some((token) => token.operator)) return undefined;
  if (tokens.some((token) => token.dynamic)) return undefined;
  const words = tokens.map((token) => token.value);
  if (words.length === 0) return undefined;
  const name = (words[0] ?? "").split(/[\\/]/u).at(-1)?.toLowerCase();
  if (isProtectedBranch(grant.branch)) return undefined;
  if (!isCommitId(grant.head)) return undefined;
  const optionName = (word: string): string => word.split("=")[0] ?? word;

  if (name === "git") {
    // `-C <task directory>` is *required*, not merely tolerated. Claude's Bash
    // tool keeps its working directory between calls and `cd` is ordinary local
    // work, so without an explicit directory the grant could be spent in any
    // clone the Worker had wandered into. The directory must be the granted one
    // *byte for byte* — no normalization, no realpath. Every looser comparison
    // has had a spelling that this process resolves one way and git another:
    // a relative `.` against this process's cwd, `/proc/self/cwd` against this
    // process's, and `<cwd>/link/..`, which Node's own `realpathSync` collapses
    // lexically to the task directory while the kernel — and git — follow the
    // link and end up elsewhere. The instruction spells the exact directory,
    // so no alternate spelling needs to be accepted at all.
    if (words[1] !== "-C") return undefined;
    const directory = words[2];
    if (directory === undefined || !isAbsolute(directory) || directory !== grant.cwd) return undefined;
    // The pinned `-c` settings are required too, in order: a `pre-push` hook
    // runs inside the granted push with the Worker's credentials where no
    // policy sees it, and `push.followTags=true` would push a tag along with
    // the commit; both can arrive by more doors than a write denial can
    // enumerate, so the one granted command is made immune instead.
    let cursor = 3;
    for (const setting of GRANTED_PUSH_SETTINGS) {
      if (words[cursor] !== "-c" || words[cursor + 1] !== setting) return undefined;
      cursor += 2;
    }
    if (words[cursor] !== "push") return undefined;
    // No push option at all: `-u` did nothing with a commit as the source, and
    // an allowlist of one no-op is only surface. The refspec names the
    // verified commit, so git pushes exactly that object; a commit made during
    // the publish turn stays local ("Everything up-to-date") instead of riding
    // the grant. `refs/heads/` is spelled out because a bare destination is
    // refused by git when the remote branch does not exist yet.
    const rest = words.slice(cursor + 1);
    if (rest.length !== 2 || rest.some((word) => word.startsWith("-"))) return undefined;
    const [remote, refspec] = rest as [string, string];
    if (remote !== grant.remoteName) return undefined;
    if (refspec !== `${grant.head}:refs/heads/${grant.branch}`) return undefined;
    return { decision: "allow", reason: `publish grant: push ${grant.head.slice(0, 12)} to ${grant.remoteName}/${grant.branch}`, granted: true };
  }

  if (name === "gh" && grant.authority === "pr") {
    if (!grant.repository) return undefined;
    if (words[1] !== "pr" || words[2] !== "create") return undefined;
    const rest = words.slice(3);
    // `--head <candidate branch>` is mandatory: without it gh uses whatever
    // branch is checked out, and `git checkout` is ordinary local work, so a
    // bare `gh pr create` could open a pull request for a branch nothing
    // verified. `--repo <pinned URL>` is mandatory for the same reason one
    // level up: without it gh picks a base repository from the remotes
    // (`upstream` on a fork, or whatever clone the Worker's shell sits in).
    // Each counts only as the option the loop itself parses, never as a word
    // another option swallowed: `--title --head` sets the title.
    let sawHead = false;
    let sawRepo = false;
    for (let cursor = 0; cursor < rest.length; cursor += 1) {
      const word = rest[cursor]!;
      if (!word.startsWith("-")) return undefined;
      const option = optionName(word);
      if (!ALLOWED_PR_CREATE_OPTIONS.has(option)) return undefined;
      const inlineValue = word.includes("=");
      const value = inlineValue ? word.slice(option.length + 1) : rest[cursor + 1];
      if (PR_CREATE_VALUE_OPTIONS.has(option)) {
        if (value === undefined) return undefined;
        if (option === "-H" || option === "--head") {
          if (value !== grant.branch) return undefined;
          sawHead = true;
        }
        if (option === "-R" || option === "--repo") {
          if (value !== grant.repository) return undefined;
          sawRepo = true;
        }
        if (!inlineValue) cursor += 1;
      }
    }
    if (!sawHead || !sawRepo) return undefined;
    return { decision: "allow", reason: `publish grant: open a pull request for ${grant.branch}`, granted: true };
  }
  return undefined;
}
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
const FIND_NAME_FILTERS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex"]);
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

export function evaluateCommand(command: string, args: readonly string[] = [], grant?: RemoteGrant): PolicyResult {
  const normalized = command.trim();
  if (!normalized) return { decision: "deny", reason: "empty command" };
  const lexical = lexShell(normalized);
  if (lexical.error) return { decision: "deny", reason: `command could not be safely parsed: ${lexical.error}` };
  const literalArgs = args.map((value) => ({ value, operator: false, dynamic: false }));
  return evaluateTokens([...lexical.tokens, ...literalArgs], 0, grant);
}

function evaluateRepositoryBoundary(tokens: readonly ShellToken[], canonical: string, depth: number, grant?: RemoteGrant): PolicyResult | undefined {
  // A publish grant admits exactly one shape; everything else still falls
  // through to the ordinary boundary denials below.
  if (grant) {
    const permitted = permittedRemoteCommand(tokens, grant);
    if (permitted) return permitted;
  }
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
  const segments = segmentsOf(tokens);
  if ((hasDynamicArgument && hasDynamicCommandName(tokens)) || segments.some((segment) => hasDynamicSensitiveArgument(segment))) {
    return { decision: "deny", reason: "a repository, package, network or shell command with a dynamic argument cannot be capability-checked; substitute the literal value for the shell variable so the command can be read, or use the Write/Edit tools when the intent is to change a file" };
  }
  if (/\bgit\b[\s\S]*\b(?:push|merge(?!-)|send-pack|receive-pack|update-ref)\b/iu.test(canonical)
    || /\bgit-(?:send|receive|upload)-pack\b/iu.test(canonical)
    || containsRemoteCliMutation(canonical)) {
    return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority", boundary: "remote" };
  }
  if (hasGit && (hasRemoteOperation || hasGitTransport) || hasGhRemote) {
    return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority", boundary: "remote" };
  }
  // Repointing a remote would make the grant's remote *name* meaningless and
  // would fool the Supervisor's own confirmation, which resolves the same name.
  // Scoped to one statement with `remote` in git's subcommand position and the
  // action right after it: matching the words anywhere denied `git remote -v &&
  // git add -A` and even `git add remote`, which are ordinary local work.
  if (segments.some((segment) => mutatesRemotes(segment))) {
    return { decision: "deny", reason: "Worker cannot change the repository's remotes" };
  }
  // The same boundary through `git config`: `remote.<name>.pushurl`,
  // `url.<x>.insteadOf`, `push.*`, `core.sshCommand`, `core.hooksPath` and the
  // credential/http keys change where a push goes, what travels with it or
  // what runs during it, without touching the remote's name. Reads stay
  // ordinary local work; only a write of one of these keys is refused.
  if (segments.some((segment) => configuresRemoteTransport(segment))) {
    return { decision: "deny", reason: "Worker cannot reconfigure the repository's remotes, URL rewrites, push behavior, credentials or hooks" };
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
  // `.git/config` (and `.git/config.worktree`) is the `git config` boundary
  // above by another door, and a hook in `.git/hooks/` runs during the granted
  // push where no policy sees it. A list of writing commands cannot be
  // complete (`python3 -c`, `tar -C`, an archive), so any statement naming
  // either path is refused unless it plainly only reads — the same stance the
  // branch-ref rule above takes. The Write and Edit tools already refuse every
  // `.git` path, and `git init --template=` would install hooks without naming
  // the directory at all. What this cannot see (`~/.gitconfig`, a script) the
  // Supervisor's remote-URL baseline catches at grant time instead.
  const namesMetadataFile = (segment: readonly ShellToken[]): boolean => segment.some((token) => !token.operator && namesGitMetadata(token.value));
  if (segments.some((segment) => namesMetadataFile(segment) && !onlyReads(segment))) {
    return { decision: "deny", reason: "Worker cannot write the repository's Git configuration or hooks directly" };
  }
  if (segments.some((segment) => initializesWithTemplate(segment))) {
    return { decision: "deny", reason: "Worker cannot install repository hooks from a template or relocate the repository's Git directory" };
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

const REMOTE_MUTATIONS = new Set(["set-url", "add", "rename", "remove", "rm", "prune", "set-branches", "set-head"]);

/** git's own pre-subcommand options that take the next word as their value when not written `--opt=value`. */
const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);

/**
 * The index of git's subcommand in one statement's words, or -1 when the
 * statement is not a git invocation. Skips the pre-subcommand options,
 * including the space-separated value forms: `git --git-dir .git remote …`
 * has its subcommand at index 3, not 2, and a locator that only knew `-C`
 * and `-c` let `remote set-url` and `config remote.*` hide behind `--git-dir`.
 */
function gitSubcommandIndex(words: readonly string[]): number {
  const first = words[0]?.split(/[\\/]/u).at(-1)?.toLowerCase();
  if (first !== "git") return -1;
  let index = 1;
  while (index < words.length && words[index]!.startsWith("-")) {
    index += GIT_GLOBAL_VALUE_OPTIONS.has(words[index]!) ? 2 : 1;
  }
  return index < words.length ? index : -1;
}

/** True when this one statement is `git [options] remote <mutating action>`. */
function mutatesRemotes(segment: readonly ShellToken[]): boolean {
  const words = segment.filter((token) => !token.operator).map((token) => token.value);
  const index = gitSubcommandIndex(words);
  if (index < 0 || words[index]?.toLowerCase() !== "remote") return false;
  // `remote`'s own options (`-v`, `--verbose`) sit before the action: git
  // parses `git remote -v add evil …` as an `add`.
  const action = words.slice(index + 1).find((word) => !word.startsWith("-"))?.toLowerCase();
  return action !== undefined && REMOTE_MUTATIONS.has(action);
}

/**
 * Configuration keys that decide where a push goes, what travels with it or
 * what runs during it. `remote.*` covers `pushurl`; `url.*` the `insteadOf`
 * rewrites; `push.*` follow-tags and push options; `include.*`/`includeIf.*`
 * would pull any of the others in from a file the Worker wrote; the rest are
 * credentials, transport and hook locations.
 */
const REMOTE_TRANSPORT_CONFIG_KEY = /^(?:remote\.|url\.|push\.|credential\.|http\.|https\.|include\.|includeif\.|init\.|core\.(?:sshcommand|hookspath|gitproxy|askpass|alternaterefscommand)$)/iu;
/** `git config` flags and verbs that only read; a key next to one of them is a query, not a change. */
const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list", "--show-origin", "--show-scope", "--name-only"]);
const GIT_CONFIG_WRITE_FLAGS = new Set(["--add", "--replace-all", "--unset", "--unset-all", "--remove-section", "--rename-section", "--edit", "-e"]);

/**
 * True when a word names `.git/config`, `.git/config.worktree` or something
 * under `.git/hooks/` in any spelling the shell would resolve to it: the raw
 * text, its normalized path (`.git/./config`, `.git//config`, `src/../.git/config`),
 * and — for a word carrying glob characters — the shape the glob could expand
 * to (`.gi[t]/config`; anything wildcarded whose path has a `config` or
 * `hooks` segment). The Write and Edit tools normalize their paths; Bash
 * does not, so this does.
 */
function namesGitMetadata(word: string): boolean {
  const metadata = /\.git[\\/](?:config|hooks)(?![A-Za-z0-9_-])/iu;
  const value = word.replaceAll("\\", "/");
  if (metadata.test(value) || metadata.test(posix.normalize(value))) return true;
  if (!/[*?[]/u.test(value)) return false;
  // A glob is judged segment by segment: it names the metadata only where
  // some segment could expand to `.git` and the next to `config`,
  // `config.worktree` or `hooks`. `src/hooks/*.ts` and `config/*.json` have no
  // such segment and stay ordinary work; `.gi[t]/config`, `.git/conf?g`,
  // `.g*/hooks/x` and `*/config` do not.
  const segments = posix.normalize(value).split("/");
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (!globMatches(segments[index]!, ".git")) continue;
    const next = segments[index + 1]!;
    if (globMatches(next, "config") || globMatches(next, "config.worktree") || globMatches(next, "hooks")) return true;
  }
  return false;
}

/** True when one shell-glob path segment could expand to `literal` (`*` any run, `?` one character, `[…]` a class). */
function globMatches(segment: string, literal: string): boolean {
  let pattern = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else if (char === "[") {
      const close = segment.indexOf("]", index + 1);
      if (close > index) { pattern += `[${segment.slice(index + 1, close).replace(/\\/gu, "\\\\")}]`; index = close; }
      else pattern += "\\[";
    } else pattern += char.replace(/[.+^${}()|\\]/gu, "\\$&");
  }
  try { return new RegExp(`^${pattern}$`, "iu").test(literal); }
  catch { return true; }
}

/** Commands that only read what they are given; a statement led by one of these may name `.git/config` or a hook to look at it. */
const READ_ONLY_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ls", "stat", "file", "wc", "diff", "md5sum", "sha256sum", "bat", "view"]);

/** True when this one statement is led by a read-only command and carries no redirection. */
function onlyReads(segment: readonly ShellToken[]): boolean {
  if (segment.some((token) => token.operator)) return false;
  const first = segment[0]?.value.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  return READ_ONLY_COMMANDS.has(first);
}

/**
 * True when this one statement is `git init --template…`, which copies hooks
 * into `.git/hooks/` of an existing repository too, or `git init|clone
 * --separate-git-dir…`, which moves the repository's config and hooks to a
 * path none of the `.git/` guards name.
 */
function initializesWithTemplate(segment: readonly ShellToken[]): boolean {
  const words = segment.filter((token) => !token.operator).map((token) => token.value);
  const index = gitSubcommandIndex(words);
  if (index < 0) return false;
  const subcommand = words[index]?.toLowerCase();
  const options = words.slice(index + 1).map((word) => word.toLowerCase());
  if (subcommand === "init" && options.some((word) => word.startsWith("--template"))) return true;
  return (subcommand === "init" || subcommand === "clone") && options.some((word) => word.startsWith("--separate-git-dir"));
}

/** True when this one statement is `git [options] config` writing a transport-affecting key. */
function configuresRemoteTransport(segment: readonly ShellToken[]): boolean {
  const words = segment.filter((token) => !token.operator).map((token) => token.value);
  const index = gitSubcommandIndex(words);
  if (index < 0 || words[index]?.toLowerCase() !== "config") return false;
  const rest = words.slice(index + 1);
  const lower = rest.map((word) => word.toLowerCase());
  const positional = rest.filter((word) => !word.startsWith("-"));
  const verb = positional[0]?.toLowerCase();
  // An editor session rewrites the whole file, every guarded key included,
  // and names none of them on the command line.
  if (lower.includes("-e") || lower.includes("--edit") || verb === "edit") return true;
  if (!rest.some((word) => REMOTE_TRANSPORT_CONFIG_KEY.test(word))) return false;
  // `git config <key>` alone reads it, as do the query flags and the newer
  // `git config get <key>` form; anything that names a value or a write verb
  // is a change.
  if (lower.some((word) => GIT_CONFIG_READ_FLAGS.has(word)) || verb === "get" || verb === "list") return false;
  const writes = lower.some((word) => GIT_CONFIG_WRITE_FLAGS.has(word))
    || verb === "set" || verb === "unset" || verb === "remove-section" || verb === "rename-section" || verb === "edit";
  return writes || positional.length >= 2;
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

function evaluateCommandInternal(command: string, depth: number, grant?: RemoteGrant): PolicyResult {
  const normalized = command.trim();
  if (!normalized) return { decision: "deny", reason: "empty command" };
  const lexical = lexShell(normalized);
  if (lexical.error) return { decision: "deny", reason: `command could not be safely parsed: ${lexical.error}` };
  return evaluateTokens(lexical.tokens, depth, grant);
}

function evaluateTokens(rawTokens: readonly ShellToken[], depth: number, grant?: RemoteGrant): PolicyResult {
  const { tokens: dataResolved, embedded } = resolveDataTokens(rawTokens);
  const tokens = resolveLiteralBindings(dataResolved);
  if (depth < 4) {
    for (const body of embedded) {
      // Never with the grant: a nested result is consulted only when it denies,
      // so a grant here could only suppress a denial -- a heredoc-wrapped push
      // would pass while the direct form is the only shape that was reviewed.
      const nestedResult = evaluateCommandInternal(body, depth + 1);
      if (nestedResult.decision === "deny") return nestedResult;
    }
  }
  const canonical = tokens.map((token) => token.value).join(" ").trim();
  if (!canonical) return { decision: "deny", reason: "empty command" };
  const boundary = evaluateRepositoryBoundary(tokens, canonical, depth, grant);
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
  // A granted publish is the Supervisor's own decision, already made: under
  // hybrid authority it is answered here, not escalated to a Decision Worker
  // that was never told the grant exists and whose standing rule is to refuse.
  if (policyResult.granted) return true;
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") return true;
  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep" || toolName === "LS" || toolName === "TodoWrite") return true;
  if (toolName === "Bash") {
    const command = input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
      ? (input as { command: string }).command
      : "";
    return command ? isRoutineShellCommand(command, cwd, options.writeRoots ?? []) : false;
  }
  // WebFetch, WebSearch, Task, mcp__* tools and any unrecognized tool name.
  return false;
}

function isRoutineShellCommand(command: string, cwd: string, writeRoots: readonly string[] = []): boolean {
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
  return segments.every((segment) => isRoutineSegment(segment, cwd, 0, writeRoots));
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

function isRoutineSegment(segment: readonly ShellToken[], cwd: string, depth: number, writeRoots: readonly string[] = []): boolean {
  if (depth > 5) return false;
  if (hasUnsafeRedirection(segment, cwd, writeRoots)) return false;
  const words = segment.filter((token) => !token.operator).map((token) => token.value);
  if (words.length === 0) return false;
  return isRoutineWords(words, cwd, depth, writeRoots);
}

function isRoutineWords(words: readonly string[], cwd: string, depth: number, writeRoots: readonly string[] = []): boolean {
  if (depth > 5) return false;
  const first = words[0]!;
  // A program named by path (./ls, /tmp/x/ls) is an arbitrary executable, not
  // the well-known utility; leave it to the Decision Worker.
  if (/[\\/]/u.test(first)) return false;
  const head = first.toLowerCase();
  if (WRAPPER_COMMANDS.has(head)) {
    const wrapped = unwrapWrapper(head, words.slice(1));
    if (!wrapped || wrapped.length === 0) return false;
    return isRoutineWords(wrapped, cwd, depth + 1, writeRoots);
  }
  if (!ROUTINE_SHELL_COMMANDS.has(head)) return false;
  const rest = words.slice(1);
  // Every path-looking argument (absolute, `..`-escaping, `~`, or the value of
  // a `--flag=path`) must resolve inside the task cwd. This keeps reads of
  // /etc, ~/.ssh or ~/.aws and every option that names an outside file out of
  // the routine set, at the cost of an occasional model call for a sed script
  // that happens to start with `/`.
  if (rest.some((word) => namesPathOutsideCwd(word, cwd, writeRoots))) return false;
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

function hasUnsafeRedirection(segment: readonly ShellToken[], cwd: string, writeRoots: readonly string[] = []): boolean {
  for (let index = 0; index < segment.length; index += 1) {
    const token = segment[index]!;
    if (token.operator && (token.value === ">" || token.value === ">>")) {
      const target = segment[index + 1];
      if (!target || target.operator) return true;
      if (isUnsafeRedirectTarget(target.value, cwd, writeRoots)) return true;
    }
  }
  return false;
}

function isUnsafeRedirectTarget(target: string, cwd: string, writeRoots: readonly string[] = []): boolean {
  if (target === "/dev/null") return false; // the one device sink that discards rather than writes
  if (target.startsWith("/dev/") || target.startsWith("~") || target.startsWith("&")) return true;
  // The same check the Write/Edit tools get, against the same roots: inside
  // the cwd or a granted write root after resolving `..`, not Git metadata,
  // and not through a symlink or hard link out of it. One root set governs
  // both tools, so `cmd > <scratchpad>/out` is as routine as writing it.
  return classifyWritePath(target, cwd, writeRoots) !== undefined;
}

/** True for an argument that names a filesystem location outside the task cwd (or ~), including `--flag=path` values. */
function namesPathOutsideCwd(word: string, cwd: string, writeRoots: readonly string[] = []): boolean {
  const value = word.startsWith("--") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
  if (value === "/dev/null") return false;
  if (value.startsWith("~")) return true;
  const pathLike = value.startsWith("/") || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value);
  // A path inside a granted write root is inside for this purpose too, judged
  // by the same walk the Write tool gets (symlinks and metadata included).
  if (pathLike && !isInsideCwd(value, cwd)) return writeRoots.length === 0 || classifyWritePath(value, cwd, writeRoots) !== undefined;
  // An argument that exists on disk may be (or pass through) a symlink that
  // leaves the cwd; compare real paths. A non-existent argument is a pattern or
  // a literal and needs no check.
  if (value.startsWith("-") || value === "") return false;
  let root: string;
  try { root = realpathSync.native(cwd); }
  catch { return true; }
  // Resolve the nearest existing ancestor so a symlinked directory component
  // (`link/new-file`) is caught even when the leaf does not exist yet.
  let candidate = resolve(cwd, value);
  while (true) {
    try {
      const real = realpathSync.native(candidate);
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
