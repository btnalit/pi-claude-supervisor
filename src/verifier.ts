import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AcceptanceCheck, AcceptanceCheckResult, AcceptanceReport, VerificationResult } from "./types.ts";
import { evidenceMaxBytes, evidenceMaxUntrackedFiles } from "./config.ts";
import { assertSafeWorkerCommand, isCommitId } from "./policy.ts";
import { workerEnvironment } from "./worker/environment.ts";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;

/** The bounded evidence/output size; configurable via PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_BYTES. */
function maxOutputBytes(): number {
  return evidenceMaxBytes();
}

/** The maximum number of untracked files to include as evidence; configurable via PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_UNTRACKED_FILES. */
function maxUntrackedFiles(): number {
  return evidenceMaxUntrackedFiles();
}

/** child_process maxBuffer stays a comfortable multiple of the configured evidence bound. */
function maxExecBufferBytes(): number {
  return Math.max(8 * 1024 * 1024, 8 * evidenceMaxBytes());
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("verification aborted");
  error.name = "AbortError";
  throw error;
}

export interface VerificationCommand {
  command: string;
  args?: string[];
}

export interface VerificationOptions {
  signal?: AbortSignal;
  onCheck?: (info: { check: AcceptanceCheck; result: AcceptanceCheckResult; index: number; total: number }) => void | Promise<void>;
}

export interface RepositoryEvidence {
  status: string;
  /** HEAD-relative diff for tracked staged and unstaged changes. */
  diff: string;
  /** Bounded content for untracked regular files. */
  untracked?: string;
  /** False when a command/file could not be safely or completely collected. */
  complete?: boolean;
  /** Commit summaries made after the task baseline. */
  commits?: string;
  /** Baseline HEAD used for the diff and commit range, when available. */
  baseRef?: string;
  /** Current branch used for the local candidate, when available. */
  branch?: string;
  /** The commit HEAD pointed at when this evidence was read; a publish grant must name the same one. */
  head?: string;
  /** True when any evidence field was bounded or omitted. */
  truncated?: boolean;
  collectedAt: string;
}

/** Read the repository HEAD without invoking a shell. */
export async function repositoryHead(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024,
      signal,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    const head = String(result.stdout).trim();
    return isCommitId(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Environment for confirming a publish: the Supervisor's own read-only
 * inspection, not a Worker command, so it inherits the process environment
 * rather than the restricted one `repositoryHead` uses for local reads. It has
 * to reach whatever remote the Worker just pushed to, and an allowlist cannot
 * keep up with that — proxies, CA bundles, enterprise tokens, credential
 * helpers — where every omission reports a real publish as unconfirmed. Only
 * the prompts are forced off, so an unreadable remote fails fast instead of
 * hanging.
 */
function remoteReadEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
  // Inheriting the network and credential variables must not also inherit the
  // ones that point git at another repository or inject configuration: with
  // GIT_DIR or GIT_CONFIG_COUNT/KEY_n/VALUE_n set in the host's shell, the
  // confirmation would pin and read a repository that is not the candidate's.
  for (const name of Object.keys(env)) {
    if (REPOSITORY_RELOCATING_GIT_VARIABLE.test(name)) delete env[name];
  }
  return env;
}

const REPOSITORY_RELOCATING_GIT_VARIABLE = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)$/u;

/**
 * Run a read-only inspection command without a shell, for confirming what the
 * Worker published. Never used for anything that mutates.
 */
export async function runReadOnly(command: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string }> {
  const result = await execFileAsync(command, [...args], {
    cwd,
    timeout: 60_000,
    maxBuffer: 256 * 1024,
    signal,
    env: remoteReadEnvironment(),
  });
  return { stdout: String(result.stdout) };
}

/** Where a remote name currently fetches from and pushes to, so a grant can be pinned to destinations rather than a name. */
export interface RemoteDestination {
  /** Every fetch URL, in order; the first is what `ls-remote` reads through. */
  fetch: string[];
  /** Every push URL, in order — git pushes to *all* of them, so a second `pushurl` is a second destination. */
  push: string[];
}

