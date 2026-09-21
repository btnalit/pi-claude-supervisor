import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";
import type { AcceptanceCheck, AcceptanceCheckResult, AcceptanceReport, VerificationResult } from "./types.ts";
import { evidenceMaxBytes, evidenceMaxUntrackedFiles } from "./config.ts";
import { assertSafeWorkerCommand, isCommitId, isSafeGrantedPushUrl, shellQuote } from "./policy.ts";
import { runBoundedCommand } from "./command-runner.ts";
import { runSupervisorGit, supervisorGitCommandArgs, supervisorGitEnvironment } from "./git-runner.ts";
import { trustedExecutablePath } from "./worker/environment.ts";

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

function decodeUtf8(value: Buffer | string): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
  /** Fresh cgroup parent for acceptance commands when automatic mode has one. */
  cgroupParentPath?: string;
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
    const result = await runSupervisorGit(cwd, ["rev-parse", "--verify", "HEAD"], { signal, maxBuffer: 1024 });
    const head = result.stdout.trim();
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
export function remoteReadEnvironment(): NodeJS.ProcessEnv {
  const env = supervisorGitEnvironment(true);
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  return env;
}

/**
 * Run a read-only inspection command without a shell, for confirming what the
 * Worker published. Never used for anything that mutates.
 */
export async function runReadOnly(command: string, args: readonly string[], cwd: string, signal?: AbortSignal, environment?: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  if (command === "git") {
    const result = await runSupervisorGit(cwd, args, { signal, timeout: 60_000, maxBuffer: 256 * 1024, network: true });
    return { stdout: result.stdout };
  }
  const result = await execFileAsync(command, [...args], {
    cwd,
    timeout: 60_000,
    maxBuffer: 256 * 1024,
    signal,
    env: environment ?? remoteReadEnvironment(),
    encoding: "buffer",
  });
  return { stdout: decodeUtf8(result.stdout) };
}

/** Where a remote name currently fetches from and pushes to, so a grant can be pinned to destinations rather than a name. */
export interface RemoteDestination {
  /** Every fetch URL, in order; the first is what `ls-remote` reads through. */
  fetch: string[];
  /** Every push URL, in order — git pushes to *all* of them, so a second `pushurl` is a second destination. */
  push: string[];
}

