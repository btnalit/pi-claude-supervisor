import { accessSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { verifyPinnedWriteRoot, type PinnedWriteRoot } from "./write-roots.ts";

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
  /** Extra directories the Worker may write to (Claude's per-session scratchpad/memory); each must be an absolute path. */
  writeRoots?: readonly string[];
  /** Startup-pinned extra write roots (declared TaskSpec.writeRoots + task-scoped temp dir), re-verified by lstat/dev/ino/realpath on every check. */
  pinnedWriteRoots?: readonly PinnedWriteRoot[];
  /** Override for delete-floor temp roots; when set (e.g. `[]` when using a task-scoped pinned temp root), narrows deletes away from shared `/tmp`. */
  tempRoots?: readonly string[];
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
    const violation = paths.map((path) => ({ path, classification: classifyWritePath(path, cwd, options.writeRoots, options.pinnedWriteRoots) })).find((entry) => entry.classification !== undefined);
    if (violation?.classification === "outside-cwd") {
      // Only name alternatives the Worker actually has right now: unverified
      // pinned roots are omitted so a swapped/deleted root is never advertised.
      const available = [
        ...(options.pinnedWriteRoots ?? []).filter((root) => verifyPinnedWriteRoot(root) !== undefined).map((root) => root.declared),
        ...(options.writeRoots ?? []),
      ];
      const alternatives = available.length > 0 ? `; writes are also allowed under ${available.join(", ")}` : "";
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
  const result = evaluateCommand(command, [], options.remote, cwd);
  if (result.decision === "deny") return result;
  const floor = deleteFloorViolation(command, cwd, {
    writeRoots: options.writeRoots ?? [],
    ...(options.pinnedWriteRoots ? { pinnedWriteRoots: options.pinnedWriteRoots } : {}),
    ...(options.tempRoots !== undefined ? { tempRoots: options.tempRoots } : {}),
  });
  if (floor) return { decision: "deny", reason: floor };
  const writeFloor = writeFloorViolation(command, cwd, {
    writeRoots: options.writeRoots ?? [],
    ...(options.pinnedWriteRoots ? { pinnedWriteRoots: options.pinnedWriteRoots } : {}),
    ...(options.tempRoots !== undefined ? { tempRoots: options.tempRoots } : {}),
  });
  return writeFloor ? { decision: "deny", reason: writeFloor } : result;
}

export interface DeleteFloorOptions {
  /** Extra directories the task may write (and so delete) in. */
  writeRoots?: readonly string[];
  /** Startup-pinned extra write roots verified by lstat/dev/ino/realpath on every check. */
  pinnedWriteRoots?: readonly PinnedWriteRoot[];
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
  const roots = deleteFloorRoots(cwd, options.writeRoots ?? [], options.tempRoots ?? [tmpdir(), "/tmp"], options.pinnedWriteRoots ?? []);
  return floorScript(command, cwd, roots, new Map(), 0);
}

/**
 * Write Floor v1 (#55-3): hard boundary across every permission authority
 * (policy, hybrid, decision-worker, human approve) blocking statically
 * resolvable Bash writes outside the unified root set `R` (`cwd`, verified
 * `pinnedWriteRoots`, `writeRoots`, and `tempRoots`) or targeting `.git`
 * (including sibling-worktree `.git` pointer files):
 * - Shell output redirections (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`, `>&file`)
 * - `tee`, `cp`, `install`, `ln` (destinations, plus symlink targets & hardlink sources)
 * - `git worktree add <path>` and `git worktree move <old> <new>`
 *
 * Unresolvable dynamic targets (`> "$OUT"`), interpreters (`python3 -c`), and
 * other commands (`touch`/`mkdir`/`sed -i`/`tar`/`curl -o`/`rsync`) remain
 * outside v1 and fall through to the active permission authority.
 */
interface WriteFloorRoots extends FloorRoots {
  rawCwd: string;
  rawWriteRoots: readonly string[];
  pinnedWriteRoots: readonly PinnedWriteRoot[];
  rawTempRoots: readonly string[];
}

export function writeFloorViolation(command: string, cwd: string, options: DeleteFloorOptions = {}): string | undefined {
  const rawWriteRoots = options.writeRoots ?? [];
  const pinnedWriteRoots = options.pinnedWriteRoots ?? [];
  const rawTempRoots = options.tempRoots ?? [tmpdir(), "/tmp"];
  const base = deleteFloorRoots(cwd, rawWriteRoots, rawTempRoots, pinnedWriteRoots);
  const roots: WriteFloorRoots = {
    ...base,
    rawCwd: cwd,
    rawWriteRoots,
    pinnedWriteRoots,
    rawTempRoots,
  };
  return writeFloorScript(command, cwd, roots, new Map(), 0);
}

interface FloorRoots { cwd: string; others: string[]; defaultTmpDir?: string }

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
/** Stop-set tools that run an arbitrary command after one of RUNNER_SUBCOMMANDS. */
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "poetry", "conda", "mamba", "micromamba", "cargo", "go"]);
const RUNNER_SUBCOMMANDS = new Set(["exec", "run", "dlx", "x"]);
/** Runners that also run a package bin named directly (`yarn rimraf …`). */
const BIN_RUNNERS = new Set(["yarn", "pnpm", "bun"]);
/** Git options whose value is message or search text, not shell. */
const GIT_MESSAGE_OPTIONS = new Set(["-m", "--message", "-F", "--file", "--grep", "-S", "-G"]);
// Note: `<<<` (here-string) is intentionally NOT in REDIRECT_OPERATORS so
// `segmentWords` retains the here-string body for quoted-script / pipe-to-shell
// checks in both the delete floor and the write floor.
const REDIRECT_OPERATORS = new Set([">", ">>", "<", "<<", ">|", "&>", "&>>", "<>", ">&", "<&"]);
const OUTPUT_REDIRECT_OPERATORS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);
const WRITE_WORD = /(?:^|[^A-Za-z0-9_.-])(?:tee|cp|install|ln|worktree)(?:[^A-Za-z0-9_.-]|$)|>/u;
const SAFE_DEVICE_WRITE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const WRITE_FLOOR_COMMANDS = new Set(["tee", "cp", "install", "ln"]);
const WRITE_FLOOR_WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-p", "-h", "-r", "-t", "-U", "-T"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "-P", "-u"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  env: new Set(["-u", "--unset", "-S", "--split-string"]),
  doas: new Set(["-u", "-C"]),
  flock: new Set(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"]),
};
const WRITE_FLOOR_CWD_CHANGING_WRAPPER_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-D", "--chdir"]),
  env: new Set(["-C", "--chdir"]),
};
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
  const bindings = floorBindings(command, lexical.tokens, inherited, roots.defaultTmpDir);
  const nested = (body: string, directory: string | undefined): string | undefined => floorScript(body, directory, roots, bindings, depth + 1);
  for (const body of substitutionBodies(withoutQuotedHeredocs(command))) {
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
  const stack: (string | undefined)[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const words = segmentWords(segment.tokens);
    let first = 0;
    while (first < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[first]!.value) || FLOOR_KEYWORDS.has(words[first]!.value))) first += 1;
    if (first >= words.length) continue;
    const head = floorCommandName(words[first]!);
    // Text piped into a shell is a script.
    const intoShell = (segment.joiner === "|" || segment.joiner === "|&") && SHELL_NAMES.has(floorCommandName(segmentWords(segments[index + 1]?.tokens ?? [])[0]) ?? "");
    if (intoShell) {
      const violation = nested(words.slice(first + 1).map((word) => word.value).join(" "), directory);
      if (violation) return violation;
    }
    // A quoted argument that mentions a delete is a script for whatever runs it
    // (`sh -lc`, `watch`, `trap`, `su -c`), unless the command only reads text.
    // Package runners run whatever follows `exec`/`run`/`dlx`/`x`; git runs
    // shell text from options (`-c core.pager=…`, `difftool -x`) but not from a message.
    const runs = head !== undefined && PACKAGE_RUNNERS.has(head) && words.slice(first + 1).some((word) => RUNNER_SUBCOMMANDS.has(word.value)
      || (BIN_RUNNERS.has(head) && DELETE_COMMANDS.has(floorCommandName(word) ?? "")));
    const stops = head !== undefined && FLOOR_STOP_COMMANDS.has(head) && !runs;
    if (!stops) {
      for (let cursor = first + 1; cursor < words.length; cursor += 1) {
        const word = words[cursor]!;
        if (head === "git" && (GIT_MESSAGE_OPTIONS.has(words[cursor - 1]!.value) || /^--(?:message|grep|file)=/u.test(word.value))) continue;
        if (/\s/u.test(word.value) && DELETE_WORD.test(word.value)) {
          const violation = nested(word.value.replace(/^[A-Za-z0-9_.-]+=/u, ""), directory);
          if (violation) return violation;
        }
      }
    }
    let local = directory;
    for (let cursor = first; cursor < words.length; cursor += 1) {
      const word = words[cursor]!;
      const name = floorCommandName(word);
      if (name === undefined) continue;
      if (name === "cd" || name === "pushd") {
        if (name === "pushd") stack.push(directory);
        directory = resolveCd(words.slice(cursor + 1), directory);
        break;
      }
      if (name === "popd") { directory = stack.length > 0 ? stack.pop() : undefined; break; }
      // Only the statement's own command can end the scan: `sudo -u git rm …` still deletes.
      if (cursor === first && stops) break;
      // `env -C DIR` and `sudo -D DIR` run the command elsewhere.
      if (name === "env" || name === "sudo") {
        const next = words[cursor + 1]?.value;
        const flags = name === "env" ? ["-C", "--chdir"] : ["-D", "--chdir"];
        if (next !== undefined && flags.includes(next)) local = resolveCd(words.slice(cursor + 2, cursor + 3), local);
        else if (next?.startsWith("--chdir=")) local = resolveCd([{ ...words[cursor + 1]!, value: next.slice("--chdir=".length) }], local);
        continue;
      }
      if (name === "xargs" || name === "parallel") {
        const later = words.slice(cursor + 1);
        const shell = later.some((word) => SHELL_NAMES.has(floorCommandName(word) ?? "") || floorCommandName(word) === "eval");
        const deletingOption = (word: ShellToken): boolean => /^(?:-delete|--delete\S*|--remove-source-files)$/u.test(word.value)
          || (word.value === "clean" && later.some((other) => floorCommandName(other) === "git"));
        const inner = later.find((word) => DELETE_COMMANDS.has(floorCommandName(word) ?? "") || deletingOption(word) || (shell && DELETE_WORD.test(word.value)));
        if (inner) return `Worker cannot delete targets taken from input (${name} ${inner.value}); name the paths, or use find -delete inside the task directory`;
        break;
      }
      const args = words.slice(cursor + 1).map((arg) => (/^(?:\$\(|<\(|>\(|\(|`)/u.test(word.value) ? { ...arg, value: arg.value.replace(/[)`]+$/u, "") } : arg));
      const found = deleteTargets(name, args);
      if (found) {
        if (found.refuse) return found.refuse;
        for (const target of found.targets) {
          const violation = judgeDeleteTarget(target, local, roots, name, found.contentsOnly);
          if (violation) return violation;
        }
        for (const target of found.plain ?? []) {
          const violation = judgeDeleteTarget(target, local, roots, name);
          if (violation) return violation;
        }
        break;
      }
      // A recognised command that deletes nothing ends the scan only as the
      // statement's own command; as a wrapper's option value it does not.
      if (cursor === first && (name === "find" || name === "git" || name === "rsync")) break;
    }
  }
  return undefined;
}

const WRITE_FLOOR_CONTROL_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi", "while", "until", "for", "do", "done",
  "case", "esac", "select", "coproc", "function", "{", "}",
]);
const WRITE_FLOOR_DEFERRED_BUILTINS = new Set(["eval", "source", ".", "trap", "alias", "shopt"]);
const WRITE_FLOOR_ENV_MUTATORS = new Set(["export", "declare", "typeset", "readonly", "local", "read"]);
const WRITE_FLOOR_PRE_CD_READ_ONLY = new Set([
  "true", "false", ":", "echo", "printf", "pwd", "ls", "stat", "test", "[", "[[",
  "cat", "head", "tail", "grep", "rg", "git", "which", "basename", "dirname", "realpath",
]);

/** True only when `text` is a single `$(…)` whose opening `$(` closes at the very last character (never `$(a) $(b)`). */
function isSingleBalancedCommandSubst(text: string): boolean {
  if (!text.startsWith("$(") || !text.endsWith(")")) return false;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote === "'") { if (ch === "'") quote = undefined; continue; }
    if (ch === "\\") { i += 1; continue; }
    if (quote === '"') { if (ch === '"') quote = undefined; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i === text.length - 1;
      if (depth < 0) return false;
    }
  }
  return false;
}

/** Parse `cd`/`pushd` options (`-L`, `-P`, `-e`, `-@`, `--`) and return its single literal operand, or `undefined` if invalid/multiple/missing. */
function parseSimpleCdOperand(args: readonly ShellToken[]): { target: ShellToken | undefined; invalid: boolean } {
  let options = true;
  const operands: ShellToken[] = [];
  for (const tok of args) {
    if (options && tok.value === "--") { options = false; continue; }
    if (options && tok.value.startsWith("-") && tok.value !== "-") {
      if (!/^-[LPe@]+$/u.test(tok.value)) return { target: undefined, invalid: true };
      continue;
    }
    operands.push(tok);
  }
  if (operands.length > 1) return { target: undefined, invalid: true };
  if (operands.length === 0) return { target: undefined, invalid: false }; // bare `cd` -> $HOME
  if (operands[0]!.value === "-") return { target: undefined, invalid: true };
  return { target: operands[0], invalid: false };
}

/** True when `process.env.CDPATH` could redirect a relative `cd target` away from `baseDir`. */
function cdpathCouldShadow(targetValue: string): boolean {
  const cdpath = process.env.CDPATH;
  if (!cdpath || isAbsolute(targetValue) || targetValue.startsWith("./") || targetValue.startsWith("../") || targetValue === "." || targetValue === "..") {
    return false;
  }
  return cdpath.split(":").some((entry) => {
    if (!entry || entry === ".") return false;
    try { return statSync(join(entry, targetValue)).isDirectory(); }
    catch { return false; }
  });
}