/**
 * The URLs a remote name resolves to, every one of them: `git remote get-url`
 * prints only the first, but git pushes to every configured `pushurl`, so a
 * destination added second would be invisible to a single-URL comparison.
 * Both sides are pinned because they diverge independently — `pushurl` and
 * `url.*.pushInsteadOf` redirect the push while the fetch URL the confirmation
 * reads through stays put — and each is reported after any rewrite.
 */
export async function remoteUrl(cwd: string, remote: string, signal?: AbortSignal): Promise<RemoteDestination | undefined> {
  try {
    const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const [fetch, push] = (await Promise.all([
      runReadOnly("git", ["remote", "get-url", "--all", "--", remote], cwd, signal),
      runReadOnly("git", ["remote", "get-url", "--push", "--all", "--", remote], cwd, signal),
    ])).map((result) => lines(result.stdout)) as [string[], string[]];
    return fetch.length === 0 || push.length === 0 ? undefined : { fetch, push };
  } catch {
    return undefined;
  }
}

/** True when two destinations list exactly the same URLs in the same order, on both sides. */
export function sameDestination(first: RemoteDestination | undefined, second: RemoteDestination | undefined): boolean {
  if (!first || !second) return false;
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);
  return same(first.fetch, second.fetch) && same(first.push, second.push);
}

/**
 * What a remote branch points at. `absent` is a fact the remote reported;
 * `unreachable` means the remote could not be asked (network, timeout, a
 * refused credential), which the caller must not report as a fact about the
 * branch. Read-only: `ls-remote` never mutates.
 */
export type RemoteBranchLookup = { outcome: "found"; head: string } | { outcome: "absent" } | { outcome: "unreachable"; error: string };