/** Return false for Git's command-executing remote-helper URL forms. */
function isSafeRemoteUrl(url: string): boolean {
  return isSafeGrantedPushUrl(url);
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
    const escapedRemote = remote.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const remoteConfigPattern = `^remote\\.${escapedRemote}\\.(url|pushurl)$`;
    const [fetch, push, localConfig, rawRemoteConfig] = (await Promise.all([
      runReadOnly("git", ["remote", "get-url", "--all", "--", remote], cwd, signal),
      runReadOnly("git", ["remote", "get-url", "--push", "--all", "--", remote], cwd, signal),
      // Local config is Worker-controlled. `url.*.insteadOf` and
      // `url.*.pushInsteadOf` still rewrite an explicit push URL, so a
      // resolved destination would not remain pinned for the whole one-shot
      // command. Name-only NUL output also handles subsection names without
      // parsing values that could contain arbitrary bytes.
      runReadOnly("git", ["config", "--local", "--name-only", "--null", "--list"], cwd, signal),
      // `remote get-url` is line-delimited, so a config value containing a
      // newline could otherwise be mistaken for two safe destinations. Read
      // raw values with NUL termination and reject control bytes before
      // splitting the resolved output.
      runReadOnly("git", ["config", "--null", "--get-regexp", remoteConfigPattern], cwd, signal),
    ])).map((result) => result.stdout) as [string, string, string, string];
    const hasMalformedRemoteConfig = rawRemoteConfig.split("\0").filter(Boolean).some((entry) => {
      const separator = entry.indexOf("\n");
      return separator < 0 || /[\u0000-\u001f\u007f]/u.test(entry.slice(separator + 1));
    });
    const hasLocalUrlRewrite = localConfig.split("\0").some((key) => /^url\..+\.(?:insteadof|pushinsteadof)$/iu.test(key));
    // Git remote helpers (`ext::`, `foo::`) are executable transport names.
    // Do not even issue a later ls-remote/push grant for one, even when a
    // repository or operator config supplied it at startup. A malformed or
    // unreadable local config fails closed through the catch below.
    const fetchUrls = lines(fetch);
    const pushUrls = lines(push);
    return hasMalformedRemoteConfig || hasLocalUrlRewrite || fetchUrls.length === 0 || pushUrls.length === 0 || [...fetchUrls, ...pushUrls].some((url) => !isSafeRemoteUrl(url))
      ? undefined
      : { fetch: fetchUrls, push: pushUrls };
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

function isSafeBranchName(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(branch)
    && !branch.includes("..")
    && !branch.includes("//")
    && !branch.includes("@{")
    && !/(?:^|\/)\./u.test(branch)
    && !/(?:^|\/)\.lock$/u.test(branch)
    && !/[.]$/u.test(branch);
}

function isSshDestination(url: string): boolean {
  if (/^ssh:\/\//iu.test(url)) return true;
  const scp = url.match(/^(?:[^/\s@]+@)?([A-Za-z0-9._-]+):/u);
  return Boolean(scp && !(scp[1]!.length === 1 && /^[A-Za-z]:[\\/]/u.test(url)));
}

export async function remoteBranchHead(cwd: string, remote: string, branch: string, signal?: AbortSignal, destinationAlreadyResolved = false): Promise<RemoteBranchLookup> {
  try {
    if (!isSafeBranchName(branch) || (!destinationAlreadyResolved && !/^[A-Za-z0-9._-]+$/u.test(remote))) {
      return { outcome: "unreachable", error: "remote branch selector is not safe to confirm" };
    }
    // Keep the historical helper behavior for callers that pass a remote name;
    // Supervisor publish confirmation passes the already-resolved URL and sets
    // the final flag so a relative local destination is not confused with a
    // same-named remote.
    const resolved = destinationAlreadyResolved ? remote : (await remoteUrl(cwd, remote, signal))?.fetch[0] ?? remote;
    if (!isSafeGrantedPushUrl(resolved)) return { outcome: "unreachable", error: "remote destination is not safe to confirm" };
    const destination = !/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:[^/\s@]+@)?[A-Za-z0-9._-]+:|\/)/u.test(resolved)
      ? resolve(cwd, resolved)
      : resolved;
    if (!isSafeGrantedPushUrl(destination)) return { outcome: "unreachable", error: "resolved remote destination is not safe to confirm" };
    // Do not run this direct-URL confirmation inside the Worker's repository:
    // local config can otherwise replace SSH, proxy, credential, URL-rewrite,
    // or HTTP settings after the grant was issued. The URL has already been
    // resolved and checked by remoteUrl; an outside cwd leaves only the
    // Supervisor's operator configuration. SSH is pinned to the same trusted
    // client and disabled user/repository SSH configuration as the grant.
    const additionalConfig = isSshDestination(destination)
      ? [`core.sshCommand=${shellQuote(await trustedExecutablePath("ssh"))} -F /dev/null`]
      : [];
    const { stdout } = await runSupervisorGit("/", ["ls-remote", "--heads", "--upload-pack=git-upload-pack", "--", destination, branch], { signal, timeout: 60_000, maxBuffer: 256 * 1024, network: true, isolateGlobalConfig: true, additionalConfig });
    const expectedRef = `refs/heads/${branch}`;
    const line = stdout.split("\n").map((entry) => entry.trim()).find((entry) => {
      const fields = entry.split(/\s+/u);
      return fields.length >= 2 && fields[1] === expectedRef;
    });
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
    // This lookup runs while deciding whether a PR grant is safe. Resolve and
    // validate the helper exactly as the later publish command does; a bare
    // `ssh` here would let an untrusted PATH entry influence the repository
    // identity before the grant pins the real helper.
    const sshCommand = await trustedExecutablePath("ssh");
    // Do not consult the mutable user SSH config here. A PR repository name is
    // a grant input, not a reason to let a Worker rewrite Host/HostName in
    // ~/.ssh/config between verification and publication; aliases that need
    // that config remain unresolvable and fail closed.
    const result = await execFileAsync(sshCommand, ["-F", "/dev/null", "-G", "--", alias], { timeout: 10_000, maxBuffer: 64 * 1024, signal, encoding: "buffer", env: { ...remoteReadEnvironment(), SSH_ASKPASS: "" } });
    const line = decodeUtf8(result.stdout).split("\n").find((entry) => entry.startsWith("hostname "));
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
    const result = await runSupervisorGit(cwd, ["cat-file", "-e", `${commit}^{commit}`], { signal, maxBuffer: 1024 });
    return result.stderr.length === 0;
  } catch {
    return false;
  }
}

