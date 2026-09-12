import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VerificationResult } from "./types.ts";
import { assertSafeWorkerCommand } from "./policy.ts";
import { workerEnvironment } from "./worker/environment.ts";

const execFileAsync = promisify(execFile);

export interface VerificationCommand {
  command: string;
  args?: string[];
}

export async function verify(
  cwd: string,
  command: VerificationCommand = { command: "git", args: ["diff", "--check"] },
  timeoutMs = 120_000,
): Promise<VerificationResult> {
  assertSafeWorkerCommand(command.command, command.args);
  const rendered = [command.command, ...(command.args ?? [])].join(" ");
  try {
    const result = await execFileAsync(command.command, command.args ?? [], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      env: workerEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
    });
    return { ok: true, command: rendered, exitCode: 0, output: `${result.stdout}${result.stderr}`, checkedAt: new Date().toISOString() };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const exitCode = typeof failure.code === "number" ? failure.code : 1;
    return {
      ok: false,
      command: rendered,
      exitCode,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? ""}`.slice(-256 * 1024),
      checkedAt: new Date().toISOString(),
    };
  }
}