function directoryAccessible(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Two-pass fail-closed Write Floor script evaluator:
 * - Pass 1 computes per-segment `possibleDirs` and whole-command `allSeenDirs`,
 *   failing closed (`undefined`) on deferred evaluators (`eval`/`source`/`.`/`trap`/`alias`/`shopt`),
 *   `CDPATH`/`cdable_vars`, dynamic command names, control-flow + `cd`, or unverified `cd`.
 *   Pure flat `cd <existing-accessible-dir> && ...` replaces the directory ONLY
 *   within its `&&` chain (and only if no earlier mutating segment could have
 *   changed the filesystem before `cd` ran).
 * - Pass 2 checks every segment's redirects, command writes, pipe-to-shell,
 *   quoted scripts, heredocs, and raw command/process substitutions against the
 *   appropriate directory set (`allSeenDirs` whenever control flow or deferred
 *   constructs are present).
 */
function writeFloorScript(
  command: string,
  start: string | undefined,
  roots: WriteFloorRoots,
  inherited: ReadonlyMap<string, string>,
  depth: number,
): string | undefined {
  if (depth >= FLOOR_MAX_DEPTH) {
    return WRITE_WORD.test(command) ? "Worker cannot write through commands nested this deep; flatten the command" : undefined;
  }
  const lexical = lexShell(command.trim());
  if (lexical.error) {
    return depth > 0 && WRITE_WORD.test(command) ? "Worker cannot write through a script the policy cannot parse" : undefined;
  }
  const bindings = floorBindings(command, lexical.tokens, inherited, roots.defaultTmpDir);
  const nested = (body: string, directory: string | undefined): string | undefined => writeFloorScript(body, directory, roots, bindings, depth + 1);
  const rawSubstBodies = substitutionBodies(withoutQuotedHeredocs(command));
  const { tokens: dataResolved, embeddedBySegment } = resolveDataTokens(lexical.tokens);
  const tokens = resolveLiteralBindings(applyFloorBindings(dataResolved, bindings));
  const segments = floorSegments(tokens);

  // Detect control-flow / compound syntax anywhere in the command (on non-heredoc tokens).
  const nonDataTokens = tokens.filter((t) => !t.operator && !t.data && !t.heredoc);
  const hasControlFlow = nonDataTokens.some((t) => {
    const clean = t.value.replace(/^[({]+|[});]+$/gu, "");
    return WRITE_FLOOR_CONTROL_KEYWORDS.has(t.value)
      || WRITE_FLOOR_CONTROL_KEYWORDS.has(clean)
      || (t.leadingOpenParens ?? 0) > 0
      || (t.trailingCloseParens ?? 0) > 0
      || t.value === "()"
      || t.value === "(){"
      || /^[A-Za-z_][A-Za-z0-9_]*\(\)\{?$/u.test(t.value);
  });

  // Pass 1: compute per-segment possibleDirs and whole-command allSeenDirs.
  const segmentDirs: Array<Set<string | undefined>> = [];
  const allSeenDirs = new Set<string | undefined>([start]);
  let possibleDirs = new Set<string | undefined>([start]);
  let preCdMutatingSeen = false;
  let globalCwdUnknown = false;
  let preChainDirs: Set<string | undefined> | undefined;

  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    const segment = segments[segIdx]!;
    const prevJoiner = segIdx > 0 ? segments[segIdx - 1]!.joiner : undefined;
    // If a flat `cd` replaced `possibleDirs` only for its `&&` chain, union back
    // the pre-cd directory once the `&&` chain ends (`;`, `||`, `&`).
    if (preChainDirs && prevJoiner !== "&&") {
      for (const dir of preChainDirs) possibleDirs.add(dir);
      preChainDirs = undefined;
    }
    const words = segmentWords(segment.tokens);
    let first = 0;
    while (first < words.length && (FLOOR_KEYWORDS.has(words[first]!.value) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[first]!.value))) first += 1;

    // Detect `CDPATH` / `cdable_vars` anywhere in non-heredoc words (after quote removal).
    if (words.some((w) => /\b(?:CDPATH|cdable_vars)\b/u.test(w.value))) {
      globalCwdUnknown = true;
      possibleDirs.add(undefined);
      allSeenDirs.add(undefined);
    }

    // Snapshot possibleDirs BEFORE this segment's own `cd` runs (so redirects on the `cd` segment itself are checked properly).
    segmentDirs.push(new Set(possibleDirs));

    if (first >= words.length) continue;

    // Locate the effective command word skipping `builtin` / `command` / `time` + their flags.
    let cmdIdx = first;
    while (cmdIdx < words.length) {
      const w = words[cmdIdx]!.value.replace(/^[({]+|[});]+$/gu, "");
      if (w === "builtin" || w === "command" || w === "time") {
        cmdIdx += 1;
        while (cmdIdx < words.length && words[cmdIdx]!.value.startsWith("-") && words[cmdIdx]!.value !== "--") cmdIdx += 1;
        if (cmdIdx < words.length && words[cmdIdx]!.value === "--") cmdIdx += 1;
        continue;
      }
      break;
    }
    const cmdTok = words[cmdIdx];
    const cmdWord = cmdTok?.value.replace(/^[({]+|[});]+$/gu, "") ?? "";
    const head = floorCommandName(words[first]);

    // Deferred evaluators (`eval`, `source`, `.`, `trap`, `alias`, `shopt`) or
    // dynamic command names can change cwd or define aliases arbitrarily -> fail closed.
    if (WRITE_FLOOR_DEFERRED_BUILTINS.has(cmdWord) || Boolean(cmdTok?.dynamic)) {
      globalCwdUnknown = true;
      possibleDirs.add(undefined);
      allSeenDirs.add(undefined);
      continue;
    }

    // Dynamic env mutators (`declare $v=~`, `export $v=~`, `printf -v $v`) could set CDPATH.
    // Check only the variable NAME (before `=`), so `export FOO="$BAR"` stays allowed.
    if (WRITE_FLOOR_ENV_MUTATORS.has(cmdWord) && words.slice(cmdIdx + 1).some((w) => {
      if (w.value.startsWith("-")) return false;
      const eq = w.value.indexOf("=");
      const varName = eq >= 0 ? w.value.slice(0, eq) : w.value;
      return /[$`*?[\]{}~]/u.test(varName);
    })) {
      globalCwdUnknown = true;
      possibleDirs.add(undefined);
      allSeenDirs.add(undefined);
      continue;
    }
    if (cmdWord === "printf" && words.slice(cmdIdx + 1).some((w, i, arr) => w === arr[i] && (w.value === "-v" || w.value.startsWith("-v")) && (arr[i + 1]?.dynamic || /\bCDPATH\b/u.test(arr[i + 1]?.value ?? "")))) {
      globalCwdUnknown = true;
      possibleDirs.add(undefined);
      allSeenDirs.add(undefined);
      continue;
    }

    // In control-flow mode, ANY mention of `cd`/`pushd`/`popd` outside stop commands
    // (including `if`/`while`/`for`/`case` arms/subshells/functions) fails closed globally.
    if (hasControlFlow) {
      const stopCmd = head !== undefined && FLOOR_STOP_COMMANDS.has(head) && head !== "tee";
      const hasDirWord = !stopCmd && words.slice(first).some((w) => {
        const clean = w.value.replace(/^[({$]+|[});]+$/gu, "");
        return clean === "cd" || clean === "pushd" || clean === "popd";
      });
      if (hasDirWord) {
        globalCwdUnknown = true;
        possibleDirs.add(undefined);
        allSeenDirs.add(undefined);
      }
      continue;
    }

    // Flat mode (no control flow anywhere in the command):
    const inPipelineOrBg = prevJoiner === "|" || prevJoiner === "|&"
      || segment.joiner === "|" || segment.joiner === "|&" || segment.joiner === "&";

    if (cmdWord === "cd" || cmdWord === "pushd") {
      if (inPipelineOrBg) continue;
      const parsed = parseSimpleCdOperand(words.slice(cmdIdx + 1));
      if (parsed.invalid || (parsed.target && cdpathCouldShadow(parsed.target.value))) {
        possibleDirs.add(undefined);
        allSeenDirs.add(undefined);
        continue;
      }
      const nextDirs = new Set<string | undefined>();
      let allAccessibleAndPhysical = true;
      for (const dir of possibleDirs) {
        const resolvedNext = resolveCd(parsed.target ? [parsed.target] : [], dir);
        if (!resolvedNext || !directoryAccessible(resolvedNext)) {
          // Missing/unaccessible target (e.g. `cd .ssh` with CDPATH or `cd nope`):
          // fail closed with `undefined` instead of guessing an in-R directory.
          nextDirs.add(undefined);
          allSeenDirs.add(undefined);
          allAccessibleAndPhysical = false;
          continue;
        }
        let physical: string;
        try { physical = realpathSync.native(resolvedNext); }
        catch { physical = resolvedNext; allAccessibleAndPhysical = false; }
        nextDirs.add(physical);
        allSeenDirs.add(physical);
        if (physical !== resolvedNext) {
          // Symlinked cd target: include BOTH lexical and physical paths so `..`
          // is checked against both views.
          nextDirs.add(resolvedNext);
          allSeenDirs.add(resolvedNext);
          allAccessibleAndPhysical = false;
        }
      }
      const canReplace = !preCdMutatingSeen
        && allAccessibleAndPhysical
        && (prevJoiner === undefined || prevJoiner === "&&" || (prevJoiner === ";" && segIdx === 0))
        && (segment.joiner === "&&" || segment.joiner === undefined || (segment.joiner === ";" && segIdx === 0));
      if (canReplace) {
        if (segment.joiner === "&&") preChainDirs = new Set(possibleDirs);
        possibleDirs = nextDirs;
      } else {
        for (const d of nextDirs) possibleDirs.add(d);
      }
      continue;
    }

    if (cmdWord === "popd") {
      if (!inPipelineOrBg) {
        possibleDirs.add(undefined);
        allSeenDirs.add(undefined);
      }
      continue;
    }

    if (head && !WRITE_FLOOR_PRE_CD_READ_ONLY.has(head)) {
      preCdMutatingSeen = true;
    }
  }

  // Pass 2: judge every segment's redirects, command writes, pipe-to-shell,
  // quoted scripts, and heredoc bodies against the resolved directory set.
  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    const segment = segments[segIdx]!;
    const dirsForSegment = hasControlFlow || globalCwdUnknown ? allSeenDirs : segmentDirs[segIdx]!;
    const checkDirs = (fn: (dir: string | undefined) => string | undefined): string | undefined => {
      for (const dir of dirsForSegment) {
        const violation = fn(dir);
        if (violation) return violation;
      }
      return undefined;
    };

    const segEmbedded = embeddedBySegment.get(segIdx);
    if (segEmbedded) {
      for (const body of segEmbedded) {
        const v = checkDirs((dir) => nested(body, dir));
        if (v) return v;
      }
    }

    const redirectTargets = extractOutputRedirectTargets(segment.tokens);
    for (const target of redirectTargets) {
      const v = checkDirs((dir) => judgeWriteTarget(target, dir, roots, { allowRootDir: false, verb: "write to" }));
      if (v) return v;
    }

    const words = segmentWords(segment.tokens);
    let first = 0;
    while (first < words.length && (FLOOR_KEYWORDS.has(words[first]!.value) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[first]!.value))) first += 1;
    if (first >= words.length) continue;

    const head = floorCommandName(words[first]);
    const intoShell = (segment.joiner === "|" || segment.joiner === "|&")
      && SHELL_NAMES.has(floorCommandName(segmentWords(segments[segIdx + 1]?.tokens ?? [])[0]) ?? "");
    if (intoShell) {
      const body = words.slice(first + 1).map((word) => word.value).join(" ");
      const v = checkDirs((dir) => nested(body, dir));
      if (v) return v;
    }

    const runs = head !== undefined && PACKAGE_RUNNERS.has(head) && words.slice(first + 1).some((word) =>
      RUNNER_SUBCOMMANDS.has(word.value) || (BIN_RUNNERS.has(head) && WRITE_FLOOR_COMMANDS.has(floorCommandName(word) ?? "")),
    );
    const stops = head !== undefined && FLOOR_STOP_COMMANDS.has(head) && head !== "tee" && !runs;

    if (!stops) {
      const segValues = words.slice(first).map((w) => w.value);
      for (const body of nestedShellCommands(segValues.map((v) => v.toLowerCase()), segValues)) {
        const v = checkDirs((dir) => nested(body, dir));
        if (v) return v;
      }
      for (let cursor = first + 1; cursor < words.length; cursor += 1) {
        const word = words[cursor]!;
        if (head === "git" && (GIT_MESSAGE_OPTIONS.has(words[cursor - 1]!.value) || /^--(?:message|grep|file)=/u.test(word.value))) continue;
        if (/\s/u.test(word.value) && WRITE_WORD.test(word.value)) {
          // Only unwrap a SINGLE balanced `$(…)` (never `$(a) $(b)`), so
          // `until [ -n "$(grep … 2>/dev/null)" ]` loses its outer `)` while
          // `trap '$(cp a /out)' EXIT` and `trap '$(true) $(cp a /out)' EXIT` are both caught.
          const cleaned = isSingleBalancedCommandSubst(word.value)
            ? word.value.slice(2, -1)
            : word.value.replace(/^[A-Za-z0-9_.-]+=/u, "");
          const v = checkDirs((dir) => nested(cleaned, dir));
          if (v) return v;
        }
      }
      const v = checkDirs((dir) => checkWriteCommandsInWords(words, first, dir, roots, nested));
      if (v) return v;
    }
  }

  // Evaluate raw-source command/process substitutions (`$(…)`, `<(…)`, `>(…)`,
  // backticks) against EVERY directory seen during the command.
  for (const body of rawSubstBodies) {
    for (const dir of allSeenDirs) {
      const violation = nested(body, dir);
      if (violation) return violation;
    }
  }
  return undefined;
}

/**
 * Extract shell output redirection target tokens from one segment.
 * For `[[ ... ]]` and `(( ... ))` (ONLY when a matching `]]`/`))` actually
 * closes them!), skip tokens inside the test/arithmetic expression while still
 * checking any redirections that follow `]]`/`))` (e.g. `(( 1 )) > /etc/x`).
 */
function extractOutputRedirectTargets(segment: readonly ShellToken[]): ShellToken[] {
  const targets: ShellToken[] = [];
  let i = 0;
  const firstVal = segment[0]?.value ?? "";
  if (firstVal === "[[") {
    const closeIdx = segment.findIndex((tok, idx) => idx > 0 && !tok.operator && tok.value === "]]");
    if (closeIdx >= 0) i = closeIdx + 1;
  } else if (firstVal.startsWith("((")) {
    const closeIdx = segment.findIndex((tok, idx) => idx >= 0 && !tok.operator && tok.value.endsWith("))"));
    if (closeIdx >= 0) i = closeIdx + 1;
  }
  for (; i < segment.length; i += 1) {
    const token = segment[i]!;
    if (!token.operator || !OUTPUT_REDIRECT_OPERATORS.has(token.value)) continue;
    const next = segment[i + 1];
    if (!next) continue;
    // `>&WORD` or `N>&WORD`: fd dup ONLY when WORD is all digits or `-`;
    // otherwise bash redirects stdout+stderr to the file named WORD.
    if (token.value === ">&") {
      if (!next.operator && !next.data && !/^(?:\d+|-)$/u.test(next.value)) {
        targets.push(next);
      }
      i += 1;
      continue;
    }
    if (!next.operator && !next.data) {
      targets.push(next);
      i += 1;
    }
  }
  return targets;
}

function checkWriteCommandsInWords(
  words: readonly ShellToken[],
  first: number,
  directory: string | undefined,
  roots: WriteFloorRoots,
  nested: (body: string, directory: string | undefined) => string | undefined,
): string | undefined {
  let effectiveDir = directory;
  let inFind = false;
  for (let cursor = first; cursor < words.length; cursor += 1) {
    const raw = words[cursor]!.value;
    if (cursor > first && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(raw)) continue;
    if (inFind && (raw === "-execdir" || raw === "-okdir")) {
      effectiveDir = undefined;
      continue;
    }
    const name = floorCommandName(words[cursor]);
    if (!name) continue;
    // Handle `env`/`sudo` wrappers including attached/clustered `-C`/`-D` and `env -S`.
    if (name === "env" || name === "sudo") {
      const cwdLetter = name === "env" ? "C" : "D";
      const valFlags = WRITE_FLOOR_WRAPPER_VALUE_FLAGS[name];
      let idx = cursor + 1;
      while (idx < words.length && words[idx]!.value.startsWith("-")) {
        const flagTok = words[idx]!.value;
        if (flagTok === "--") { idx += 1; break; }
        const eq = flagTok.indexOf("=");
        const flagName = eq > 0 ? flagTok.slice(0, eq) : flagTok;
        if (flagName === `-${cwdLetter}` || flagName === "--chdir") {
          const dirArg = eq > 0 ? { ...words[idx]!, value: flagTok.slice(eq + 1) } : words[idx + 1];
          effectiveDir = dirArg ? resolveCd([dirArg], effectiveDir) : undefined;
          if (eq < 0) idx += 1;
          idx += 1;
          continue;
        }
        if (name === "env" && (flagName === "-S" || flagName === "--split-string")) {
          const scriptArg = eq > 0 ? flagTok.slice(eq + 1) : words[idx + 1]?.value;
          if (scriptArg) {
            const violation = nested(scriptArg, effectiveDir);
            if (violation) return violation;
          }
          if (eq < 0) idx += 1;
          idx += 1;
          continue;
        }
        // Short clusters for `env`/`sudo` (e.g. `env -iC/home/u`, `env -C/home/u`, `sudo -D/etc`, `env -S'cp ...'`).
        // Walk letter-by-letter and STOP at the first letter that consumes a value
        // (e.g. `-uC` means `-u C`, NOT `-u` + `-C`) so value text is never misread as flags.
        if (!flagTok.startsWith("--") && flagTok.length > 2) {
          const letters = flagTok.slice(1);
          const valueLetters = name === "env" ? new Set(["u"]) : new Set(["u", "g", "C", "p", "h", "r", "t", "U", "T"]);
          let handledCluster = false;
          for (let c = 0; c < letters.length; c += 1) {
            const ch = letters[c]!;
            const restOfWord = letters.slice(c + 1);
            if (ch === cwdLetter) {
              const dirArg = restOfWord ? { ...words[idx]!, value: restOfWord } : words[idx + 1];
              effectiveDir = dirArg ? resolveCd([dirArg], effectiveDir) : undefined;
              if (!restOfWord) idx += 1;
              idx += 1;
              handledCluster = true;
              break;
            }
            if (name === "env" && ch === "S") {
              const scriptArg = restOfWord || words[idx + 1]?.value;
              if (scriptArg) {
                const violation = nested(scriptArg, effectiveDir);
                if (violation) return violation;
              }
              if (!restOfWord) idx += 1;
              idx += 1;
              handledCluster = true;
              break;
            }
            if (valueLetters.has(ch)) {
              if (!restOfWord) idx += 1;
              idx += 1;
              handledCluster = true;
              break;
            }
          }
          if (handledCluster) continue;
        }
        if (valFlags?.has(flagName)) {
          if (eq < 0) idx += 1;
          idx += 1;
          continue;
        }
        idx += 1;
      }
      cursor = idx - 1;
      continue;
    }
    const valFlags = WRITE_FLOOR_WRAPPER_VALUE_FLAGS[name];
    if (valFlags) {
      let idx = cursor + 1;
      while (idx < words.length && words[idx]!.value.startsWith("-")) {
        const flagTok = words[idx]!.value;
        if (flagTok === "--") { idx += 1; break; }
        const eq = flagTok.indexOf("=");
        const flagName = eq > 0 ? flagTok.slice(0, eq) : flagTok;
        if (valFlags.has(flagName)) {
          if (eq < 0) idx += 1;
          idx += 1;
          continue;
        }
        idx += 1;
      }
      if (name === "timeout" && idx < words.length) idx += 1;
      if (name === "flock" && idx < words.length) idx += 1;
      cursor = idx - 1;
      continue;
    }
    if (name === "tee") {
      const violation = checkTeeWriteTargets(trimFindExecTerminator(words.slice(cursor + 1), cursor > first), effectiveDir, roots);
      if (violation) return violation;
      if (!inFind) return undefined;
      continue;
    }
    if (WRITE_FLOOR_COMMANDS.has(name)) {
      const violation = checkFileWriteCommandTargets(name, trimFindExecTerminator(words.slice(cursor + 1), cursor > first), effectiveDir, roots);
      if (violation) return violation;
      if (!inFind) return undefined;
      continue;
    }
    if (name === "git") {
      const violation = checkGitWorktreeWriteTargets(trimFindExecTerminator(words.slice(cursor + 1), cursor > first), effectiveDir, roots);
      if (violation) return violation;
      if (cursor === first) break;
      continue;
    }
    if (name === "find") { inFind = true; continue; }
    if (cursor === first && (name === "xargs" || name === "parallel")) continue;
    if (cursor === first && PACKAGE_RUNNERS.has(name)) continue;
    if (cursor === first && FLOOR_STOP_COMMANDS.has(name)) break;
  }
  return undefined;
}

/** Strip trailing `;` or `+` terminator from `find ... -exec <cmd> ... \;` / `+` operands. */
function trimFindExecTerminator(args: readonly ShellToken[], nested: boolean): readonly ShellToken[] {
  if (!nested) return args;
  const end = args.findIndex((tok) => !tok.operator && (tok.value === ";" || tok.value === "+"));
  return end >= 0 ? args.slice(0, end) : args;
}

function checkTeeWriteTargets(args: readonly ShellToken[], directory: string | undefined, roots: WriteFloorRoots): string | undefined {
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    if (options && tok.value === "--") { options = false; continue; }
    if (options && tok.value.startsWith("-") && tok.value !== "-") {
      // Note: `--output-error` takes an optional arg ONLY via `=` (`--output-error=MODE`),
      // NEVER a separate next word, so `tee --output-error /etc/x` writes `/etc/x`.
      continue;
    }
    if (tok.value === "-") continue;
    const violation = judgeWriteTarget(tok, directory, roots, { allowRootDir: false, verb: "write to" });
    if (violation) return violation;
  }
  return undefined;
}

// Note: `--context` and `-Z` take optional/no separate value in GNU cp/install/ln
// (`--context=CTX` only), so they MUST NOT swallow the next operand.
const CP_INSTALL_LN_VALUE_FLAGS = new Set(["-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group", "--strip-program"]);

function checkFileWriteCommandTargets(
  name: string,
  args: readonly ShellToken[],
  directory: string | undefined,
  roots: WriteFloorRoots,
): string | undefined {
  let options = true;
  let targetDir: ShellToken | undefined;
  let noTargetDir = false;
  let force = false;
  let noDeref = false;
  let symbolic = false;
  let hardlink = name === "ln";
  let installDirectoryMode = false;
  const positionals: ShellToken[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    const val = tok.value;
    if (options && val === "--") { options = false; continue; }
    if (options && val.startsWith("-") && val !== "-") {
      if (val.startsWith("--")) {
        const eq = val.indexOf("=");
        const flagName = eq > 0 ? val.slice(0, eq) : val;
        // Match GNU long-option unambiguous prefixes (`--t` / `--tar` / `--target-directory`,
        // `--no-t` / `--no-target-directory`, `--sym` / `--symbolic-link`, `--lin` / `--link`).
        if (flagName.length >= 3 && "--target-directory".startsWith(flagName)) {
          if (eq > 0) targetDir = { ...tok, value: val.slice(eq + 1) };
          else if (i + 1 < args.length) { targetDir = args[i + 1]; i += 1; }
          continue;
        }
        if (flagName.length >= 6 && "--no-target-directory".startsWith(flagName)) { noTargetDir = true; continue; }
        if (flagName === "--force") { force = true; continue; }
        if (flagName === "--no-dereference") { noDeref = true; continue; }
        if (flagName.length >= 5 && ("--symbolic".startsWith(flagName) || "--symbolic-link".startsWith(flagName))) { symbolic = true; hardlink = false; continue; }
        if (flagName.length >= 4 && "--link".startsWith(flagName)) { hardlink = true; continue; }
        if (name === "install" && flagName.length >= 5 && "--directory".startsWith(flagName)) { installDirectoryMode = true; continue; }
        if (CP_INSTALL_LN_VALUE_FLAGS.has(flagName)) {
          if (eq < 0 && i + 1 < args.length) i += 1;
          continue;
        }
        // Optional-arg flags (`--backup[=C]`, `--reflink[=W]`, `--preserve[=L]`, `--context[=CTX]`) take no separate word.
        continue;
      }
      // Short option or cluster (e.g. `-sf`, `-rt/etc`, `-rt /etc`, `-lnf`).
      const letters = val.slice(1);
      for (let c = 0; c < letters.length; c += 1) {
        const ch = letters[c]!;
        if (ch === "t") {
          const attached = letters.slice(c + 1);
          if (attached) targetDir = { ...tok, value: attached };
          else if (i + 1 < args.length) { targetDir = args[i + 1]; i += 1; }
          break;
        }
        if (ch === "T") { noTargetDir = true; continue; }
        if (ch === "f") { force = true; continue; }
        if (ch === "n" || ch === "h") { noDeref = true; continue; }
        if (ch === "s" && (name === "ln" || name === "cp")) { symbolic = true; hardlink = false; continue; }
        if (ch === "l" && name === "cp") { hardlink = true; continue; }
        if (ch === "d" && name === "install") { installDirectoryMode = true; continue; }
        if (["S", "m", "o", "g"].includes(ch)) {
          const attached = letters.slice(c + 1);
          if (!attached && i + 1 < args.length) i += 1;
          break;
        }
      }
      continue;
    }
    positionals.push(tok);
  }

  const destAsFile = noTargetDir || (name === "ln" && noDeref && force);
  let destToken: ShellToken | undefined;
  let sources: ShellToken[] = [];

  if (targetDir) {
    const v = judgeWriteTarget(targetDir, directory, roots, { allowRootDir: true, verb: `${name} into` });
    if (v) return v;
    destToken = targetDir;
    sources = positionals;
  } else if (installDirectoryMode) {
    for (const dirTok of positionals) {
      const v = judgeWriteTarget(dirTok, directory, roots, { allowRootDir: true, verb: "install directory" });
      if (v) return v;
    }
    return undefined;
  } else if (positionals.length >= 2) {
    destToken = positionals.at(-1)!;
    sources = positionals.slice(0, -1);
    const v = judgeWriteTarget(destToken, directory, roots, { allowRootDir: !destAsFile, verb: `${name} to` });
    if (v) return v;
  } else if (name === "ln" && positionals.length === 1) {
    sources = positionals;
    const baseName = basename(stripTrailingSubshellParen(positionals[0]!));
    if (baseName) {
      destToken = { value: baseName, operator: false, dynamic: positionals[0]!.dynamic };
      const v = judgeWriteTarget(destToken, directory, roots, { allowRootDir: false, verb: "ln to" });
      if (v) return v;
    }
  }

  // Hardlinks (`ln` without `-s`, `cp -l`): refusing outside-R / `.git` sources prevents mutating external inodes.
  if (hardlink && !symbolic) {
    for (const src of sources) {
      const v = judgeWriteTarget(src, directory, roots, { allowRootDir: false, verb: "hard-link from" });
      if (v) return v;
    }
  }

  // Symlinks (`ln -s`, `cp -s`): refuse statically resolvable targets pointing outside R or into `.git`.
  if (symbolic) {
    const linkParent = resolveSymlinkParent(destToken, Boolean(targetDir), destAsFile, directory);
    for (const src of sources) {
      const v = judgeSymlinkTarget(src, linkParent, roots);
      if (v) return v;
    }
  }

  return undefined;
}

function stripTrailingSubshellParen(token: ShellToken): string {
  const count = token.trailingCloseParens ?? 0;
  return count > 0 ? token.value.slice(0, Math.max(0, token.value.length - count)) : token.value;
}

function resolveSymlinkParent(
  destToken: ShellToken | undefined,
  isTargetDirFlag: boolean,
  destAsFile: boolean,
  directory: string | undefined,
): string | undefined {
  if (!destToken) return directory;
  if (destToken.dynamic) return undefined;
  const cleaned = stripTrailingSubshellParen(destToken);
  const raw = cleaned.startsWith("~/") || cleaned === "~"
    ? homedir() + cleaned.slice(1)
    : cleaned;
  if (!isAbsolute(raw) && directory === undefined) return undefined;
  const resolvedDest = isAbsolute(raw) ? resolve(raw) : resolve(directory!, raw);
  if (isTargetDirFlag) return resolvedDest;
  if (!destAsFile) {
    try {
      if (statSync(resolvedDest).isDirectory()) return resolvedDest;
    } catch { /* non-existent destination: link is placed in dirname(dest) */ }
  }
  return dirname(resolvedDest);
}

function judgeSymlinkTarget(target: ShellToken, linkParent: string | undefined, roots: WriteFloorRoots): string | undefined {
  const literal = resolveStaticPathValue(target, linkParent);
  if (literal === undefined) return undefined;
  if (!isAbsolute(literal) && linkParent === undefined) return undefined;
  const lexical = isAbsolute(literal) ? resolve(literal) : resolve(linkParent!, literal);
  if (lexical.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) {
    return `Worker cannot create a symlink targeting Git metadata (${target.value})`;
  }
  const canonical = resolveExistingPath(lexical);
  if (canonical.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) {
    return `Worker cannot create a symlink targeting Git metadata (${target.value})`;
  }
  const allRoots = [roots.cwd, ...roots.others];
  const inside = allRoots.some((root) => {
    const prefix = root === "/" ? "/" : `${root}/`;
    return canonical === root || canonical.startsWith(prefix);
  });
  if (!inside) {
    return `Worker cannot create a symlink pointing outside the task directory (${target.value})`;
  }
  return undefined;
}

function checkGitWorktreeWriteTargets(args: readonly ShellToken[], directory: string | undefined, roots: WriteFloorRoots): string | undefined {
  let effectiveDir = directory;
  let index = 0;
  while (index < args.length) {
    const word = args[index]!.value;
    if (word === "-C") {
      const next = args[index + 1];
      if (!next) return undefined;
      effectiveDir = resolveCd([next], effectiveDir);
      index += 2;
      continue;
    }
    if (word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") {
      index += 2;
      continue;
    }
    if (word.startsWith("-")) { index += 1; continue; }
    break;
  }
  if (args[index]?.value.toLowerCase() !== "worktree") return undefined;
  const action = args[index + 1]?.value.toLowerCase();
  if (action !== "add" && action !== "move") return undefined;
  const positionals: ShellToken[] = [];
  let options = true;
  for (let i = index + 2; i < args.length; i += 1) {
    const tok = args[i]!;
    const val = tok.value;
    if (options && val === "--") { options = false; continue; }
    if (options && val.startsWith("-")) {
      if (action === "add") {
        if (val.startsWith("--")) {
          const eq = val.indexOf("=");
          const flag = eq > 0 ? val.slice(0, eq) : val;
          // Match git's abbreviated `--reason` prefix (e.g. `--reas why`).
          if (flag.length >= 4 && "--reason".startsWith(flag) && eq < 0) i += 1;
        } else {
          // Bundled short options like `-fb feat <path>` or `-qb feat <path>`.
          const letters = val.slice(1);
          for (let c = 0; c < letters.length; c += 1) {
            if (letters[c] === "b" || letters[c] === "B") {
              if (c === letters.length - 1) i += 1;
              break;
            }
          }
        }
      }
      continue;
    }
    positionals.push(tok);
  }
  const target = action === "add" ? positionals[0] : positionals[1];
  if (!target) return undefined;
  return judgeWriteTarget(target, effectiveDir, roots, { allowRootDir: false, verb: `git worktree ${action} to` });
}

function resolveStaticPathValue(target: ShellToken, directory: string | undefined): string | undefined {
  let value = stripTrailingSubshellParen(target);
  if (directory !== undefined && /\$(?:\{PWD\}|PWD(?![A-Za-z0-9_]))/u.test(value)) {
    value = value.replace(/\$(?:\{PWD\}|PWD(?![A-Za-z0-9_]))/gu, directory);
  }
  if (value === "~" || value.startsWith("~/")) {
    value = homedir() + value.slice(1);
  }
  if (/[$`*?[\]{}~]/u.test(value)) return undefined;
  return value;
}