/** Verify that `ancestor` is reachable from `descendant` (or is `descendant` itself) without invoking a shell. */
export async function repositoryIsAncestor(cwd: string, ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runSupervisorGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], { signal, maxBuffer: 1024 });
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
    const result = await runSupervisorGit(cwd, ["status", "--porcelain", "--untracked-files=all"], { signal, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() === "";
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
      const result = await runSupervisorGit(cwd, args, { signal, maxBuffer: 4096 });
      return result.stdout.trim();
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
    const result = await runSupervisorGit(cwd, ["rev-parse", "--is-inside-work-tree"], { signal, maxBuffer: 1024 });
    const value = result.stdout.trim();
    return value === "true" ? true : value === "false" ? false : undefined;
  } catch {
    return undefined;
  }
}

/** Read the current symbolic branch without invoking a shell. */
export async function repositoryBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await runSupervisorGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { signal, maxBuffer: 1024 });
    const branch = result.stdout.trim();
    return isSafeBranchName(branch) ? branch : undefined;
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
  const result = await runCheck(cwd, check, options);
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
    const result = await runCheck(cwd, check, options);
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
  const [statusResult, diffResult, diffPathsResult, commitsResult, branchResult, untrackedResult, head] = await Promise.all([
    readGitEvidence(cwd, ["status", "--short", "--untracked-files=all"], options.signal),
    // A baseline-relative diff includes committed, staged, and unstaged changes.
    readGitEvidence(cwd, ["diff", "--unified=3", diffRef, "--"], options.signal),
    readGitEvidence(cwd, ["diff", "--name-only", diffRef, "--"], options.signal),
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
    // A changed tracked path with an empty diff means Git refused to expose
    // part of the candidate (attributes, textconv or a binary driver). Never
    // call that evidence complete: the Reviewer must see content or the task
    // must be repaired/parked.
    complete: statusResult.complete && diffResult.complete && diffPathsResult.complete && commitsResult.complete && branchResult.complete && untrackedResult.complete
      && (diffPathsResult.text === "(none)" || diffResult.text !== "(none)"),
    truncated: statusResult.truncated || diffResult.truncated || diffPathsResult.truncated || commitsResult.truncated || branchResult.truncated || untrackedResult.truncated,
    collectedAt: new Date().toISOString(),
  };
}

