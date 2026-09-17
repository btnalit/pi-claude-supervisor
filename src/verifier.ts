import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AcceptanceCheck, AcceptanceCheckResult, AcceptanceReport, VerificationResult } from "./types.ts";
import { evidenceMaxBytes, evidenceMaxUntrackedFiles } from "./config.ts";
import { assertSafeWorkerCommand } from "./policy.ts";
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
    return /^[0-9a-f]{40,64}$/u.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/** Verify that a full commit object is still present without invoking a shell. */
export async function repositoryCommitExists(cwd: string, commit: string, signal?: AbortSignal): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/iu.test(commit)) return false;
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
  const [statusResult, diffResult, commitsResult, branchResult, untrackedResult] = await Promise.all([
    readGitEvidence(cwd, ["status", "--short", "--untracked-files=all"], options.signal),
    // A baseline-relative diff includes committed, staged, and unstaged changes.
    readGitEvidence(cwd, ["diff", "--no-ext-diff", "--unified=3", diffRef, "--"], options.signal),
    readGitEvidence(cwd, commitArgs, options.signal),
    readGitEvidence(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], options.signal),
    collectUntrackedEvidence(cwd, options.signal),
  ]);
  throwIfAborted(options.signal);
  return {
    status: statusResult.text,
    diff: diffResult.text,
    commits: commitsResult.text,
    untracked: untrackedResult.text,
    ...(baseRef ? { baseRef } : {}),
    ...(branchResult.text.trim() !== "(none)" ? { branch: branchResult.text.trim() } : {}),
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
        sections.push(`--- ${JSON.stringify(path)}${read.bytesRead > MAX_UNTRACKED_FILE_BYTES ? " [TRUNCATED]" : ""}\n${bytes.toString("utf8")}`);
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