export async function remoteBranchHead(cwd: string, remote: string, branch: string, signal?: AbortSignal): Promise<RemoteBranchLookup> {
  try {
    const { stdout } = await runReadOnly("git", ["ls-remote", "--heads", "--", remote, branch], cwd, signal);
    const line = stdout.split("\n").map((entry) => entry.trim()).find((entry) => entry.endsWith(`refs/heads/${branch}`));
    const sha = line?.split(/\s+/u)[0] ?? "";
    return isCommitId(sha) ? { outcome: "found", head: sha } : { outcome: "absent" };
  } catch (error) {
    return { outcome: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A remote URL as the `host/owner/repo` gh accepts for `--repo`, or undefined
 * when the URL does not name one. gh parses `https://`, `ssh://` and
 * `git@host:owner/repo` forms itself but not an SSH-config host alias
 * (`gh-work:owner/repo.git`, the usual multi-account setup); the alias is
 * translated here the way gh translates a remote, through `ssh -G`, so a `pr`
 * grant can be pinned to a repository gh can actually open.
 */
export async function repositorySlug(url: string, signal?: AbortSignal): Promise<string | undefined> {
  const parsed = parseRemoteUrl(url.trim());
  if (!parsed) return undefined;
  let host = parsed.host;
  // `git@github.com:` is the common scp form and needs no translation; only a
  // bare word (`gh-work`) can be an SSH-config alias worth asking `ssh -G` about.
  if (parsed.sshAlias && !parsed.host.includes(".")) host = (await resolveSshHostname(parsed.host, signal)) ?? parsed.host;
  return `${host.toLowerCase()}/${parsed.owner}/${parsed.repo}`;
}

function parseRemoteUrl(url: string): { host: string; owner: string; repo: string; sshAlias: boolean } | undefined {
  const path = (value: string): [string, string] | undefined => {
    const parts = value.replace(/^\/+/u, "").replace(/\/+$/u, "").replace(/\.git$/u, "").split("/");
    return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9._-]+$/u.test(part)) ? [parts[0]!, parts[1]!] : undefined;
  };
  const scheme = url.match(/^(?:https?|ssh|git):\/\/(?:[^@\/]+@)?([^\/:]+)(?::\d+)?\/(.+)$/u);
  if (scheme) {
    const parts = path(scheme[2]!);
    return parts ? { host: scheme[1]!, owner: parts[0], repo: parts[1], sshAlias: false } : undefined;
  }
  // scp-like: `user@host:owner/repo` or `alias:owner/repo`. Without a user the
  // host is most likely an SSH-config alias; with one it may still be.
  const scp = url.match(/^(?:([^@\/:]+)@)?([A-Za-z0-9._-]+):(.+)$/u);
  if (scp && !scp[3]!.startsWith("/")) {
    const parts = path(scp[3]!);
    return parts ? { host: scp[2]!, owner: parts[0], repo: parts[1], sshAlias: true } : undefined;
  }
  return undefined;
}

/** The real hostname behind an SSH-config alias (`ssh -G` prints `hostname <real>`), or undefined. */
async function resolveSshHostname(alias: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await execFileAsync("ssh", ["-G", "--", alias], { timeout: 10_000, maxBuffer: 64 * 1024, signal, env: { ...process.env, SSH_ASKPASS: "" } });
    const line = String(result.stdout).split("\n").find((entry) => entry.startsWith("hostname "));
    const host = line?.slice("hostname ".length).trim();
    return host && /^[A-Za-z0-9.-]+$/u.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Verify that a full commit object is still present without invoking a shell. */
export async function repositoryCommitExists(cwd: string, commit: string, signal?: AbortSignal): Promise<boolean> {
  if (!isCommitId(commit)) return false;
  try {
    const result = await execFileAsync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024,
      signal,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    return result.stderr.length === 0;
  } catch {
    return false;
  }
}

/** Verify that `ancestor` is reachable from `descendant` (or is `descendant` itself) without invoking a shell. */
export async function repositoryIsAncestor(cwd: string, ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024,
      signal,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the working tree has nothing uncommitted or untracked, or undefined
 * when git could not say. The same reading the evidence uses, so the publish
 * turn's "unchanged" means what the grant's "clean" meant.
 */
export async function repositoryClean(cwd: string, signal?: AbortSignal): Promise<boolean | undefined> {
  try {
    const result = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      signal,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    return String(result.stdout).trim() === "";
  } catch {
    return undefined;
  }
}

/**
 * True when the repository's Git directory is where the `.git/` guards look:
 * `<cwd>/.git` itself, or a linked worktree's `<common>/.git/worktrees/<name>`
 * (a worktree's `.git` is a `gitdir:` file by design, and its config and hooks
 * live in the common directory — the pinned `core.hooksPath` is what protects
 * the granted push there). A Git directory anywhere else is the
 * `--separate-git-dir` case, refused for the Worker but not for whoever made
 * the clone.
 */
export async function repositoryGitDirectoryIsLocal(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const read = async (args: string[]): Promise<string> => {
      const result = await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 4096, signal, env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }) });
      return String(result.stdout).trim();
    };
    const [gitDir, commonDir] = await Promise.all([read(["rev-parse", "--git-dir"]), read(["rev-parse", "--git-common-dir"])]);
    if (!gitDir || !commonDir) return false;
    const resolvedGitDir = await realpath(resolve(cwd, gitDir));
    const resolvedCommon = await realpath(resolve(cwd, commonDir));
    const own = await realpath(cwd).then((real) => join(real, ".git")).catch(() => undefined);
    if (own !== undefined && resolvedGitDir === own) return true;
    // A linked worktree: its git dir sits under the common dir's worktrees/,
    // and the common dir is itself a repository's own .git.
    const worktrees = join(resolvedCommon, "worktrees");
    return resolvedCommon.endsWith(`${sep}.git`) && resolvedGitDir.startsWith(`${worktrees}${sep}`);
  } catch {
    return false;
  }
}

/** Determine whether cwd is a non-bare Git worktree without invoking a shell. */
export async function repositoryWorkTree(cwd: string, signal?: AbortSignal): Promise<boolean | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024,
      signal,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    const value = String(result.stdout).trim();
    return value === "true" ? true : value === "false" ? false : undefined;
  } catch {
    return undefined;
  }
}