/**
 * When a write target contains a glob or variable AFTER a fixed prefix (e.g.
 * `/etc/$X`, `~/.ssh/authorized_key?`, `/hom[e]/u/.bashrc`, `.git/$X`), check
 * whether that fixed prefix is already proven outside every root in `R` or
 * names `.git`. Pure leading-dynamic targets (`"$OUT"`) return undefined so
 * they fall through to the active permission authority.
 */
function checkDynamicWritePrefix(
  target: ShellToken,
  directory: string | undefined,
  roots: WriteFloorRoots,
  verb: string,
): string | undefined {
  let value = stripTrailingSubshellParen(target);
  if (directory !== undefined && /\$(?:\{PWD\}|PWD(?![A-Za-z0-9_]))/u.test(value)) {
    value = value.replace(/\$(?:\{PWD\}|PWD(?![A-Za-z0-9_]))/gu, directory);
  }
  if (value === "~" || value.startsWith("~/")) {
    value = homedir() + value.slice(1);
  }
  // No literal path structure before the dynamic expansion (e.g. `"$OUT"`).
  if (/^[$`~{]/u.test(value)) return undefined;
  const fullPath = isAbsolute(value) ? value : (directory !== undefined ? `${directory.replace(/\/+$/u, "")}/${value}` : undefined);
  if (!fullPath) return undefined;
  const segments = fullPath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.length === 0) return undefined;

  // Check if any literal segment before the first `$`/`backtick` names `.git`.
  for (const seg of segments) {
    if (/[$`]/u.test(seg)) break;
    if (seg.toLowerCase() === ".git" || (/[*?[]/u.test(seg) && globMatches(seg, ".git"))) {
      return `Worker cannot ${verb} Git metadata or .git pointers (${target.value})`;
    }
  }

  // Build candidate canonical root segment lists for every root in R.
  const allRootPaths = [
    roots.cwd,
    ...roots.others,
    roots.rawCwd,
    ...roots.rawWriteRoots,
    ...roots.rawTempRoots,
    ...roots.pinnedWriteRoots.map((r) => r.declared),
  ].filter((p) => isAbsolute(p));
  const rootSegLists = [...new Set(allRootPaths.map((p) => resolve(p).replaceAll("\\", "/")))].map((p) => p.split("/").filter(Boolean));

  // Walk segments up to the first `$` / backtick / `{`; if the prefix cannot
  // lie inside OR be a prefix of ANY root in R, it is provably outside R!
  const concreteSegments: string[] = [];
  for (const seg of segments) {
    if (/[$`{}]/u.test(seg)) break;
    if (seg === ".") continue;
    if (seg === "..") {
      if (concreteSegments.length > 0 && !/[*?[]/u.test(concreteSegments.at(-1)!)) concreteSegments.pop();
      else break;
      continue;
    }
    concreteSegments.push(seg);
  }
  if (concreteSegments.length === 0) return undefined;

  const matchesAnyRoot = rootSegLists.some((rootSegs) => {
    const limit = Math.min(concreteSegments.length, rootSegs.length);
    for (let k = 0; k < limit; k += 1) {
      const seg = concreteSegments[k]!;
      const rootSeg = rootSegs[k]!;
      if (/[*?[]/u.test(seg)) {
        if (!globMatches(seg, rootSeg)) return false;
      } else if (seg !== rootSeg) {
        return false;
      }
    }
    // If concreteSegments is shorter than rootSegs, it could still be an ancestor
    // of a root (e.g. `/tmp/$X` when a root is `/tmp/pi-claude-task-…`): only
    // allow if a later dynamic segment follows; if the entire path ended before
    // reaching any root (e.g. `/tmp/x?` vs `/tmp/pi-claude-task-…`), concreteSegments[1]
    // already failed `globMatches("x?", "pi-claude-task-…")`.
    return true;
  });
  if (!matchesAnyRoot) {
    return `Worker cannot ${verb} outside the task directory (${target.value})`;
  }
  return undefined;
}

function judgeWriteTarget(
  target: ShellToken,
  directory: string | undefined,
  roots: WriteFloorRoots,
  options: { allowRootDir: boolean; verb: string },
): string | undefined {
  const cleanedRaw = stripTrailingSubshellParen(target);
  if (SAFE_DEVICE_WRITE_SINKS.has(cleanedRaw) || /^\/(?:dev|proc\/self)\/fd\/\d+$/u.test(cleanedRaw)) {
    return undefined;
  }
  const literal = resolveStaticPathValue(target, directory);
  if (literal === undefined) {
    // Still check any fixed literal/glob prefix (e.g. `/etc/$X`, `~/.ssh/key?`, `/hom[e]/u/.bashrc`).
    return checkDynamicWritePrefix(target, directory, roots, options.verb);
  }
  if (SAFE_DEVICE_WRITE_SINKS.has(literal) || /^\/(?:dev|proc\/self)\/fd\/\d+$/u.test(literal)) {
    return undefined;
  }
  if (!isAbsolute(literal) && directory === undefined) {
    return `Worker cannot ${options.verb} a relative path after a cd the policy cannot follow (${target.value})`;
  }
  const unnormalized = isAbsolute(literal) ? literal : `${directory!.replace(/\/+$/u, "")}/${literal}`;
  const rawSegments = unnormalized.replaceAll("\\", "/").split("/");
  if (rawSegments.some((segment) => segment.toLowerCase() === ".git")) {
    return `Worker cannot ${options.verb} Git metadata or .git pointers (${target.value})`;
  }
  // Judge against unified root set R passing RAW cwd + writeRoots + tempRoots +
  // pinnedWriteRoots so symlinked OS ancestors (macOS /tmp -> /private/tmp,
  // /var -> /private/var) match via `pathBelow` identically to Write/Edit.
  const combinedWriteRoots = [...roots.rawWriteRoots, ...roots.rawTempRoots];
  const violation = classifyWritePath(unnormalized, roots.rawCwd, combinedWriteRoots, roots.pinnedWriteRoots);
  if (violation === "git-metadata") {
    return `Worker cannot ${options.verb} Git metadata or .git pointers (${target.value})`;
  }
  if (violation === "cwd-missing") {
    return `the task working directory no longer exists, so nothing can be written (${target.value})`;
  }
  if (violation === "outside-cwd") {
    return `Worker cannot ${options.verb} outside the task directory (${target.value})`;
  }
  if (!options.allowRootDir) {
    const resolved = resolveExistingPath(resolve(unnormalized));
    if (resolved === roots.cwd || roots.others.includes(resolved)) {
      return `Worker cannot overwrite a task or write-root directory itself (${target.value})`;
    }
  }
  return undefined;
}

const FLOOR_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "(", "{", "}", "done", "fi", "esac"]);

function deleteFloorRoots(cwd: string, writeRoots: readonly string[], tempRoots: readonly string[], pinnedWriteRoots: readonly PinnedWriteRoot[] = []): FloorRoots {
  const canonical = (path: string): string => {
    try { return realpathSync.native(path); } catch { return resolve(path); }
  };
  const verifiedPinned = pinnedWriteRoots
    .map((root) => verifyPinnedWriteRoot(root))
    .filter((path): path is string => path !== undefined);
  const canonicalTemps = tempRoots.filter((root) => isAbsolute(root)).map(canonical);
  const others = [
    ...verifiedPinned,
    ...writeRoots.filter((root) => isAbsolute(root)).map(canonical),
    ...canonicalTemps,
  ];
  return { cwd: canonical(cwd), others: [...new Set(others)], defaultTmpDir: canonicalTemps[0] };
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

/** A statement's words: no operators, fd-redirect numbers, quoted heredoc data or redirection targets (a process substitution and a here-string stay). */
function segmentWords(segment: readonly ShellToken[]): ShellToken[] {
  const words: ShellToken[] = [];
  let skipNext = false;
  for (const token of segment) {
    if (token.operator) {
      if (REDIRECT_OPERATORS.has(token.value)) {
        // Strip a leading fd number (`2>/dev/null`, `{fd}>/dev/null`) belonging to the redirect.
        const prev = words.at(-1);
        if (prev && !prev.quoted && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/u.test(prev.value)) words.pop();
        skipNext = true;
      } else {
        skipNext = false;
      }
      continue;
    }
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

/** The command with quoted heredoc bodies removed: nothing in them expands, so a backtick there is text. */
function withoutQuotedHeredocs(command: string): string {
  return command.replace(/<<-?[ \t]*(['"])([^'"\s]+)\1([^\n]*)\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|\)|$)|$)/gu, "<<$1$2$1$3");
}

/** The bodies of `$(…)`, `<(…)`, `>(…)` and backticks outside single quotes (tracking double quotes and backslash escapes). */
function substitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  let single = false;
  let double = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (single) { if (character === "'") single = false; continue; }
    if (character === "\\") { index += 1; continue; }
    if (double) {
      if (character === '"') { double = false; continue; }
    } else {
      if (character === "'") { single = true; continue; }
      if (character === '"') { double = true; continue; }
    }
    if (character === "`") {
      let close = index + 1;
      while (close < command.length && command[close] !== "`") {
        if (command[close] === "\\") close += 1;
        close += 1;
      }
      if (close >= command.length) break;
      bodies.push(command.slice(index + 1, close));
      index = close;
      continue;
    }
    if (character === "(" && index > 0 && (command[index - 1] === "$" || (!double && (command[index - 1] === "<" || command[index - 1] === ">")))) {
      let level = 1;
      let cursor = index + 1;
      for (; cursor < command.length && level > 0; cursor += 1) {
        if (command[cursor] === "\\") { cursor += 1; continue; }
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
function floorBindings(command: string, tokens: readonly ShellToken[], inherited: ReadonlyMap<string, string>, defaultTmpDir?: string): Map<string, string> {
  // A name is trusted only while its one definition is its only bare mention:
  // `d+=…`, `printf -v d`, `read d`, `mapfile d` or a second `d=` drop it.
  const bareMentions = (name: string): number => (command.match(new RegExp(`(?<![$\\w{-])${name}(?![\\w])`, "gu")) ?? []).length;
  const bindings = new Map([...inherited].filter(([name]) => bareMentions(name) === 0));
  const defaults: Array<[string, string]> = [["HOME", homedir()]];
  if (defaultTmpDir !== undefined) defaults.push(["TMPDIR", defaultTmpDir]);
  for (const [name, value] of defaults) {
    if (!bindings.has(name) && bareMentions(name) === 0) bindings.set(name, value);
  }
  const assignedOnce = (name: string): boolean => bareMentions(name) === 1;
  for (const match of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(["']?)\$\(\s*mktemp\b([^)]*)\)\2(?=[\s;&|)]|$)/gu)) {
    const name = match[1]!;
    if (!assignedOnce(name)) { bindings.delete(name); continue; }
    const words = match[3]!.trim().split(/\s+/u).filter(Boolean);
    let directory: string | undefined = defaultTmpDir;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!;
      if (word === "-p" || word === "--tmpdir") directory = words[index + 1];
      else if (word.startsWith("--tmpdir=")) directory = word.slice("--tmpdir=".length);
      else if (!word.startsWith("-") && word.includes("/")) directory = dirname(word);
      if (word === "-p") index += 1;
    }
    if (directory !== undefined && /^\$\{?TMPDIR\}?(?=\/|$)/u.test(directory)) {
      directory = defaultTmpDir !== undefined ? defaultTmpDir + directory.replace(/^\$\{?TMPDIR\}?/u, "") : undefined;
    }
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
    // `${f%.bak}` keeps the directory part, so it reads as the bound value; a
    // `#` prefix strip, or a `%` pattern with `/` or a wildcard (which matches
    // `/` in parameter expansion, as can one arriving through `$p`), can drop
    // directories and stays unknown.
    const value = token.value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?=+][^}]*|%{1,2}[^}/*?[\]\\$`]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
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
  // `cd "$(git rev-parse --show-toplevel)"`: the work tree that holds the current directory.
  if (/^\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)$/u.test(target.value)) return directory === undefined ? undefined : gitTopLevel(directory);
  const value = target.value.replace(/[)`;]+$/u, "");
  let literal = value;
  if (target.dynamic) {
    if (literal === "~" || literal.startsWith("~/")) literal = homedir() + literal.slice(1);
    if (/[$`*?[{~]/u.test(literal)) return undefined;
  }
  if (isAbsolute(literal)) return resolve(literal);
  return directory === undefined ? undefined : resolve(directory, literal);
}

function gitTopLevel(directory: string): string | undefined {
  for (let current = resolve(directory); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return undefined;
  }
}

/**
 * What a command would delete or move away. `contentsOnly` marks a target
 * whose own directory survives (a filtered find, `git clean -C`), so a start at
 * the task directory itself is fine.
 */
function deleteTargets(name: string, args: readonly ShellToken[]): { targets: ShellToken[]; contentsOnly?: boolean; plain?: ShellToken[]; refuse?: string } | undefined {
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
    const execEnd = (index: number): number => {
      const end = rest.findIndex((later, cursor) => cursor > index + 1 && (later.value === ";" || later.value === "+"));
      return end < 0 ? rest.length : end;
    };
    // The command an `-exec` runs, read through any wrapper (`sudo`, `env`).
    const execDelete = (index: number): number => rest.slice(index + 1, execEnd(index)).findIndex((word) => DELETE_COMMANDS.has(floorCommandName(word) ?? ""));
    const deletes = rest.some((token, index) => token.value === "-delete" || (FIND_EXEC_ACTIONS.has(token.value) && execDelete(index) >= 0));
    if (!deletes) return undefined;
    const startValues = starts.length > 0 ? starts.map((token) => token.value) : ["."];
    // A filter keeps the start directory only when every `-o` branch carries a
    // positive name/path filter and none of those can match Git's own store; a
    // negated filter (`-not -path './node_modules/*'`) only narrows an AND.
    const branches: ShellToken[][] = [[]];
    for (const token of rest) {
      if (token.value === "-o" || token.value === "-or" || token.value === ",") branches.push([]);
      else branches.at(-1)!.push(token);
    }
    const positive = (branch: readonly ShellToken[]) => branch.flatMap((token, index) => (FIND_NAME_FILTERS.has(token.value) && !["!", "-not"].includes(branch[index - 1]?.value ?? "")
      ? [{ kind: token.value, pattern: branch[index + 1]?.value }] : []));
    const contentsOnly = branches.every((branch) => {
      const filters = positive(branch);
      return filters.length > 0 && filters.every(({ kind, pattern }) => pattern !== undefined && !findFilterReachesGit(kind, pattern, startValues));
    });
    // The literal words of an `-exec rm/mv …` are targets of their own.
    const plain: ShellToken[] = [];
    let refuse: string | undefined;
    rest.forEach((token, index) => {
      if (!FIND_EXEC_ACTIONS.has(token.value)) return;
      const offset = execDelete(index);
      if (offset < 0) return;
      const execName = floorCommandName(rest[index + 1 + offset]) ?? "";
      const argv = rest.slice(index + 2 + offset, execEnd(index));
      if (argv.some((word) => word.value.includes("{}") && word.value !== "{}")) refuse ??= `Worker cannot ${execName} a path built around find's {} (${argv.find((word) => word.value.includes("{}") && word.value !== "{}")!.value}); pass {} alone`;
      const words = argv.filter((word) => word.value !== "{}");
      const extra = deleteTargets(execName, words)?.targets ?? [];
      if (token.value.endsWith("dir") && extra.some((word) => !isAbsolute(word.value))) refuse ??= `Worker cannot ${execName} a relative path from find ${token.value}; it runs in every matched directory`;
      plain.push(...extra);
    });
    return { targets: starts.length > 0 ? starts : [{ value: ".", operator: false, dynamic: false }], contentsOnly, plain, ...(refuse ? { refuse } : {}) };
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

function classifyWritePath(
  value: string,
  cwd: string,
  writeRoots: readonly string[] = [],
  pinnedWriteRoots: readonly PinnedWriteRoot[] = [],
): WritePathViolation | undefined {
  if (value.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) return "git-metadata";
  if (isAbsolute(value)) {
    for (const pinned of pinnedWriteRoots) {
      const verified = verifyPinnedWriteRoot(pinned);
      if (!verified) continue;
      const below = pathBelow(value, [pinned.declared, verified]);
      if (below === undefined) continue;
      return walkWritePath(below, verified);
    }
    // Session write roots (Claude's own scratchpad or memory directory): may
    // not exist yet on first write, resolved once before the per-segment walk.
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
 * refusing `..` that would climb out, any `.git` segment, dangling symlinks,
 * and any symlink whose real target leaves `root` or enters `.git`. Symlinks
 * whose canonical target stays cleanly inside `root` (e.g. monorepo workspace
 * links) are followed by resetting the walk cursor to the resolved in-root
 * path (D9b).
 */
function walkWritePath(relativePath: string, root: string): WritePathViolation | undefined {
  const canonicalRoot = resolveExistingPath(root);
  const rootPrefix = canonicalRoot === "/" ? "/" : `${canonicalRoot}/`;
  const normalized: string[] = [];
  let followedSymlink = false;
  for (const segment of relativePath.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      // Once a symlink has been followed, the kernel resolves `..` from the
      // symlink's real target while Write/Edit tools normalize `..` lexically
      // (which can escape `root` when the symlink target is deeper than the
      // link, e.g. pnpm's `node_modules/foo -> .pnpm/.../node_modules/foo`).
      // Refuse any `..` after a symlink segment so lexical and kernel views can
      // never diverge.
      if (followedSymlink || normalized.length === 0) return "outside-cwd";
      normalized.pop();
      continue;
    }
    if (segment.toLowerCase() === ".git") return "git-metadata";
    const candidate = join(canonicalRoot, ...normalized, segment);
    try {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) {
        let target: string;
        try { target = realpathSync.native(candidate); }
        catch { return "git-metadata"; }
        if (target.replaceAll("\\", "/").split("/").some((part) => part.toLowerCase() === ".git")) return "git-metadata";
        if (target !== canonicalRoot && !target.startsWith(rootPrefix)) return "outside-cwd";
        const rel = target === canonicalRoot ? "" : target.slice(rootPrefix.length);
        normalized.length = 0;
        if (rel) normalized.push(...rel.split("/").filter(Boolean));
        followedSymlink = true;
        continue;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return "git-metadata";
    }
    normalized.push(segment);
  }
  const absolute = join(canonicalRoot, ...normalized);
  // Defense-in-depth: confirm the deepest existing ancestor of `absolute`
  // resolves within `root` (and contains no `.git` segment).
  const resolvedAncestor = resolveExistingPath(absolute);
  if (resolvedAncestor !== canonicalRoot && !resolvedAncestor.startsWith(rootPrefix)) return "outside-cwd";
  if (resolvedAncestor.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git")) return "git-metadata";
  try {
    const info = statSync(absolute);
    // A regular file with multiple links may be an alias for a Git ref or
    // other metadata file even when its pathname contains no `.git` segment.
    if (info.isFile() && info.nlink > 1) return "git-metadata";
    const resolved = realpathSync.native(absolute);
    if (resolved !== canonicalRoot && !resolved.startsWith(rootPrefix)) return "outside-cwd";
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
  /** True when the token originated from a quoted heredoc body (`<<'EOF'`), which never undergoes shell substitution. */
  heredoc?: boolean;
  /** True when the token contained any single- or double-quoted segment in the original command. */
  quoted?: boolean;
  /** Number of unquoted, unescaped leading `(` subshell openers (excluding `((`). */
  leadingOpenParens?: number;
  /** Number of unquoted, unescaped trailing `)` subshell closers (excluding `)` that close `$(…)` / `))`). */
  trailingCloseParens?: number;
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

export function evaluateCommand(command: string, args: readonly string[] = [], grant?: RemoteGrant, cwd?: string): PolicyResult {
  const normalized = command.trim();
  if (!normalized) return { decision: "deny", reason: "empty command" };
  const lexical = lexShell(normalized);
  if (lexical.error) return { decision: "deny", reason: `command could not be safely parsed: ${lexical.error}` };
  const literalArgs = args.map((value) => ({ value, operator: false, dynamic: false }));
  return evaluateTokens([...lexical.tokens, ...literalArgs], 0, new Map(), grant, cwd);
}

// Scoped to one permission check. The conservative shell scan encounters the
// same suffix at many nesting levels; re-evaluating it makes a short command
// take seconds. Depth remains part of the key because it bounds recursion.
type NestedCommandCache = Map<string, PolicyResult>;

/**
 * Strict allowlist of non-executing inspection commands permitted in an
 * all-allowlisted command for subtractive boundary scanning. Excludes `echo`,
 * `printf`, pagers/editors (`view`, `less`, `more`, `bat`), `sort`, `diff`,
 * `tee` and `jq`.
 */
const STRICT_INSPECTION_COMMANDS = new Set([
  "grep", "egrep", "fgrep", "rg", "head", "tail", "wc", "cat", "cut", "tr", "uniq", "nl", "ls", "stat",
]);
/** Known non-executing `rg` flags (allowlist; excludes `--pre`, `--hostname-bin`, `-z`, `--search-zip`, etc.). */
const RG_SAFE_LONG_FLAGS = new Set([
  "--line-number", "--no-line-number", "--ignore-case", "--case-sensitive", "--smart-case",
  "--files-with-matches", "--files-without-match", "--count", "--count-matches",
  "--word-regexp", "--fixed-strings", "--invert-match", "--only-matching",
  "--hidden", "--no-ignore", "--no-heading", "--with-filename", "--no-filename",
  "--quiet", "--no-messages", "--glob", "--iglob", "--type", "--type-not",
  "--max-count", "--regexp", "--after-context", "--before-context", "--context",
  "--color", "--multiline", "--files",
]);
const RG_SAFE_SHORT_CHARS = new Set([..."nilcwFSUvHovqsrmgeABCtT"]);
/** Git subcommands that only read repository state; their literal args cannot push, merge or mutate remotes. */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "blame", "describe",
  "cat-file", "merge-base", "merge-tree", "shortlog", "whatchanged", "name-rev",
  "check-ignore", "check-attr", "ls-tree", "diff-tree", "diff-index", "diff-files",
  "for-each-ref", "show-ref",
]);
const GIT_MERGE_CONTROL_FLAGS = new Set(["--abort", "--continue", "--quit"]);
const GIT_MERGE_VALUE_OPTIONS = new Set(["-m", "--message", "-s", "--strategy", "-X", "--strategy-option", "--cleanup"]);
const GIT_MERGE_SAFE_FLAGS = new Set([
  "--no-ff", "--ff", "--ff-only", "--squash", "--no-squash", "--commit", "--no-commit",
  "--no-edit", "-q", "--quiet", "-v", "--verbose", "--stat", "-n", "--no-stat",
  "--log", "--no-log", "--rerere-autoupdate", "--no-rerere-autoupdate",
  "--allow-unrelated-histories", "--no-verify",
]);
const SHELL_META_CHARS = /[()`${}]/u;

interface ScanSegment {
  tokens: ShellToken[];
  nextOperator?: string;
}

function scanSegmentsOf(tokens: readonly ShellToken[]): ScanSegment[] {
  const segments: ScanSegment[] = [];
  let current: ShellToken[] = [];
  for (const token of tokens) {
    if (token.operator && SEGMENT_SPLIT_OPERATORS.has(token.value)) {
      if (current.length > 0) segments.push({ tokens: current, nextOperator: token.value });
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push({ tokens: current });
  return segments;
}

function hasDisallowedGlobalScanToken(tokens: readonly ShellToken[]): boolean {
  for (const token of tokens) {
    if (token.operator) {
      // Any redirection operator (`>`, `>>`, `<`, `<<`, `<<<`, `>|`, `&>`, `>&`) disables stripping for the whole command.
      if (!SEGMENT_SPLIT_OPERATORS.has(token.value)) return true;
      continue;
    }
    if (token.dynamic || token.data) return true;
    if (SHELL_META_CHARS.test(token.value)) return true;
  }
  return false;
}

function isSafeRgArgs(args: readonly ShellToken[]): boolean {
  for (const token of args) {
    const value = token.value;
    if (value === "--" || value === "-" || !value.startsWith("-")) continue;
    if (value.startsWith("--")) {
      const flag = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
      if (!RG_SAFE_LONG_FLAGS.has(flag)) return false;
      continue;
    }
    // Short option cluster (e.g. `-rn`, `-in`, `-C3`).
    const chars = value.slice(1);
    if (!chars) return false;
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]!;
      if (!RG_SAFE_SHORT_CHARS.has(ch)) return false;
      // Short flags that take an inline numeric/string value (`-m5`, `-A2`, `-ePAT`, `-g*.ts`).
      if ("ABCmgteT".includes(ch)) break;
    }
  }
  return true;
}

function hasEditFlag(args: readonly ShellToken[]): boolean {
  for (const token of args) {
    const value = token.value;
    if (value === "--") break;
    if (value === "-e" || value === "-c") return true;
    if (value.startsWith("--")) {
      const flag = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
      // Git accepts any unambiguous prefix of `--edit` or `--reedit-message` (e.g. `--e`, `--ed`, `--edi`, `--reedit`).
      if (flag.length >= 3 && ("--edit".startsWith(flag) || "--reedit-message".startsWith(flag))) return true;
      continue;
    }
    // Combined short option cluster containing `e` or `c` (stop before `-m` payload in `-amfoo`).
    if (value.startsWith("-") && value.length > 2) {
      const beforeMsg = value.includes("m") ? value.slice(1, value.indexOf("m")) : value.slice(1);
      if (beforeMsg.includes("e") || beforeMsg.includes("c")) return true;
    }
  }
  return false;
}

/**
 * Open and read a small regular file without blocking on FIFOs/devices or
 * following symlinks. Returns undefined on missing, non-regular, oversized or
 * unreadable files so callers can fail closed.
 */
function readSmallRegularFile(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    fd = openSync(path, flags);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readGitDirs(directory: string): { gitDir: string; commonDir: string } | undefined {
  const top = gitTopLevel(directory);
  if (!top) return undefined;
  const dotGit = join(top, ".git");
  try {
    const stat = lstatSync(dotGit);
    if (stat.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    if (!stat.isFile()) return undefined;
    const pointer = readSmallRegularFile(dotGit, 4096);
    if (pointer === undefined) return undefined;
    const match = /^gitdir:\s*(.+)$/im.exec(pointer);
    if (!match?.[1]) return undefined;
    const rawGitDir = match[1].trim();
    const gitDir = isAbsolute(rawGitDir) ? resolve(rawGitDir) : resolve(top, rawGitDir);
    let commonDir = gitDir;
    const commonFile = join(gitDir, "commondir");
    if (existsSync(commonFile)) {
      const rawCommon = readSmallRegularFile(commonFile, 4096)?.trim();
      if (rawCommon === undefined) return undefined;
      if (rawCommon) commonDir = isAbsolute(rawCommon) ? resolve(rawCommon) : resolve(gitDir, rawCommon);
    }
    return { gitDir, commonDir };
  } catch {
    return undefined;
  }
}

function readCurrentGitBranch(directory: string): string | undefined {
  const dirs = readGitDirs(directory);
  if (!dirs) return undefined;
  const head = readSmallRegularFile(join(dirs.gitDir, "HEAD"), 4096)?.trim();
  if (!head) return undefined;
  const match = /^ref:\s*refs\/heads\/(.+)$/u.exec(head);
  return match?.[1]?.trim() || undefined;
}

function hasRemoteNamed(name: string, commonDir: string): boolean {
  if (name === "origin" || name === "upstream") return true;
  if (existsSync(join(commonDir, "refs", "remotes", name))) return true;
  const packed = join(commonDir, "packed-refs");
  if (existsSync(packed)) {
    const content = readSmallRegularFile(packed, 2 * 1024 * 1024);
    if (content === undefined) return true; // FIFO, symlink, oversized or unreadable -> fail closed.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(` refs/remotes/${escaped}/`, "u").test(content)) return true;
  }
  return false;
}

function isRemoteTrackingRef(ref: string, commonDir: string): boolean {
  if (/^(?:refs\/)?remotes\//iu.test(ref)) return true;
  const slash = ref.indexOf("/");
  if (slash <= 0) return hasRemoteNamed(ref, commonDir);
  return hasRemoteNamed(ref.slice(0, slash), commonDir);
}

function isSafeMergeControl(words: readonly ShellToken[], subIndex: number): boolean {
  const args = words.slice(subIndex + 1);
  if (args.length === 0) return false;
  let sawControl = false;
  for (const token of args) {
    if (GIT_MERGE_CONTROL_FLAGS.has(token.value)) { sawControl = true; continue; }
    if (["-q", "--quiet", "-v", "--verbose"].includes(token.value)) continue;
    return false;
  }
  return sawControl;
}

/**
 * #55-2: allow a local non-protected branch merge ONLY under strict, TOCTOU-free
 * conditions:
 * - `cwd` is provided;
 * - the merge is the sole statement in the command;
 * - no leading environment assignments, redirections, dynamic/meta tokens or git global options (`subIndex === 1`);
 * - no `--edit`/`-e` flag;
 * - HEAD is an attached non-protected branch, and every source is a literal
 *   local non-protected branch (not `-`, not a remote or remote-tracking ref,
 *   no rev syntax `^`/`~`/`..`/`:`/`@{`, stripping `refs/heads/` and `heads/`).
 */
function isAllowedLocalMerge(words: readonly ShellToken[], totalSegments: number, cwd: string | undefined): boolean {
  if (cwd === undefined || totalSegments !== 1) return false;
  const dirs = readGitDirs(cwd);
  if (!dirs) return false;
  const targetBranch = readCurrentGitBranch(cwd);
  if (!targetBranch || isProtectedBranch(targetBranch)) return false;

  const args = words.slice(2);
  const sources: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]!.value;
    if (options && value === "--") { options = false; continue; }
    if (options && value.startsWith("-")) {
      if (value === "-") return false;
      if (GIT_MERGE_VALUE_OPTIONS.has(value)) {
        if (i + 1 >= args.length) return false;
        i += 1;
        continue;
      }
      if (GIT_MERGE_SAFE_FLAGS.has(value)) continue;
      if (/^--(?:message|strategy|strategy-option|cleanup|log)=/u.test(value)) continue;
      if (/^-m./u.test(value)) continue;
      return false;
    }
    sources.push(value);
  }
  if (sources.length === 0) return false;
  for (const source of sources) {
    if (!source || source === "-" || /[:^~]|@\{|\.\./u.test(source)) return false;
    if (["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD"].includes(source)) return false;
    if (isRemoteTrackingRef(source, dirs.commonDir)) return false;
    const normalized = source.replace(/^(?:refs\/)?heads\//u, "");
    if (!normalized || isProtectedBranch(normalized)) return false;
  }
  return true;
}

function collectMessageDropTokens(args: readonly ShellToken[], dropSet: Set<ShellToken>): void {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token.value === "--") break;
    if (token.value === "-m" || token.value === "--message") {
      const next = args[i + 1];
      if (next) { dropSet.add(next); i += 1; }
      continue;
    }
    if (token.value.startsWith("--message=") || /^-m./u.test(token.value)) {
      dropSet.add(token);
    }
  }
}

/**
 * Strict fail-closed allowlist check for a single segment. Returns the exact
 * set of harmless literal tokens to drop from this segment, or `undefined` if
 * the segment is NOT an allowlisted shape (which disables stripping for the
 * ENTIRE command).
 */
function allowlistedSegmentDrops(segment: readonly ShellToken[], totalSegments: number, cwd: string | undefined): Set<ShellToken> | undefined {
  if (segment.length === 0) return undefined;
  const head = segment[0]!;
  // Reject leading env assignments (`NAME=val`), path-qualified binaries (`./cat`, `/bin/cat`), and shell keywords.
  if (/[\\/=]/u.test(head.value)) return undefined;
  const name = head.value.toLowerCase();
  const args = segment.slice(1);
  const dropSet = new Set<ShellToken>();

  // Shape A: strictly non-executing inspection command (with flag allowlist for `rg`).
  if (STRICT_INSPECTION_COMMANDS.has(name)) {
    if (name === "rg" && !isSafeRgArgs(args)) return undefined;
    for (const token of args) dropSet.add(token);
    return dropSet;
  }

  // Shapes B–F: bare `git` with NO global options before the subcommand (`segment[1]` is the subcommand).
  if (name !== "git" || segment.length < 2) return undefined;
  const subToken = segment[1]!;
  if (subToken.value.startsWith("-")) return undefined;
  const sub = subToken.value.toLowerCase();
  const subArgs = segment.slice(2);

  // Shape B: read-only git subcommand without external diff/textconv driver flags.
  if (GIT_READ_ONLY_SUBCOMMANDS.has(sub)) {
    if (subArgs.some((token) => GIT_DRIVER_FLAGS.test(token.value))) return undefined;
    for (const token of subArgs) dropSet.add(token);
    return dropSet;
  }

  // Shape C: `git commit` / `git tag` with `-m`/`--message` and no editor invocation.
  if (sub === "commit" || sub === "tag") {
    if (hasEditFlag(subArgs)) return undefined;
    collectMessageDropTokens(subArgs, dropSet);
    return dropSet;
  }

  // Shape D: `git stash push` (and optional `-m`/`--message`) without editor invocation.
  if (sub === "stash") {
    if (hasEditFlag(subArgs)) return undefined;
    const actionToken = subArgs.find((token) => !token.value.startsWith("-"));
    if (actionToken && actionToken.value.toLowerCase() === "push") {
      dropSet.add(actionToken);
      collectMessageDropTokens(subArgs, dropSet);
      return dropSet;
    }
    return undefined;
  }

  // Shapes E & F: `git merge --abort|--continue|--quit` OR single-statement local non-protected merge (#55-2).
  if (sub === "merge") {
    if (isSafeMergeControl(segment, 1)) {
      dropSet.add(subToken);
      return dropSet;
    }
    if (isAllowedLocalMerge(segment, totalSegments, cwd)) {
      dropSet.add(subToken);
      collectMessageDropTokens(subArgs, dropSet);
      return dropSet;
    }
    return undefined;
  }

  return undefined;
}

/**
 * Fail-closed allowlist subtractive scan: if ANY token in the command is
 * dynamic, a redirection, or a shell meta-character (`()\`${}`), OR if ANY
 * statement in the command falls outside the strict allowlist of harmless
 * shapes, return the original token list completely unstripped.
 */
function sanitizeTokensForBoundaryScan(tokens: readonly ShellToken[], cwd?: string): ShellToken[] {
  if (hasDisallowedGlobalScanToken(tokens)) return [...tokens];
  const segments = scanSegmentsOf(tokens);
  if (segments.length === 0) return [...tokens];
  const segmentDrops: Set<ShellToken>[] = [];
  for (const segment of segments) {
    const drops = allowlistedSegmentDrops(segment.tokens, segments.length, cwd);
    if (!drops) return [...tokens];
    segmentDrops.push(drops);
  }
  const output: ShellToken[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const drops = segmentDrops[i]!;
    for (const token of segment.tokens) {
      if (!drops.has(token)) output.push(token);
    }
    if (segment.nextOperator) output.push({ value: segment.nextOperator, operator: true, dynamic: false });
  }
  return output;
}

function evaluateRepositoryBoundary(tokens: readonly ShellToken[], canonical: string, scanTokens: readonly ShellToken[], scanCanonical: string, depth: number, cache: NestedCommandCache, grant?: RemoteGrant): PolicyResult | undefined {
  // A publish grant admits exactly one shape; everything else still falls
  // through to the ordinary boundary denials below.
  if (grant) {
    const permitted = permittedRemoteCommand(tokens, grant);
    if (permitted) return permitted;
  }
  const values = tokens.filter((token) => !token.operator).map((token) => token.value);
  const lower = values.map((value) => value.toLowerCase());
  const scanValues = scanTokens.filter((token) => !token.operator).map((token) => token.value);
  const scanLower = scanValues.map((value) => value.toLowerCase());
  const hasGit = values.some((value) => /(?:^|[\\/])git$/iu.test(value) || /^(?:git-(?:send|receive|upload)-pack)$/iu.test(value));
  const scanHasGit = scanValues.some((value) => /(?:^|[\\/])git$/iu.test(value) || /^(?:git-(?:send|receive|upload)-pack)$/iu.test(value));
  const hasGitTransport = scanLower.some((value) => /^(?:git-(?:send|receive|upload)-pack)$/u.test(value));
  const hasRemoteOperation = scanLower.some((value) => remoteOperations.has(value));
  const hasGhRemote = containsRemoteCliMutation(scanCanonical);
  const hasPackagePublication = scanLower.some((value) => value === "npm" || value === "pnpm" || value === "yarn") && scanLower.includes("publish");
  const hasGitAliasConfiguration = hasGit && lower.some((value) => /^alias\.[^=]*(?:=|$)/u.test(value));
  if (depth < 4) {
    for (const nested of nestedShellCommands(lower, values)) {
      const nestedResult = evaluateCommandInternal(nested, depth + 1, cache);
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
  if (/\bgit\b[\s\S]*\b(?:push|merge(?!-)|send-pack|receive-pack|update-ref)\b/iu.test(scanCanonical)
    || /\bgit-(?:send|receive|upload)-pack\b/iu.test(scanCanonical)
    || containsRemoteCliMutation(scanCanonical)) {
    return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority", boundary: "remote" };
  }
  if (scanHasGit && (hasRemoteOperation || hasGitTransport) || hasGhRemote) {
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
  const directRefWrite = tokens.some((token) => token.operator && OUTPUT_REDIRECT_OPERATORS.has(token.value))
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
/** Pure shell syntax keywords that introduce a command without executing anything themselves. */
const SHELL_SYNTAX_PREFIX_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "(", "{"]);
/** Strictly read-only git subcommands whose dynamic arguments after the subcommand cannot mutate refs or reach remotes (D5). */
const D5_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "blame",
  "describe", "cat-file", "merge-base", "shortlog", "ls-tree", "name-rev", "check-ignore", "for-each-ref",
]);
const D5_GIT_BRANCH_READ_ONLY_FLAGS = new Set(["--list", "-l", "--contains", "--merged", "--no-merged", "--show-current"]);
const D5_GIT_BRANCH_ALLOWED_FLAGS = new Set(["--list", "-l", "--contains", "--merged", "--no-merged", "--show-current", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--no-color", "--color", "--sort", "--format", "--points-at", "--abbrev", "--no-abbrev", "--column", "--no-column", "-i", "--ignore-case"]);
const D5_GIT_TAG_READ_ONLY_FLAGS = new Set(["-l", "--list", "--contains", "--merged", "--no-merged"]);
const D5_GIT_TAG_ALLOWED_FLAGS = new Set(["-l", "--list", "--contains", "--merged", "--no-merged", "-n", "--sort", "--format", "--points-at", "--no-color", "--color", "-i", "--ignore-case"]);
const D5_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const D5_PACKAGE_ALLOWED_SUBCOMMANDS = new Set(["test", "run", "exec", "lint", "build", "check", "typecheck", "ls", "list"]);
const D5_PACKAGE_RUNNER_SUBCOMMANDS = new Set(["run", "exec"]);
const D5_PNPM_PRE_BOOL_FLAGS = new Set(["-r", "--recursive", "-w", "--workspace-root", "-s", "--silent"]);
const D5_NPM_PRE_BOOL_FLAGS = new Set(["-s", "--silent"]);
const D5_YARN_PRE_BOOL_FLAGS = new Set(["-s", "--silent"]);
/** Text/read-only commands that do not execute their positional arguments as commands. */
const D5_TEXT_ONLY_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ls", "stat", "file",
  "wc", "diff", "md5sum", "sha1sum", "sha256sum", "echo", "printf", "uniq",
  "cut", "tr", "nl", "tac", "rev", "column", "fold", "paste", "comm", "cmp", "od", "hexdump", "xxd",
  "base64", "jq", "yq", "tee",
]);
/** Container CLIs where an inner `sh -c` argument is routine; still denies if git/remote/publish/network words appear. */
const D5_CONTAINER_COMMANDS = new Set(["docker", "podman"]);
const D5_CONTAINER_FORBIDDEN_WORDS = new Set(["git", "gh", "glab", "hub", "npm", "pnpm", "yarn", "npx", "curl", "wget", "ssh", "scp", "rsync", "sftp", "claude"]);

/** True when `value` contains only filename glob metacharacters (`*`, `?`, `[...]`) and no shell variable, substitution, tilde, or brace expansion. */
function isPureFilenameGlob(value: string): boolean {
  return /[*?[]/u.test(value) && !/[$`~{}()]/u.test(value);
}

/**
 * Unwrap a transparent timing/nohup wrapper (`timeout`, `time`, `nohup`) in
 * command position ONLY when all wrapper flags/duration are literal. Returns
 * the wrapped argv slice, `"dynamic"` if the wrapper's own args are dynamic or
 * malformed, or `undefined` if `argv[0]` is not an unwrappable wrapper.
 */
function unwrapDynamicSafeWrapper(argv: readonly ShellToken[]): readonly ShellToken[] | "dynamic" | undefined {
  const head = argv[0]?.value.split(/[\\/]/u).at(-1)?.toLowerCase();
  if (!head) return undefined;
  if (head === "time" || head === "nohup") {
    let idx = 1;
    while (idx < argv.length && argv[idx]!.value.startsWith("-")) {
      if (argv[idx]!.dynamic) return "dynamic";
      idx += 1;
    }
    return idx < argv.length ? argv.slice(idx) : "dynamic";
  }
  if (head === "timeout") {
    let idx = 1;
    while (idx < argv.length && argv[idx]!.value.startsWith("-")) {
      const flag = argv[idx]!.value;
      if (argv[idx]!.dynamic) return "dynamic";
      if (flag !== "--foreground" && flag !== "--preserve-status") return "dynamic";
      idx += 1;
    }
    if (idx >= argv.length || argv[idx]!.dynamic || !/^\d+(?:\.\d+)?[smhd]?$/u.test(argv[idx]!.value)) return "dynamic";
    idx += 1;
    return idx < argv.length ? argv.slice(idx) : "dynamic";
  }
  return undefined;
}

/** True when a git command in command position is strictly read-only with all global options and the subcommand itself literal. */
function isReadOnlyGitDynamicSafe(argv: readonly ShellToken[]): boolean {
  const values = argv.map((t) => t.value);
  const subIndex = gitSubcommandIndex(values);
  if (subIndex < 0) return false;
  // Any dynamic token before or at the subcommand (e.g. `git $SUB`, `git -C $DIR status`, `git -c $OPT status`) is refused.
  if (argv.slice(0, subIndex + 1).some((token) => token.dynamic)) return false;
  const sub = values[subIndex]!.toLowerCase();
  const rest = argv.slice(subIndex + 1);
  // Reject driver/output relocation flags even on read-only subcommands.
  if (rest.some((t) => GIT_DRIVER_FLAGS.test(t.value) || t.value === "-o" || t.value.startsWith("--output"))) return false;
  if (D5_READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return true;
  if (sub === "branch") {
    const flags = rest.filter((t) => t.value.startsWith("-")).map((t) => t.value.split("=")[0]!);
    const hasReadOnlyFlag = flags.some((f) => D5_GIT_BRANCH_READ_ONLY_FLAGS.has(f));
    const allSafeFlags = flags.every((f) => D5_GIT_BRANCH_ALLOWED_FLAGS.has(f));
    return hasReadOnlyFlag && allSafeFlags;
  }
  if (sub === "tag") {
    const flags = rest.filter((t) => t.value.startsWith("-")).map((t) => t.value.split("=")[0]!);
    const hasReadOnlyFlag = flags.some((f) => D5_GIT_TAG_READ_ONLY_FLAGS.has(f));
    const allSafeFlags = flags.every((f) => D5_GIT_TAG_ALLOWED_FLAGS.has(f) || /^-n\d*$/u.test(f));
    return hasReadOnlyFlag && allSafeFlags;
  }
  return false;
}

/**
 * True when a non-publish npm/pnpm/yarn command uses only allowlisted
 * pre-subcommand flags, an allowlisted non-publish subcommand, a safe literal
 * target (for `run`/`exec`, recursively checked against `hasDynamicSensitiveArgument`
 * so `pnpm exec git pu*` stays denied), and ONLY pure filename glob dynamic args.
 */
function isPackageManagerGlobOnlySafe(argv: readonly ShellToken[], depth: number): boolean {
  const values = argv.map((t) => t.value);
  const lower = values.map((v) => v.toLowerCase());
  const pkgManager = lower[0]!.split(/[\\/]/u).at(-1) ?? lower[0]!;
  if (lower.includes("publish")) return false;
  // Strictly allowlist pre-subcommand flags per package manager so value flags
  // (`npm -w <ws>`, `-C .`, `--prefix .`) can never shift a value into
  // subcommand position.
  let subIndex = -1;
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i]!;
    if (tok.dynamic) return false;
    if (pkgManager === "pnpm") {
      if (tok.value === "--filter" || tok.value === "-F") {
        if (i + 1 >= argv.length || argv[i + 1]!.dynamic) return false;
        i += 1;
        continue;
      }
      if (tok.value.startsWith("--filter=") || tok.value.startsWith("-F=")) continue;
      if (D5_PNPM_PRE_BOOL_FLAGS.has(tok.value)) continue;
    } else if (pkgManager === "npm") {
      if (tok.value === "-w" || tok.value === "--workspace") {
        if (i + 1 >= argv.length || argv[i + 1]!.dynamic) return false;
        i += 1;
        continue;
      }
      if (tok.value.startsWith("--workspace=")) continue;
      if (D5_NPM_PRE_BOOL_FLAGS.has(tok.value)) continue;
    } else if (pkgManager === "yarn") {
      if (D5_YARN_PRE_BOOL_FLAGS.has(tok.value)) continue;
    }
    if (tok.value.startsWith("-")) return false;
    subIndex = i;
    break;
  }
  if (subIndex < 0) return false;
  const sub = lower[subIndex]!;
  if (!D5_PACKAGE_ALLOWED_SUBCOMMANDS.has(sub)) return false;
  // Every dynamic token after the subcommand must be a pure filename glob.
  if (!argv.slice(subIndex + 1).every((tok) => !tok.dynamic || isPureFilenameGlob(tok.value))) return false;
  // For `run`/`exec`, the target script/binary MUST be literal and its own argv
  // must pass the full dynamic-sensitive check (so `pnpm exec git pu*` denies).
  if (D5_PACKAGE_RUNNER_SUBCOMMANDS.has(sub)) {
    let targetIndex = subIndex + 1;
    while (targetIndex < argv.length && argv[targetIndex]!.value.startsWith("-")) {
      if (argv[targetIndex]!.dynamic) return false;
      targetIndex += 1;
    }
    if (targetIndex >= argv.length || argv[targetIndex]!.dynamic) return false;
    if (sub === "exec") {
      if (depth >= 4) return false;
      if (hasDynamicSensitiveArgument(argv.slice(targetIndex), depth + 1)) return false;
    } else if (argv.slice(targetIndex + 1).some((tok) => {
      const base = tok.value.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
      return DYNAMIC_SENSITIVE_COMMANDS.has(base);
    })) {
      return false;
    }
  }
  return true;
}

/**
 * True when one statement combines a dynamic word with a command whose dynamic
 * argument could reach the boundary (D5 fail-closed design: keep the original
 * anywhere-in-statement sensitive-command deny as the default, and exempt ONLY
 * statements whose command-position executable is explicitly proven safe:
 *   1. text/read-only commands that never execute their args (`grep`, `echo`, …),
 *   2. container CLIs (`docker`/`podman`) containing no git/remote/network words,
 *   3. strictly read-only `git` subcommands with literal global flags/subcommand,
 *   4. allowlisted non-publish `npm`/`pnpm`/`yarn` commands with pure filename globs,
 *   after optionally unwrapping literal `timeout`/`time`/`nohup`).
 */
function hasDynamicSensitiveArgument(segment: readonly ShellToken[], depth = 0): boolean {
  if (depth > 4) return true;
  // A leading `NAME=value` prefix sets the environment and a redirection
  // target names a file; neither reaches the command's argv, so
  // `npm_config_cache=$TMPDIR/x npm run check` and `git show HEAD:f > $OLD/f`
  // are literal commands.
  const words: ShellToken[] = [];
  let afterRedirect = false;
  for (const token of segment) {
    if (token.operator) { afterRedirect = REDIRECT_OPERATORS.has(token.value) || token.value === "<<<"; continue; }
    if (!afterRedirect && !token.data) words.push(token);
    afterRedirect = false;
  }
  let argvStart = 0;
  while (argvStart < words.length) {
    const raw = words[argvStart]!.value;
    const stripped = raw.toLowerCase().replace(/^\(+/u, "") || "(";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(raw)) { argvStart += 1; continue; }
    if (!words[argvStart]!.dynamic && SHELL_SYNTAX_PREFIX_KEYWORDS.has(stripped)) { argvStart += 1; continue; }
    break;
  }
  let argv: readonly ShellToken[] = words.slice(argvStart);
  if (argv.length === 0 || !argv.some((token) => token.dynamic)) return false;

  // Unwrap transparent wrappers (`timeout`, `time`, `nohup`) up to 4 levels.
  for (let unwrapDepth = 0; unwrapDepth < 4; unwrapDepth += 1) {
    if (argv[0]!.dynamic) return true;
    const unwrapped = unwrapDynamicSafeWrapper(argv);
    if (unwrapped === undefined) break;
    if (unwrapped === "dynamic") return true;
    argv = unwrapped;
    let innerStart = 0;
    while (innerStart < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[innerStart]!.value)) innerStart += 1;
    argv = argv.slice(innerStart);
    if (argv.length === 0 || !argv.some((token) => token.dynamic)) return false;
  }

  if (argv[0]!.dynamic) return true;
  const cmd = argv[0]!.value.replace(/^\(+/u, "").split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  const values = argv.map((t) => t.value);
  const lower = values.map((v) => v.toLowerCase());
  const executables = lower.map((v) => v.split(/[\\/]/u).at(-1) ?? v);
  const canonical = values.join(" ");

  if (containsRemoteCliMutation(canonical)) return true;
  if (values.some((v) => /^git-(?:send|receive|upload)-pack$/iu.test(v))) return true;

  // Explicit safe exemptions (everything else falls through to fail-closed anywhere-in-statement check):
  if (D5_TEXT_ONLY_COMMANDS.has(cmd)) {
    if (cmd === "rg" && argv.some((t) => t.value.startsWith("--pre") || t.value === "-z" || t.value === "--search-zip" || /^-[A-Za-z]*z/u.test(t.value))) {
      return true;
    }
    return false;
  }
  if (D5_CONTAINER_COMMANDS.has(cmd)) {
    return executables.some((exe) => D5_CONTAINER_FORBIDDEN_WORDS.has(exe));
  }
  if (cmd === "git") return !isReadOnlyGitDynamicSafe(argv);
  if (D5_PACKAGE_MANAGERS.has(cmd)) return !isPackageManagerGlobOnlySafe(argv, depth);

  // Fail-closed default: catches `case`, `coproc`, `f()`, `linux64`, `uv run`,
  // `sudo`, `env`, `sh`, `xargs`, `find -exec`, and any unknown wrapper that
  // contains a sensitive command word anywhere in the statement.
  return values.some((value) => /(?:^|[\\/])git$/iu.test(value))
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

function evaluateCommandInternal(command: string, depth: number, cache: NestedCommandCache): PolicyResult {
  const normalized = command.trim();
  const key = `${depth}:${normalized}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const lexical = lexShell(normalized);
  const result: PolicyResult = lexical.error
    ? { decision: "deny", reason: `command could not be safely parsed: ${lexical.error}` }
    : evaluateTokens(lexical.tokens, depth, cache);
  cache.set(key, result);
  return result;
}

function evaluateTokens(rawTokens: readonly ShellToken[], depth: number, cache: NestedCommandCache, grant?: RemoteGrant, cwd?: string): PolicyResult {
  const { tokens: dataResolved, embedded } = resolveDataTokens(rawTokens);
  const tokens = resolveLiteralBindings(dataResolved);
  if (depth < 4) {
    for (const body of embedded) {
      // Never with the grant: a nested result is consulted only when it denies,
      // so a grant here could only suppress a denial -- a heredoc-wrapped push
      // would pass while the direct form is the only shape that was reviewed.
      const nestedResult = evaluateCommandInternal(body, depth + 1, cache);
      if (nestedResult.decision === "deny") return nestedResult;
    }
  }
  const canonical = tokens.map((token) => token.value).join(" ").trim();
  if (!canonical) return { decision: "deny", reason: "empty command" };
  const scanTokens = sanitizeTokensForBoundaryScan(tokens, cwd);
  const scanCanonical = scanTokens.map((token) => token.value).join(" ").trim();
  const boundary = evaluateRepositoryBoundary(tokens, canonical, scanTokens, scanCanonical, depth, cache, grant);
  if (boundary) return boundary;
  if (containsRemoteHttpMutation(scanCanonical)) {
    return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority" };
  }
  if (deniedPatterns.some((pattern) => pattern.test(scanCanonical))) {
    if (/\b(?:curl|wget)\b[\s\S]*(?:github|gitlab|bitbucket|registry\.npmjs)\b/iu.test(scanCanonical)) {
      return { decision: "deny", reason: "Worker has no remote repository or main/integration merge authority" };
    }
    if (/\bgit\b[\s\S]*\b(?:reset|update-ref|symbolic-ref)\b[\s\S]*\b(?:main|master|trunk|integration|develop)\b/iu.test(scanCanonical)
      || /\bgit\b[\s\S]*\bbranch\b[\s\S]*(?:^|\s)(?:-d|-m|-f|--force|--delete|--move)\b[\s\S]*\b(?:main|master|trunk|integration|develop)\b/iu.test(scanCanonical)) {
      return { decision: "deny", reason: "Worker cannot rewrite or delete a protected integration branch" };
    }
    if (/\b(?:npm|pnpm|yarn)\b(?:\s+-\S+)*\s+publish\b/iu.test(scanCanonical)) {
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
function resolveDataTokens(tokens: readonly ShellToken[]): { tokens: ShellToken[]; embedded: string[]; embeddedBySegment: Map<number, string[]> } {
  if (!tokens.some((token) => token.data)) return { tokens: [...tokens], embedded: [], embeddedBySegment: new Map() };
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
  const embeddedBySegment = new Map<number, string[]>();
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
      if (segments[cursor]!.joiner !== "|" && segments[cursor]!.joiner !== "|&") break;
    }
    const shellConsumer = consumers.some((consumer) => SHELL_NAMES.has(consumer.name) || consumer.name === "eval" || consumer.name === "source" || consumer.name === ".");
    const sinkOnly = consumers.length > 0 && consumers.every((consumer) => DATA_SINK_COMMANDS.has(consumer.name) || (consumer.name === "git" && consumer.words.includes("commit")));
    if (shellConsumer) {
      const bodyTexts = bodies.map((token) => token.value);
      embedded.push(...bodyTexts);
      embeddedBySegment.set(index, [...(embeddedBySegment.get(index) ?? []), ...bodyTexts]);
    }
    const kept = shellConsumer || sinkOnly ? segment.tokens.filter((token) => !token.data) : segment.tokens.map((token) => ({ ...token, data: false }));
    resolved.push(...kept, ...(segment.joiner ? [{ value: segment.joiner, operator: true, dynamic: false }] : []));
  });
  return { tokens: resolved, embedded, embeddedBySegment };
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
  let leadingOpenParens = 0;
  let atLeadingParen = true;
  let trailingCloseParens = 0;
  let substParenDepth = 0;
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
    // Arithmetic `((…))` is not a subshell paren opener/closer.
    const effectiveLeading = value.startsWith("((") && leadingOpenParens >= 2 ? leadingOpenParens - 2 : leadingOpenParens;
    const effectiveTrailing = value.endsWith("))") && trailingCloseParens >= 2 ? trailingCloseParens - 2 : trailingCloseParens;
    tokens.push({
      value,
      operator: false,
      dynamic,
      ...(tokenData ? { data: true } : {}),
      ...(tokenQuoted ? { quoted: true } : {}),
      ...(effectiveLeading > 0 ? { leadingOpenParens: effectiveLeading } : {}),
      ...(effectiveTrailing > 0 ? { trailingCloseParens: effectiveTrailing } : {}),
    });
    value = "";
    dynamic = false;
    started = false;
    tokenQuoted = false;
    tokenData = false;
    leadingOpenParens = 0;
    atLeadingParen = true;
    trailingCloseParens = 0;
  };
  const pushOperator = (operator: string): void => {
    flush();
    // Never reset substParenDepth while inside an open `$(…)` / `<(…)` / `>(…)`:
    // statement operators like `;` inside `$(true; true)` stay inside the substitution.
    if (substParenDepth === 0 && SEGMENT_SPLIT_OPERATORS.has(operator)) substParenDepth = 0;
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
      tokens.push(heredoc.quoted ? { value: body, operator: false, dynamic: false, data: true, heredoc: true } : { value: body, operator: false, dynamic: /[$`]/u.test(body) });
      if (!terminated) break;
    }
    return Math.min(position, input.length);
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const next = input[index + 1];
    if (quote === "single") {
      atLeadingParen = false;
      trailingCloseParens = 0;
      if (character === "'") quote = undefined;
      else value += character;
      started = true;
      continue;
    }
    if (quote === "double") {
      atLeadingParen = false;
      trailingCloseParens = 0;
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
    if (character === "'") { quote = "single"; started = true; tokenQuoted = true; atLeadingParen = false; trailingCloseParens = 0; continue; }
    if (character === '"') { quote = "double"; started = true; tokenQuoted = true; atLeadingParen = false; trailingCloseParens = 0; continue; }
    if (character === "\\") {
      atLeadingParen = false;
      trailingCloseParens = 0;
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
    if (character === "$" || character === "`") {
      atLeadingParen = false;
      trailingCloseParens = 0;
      dynamic = true;
      value += character;
      started = true;
      continue;
    }
    // Brace, tilde and pathname expansion can change command names, targets or
    // Git refs after this lexical pass. Treat all unquoted expansion markers as
    // dynamic rather than attempting to model Bash's expansion order.
    // A tilde expands only at the start of a word (or of an assignment value);
    // `HEAD~1` and `a~b` are literal text.
    if (character === "~") { atLeadingParen = false; trailingCloseParens = 0; if (value === "" || /[=:]$/u.test(value)) dynamic = true; value += character; started = true; continue; }
    if ("*?[]{}".includes(character)) { atLeadingParen = false; trailingCloseParens = 0; dynamic = true; value += character; started = true; continue; }
    if (";&|<>".includes(character)) {
      if ((character === "<" || character === ">") && next === "(") {
        // Process substitution `<(…)` / `>(…)` — track paren depth without counting its `)` as a subshell closer.
        pushOperator(character);
        substParenDepth += 1;
        value += "(";
        started = true;
        atLeadingParen = false;
        index += 1;
        continue;
      }
      if (character === "<" && next === "<") {
        const third = input[index + 2];
        if (third === "<") { pushOperator("<<<"); index += 2; continue; }
        const stripTabs = third === "-";
        pushOperator("<<");
        expectDelimiter = { stripTabs };
        index += stripTabs ? 2 : 1;
        continue;
      }
      if (character === "<" && next === ">") { pushOperator("<>"); index += 1; continue; }
      if (character === "<" && next === "&") { pushOperator("<&"); index += 1; continue; }
      if (character === ">" && next === "|") { pushOperator(">|"); index += 1; continue; }
      if (character === ">" && next === "&") { pushOperator(">&"); index += 1; continue; }
      if (character === "|" && next === "&") { pushOperator("|&"); index += 1; continue; }
      if (character === "&" && next === ">") {
        if (input[index + 2] === ">") { pushOperator("&>>"); index += 2; continue; }
        pushOperator("&>");
        index += 1;
        continue;
      }
      const operator = next && ((character === "&" && next === "&") || (character === "|" && next === "|") || (character === ">" && next === ">"))
        ? `${character}${next}`
        : character;
      pushOperator(operator);
      if (operator.length === 2) index += 1;
      continue;
    }
    if (character === "(") {
      const prevChar = index > 0 ? input[index - 1] : undefined;
      if (prevChar === "$" || substParenDepth > 0) {
        substParenDepth += 1;
        atLeadingParen = false;
      } else if (atLeadingParen) {
        leadingOpenParens += 1;
      }
      trailingCloseParens = 0;
    } else if (character === ")") {
      atLeadingParen = false;
      if (substParenDepth > 0) { substParenDepth -= 1; trailingCloseParens = 0; }
      else trailingCloseParens += 1;
    } else {
      atLeadingParen = false;
      trailingCloseParens = 0;
    }
    value += character;
    started = true;
  }
  if (quote) return { tokens, error: "unterminated quote" };
  flush();
  return { tokens };
}

const SEGMENT_SPLIT_OPERATORS = new Set(["|", "|&", "&&", "||", ";", "&"]);

/**
 * Utilities whose effects are fully visible in their static argv. Anything that
 * can run another program from an option (`xargs`, `sort --compress-program`,
 * `env`, `find -exec`, `file -C`) is either absent or has that option rejected.
 */
const ROUTINE_SHELL_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "egrep", "fgrep", "sed", "awk", "cut", "uniq", "wc", "tr",
  "find", "echo", "printf", "pwd", "which", "true", "false", "test", "[", "diff", "stat",
  "basename", "dirname", "realpath", "readlink", "date", "sleep", "timeout",
  "node", "npm", "pnpm", "tsc", "git", "make", "cargo", "go", "pytest",
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
const ROUTINE_PNPM_SUBCOMMANDS = new Set(["test", "run", "ls", "list"]);
const ROUTINE_CARGO_SUBCOMMANDS = new Set(["test", "check", "build", "clippy", "fmt", "doc", "bench", "metadata", "tree"]);
const ROUTINE_GO_SUBCOMMANDS = new Set(["test", "vet", "build", "fmt", "doc", "list", "version"]);
const ROUTINE_NODE_FLAG = /^(?:--test(?:-(?:only|name-pattern|skip-pattern|concurrency|timeout|force-exit|coverage|isolation)(?:=.*)?)?|--check|-c|--version|-v|--enable-source-maps|--no-warnings|--experimental-strip-types)$/u;
/** `timeout` is the only transparent wrapper: it runs exactly the static argv that follows its duration. */
const WRAPPER_COMMANDS = new Set(["timeout"]);
const GIT_DRIVER_FLAGS = /^--(?:ext-diff|textconv|no-textconv|exec-path)/u;
const NODE_BUILTIN_REPORTERS = new Set(["spec", "tap", "dot", "junit", "lcov"]);
const NPM_RELOCATING_FLAGS = /^(?:--prefix|-C|--dir|--store-dir|--userconfig|--globalconfig|--config|--location|-g|--global|--registry|--cache|--script-shell|--ignore-scripts)(?:=|$)/u;
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
    const verifiedPinned = (options.pinnedWriteRoots ?? [])
      .map((root) => verifyPinnedWriteRoot(root))
      .filter((path): path is string => path !== undefined);
    const allRoots = [...verifiedPinned, ...(options.writeRoots ?? [])];
    return command ? isRoutineShellCommand(command, cwd, allRoots) : false;
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
  const segments: Array<{ tokens: ShellToken[]; joiner?: string }> = [{ tokens: [] }];
  for (const token of tokens) {
    if (token.operator && SEGMENT_SPLIT_OPERATORS.has(token.value)) {
      segments.at(-1)!.joiner = token.value;
      segments.push({ tokens: [] });
      continue;
    }
    segments.at(-1)!.tokens.push(token);
  }
  if (segments.some((segment) => segment.tokens.length === 0)) return false;
  let effectiveDir = cwd;
  let sawCd = false;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const prevJoiner = i > 0 ? segments[i - 1]!.joiner : undefined;
    // Once a `cd` has shifted `effectiveDir`, disallow `;`, `||`, or `&`
    // anywhere later so a skipped/failed `cd` can never let a later command run
    // from the original directory while checked against `effectiveDir`.
    if (sawCd && (prevJoiner === ";" || prevJoiner === "||" || prevJoiner === "&")) return false;
    const nextDir = routineCdTarget(segment.tokens, effectiveDir, cwd, writeRoots, prevJoiner, segment.joiner);
    if (nextDir === "invalid") return false;
    if (nextDir !== undefined) {
      effectiveDir = nextDir;
      sawCd = true;
      continue;
    }
    if (!isRoutineSegment(segment.tokens, effectiveDir, 0, writeRoots, cwd)) return false;
  }
  return true;
}

/**
 * Allow a plain literal `cd <dir> && <cmd>` whose target is an existing real
 * (non-symlink) directory inside the unified root set `R` (`cwd` or a granted
 * write root, never `.git`, never crossing a symlink so bash's default `cd -L`
 * cannot diverge from the real path). Must be preceded only by start-of-command
 * or `&&`/`;`, and MUST be followed by `&&` (never bare trailing `cd`, `;`,
 * `|`, `||`, or `&`).
 */
function routineCdTarget(
  segment: readonly ShellToken[],
  effectiveDir: string,
  boundaryCwd: string,
  writeRoots: readonly string[],
  prevJoiner: string | undefined,
  nextJoiner: string | undefined,
): string | "invalid" | undefined {
  const words = segment.filter((token) => !token.operator).map((token) => token.value);
  // Match `cd` case-sensitively: on case-insensitive filesystems (macOS), `CD`
  // can invoke `/usr/bin/cd` in a subprocess that exits 0 without changing the
  // parent shell's cwd.
  if (words.length === 0 || words[0] !== "cd") return undefined;
  // Redirections on cd, preceding `|`/`||`/`&`, or anything other than `&&`
  // after `cd` (including a bare trailing `cd`) make execution or later cwd
  // tracking ambiguous.
  if (segment.some((token) => token.operator)) return "invalid";
  if (prevJoiner !== undefined && prevJoiner !== "&&" && prevJoiner !== ";") return "invalid";
  if (nextJoiner !== "&&") return "invalid";
  let target: string | undefined;
  if (words.length === 2 && !words[1]!.startsWith("-")) target = words[1]!;
  else if (words.length === 3 && words[1] === "--" && words[2] !== "-") target = words[2]!;
  else return "invalid";
  if (!target || target === "-" || target.startsWith("~")) return "invalid";
  const unnormalized = isAbsolute(target) ? target : `${effectiveDir.replace(/\/+$/u, "")}/${target}`;
  if (classifyWritePath(unnormalized, boundaryCwd, writeRoots) !== undefined) return "invalid";
  // Target MUST exist as a real directory and MUST NOT cross any symlink from
  // effectiveDir (so bash's lexical `cd -L` and physical `cd -P` agree 100%).
  const resolved = resolve(effectiveDir, target);
  let realTarget: string;
  let realEffective: string;
  try {
    const statInfo = statSync(resolved);
    if (!statInfo.isDirectory()) return "invalid";
    realTarget = realpathSync.native(resolved);
    realEffective = realpathSync.native(effectiveDir);
  } catch {
    return "invalid";
  }
  const lexicalFromReal = isAbsolute(target) ? resolve(target) : resolve(realEffective, target);
  if (realTarget !== lexicalFromReal) {
    // Allow only when target itself is an absolute path through a symlinked
    // OS root (e.g., /var -> /private/var on macOS) whose relative walk from a
    // verified root contains no symlinks.
    const realBoundary = resolveExistingPath(boundaryCwd);
    const matchingRoot = [boundaryCwd, ...writeRoots]
      .find((r) => isAbsolute(r) && pathBelow(target!, [r, resolveExistingPath(r)]) !== undefined);
    if (!isAbsolute(target) || !matchingRoot) return "invalid";
    const rootReal = resolveExistingPath(matchingRoot);
    const below = pathBelow(target, [matchingRoot, rootReal]);
    if (below === undefined || resolve(rootReal, below) !== realTarget) return "invalid";
    if (realTarget !== realBoundary && !realTarget.startsWith(`${realBoundary}/`)
      && !writeRoots.some((r) => { const rr = resolveExistingPath(r); return realTarget === rr || realTarget.startsWith(`${rr}/`); })) {
      return "invalid";
    }
  }
  return realTarget;
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
 * re-route existing streams and never name a file. Any other `>& file` or
 * `&> file` is left in place so the target is validated as a file write.
 */
function withoutFdDuplication(tokens: readonly ShellToken[]): ShellToken[] | undefined {
  const result: ShellToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const target = tokens[index + 1];
    if (token.operator && (token.value === ">&" || token.value === "<&") && target && !target.operator && /^(?:\d+|-)$/u.test(target.value)) {
      // An optional leading descriptor number belongs to this redirection.
      const previous = result.at(-1);
      if (previous && !previous.operator && /^\d+$/u.test(previous.value) && result.length > 0) result.pop();
      index += 1;
      continue;
    }
    result.push(token);
  }
  return result;
}

function isRoutineSegment(
  segment: readonly ShellToken[],
  effectiveDir: string,
  depth: number,
  writeRoots: readonly string[] = [],
  boundaryCwd: string = effectiveDir,
): boolean {
  if (depth > 5) return false;
  if (hasUnsafeRedirection(segment, effectiveDir, writeRoots, boundaryCwd)) return false;
  const words = segment.filter((token) => !token.operator).map((token) => token.value);
  if (words.length === 0) return false;
  return isRoutineWords(words, effectiveDir, depth, writeRoots, boundaryCwd);
}

function isRoutineWords(
  words: readonly string[],
  effectiveDir: string,
  depth: number,
  writeRoots: readonly string[] = [],
  boundaryCwd: string = effectiveDir,
): boolean {
  if (depth > 5) return false;
  const first = words[0]!;
  // A program named by path (./ls, /tmp/x/ls) is an arbitrary executable, not
  // the well-known utility; leave it to the Decision Worker.
  if (/[\\/]/u.test(first)) return false;
  const head = first.toLowerCase();
  if (WRAPPER_COMMANDS.has(head)) {
    const wrapped = unwrapWrapper(head, words.slice(1));
    if (!wrapped || wrapped.length === 0) return false;
    return isRoutineWords(wrapped, effectiveDir, depth + 1, writeRoots, boundaryCwd);
  }
  if (!ROUTINE_SHELL_COMMANDS.has(head)) return false;
  const rest = words.slice(1);
  // Every path-looking argument (absolute, `..`-escaping, `~`, or the value of
  // a `--flag=path`) must resolve inside the task boundary R. This keeps reads
  // of /etc, ~/.ssh or ~/.aws and every option that names an outside file out
  // of the routine set, at the cost of an occasional model call for a sed
  // script that happens to start with `/`.
  if (rest.some((word) => namesPathOutsideCwd(word, effectiveDir, writeRoots, boundaryCwd))) return false;
  switch (head) {
    case "git": return isRoutineGit(rest, effectiveDir, boundaryCwd, writeRoots);
    case "npm": return isRoutineNpm(rest);
    case "pnpm": return isRoutinePnpm(rest);
    case "make": return isRoutineMake(rest, effectiveDir, boundaryCwd, writeRoots);
    case "cargo": return isRoutineCargo(rest, effectiveDir, boundaryCwd, writeRoots);
    case "go": return isRoutineGo(rest, effectiveDir, boundaryCwd, writeRoots);
    case "pytest": return isRoutinePytest(rest, effectiveDir, boundaryCwd, writeRoots);
    case "node": return isRoutineNode(rest, effectiveDir, boundaryCwd, writeRoots);
    case "tsc": return isRoutineTsc(rest, effectiveDir, boundaryCwd, writeRoots);
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

function isRoutineGit(rest: readonly string[], effectiveDir: string, boundaryCwd: string, writeRoots: readonly string[]): boolean {
  let index = 0;
  while (index < rest.length) {
    const word = rest[index]!;
    if (word === "-C") {
      const target = rest[index + 1];
      if (!target || !isInsideBoundaryArgument(target, effectiveDir, boundaryCwd, writeRoots)) return false;
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

function isRoutineTsc(rest: readonly string[], effectiveDir: string, boundaryCwd: string, writeRoots: readonly string[]): boolean {
  // Every flag that names an output or project location must stay inside the
  // task boundary R, whether written as `--outDir dir` or `--outDir=dir`.
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]!;
    const equals = word.indexOf("=");
    const flag = equals > 0 ? word.slice(0, equals) : word;
    if (!TSC_PATH_FLAGS.test(flag)) continue;
    const value = equals > 0 ? word.slice(equals + 1) : rest[index + 1];
    if (value === undefined || value.startsWith("-")) continue;
    if (!isInsideBoundaryArgument(value, effectiveDir, boundaryCwd, writeRoots)) return false;
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

const ROUTINE_PNPM_PRE_FLAGS = new Set(["-r", "--recursive", "-s", "--silent", "-w", "--workspace-root"]);

function isRoutinePnpm(rest: readonly string[]): boolean {
  const separator = rest.indexOf("--");
  const pnpmArguments = separator >= 0 ? rest.slice(0, separator) : rest;
  if (pnpmArguments.some((word) => NPM_RELOCATING_FLAGS.test(word))) return false;
  // Only skip known safe pre-subcommand flags so an unknown option's value
  // (e.g. `--test-pattern test exec …`) can never be mistaken for the subcommand.
  for (let index = 0; index < pnpmArguments.length; index += 1) {
    const word = pnpmArguments[index]!;
    if (word === "--filter" || word === "-F") {
      if (index + 1 >= pnpmArguments.length) return false;
      index += 1;
      continue;
    }
    if (word.startsWith("--filter=") || word.startsWith("-F=")) continue;
    if (ROUTINE_PNPM_PRE_FLAGS.has(word)) continue;
    if (word.startsWith("-")) return false;
    return ROUTINE_PNPM_SUBCOMMANDS.has(word.toLowerCase());
  }
  return false;
}

// Strict allowlists for make / cargo / go / pytest flags: any unrecognized,
// abbreviated, or clustered flag returns false (escalating to the Decision
// Worker instead of auto-approving as routine).
const MAKE_BOOL_FLAGS = new Set([
  "-n", "--just-print", "--dry-run", "--recon",
  "-s", "--silent", "--quiet",
  "-k", "--keep-going",
  "-B", "--always-make",
  "-i", "--ignore-errors",
  "-w", "--print-directory", "--no-print-directory",
  "-S", "--no-keep-going", "--stop",
]);

function isRoutineMake(rest: readonly string[], effectiveDir: string, boundaryCwd: string, writeRoots: readonly string[]): boolean {
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]!;
    if (word === "--") continue;
    if (word.startsWith("-")) {
      if (MAKE_BOOL_FLAGS.has(word)) continue;
      if (word === "-j" || word === "--jobs") {
        if (index + 1 < rest.length && /^\d+$/u.test(rest[index + 1]!)) index += 1;
        continue;
      }
      if (/^(?:-j\d+|--jobs=\d+)$/u.test(word)) continue;
      if (word === "-C" || word === "--directory") {
        const value = rest[index + 1];
        if (!value || !isInsideBoundaryArgument(value, effectiveDir, boundaryCwd, writeRoots)) return false;
        index += 1;
        continue;
      }
      if (word.startsWith("--directory=")) {
        const value = word.slice("--directory=".length);
        if (!value || !isInsideBoundaryArgument(value, effectiveDir, boundaryCwd, writeRoots)) return false;
        continue;
      }
      // Reject all other flags (including -f, -I, -e, -E, abbreviated --ev, short clusters like -kC..).
      return false;
    }
    // Block all Makefile variable assignments (`SHELL=…`, `CC=…`, `MAKE=…`, etc.).
    if (word.includes("=")) return false;
  }
  return true;
}

const CARGO_BOOL_FLAGS = new Set([
  "--release", "--debug", "--all-targets", "--all-features", "--no-default-features",
  "--workspace", "--all", "--lib", "--bins", "--tests", "--benches", "--examples",
  "--doc", "--no-run", "--no-fail-fast", "--locked", "--frozen", "--offline",
  "--quiet", "-q", "--verbose", "-v", "-vv", "--check", "--no-deps",
]);
const CARGO_VALUE_FLAGS = new Set([
  "-p", "--package", "-F", "--features", "-j", "--jobs",
  "--bin", "--test", "--bench", "--example", "--profile", "--target",
  "--color", "--message-format", "--format-version", "--edition", "--depth", "--edges",
]);
const CARGO_PATH_FLAGS = new Set(["--manifest-path", "--target-dir"]);
const CARGO_PASSTHROUGH_BOOL_FLAGS = new Set([
  "--nocapture", "--show-output", "--exact", "--ignored", "--include-ignored",
  "--list", "--quiet", "-q", "--check",
]);
const CARGO_PASSTHROUGH_VALUE_FLAGS = new Set([
  "--test-threads", "--color", "--skip", "--format",
  "-D", "--deny", "-W", "--warn", "-A", "--allow",
]);

function isRoutineCargo(rest: readonly string[], effectiveDir: string, boundaryCwd: string, writeRoots: readonly string[]): boolean {
  const separator = rest.indexOf("--");
  const cargoArguments = separator >= 0 ? rest.slice(0, separator) : rest;
  const passthrough = separator >= 0 ? rest.slice(separator + 1) : [];
  let subcommand: string | undefined;
  for (let index = 0; index < cargoArguments.length; index += 1) {
    const word = cargoArguments[index]!;
    if (!word.startsWith("-")) {
      if (!subcommand) {
        subcommand = word.toLowerCase();
        if (!ROUTINE_CARGO_SUBCOMMANDS.has(subcommand)) return false;
      }
      continue;
    }
    const equals = word.indexOf("=");
    const flag = equals > 0 ? word.slice(0, equals) : word;
    if (equals < 0 && CARGO_BOOL_FLAGS.has(flag)) continue;
    if (CARGO_VALUE_FLAGS.has(flag)) {
      const value = equals > 0 ? word.slice(equals + 1) : cargoArguments[index + 1];
      if (!value || (equals < 0 && value.startsWith("-"))) return false;
      if (equals < 0) index += 1;
      continue;
    }
    if (CARGO_PATH_FLAGS.has(flag)) {
      const value = equals > 0 ? word.slice(equals + 1) : cargoArguments[index + 1];
      if (!value || !isInsideBoundaryArgument(value, effectiveDir, boundaryCwd, writeRoots)) return false;
      if (equals < 0) index += 1;
      continue;
    }
    // Reject any unrecognized flag (including --config, -Z, -vZ..., +nightly).
    return false;
  }
  if (!subcommand) return false;
  for (let index = 0; index < passthrough.length; index += 1) {
    const word = passthrough[index]!;
    if (!word.startsWith("-")) continue;
    const equals = word.indexOf("=");
    const flag = equals > 0 ? word.slice(0, equals) : word;
    if (equals < 0 && CARGO_PASSTHROUGH_BOOL_FLAGS.has(flag)) continue;
    if (CARGO_PASSTHROUGH_VALUE_FLAGS.has(flag)) {
      const value = equals > 0 ? word.slice(equals + 1) : passthrough[index + 1];
      if (!value) return false;
      if (equals < 0) index += 1;
      continue;
    }
    return false;
  }
  return true;
}

const GO_BOOL_FLAGS = new Set([
  "-v", "-race", "-short", "-json", "-failfast", "-a", "-n", "-x",
  "-work", "-trimpath", "-cover", "-benchmem", "-m", "-all", "-deps", "-buildvcs",
]);
const GO_VALUE_FLAGS = new Set([
  "-run", "-skip", "-bench", "-benchtime", "-count", "-timeout",
  "-parallel", "-p", "-tags", "-f", "-coverpkg", "-covermode",
  "-shuffle", "-mod", "-list",
]);
const GO_PATH_FLAGS = new Set(["-o", "-C", "-coverprofile"]);

function isRoutineGo(rest: readonly string[], effectiveDir: string, boundaryCwd: string, writeRoots: readonly string[]): boolean {
  const subcommand = rest[0]?.toLowerCase();
  if (!subcommand || !ROUTINE_GO_SUBCOMMANDS.has(subcommand)) return false;
  for (let index = 1; index < rest.length; index += 1) {
    const word = rest[index]!;
    if (word === "--") break;
    if (!word.startsWith("-")) continue;
    const equals = word.indexOf("=");
    const rawFlag = equals > 0 ? word.slice(0, equals) : word;
    // Go's flag package accepts `-flag` and `--flag` interchangeably.
    const normFlag = rawFlag.startsWith("--") ? rawFlag.slice(1) : rawFlag;
    if (equals < 0 && GO_BOOL_FLAGS.has(normFlag)) continue;
    if (normFlag === "-buildvcs" && equals > 0) {
      const val = word.slice(equals + 1);
      if (val === "auto" || val === "true" || val === "false") continue;
      return false;
    }
    if (GO_VALUE_FLAGS.has(normFlag)) {
      const value = equals > 0 ? word.slice(equals + 1) : rest[index + 1];
      if (!value) return false;
      if (equals < 0) index += 1;
      continue;
    }
    if (GO_PATH_FLAGS.has(normFlag)) {
      const value = equals > 0 ? word.slice(equals + 1) : rest[index + 1];
      if (!value || !isInsideBoundaryArgument(value, effectiveDir, boundaryCwd, writeRoots)) return false;
      if (equals < 0) index += 1;
      continue;
    }
    // Reject all other flags (including -ldflags, -gccgoflags, -compiler, -exec, -toolexec, -vettool, -trace, -overlay, -pkgdir, -modfile).
    return false;
  }
  return true;
}

const PYTEST_BOOL_FLAGS = new Set([
  "-q", "--quiet", "-v", "--verbose", "-s", "-x", "--exitfirst",
  "--ff", "--failed-first", "--lf", "--last-failed", "--nf", "--new-first",
  "--no-header", "--no-summary", "--collect-only", "--co", "--version",
  "--disable-warnings", "--strict-markers", "--strict-config", "--full-trace",
  "--show-capture=no", "--show-capture=stdout", "--show-capture=stderr", "--show-capture=all",
  "--color=yes", "--color=no", "--color=auto",
]);
const PYTEST_VALUE_FLAGS = new Set([
  "-k", "-m", "--tb", "--maxfail", "-r", "--durations", "-n", "--capture", "--color", "--show-capture",
]);
const PYTEST_PATH_FLAGS = new Set(["-c", "--rootdir", "--basetemp", "--junitxml", "--junit-xml"]);

function isRoutinePytest(rest: readonly string[], effectiveDir: string, boundaryCwd: string, writeRoots: readonly string[]): boolean {
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]!;
    if (word === "--") break;
    if (!word.startsWith("-")) continue;
    const equals = word.indexOf("=");
    const flag = equals > 0 ? word.slice(0, equals) : word;
    if (PYTEST_BOOL_FLAGS.has(word)) continue;
    // Allow short boolean clusters ONLY from `{q, v, s, x}` (e.g. `-vv`, `-qx`, `-sv`).
    if (/^-[qvsx]+$/u.test(word)) continue;
    // Allow `-r<chars>` (e.g. `-ra`, `-rfE`).
    if (/^-r[A-Za-z]+$/u.test(word)) continue;
    if (PYTEST_VALUE_FLAGS.has(flag)) {
      const value = equals > 0 ? word.slice(equals + 1) : rest[index + 1];
      if (!value) return false;
      if (equals < 0) index += 1;
      continue;
    }
    if (PYTEST_PATH_FLAGS.has(flag)) {
      const value = equals > 0 ? word.slice(equals + 1) : rest[index + 1];
      if (!value || !isInsideBoundaryArgument(value, effectiveDir, boundaryCwd, writeRoots)) return false;
      if (equals < 0) index += 1;
      continue;
    }
    // Reject all other flags (including -o, -qo, -vc/..., --override-ini, -p, etc.).
    return false;
  }
  return true;
}

function isRoutineNode(rest: readonly string[], effectiveDir: string, boundaryCwd: string, writeRoots: readonly string[]): boolean {
  // Inline evaluation (-e/-p/--eval=/--print=/--input-type) and module
  // preloading (-r/--require/--import) run ad-hoc code; only a script inside
  // the task boundary R, with a small set of harmless flags, is routine.
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
    if (!isInsideBoundaryArgument(word, effectiveDir, boundaryCwd, writeRoots)) return false;
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

function hasUnsafeRedirection(
  segment: readonly ShellToken[],
  effectiveDir: string,
  writeRoots: readonly string[] = [],
  boundaryCwd: string = effectiveDir,
): boolean {
  for (let index = 0; index < segment.length; index += 1) {
    const token = segment[index]!;
    if (token.operator && OUTPUT_REDIRECT_OPERATORS.has(token.value)) {
      const target = segment[index + 1];
      if (!target || target.operator) return true;
      if (isUnsafeRedirectTarget(target.value, effectiveDir, writeRoots, boundaryCwd)) return true;
    }
  }
  return false;
}

function isUnsafeRedirectTarget(
  target: string,
  effectiveDir: string,
  writeRoots: readonly string[] = [],
  boundaryCwd: string = effectiveDir,
): boolean {
  if (target === "/dev/null") return false; // the one device sink that discards rather than writes
  if (target.startsWith("/dev/") || target.startsWith("~") || target.startsWith("&")) return true;
  // Pass unnormalized `${effectiveDir}/${target}` so `pathBelow` and
  // `walkWritePath` still see every `link/..` segment instead of collapsing it
  // lexically with `path.resolve`.
  const checkedTarget = isAbsolute(target) || effectiveDir === boundaryCwd
    ? target
    : `${effectiveDir.replace(/\/+$/u, "")}/${target}`;
  return classifyWritePath(checkedTarget, boundaryCwd, writeRoots) !== undefined;
}

/** True for an argument that names a filesystem location outside the task boundary R (or ~), including `-flag=path` and `--flag=path` values. */
function namesPathOutsideCwd(
  word: string,
  effectiveDir: string,
  writeRoots: readonly string[] = [],
  boundaryCwd: string = effectiveDir,
): boolean {
  const value = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
  if (value === "/dev/null") return false;
  if (value.startsWith("~")) return true;
  const pathLike = value.startsWith("/") || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value);
  const unnormalizedCandidate = isAbsolute(value) ? value : `${effectiveDir.replace(/\/+$/u, "")}/${value}`;
  const resolvedCandidate = isAbsolute(value) ? value : resolve(effectiveDir, value);
  // A path inside the task boundary R (cwd or a granted write root) is allowed,
  // judged by the same unnormalized walk the Write tool gets (symlinks and
  // metadata included).
  if (pathLike) {
    return classifyWritePath(unnormalizedCandidate, boundaryCwd, writeRoots) !== undefined;
  }
  // An argument that exists on disk may be (or pass through) a symlink that
  // leaves the boundary R; compare real paths. A non-existent argument is a
  // pattern or a literal and needs no check.
  if (value.startsWith("-") || value === "") return false;
  let root: string;
  try { root = realpathSync.native(boundaryCwd); }
  catch { return true; }
  const allowedRoots = [root, ...writeRoots.filter((r) => isAbsolute(r)).map((r) => resolveExistingPath(r))];
  const inAllowedRoots = (realPath: string): boolean => allowedRoots.some((allowed) => {
    const rel = relative(allowed, realPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  // Resolve the nearest existing ancestor so a symlinked directory component
  // (`link/new-file`) is caught even when the leaf does not exist yet.
  let candidate = resolvedCandidate;
  while (true) {
    try {
      const real = realpathSync.native(candidate);
      return !inAllowedRoots(real);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      const relParent = relative(effectiveDir, parent);
      if (relParent === "") return false; // reached effectiveDir itself: nothing left to resolve
      candidate = parent;
    }
  }
}

function isInsideBoundaryArgument(pathValue: string, effectiveDir: string, boundaryCwd: string, writeRoots: readonly string[]): boolean {
  if (pathValue.startsWith("~")) return false;
  const value = pathValue.includes("=") && pathValue.startsWith("-") ? pathValue.slice(pathValue.indexOf("=") + 1) : pathValue;
  const unnormalized = isAbsolute(value) ? value : `${effectiveDir.replace(/\/+$/u, "")}/${value}`;
  return classifyWritePath(unnormalized, boundaryCwd, writeRoots) === undefined;
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
