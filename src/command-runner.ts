import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, mkdir, rmdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { cleanupCgroup, processGroupHasLiveMember } from "./worker/process-adapter.ts";
import { nodeScriptCommand } from "./worker/runtime.ts";

const COMMAND_CGROUP_ENV = "PI_CLAUDE_SUPERVISOR_INTERNAL_VERIFICATION_CGROUP";
const COMMAND_CGROUP_GUARDIAN = String.raw`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const cgroup = process.env.${COMMAND_CGROUP_ENV};
const command = process.argv[1];
let args;
try { args = JSON.parse(process.argv[2] || "[]"); } catch { process.exit(125); }
if (!cgroup || typeof command !== "string" || !Array.isArray(args) || args.some((value) => typeof value !== "string")) process.exit(125);
try { writeFileSync(cgroup + "/cgroup.procs", String(process.pid) + "\n"); } catch (error) {
  process.stderr.write("verification cgroup attachment failed: " + String(error) + "\n");
  process.exit(125);
}
const childEnvironment = { ...process.env };
delete childEnvironment.${COMMAND_CGROUP_ENV};
const child = spawn(command, args, { cwd: process.cwd(), env: childEnvironment, stdio: ["ignore", "inherit", "inherit"] });
for (const signal of ["SIGTERM", "SIGINT", "SIGQUIT"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
child.once("error", (error) => { process.stderr.write(String(error) + "\n"); process.exit(127); });
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    setTimeout(() => process.exit(1), 100);
  } else process.exit(code === null ? 1 : code);
});
`;

export interface BoundedCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes: number;
  /** A Supervisor-owned cgroup parent. The command gets a fresh child group. */
  cgroupParentPath?: string;
}

interface ProcessGroupIdentity {
  startTime: string;
  pgid: number;
}

export interface BoundedCommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: Error;
  cleanupError?: Error;
  decodeError?: Error;
  outputTruncated: boolean;
}

/**
 * Run an acceptance command in its own process group and, when supplied, a
 * fresh cgroup. The cgroup is deliberately owned by this command runner: a
 * Worker cannot retain a daemon after a timeout or make verification escape
 * the Worker's descendant boundary.
 */