/** Read the current symbolic branch without invoking a shell. */
export async function repositoryBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024,
      signal,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    const branch = String(result.stdout).trim();
    return branch && /^[A-Za-z0-9._/-]+$/u.test(branch) ? branch : undefined;
  } catch {
    return undefined;
  }
}

export async function verify(
  cwd: string,
  command: VerificationCommand = { command: "git", args: ["diff", "--check"] },
  timeoutMs = 120_000,
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  assertSafeWorkerCommand(command.command, command.args);
  const check: AcceptanceCheck = {
    id: "verification",
    name: "verification",
    command: command.command,
    args: [...(command.args ?? [])],
    required: true,
    timeoutMs,
  };
  const result = await runCheck(cwd, check, options.signal);
  return {
    ok: result.ok && !options.signal?.aborted,
    command: [check.command, ...check.args].join(" "),
    exitCode: result.exitCode,
    output: result.output,
    checkedAt: result.finishedAt,
  };
}

export async function verifyAll(cwd: string, checks: readonly AcceptanceCheck[], options: VerificationOptions = {}): Promise<AcceptanceReport> {
  if (checks.length === 0) throw new Error("at least one acceptance check is required");
  const results: AcceptanceCheckResult[] = [];
  for (const [index, check] of checks.entries()) {
    const result = await runCheck(cwd, check, options.signal);
    results.push(result);
    await options.onCheck?.({ check, result, index, total: checks.length });
    if (options.signal?.aborted) break;
  }
  const cancelled = options.signal?.aborted === true;
  const ok = !cancelled && results.every((result) => !result.check.required || result.ok);
  const firstFailure = results.find((result) => result.check.required && !result.ok);
  return {
    ok,
    command: "acceptance checks",
    exitCode: firstFailure?.exitCode ?? (cancelled ? 1 : 0),
    output: boundOutput(`${results.map(formatCheckResult).join("\n\n")}${cancelled ? "\n\n[verification cancelled]" : ""}`),
    checkedAt: new Date().toISOString(),
    checks: results,
  };
}

/** Collect bounded repository evidence for the independent read-only Reviewer. */
export async function collectRepositoryEvidence(cwd: string, options: Pick<VerificationOptions, "signal"> & { baseRef?: string } = {}): Promise<RepositoryEvidence> {
  throwIfAborted(options.signal);
  const baseRef = options.baseRef;
  const diffRef = baseRef ?? "HEAD";
  const commitArgs = baseRef ? ["log", "--format=%h %s", "--no-decorate", `${baseRef}..HEAD`, "--"] : ["log", "--format=%h %s", "--no-decorate", "-20", "--"];
  const [statusResult, diffResult, commitsResult, branchResult, untrackedResult, head] = await Promise.all([
    readGitEvidence(cwd, ["status", "--short", "--untracked-files=all"], options.signal),
    // A baseline-relative diff includes committed, staged, and unstaged changes.
    readGitEvidence(cwd, ["diff", "--no-ext-diff", "--unified=3", diffRef, "--"], options.signal),
    readGitEvidence(cwd, commitArgs, options.signal),
    readGitEvidence(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], options.signal),
    collectUntrackedEvidence(cwd, options.signal),
    repositoryHead(cwd, options.signal),
  ]);
  throwIfAborted(options.signal);
  return {
    status: statusResult.text,
    diff: diffResult.text,
    commits: commitsResult.text,
    untracked: untrackedResult.text,
    ...(baseRef ? { baseRef } : {}),
    ...(branchResult.text.trim() !== "(none)" ? { branch: branchResult.text.trim() } : {}),
    ...(head ? { head } : {}),
    complete: statusResult.complete && diffResult.complete && commitsResult.complete && branchResult.complete && untrackedResult.complete,
    truncated: statusResult.truncated || diffResult.truncated || commitsResult.truncated || branchResult.truncated || untrackedResult.truncated,
    collectedAt: new Date().toISOString(),
  };
}

