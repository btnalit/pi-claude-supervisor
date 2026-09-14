import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AcceptanceCheck, AcceptanceCheckResult, AcceptanceReport, VerificationResult } from "./types.ts";
import { assertSafeWorkerCommand } from "./policy.ts";
import { workerEnvironment } from "./worker/environment.ts";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface VerificationCommand {
  command: string;
  args?: string[];
}

export interface RepositoryEvidence {
  status: string;
  diff: string;
  collectedAt: string;
}

export async function verify(
  cwd: string,
  command: VerificationCommand = { command: "git", args: ["diff", "--check"] },
  timeoutMs = 120_000,
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
  const result = await runCheck(cwd, check);
  return {
    ok: result.ok,
    command: [check.command, ...check.args].join(" "),
    exitCode: result.exitCode,
    output: result.output,
    checkedAt: result.finishedAt,
  };
}

export async function verifyAll(cwd: string, checks: readonly AcceptanceCheck[]): Promise<AcceptanceReport> {
  if (checks.length === 0) throw new Error("at least one acceptance check is required");
  const results: AcceptanceCheckResult[] = [];
  for (const check of checks) results.push(await runCheck(cwd, check));
  const ok = results.every((result) => !result.check.required || result.ok);
  const firstFailure = results.find((result) => result.check.required && !result.ok);
  return {
    ok,
    command: "acceptance checks",
    exitCode: firstFailure?.exitCode ?? 0,
    output: boundOutput(results.map(formatCheckResult).join("\n\n")),
    checkedAt: new Date().toISOString(),
    checks: results,
  };
}

/** Collect bounded repository evidence for the independent read-only Reviewer. */
export async function collectRepositoryEvidence(cwd: string): Promise<RepositoryEvidence> {
  const [status, diff] = await Promise.all([
    readGitEvidence(cwd, ["status", "--short", "--untracked-files=all"]),
    readGitEvidence(cwd, ["diff", "--no-ext-diff", "--unified=3"]),
  ]);
  return { status, diff, collectedAt: new Date().toISOString() };
}

async function runCheck(cwd: string, check: AcceptanceCheck): Promise<AcceptanceCheckResult> {
  assertSafeWorkerCommand(check.command, check.args);
  const startedAt = new Date().toISOString();
  try {
    const result = await execFileAsync(check.command, check.args, {
      cwd,
      timeout: check.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
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
    const failure = error as { code?: number | string; signal?: string; stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const finishedAt = new Date().toISOString();
    const timedOut = failure.killed === true || failure.signal === "SIGTERM" || failure.code === "ETIMEDOUT";
    const exitCode = typeof failure.code === "number" ? failure.code : 1;
    return {
      check,
      status: timedOut ? "timed_out" : "failed",
      ok: false,
      exitCode,
      output: boundOutput(`${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? ""}`),
      startedAt,
      finishedAt,
    };
  }
}

async function readGitEvidence(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    return boundOutput(`${result.stdout}${result.stderr}`) || "(none)";
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return boundOutput(`${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? "git evidence unavailable"}`);
  }
}

function formatCheckResult(result: AcceptanceCheckResult): string {
  return `[${result.status}] ${result.check.id}: ${result.check.command} ${result.check.args.join(" ")}\n${result.output || "(no output)"}`;
}

function boundOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES) return value;
  return `${Buffer.from(value, "utf8").subarray(-MAX_OUTPUT_BYTES).toString("utf8")}\n[TRUNCATED]`;
}