export async function runBoundedCommand(command: string, args: readonly string[], options: BoundedCommandOptions): Promise<BoundedCommandResult> {
  let cgroupPath: string | undefined;
  let cancelled = options.signal?.aborted === true;
  let setupAbortRequested = cancelled;
  let cleanupForAbort: ((reason: string) => Promise<void>) | undefined;
  const onAbort = () => {
    cancelled = true;
    setupAbortRequested = true;
    if (cleanupForAbort) void cleanupForAbort("verification cancelled");
  };
  const removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
  if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
  if (setupAbortRequested) {
    removeAbortListener();
    return {
      stdout: "",
      stderr: "verification cancelled",
      exitCode: 1,
      timedOut: false,
      cancelled: true,
      outputTruncated: false,
    };
  }
  try {
    cgroupPath = options.cgroupParentPath ? await createCommandCgroup(options.cgroupParentPath) : undefined;
  } catch (error) {
    removeAbortListener();
    return {
      stdout: "",
      stderr: `verification cgroup could not be created: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
      timedOut: false,
      cancelled,
      cleanupError: error instanceof Error ? error : new Error(String(error)),
      outputTruncated: false,
    };
  }
  if (setupAbortRequested || options.signal?.aborted === true) {
    cancelled = true;
    const cleanupError = await removeCommandCgroup(cgroupPath);
    removeAbortListener();
    return {
      stdout: "",
      stderr: "verification cancelled",
      exitCode: 1,
      timedOut: false,
      cancelled: true,
      ...(cleanupError ? { cleanupError } : {}),
      outputTruncated: false,
    };
  }

  let child: ChildProcess;
  try {
    const guarded = cgroupPath !== undefined;
    const childEnvironment = guarded
      ? { ...options.env, [COMMAND_CGROUP_ENV]: cgroupPath }
      : options.env;
    child = spawn(guarded ? nodeScriptCommand() : command, guarded
      ? ["-e", COMMAND_CGROUP_GUARDIAN, command, JSON.stringify(args)]
      : [...args], {
      cwd: options.cwd,
      env: childEnvironment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const cleanupError = await removeCommandCgroup(cgroupPath);
    removeAbortListener();
    return {
      stdout: "",
      stderr: `verification command could not start: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
      timedOut: false,
      cancelled,
      spawnError: error instanceof Error ? error : new Error(String(error)),
      ...(cleanupError ? { cleanupError } : {}),
      outputTruncated: false,
    };
  }

  const processGroupIdentity = child.pid !== undefined && process.platform === "linux" ? readProcessGroupIdentitySync(child.pid) : undefined;
  let stdout = "";
  let stderr = "";
  let outputTruncated = false;
  let decodeError: Error | undefined;
  const decoders = { stdout: new TextDecoder("utf-8", { fatal: true }), stderr: new TextDecoder("utf-8", { fatal: true }) };
  const append = (stream: "stdout" | "stderr", text: string): void => {
    const current = stream === "stdout" ? stdout : stderr;
    const joined = current + text;
    const encoded = Buffer.from(joined, "utf8");
    let next = joined;
    if (encoded.byteLength > options.maxOutputBytes) {
      next = utf8Tail(encoded, options.maxOutputBytes);
      outputTruncated = true;
    }
    if (stream === "stdout") stdout = next;
    else stderr = next;
  };
  const appendBytes = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
    const decoder = decoders[stream];
    try {
      append(stream, decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true }));
    } catch (error) {
      decodeError ??= error instanceof Error ? error : new Error(String(error));
      append(stream, "[invalid UTF-8 output]\n");
      void cleanupForAbort?.("invalid UTF-8 output");
    }
  };
  child.stdout?.on("data", (chunk) => appendBytes("stdout", chunk));
  child.stderr?.on("data", (chunk) => appendBytes("stderr", chunk));
  const flushDecoders = (): void => {
    for (const [stream, decoder] of Object.entries(decoders) as Array<["stdout" | "stderr", TextDecoder]>) {
      try { append(stream, decoder.decode()); }
      catch (error) { decodeError ??= error instanceof Error ? error : new Error(String(error)); }
    }
  };

  let exitCode: number | null | undefined;
  let exitSignal: NodeJS.Signals | undefined;
  let spawnError: Error | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  let resolveClose!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClose = resolve; });
  child.once("error", (error) => {
    spawnError = error;
    if (exitCode === undefined) exitCode = -1;
    resolveExit();
  });
  child.once("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal ?? undefined;
    resolveExit();
    void cleanupForAbort?.("leader exit");
  });
  child.once("close", () => resolveClose());

  let timedOut = false;
  let cleanupStarted = false;
  let cleanupPromise: Promise<void> | undefined;
  const ensureCleanup = (reason: string): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupStarted = true;
    cleanupPromise = cleanupCommandBoundary(child, cgroupPath, processGroupIdentity, reason, exited, options.timeoutMs).catch((error) => {
      throw error instanceof Error ? error : new Error(String(error));
    });
    return cleanupPromise;
  };
  cleanupForAbort = ensureCleanup;
  if (setupAbortRequested || Boolean(options.signal?.aborted)) {
    cancelled = true;
    void ensureCleanup("verification cancelled");
  }
  const timer = setTimeout(() => {
    timedOut = true;
    void ensureCleanup("verification timeout");
  }, options.timeoutMs);

  // The boundary cleanup starts from the exit event, so descendants which keep
  // stdout/stderr open are killed before close() is awaited. The extra bound
  // prevents a broken pipe from keeping the Supervisor waiting forever.
  await Promise.race([closed, delay(options.timeoutMs + 2_000)]);
  clearTimeout(timer);
  if (!cleanupStarted) void ensureCleanup("verification complete");
  let cleanupError: Error | undefined;
  try {
    await cleanupPromise;
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }
  await Promise.race([closed, delay(1_000)]);
  flushDecoders();
  removeAbortListener();
  if (spawnError && !stderr.includes(spawnError.message)) stderr += `\n${spawnError.message}`;
  return { stdout, stderr, exitCode, signal: exitSignal, timedOut, cancelled, ...(spawnError ? { spawnError } : {}), ...(cleanupError ? { cleanupError } : {}), ...(decodeError ? { decodeError } : {}), outputTruncated };
}