async function runCheck(cwd: string, check: AcceptanceCheck, signal?: AbortSignal): Promise<AcceptanceCheckResult> {
  throwIfAborted(signal);
  assertSafeWorkerCommand(check.command, check.args);
  const startedAt = new Date().toISOString();
  try {
    const result = await execFileAsync(check.command, check.args, {
      cwd,
      timeout: check.timeoutMs,
      maxBuffer: maxExecBufferBytes(),
      signal,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    const finishedAt = new Date().toISOString();
    return {
      check,
      status: "passed",
      ok: true,
      exitCode: 0,
      output: boundOutput(`${result.stdout}${result.stderr}`),
      startedAt,
      finishedAt,
    };
  } catch (error) {
    const failure = error as { code?: number | string; signal?: string; stdout?: string; stderr?: string; message?: string; killed?: boolean; name?: string };
    const finishedAt = new Date().toISOString();
    const cancelled = signal?.aborted === true || failure.name === "AbortError" || failure.code === "ABORT_ERR";
    const timedOut = !cancelled && (failure.killed === true || failure.signal === "SIGTERM" || failure.code === "ETIMEDOUT");
    const exitCode = typeof failure.code === "number" ? failure.code : 1;
    return {
      check,
      status: cancelled ? "cancelled" : timedOut ? "timed_out" : "failed",
      ok: false,
      exitCode,
      output: boundOutput(`${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? ""}`),
      startedAt,
      finishedAt,
    };
  }
}

interface EvidencePart {
  text: string;
  complete: boolean;
  truncated: boolean;
}

async function readGitEvidence(cwd: string, args: string[], signal?: AbortSignal): Promise<EvidencePart> {
  throwIfAborted(signal);
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: maxExecBufferBytes(),
      signal,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    const bounded = boundEvidence(`${result.stdout}${result.stderr}`);
    return { ...bounded, text: bounded.text || "(none)" };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const bounded = boundEvidence(`${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? "git evidence unavailable"}`);
    // Oversized output is a bounding problem, not an unsafe/incomplete command: let the
    // Supervisor's truncated-evidence repair path handle it instead of a hard park.
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { ...bounded, complete: false, truncated: true };
    return { ...bounded, complete: false };
  }
}

async function collectUntrackedEvidence(cwd: string, signal?: AbortSignal): Promise<EvidencePart> {
  throwIfAborted(signal);
  let output: string;
  let root: string;
  try {
    root = await realpath(cwd);
  } catch (error) {
    return { text: `[UNTRACKED EVIDENCE UNAVAILABLE] ${error instanceof Error ? error.message : String(error)}`, complete: false, truncated: false };
  }
  try {
    const result = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd,
      timeout: 30_000,
      maxBuffer: maxOutputBytes(),
      signal,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    output = result.stdout;
    throwIfAborted(signal);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { text: `[UNTRACKED EVIDENCE UNAVAILABLE] ${failure.stderr ?? failure.message ?? "git ls-files failed"}`, complete: false, truncated: false };
  }
  const paths = output.split("\0").filter(Boolean);
  if (paths.length === 0) return { text: "(none)", complete: true, truncated: false };
  const untrackedLimit = maxUntrackedFiles();
  let complete = paths.length <= untrackedLimit;
  let truncated = false;
  const sections: string[] = [];
  for (const path of paths.slice(0, untrackedLimit)) {
    const fullPath = resolve(root, path);
    const relativePath = relative(root, fullPath);
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${"/"}`) || relativePath.startsWith(`..${"\\"}`)) {
      complete = false;
      sections.push(`--- ${JSON.stringify(path)} [unsafe path omitted]`);
      continue;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // Directory components must be real; the leaf itself may be a link, reported below.
      await assertNoSymlinkComponents(root, dirname(relativePath));
      // A symlink, a special file or a binary is named with what can be said
      // about it, but its content is not read. Its presence is complete
      // evidence in itself: parking a task because the Worker added a PNG, a
      // fixture database or a symlink helps nobody.
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) {
        // Unreadable means it changed after lstat: nothing true can be said about it.
        const target = await readlink(fullPath);
        sections.push(`--- ${JSON.stringify(path)} [symbolic link to ${JSON.stringify(target)}; not followed]`);
        continue;
      }
      if (!info.isFile()) {
        sections.push(`--- ${JSON.stringify(path)} [non-regular file omitted]`);
        continue;
      }
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      handle = await open(fullPath, fsConstants.O_RDONLY | noFollow);
      const opened = await handle.stat();
      if (!opened.isFile()) {
        sections.push(`--- ${JSON.stringify(path)} [non-regular file omitted]`);
        continue;
      }
      if (opened.nlink > 1) {
        // Unlike a binary or a symlink, a second link would hide ordinary text
        // from the Reviewer just by existing, so it keeps the evidence incomplete.
        complete = false;
        sections.push(`--- ${JSON.stringify(path)} [hard-link file omitted]`);
        continue;
      }
      await assertOpenedEvidencePath(root, handle.fd);
      const buffer = Buffer.alloc(MAX_UNTRACKED_FILE_BYTES + 1);
      const read = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, read.bytesRead);
      if (bytes.includes(0)) {
        // Omitted whatever its size: a large binary is not truncated text.
        sections.push(`--- ${JSON.stringify(path)} [binary file, ${opened.size} bytes; content omitted]`);
        continue;
      }
      if (read.bytesRead > MAX_UNTRACKED_FILE_BYTES) {
        complete = false;
        truncated = true;
      }
      sections.push(`--- ${JSON.stringify(path)}${read.bytesRead > MAX_UNTRACKED_FILE_BYTES ? " [TRUNCATED]" : ""}\n${bytes.toString("utf8")}`);
    } catch (error) {
      complete = false;
      sections.push(`--- ${JSON.stringify(path)} [read failed: ${error instanceof Error ? error.message : String(error)}]`);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  if (paths.length > untrackedLimit) {
    truncated = true;
    sections.push(`[TRUNCATED: ${paths.length - untrackedLimit} untracked paths omitted]`);
  }
  const bounded = boundEvidence(sections.join("\n"));
  return { ...bounded, complete: complete && bounded.complete, truncated: truncated || bounded.truncated };
}

async function assertOpenedEvidencePath(root: string, fd: number): Promise<void> {
  if (process.platform !== "linux") throw new Error("opened evidence identity cannot be verified on this platform");
  const target = (await readlink(`/proc/self/fd/${fd}`)).replace(/ \(deleted\)$/u, "");
  const normalizedTarget = target.replaceAll("\\", "/");
  if (normalizedTarget.split("/").some((segment) => segment.toLowerCase() === ".git")) throw new Error("opened evidence path resolves into Git metadata");
  const relativeTarget = relative(root, target);
  if (isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || relativeTarget.startsWith(`..${"\\"}`)) {
    throw new Error("opened evidence path escaped the repository root");
  }
}

async function assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split(sep).filter((part) => part && part !== ".");
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("symlink path component is not allowed in repository evidence");
  }
}

function formatCheckResult(result: AcceptanceCheckResult): string {
  return `[${result.status}] ${result.check.id}: ${result.check.command} ${result.check.args.join(" ")}\n${result.output || "(no output)"}`;
}

function boundEvidence(value: string): EvidencePart {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxOutputBytes()) return { text: value, complete: true, truncated: false };
  const marker = Buffer.from("\n[TRUNCATED]", "utf8");
  const suffix = encoded.subarray(-Math.max(0, maxOutputBytes() - marker.byteLength));
  return { text: `${suffix.toString("utf8")}${marker.toString("utf8")}`, complete: false, truncated: true };
}

function boundOutput(value: string): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxOutputBytes()) return value;
  const marker = Buffer.from("\n[TRUNCATED]", "utf8");
  const suffix = encoded.subarray(-Math.max(0, maxOutputBytes() - marker.byteLength));
  return `${suffix.toString("utf8")}${marker.toString("utf8")}`;
}