async function runCheck(cwd: string, check: AcceptanceCheck, options: VerificationOptions): Promise<AcceptanceCheckResult> {
  throwIfAborted(options.signal);
  assertSafeWorkerCommand(check.command, check.args);
  const startedAt = new Date().toISOString();
  const isGit = check.command === "git";
  const args = isGit
    ? await supervisorGitCommandArgs(cwd, check.args, { signal: options.signal, timeout: check.timeoutMs, diff: check.args[0] === "diff" })
    : check.args;
  const result = await runBoundedCommand(check.command, args, {
    cwd,
    timeoutMs: check.timeoutMs,
    signal: options.signal,
    maxOutputBytes: maxOutputBytes(),
    cgroupParentPath: options.cgroupParentPath,
    env: supervisorGitEnvironment(false),
  });
  const finishedAt = new Date().toISOString();
  const output = boundOutput(`${result.stdout}${result.stderr}${result.timedOut ? `\nverification timed out after ${check.timeoutMs}ms` : ""}${result.cancelled ? "\nverification cancelled" : ""}${result.decodeError ? `\nverification output was not valid UTF-8: ${result.decodeError.message}` : ""}${result.cleanupError ? `\nverification cleanup failed: ${result.cleanupError.message}` : ""}`);
  const cancelled = result.cancelled || options.signal?.aborted === true;
  const timedOut = !cancelled && result.timedOut;
  const ok = !cancelled && !timedOut && !result.spawnError && !result.cleanupError && !result.decodeError && result.exitCode === 0 && result.signal === undefined;
  return {
    check,
    status: cancelled ? "cancelled" : timedOut ? "timed_out" : ok ? "passed" : "failed",
    ok,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : ok ? 0 : 1,
    output,
    startedAt,
    finishedAt,
  };
}

interface EvidencePart {
  text: string;
  complete: boolean;
  truncated: boolean;
}

async function readGitEvidence(cwd: string, args: string[], signal?: AbortSignal): Promise<EvidencePart> {
  throwIfAborted(signal);
  try {
    const isDiff = args[0] === "diff";
    const result = await runSupervisorGit(cwd, args, {
      signal,
      maxBuffer: maxExecBufferBytes(),
      diff: isDiff,
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
    const result = await runSupervisorGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], {
      signal,
      maxBuffer: maxOutputBytes(),
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
      await assertNoSymlinkComponents(root, relativePath);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        complete = false;
        sections.push(`--- ${JSON.stringify(path)} [non-regular file omitted]`);
        continue;
      }
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      handle = await open(fullPath, fsConstants.O_RDONLY | noFollow);
      const opened = await handle.stat();
      if (!opened.isFile()) {
        complete = false;
        sections.push(`--- ${JSON.stringify(path)} [non-regular file omitted]`);
        continue;
      }
      if (opened.nlink > 1) {
        complete = false;
        sections.push(`--- ${JSON.stringify(path)} [hard-link file omitted]`);
        continue;
      }
      await assertOpenedEvidencePath(root, handle.fd);
      const buffer = Buffer.alloc(MAX_UNTRACKED_FILE_BYTES + 1);
      const read = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, read.bytesRead);
      if (read.bytesRead > MAX_UNTRACKED_FILE_BYTES) {
        complete = false;
        truncated = true;
      }
      if (bytes.includes(0)) {
        complete = false;
        sections.push(`--- ${JSON.stringify(path)} [binary file omitted]`);
      } else {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          sections.push(`--- ${JSON.stringify(path)}${read.bytesRead > MAX_UNTRACKED_FILE_BYTES ? " [TRUNCATED]" : ""}\n${text}`);
        } catch {
          complete = false;
          sections.push(`--- ${JSON.stringify(path)} [invalid UTF-8 omitted]`);
        }
      }
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
  const parts = relativePath.split(sep).filter(Boolean);
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
  const suffix = utf8Tail(encoded, Math.max(0, maxOutputBytes() - marker.byteLength));
  return { text: `${suffix}${marker.toString("utf8")}`, complete: false, truncated: true };
}

function boundOutput(value: string): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxOutputBytes()) return value;
  const marker = Buffer.from("\n[TRUNCATED]", "utf8");
  const suffix = utf8Tail(encoded, Math.max(0, maxOutputBytes() - marker.byteLength));
  return `${suffix}${marker.toString("utf8")}`;
}

function utf8Tail(value: Buffer, maxBytes: number): string {
  if (value.byteLength <= maxBytes) return value.toString("utf8");
  let start = Math.max(0, value.byteLength - maxBytes);
  while (start < value.byteLength && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start).toString("utf8");
}