async function createCommandCgroup(parent: string): Promise<string> {
  if (process.platform !== "linux") throw new Error("verification cgroups are only available on Linux");
  const path = `${parent}/pi-claude-supervisor-verification-${process.pid}-${randomUUID()}`;
  await mkdir(path);
  try {
    await access(`${path}/cgroup.procs`, fsConstants.R_OK | fsConstants.W_OK);
    await access(`${path}/cgroup.events`, fsConstants.R_OK);
    await access(`${path}/cgroup.kill`, fsConstants.W_OK);
    return path;
  } catch (error) {
    // The directory was created by this invocation, but the caller has not
    // received its path yet. Remove it directly first: a failed control-file
    // preflight may be exactly the case where cgroup.kill is unavailable.
    try {
      await rmdir(path);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Error && /ENOENT/u.test(cleanupError.message))) {
        await removeCommandCgroup(path);
      }
    }
    throw error;
  }
}

async function cleanupCommandBoundary(child: ChildProcess, cgroupPath: string | undefined, identity: ProcessGroupIdentity | undefined, _reason: string, exited: Promise<void>, timeoutMs: number): Promise<void> {
  const pid = child.pid;
  if (pid !== undefined && (process.platform !== "linux" || (identity && await processGroupIdentityMatches(pid, identity)))) {
    try { process.kill(-pid, "SIGTERM"); } catch (error) {
      if (!(error instanceof Error) || !/ESRCH/u.test(error.message)) throw error;
    }
  }
  if (cgroupPath) {
    try { await writeFile(`${cgroupPath}/cgroup.kill`, "1\n"); }
    catch (error) {
      if (!(error instanceof Error && /ENOENT/u.test(error.message))) throw error;
    }
  }
  await Promise.race([exited, delay(Math.min(250, Math.max(25, timeoutMs))) ]);
  if (pid !== undefined && (process.platform !== "linux" || (identity && await processGroupIdentityMatches(pid, identity)))) {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) {
      if (!(error instanceof Error) || !/ESRCH/u.test(error.message)) throw error;
    }
  }
  if (cgroupPath) {
    try { await writeFile(`${cgroupPath}/cgroup.kill`, "1\n"); }
    catch (error) {
      if (!(error instanceof Error && /ENOENT/u.test(error.message))) throw error;
    }
    await cleanupCgroup(cgroupPath, Math.max(500, Math.min(2_000, timeoutMs))).catch((error) => { throw error; });
  }
  if (pid !== undefined && process.platform === "linux" && !identity && cgroupPath === undefined) throw new Error(`verification process-group identity was unavailable for ${pid}`);
  if (pid !== undefined && (process.platform !== "linux" || (identity && await processGroupIdentityMatches(pid, identity)))) {
    const deadline = Date.now() + 500;
    while (Date.now() <= deadline) {
      if (!await processGroupHasLiveMember(pid)) return;
      await delay(10);
    }
    throw new Error(`verification process group ${pid} did not exit before cleanup deadline`);
  }
}

async function removeCommandCgroup(path: string | undefined): Promise<Error | undefined> {
  if (!path) return undefined;
  try {
    await cleanupCgroup(path, 500);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function readProcessGroupIdentitySync(pid: number): ProcessGroupIdentity | undefined {
  try {
    const statText = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    const fields = closeParen >= 0 ? statText.slice(closeParen + 2).trim().split(/\s+/u) : [];
    const pgid = Number(fields[2]);
    const startTime = fields[19];
    return Number.isSafeInteger(pgid) && pgid === pid && /^\d+$/u.test(startTime ?? "") ? { pgid, startTime: startTime! } : undefined;
  } catch {
    return undefined;
  }
}

async function processGroupIdentityMatches(pid: number, expected: ProcessGroupIdentity): Promise<boolean> {
  const current = readProcessGroupIdentitySync(pid);
  if (!current) return false;
  if (current.pgid !== expected.pgid || current.startTime !== expected.startTime) throw new Error(`verification process-group identity changed for ${pid}`);
  return true;
}

function utf8Tail(value: Buffer, maxBytes: number): string {
  let start = Math.max(0, value.byteLength - maxBytes);
  while (start < value.byteLength && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
