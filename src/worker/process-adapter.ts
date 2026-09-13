import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type {
  WorkerAdapter,
  WorkerCapabilities,
  WorkerHandle,
  PermissionDecision,
  WorkerEventListener,
  WorkerOutputChunk,
  WorkerStartInput,
  WorkerStatus,
} from "../types.ts";
import { assertSafeWorkerCommand } from "../policy.ts";
import { workerEnvironment } from "./environment.ts";

export interface ProcessWorkerAdapterOptions {
  /** Use Claude Code's documented stream-json stdin/stdout framing. */
  mode?: "process-pipe" | "claude-jsonl";
  /** Grace period before the detached process group is force-killed. */
  terminationGraceMs?: number;
  /** Additional wait after force-killing the process group. */
  killGraceMs?: number;
  /** Maximum number of captured output chunks retained per worker. */
  maxOutputChunks?: number;
  /** Maximum UTF-8 bytes of captured output retained per worker. */
  maxOutputBytes?: number;
  /** Maximum time a blocked stdin write may hold lifecycle operations. */
  inputWriteTimeoutMs?: number;
  /** Linux descendant cleanup mode; required is the fail-closed default. */
  cgroupMode?: "off" | "auto" | "required";
}

interface ProcessRecord {
  child: ChildProcess;
  handle: WorkerHandle;
  output: WorkerOutputChunk[];
  outputBytes: number;
  outputTruncated: boolean;
  lastOutputAt?: string;
  lastInputAt?: string;
  activeRequests: number;
  turnSequence: number;
  protocolBuffer: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  spawnError?: Error;
  stdinError?: Error;
  groupCleanup?: Promise<void>;
  groupCleanupComplete?: boolean;
  cleanupError?: Error;
  cgroupPath?: string;
  cgroupError?: Error;
  /** Required cgroup setup failed; process-group cleanup cannot prove descendants are gone. */
  cgroupRequiredUnavailable?: boolean;
  runtimeError?: Error;
  spawned: Promise<void>;
  spawnedSuccessfully: boolean;
  exited: Promise<void>;
  resolveExit: () => void;
  sentKeys: Set<string>;
  inputTail: Promise<void>;
  listeners: Set<WorkerEventListener>;
  permissionResponses: Set<string>;
  stopping?: boolean;
}

/**
 * Minimal dependency-free worker transport.
 *
 * This is deliberately process-pipe, not a PTY. It is suitable for the MVP
 * control boundary and transport spike; PTY support must be added only after
 * its lifecycle and takeover semantics are independently verified.
 */
export class ProcessWorkerAdapter implements WorkerAdapter {
  readonly #records = new Map<string, ProcessRecord>();
  readonly #mode: "process-pipe" | "claude-jsonl";
  readonly #terminationGraceMs: number;
  readonly #killGraceMs: number;
  readonly #maxOutputChunks: number;
  readonly #maxOutputBytes: number;
  readonly #inputWriteTimeoutMs: number;
  readonly #cgroupMode: "off" | "auto" | "required";

  constructor(options: ProcessWorkerAdapterOptions = {}) {
    this.#mode = options.mode ?? "process-pipe";
    this.#terminationGraceMs = boundedDelay(options.terminationGraceMs ?? 2_000);
    this.#killGraceMs = boundedDelay(options.killGraceMs ?? 500);
    this.#maxOutputChunks = boundedPositiveInteger(options.maxOutputChunks ?? 10_000, "maxOutputChunks");
    this.#maxOutputBytes = boundedPositiveInteger(options.maxOutputBytes ?? 8 * 1024 * 1024, "maxOutputBytes");
    this.#inputWriteTimeoutMs = boundedDelay(options.inputWriteTimeoutMs ?? 10_000);
    this.#cgroupMode = options.cgroupMode ?? "required";
  }

  capabilities(): WorkerCapabilities {
    return {
      transport: this.#mode === "claude-jsonl" ? "jsonl" : "process-pipe",
      interactiveInput: true,
      pause: true,
      resumeSession: false,
      processGroupControl: true,
    };
  }

  async start(input: WorkerStartInput): Promise<WorkerHandle> {
    const args = this.#mode === "claude-jsonl" ? claudeJsonlArgs(input.args) : (input.args ?? []);
    assertSafeWorkerCommand(input.command, args, input.approval);
    const handle: WorkerHandle = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      cwd: input.cwd,
    };
    const child = spawn(input.command, args, {
      cwd: input.cwd,
      env: workerEnvironment(process.env, input.env),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    handle.pid = child.pid;
    let resolveSpawn!: () => void;
    let rejectSpawn!: (error: Error) => void;
    const spawned = new Promise<void>((resolve, reject) => {
      resolveSpawn = resolve;
      rejectSpawn = reject;
    });
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const record: ProcessRecord = {
      child,
      handle,
      output: [],
      outputBytes: 0,
      outputTruncated: false,
      activeRequests: input.task ? 1 : 0,
      turnSequence: 0,
      protocolBuffer: "",
      exited,
      resolveExit,
      sentKeys: new Set(),
      groupCleanupComplete: child.pid === undefined,
      spawned,
      spawnedSuccessfully: false,
      inputTail: Promise.resolve(),
      listeners: new Set(input.eventListener ? [input.eventListener] : []),
      permissionResponses: new Set(),
    };
    this.#records.set(handle.id, record);
    const capture = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const text = String(chunk);
      record.lastOutputAt = new Date().toISOString();
      const outputChunk = { stream, text, at: record.lastOutputAt } as WorkerOutputChunk;
      this.#appendOutput(record, outputChunk);
      this.#emit(record, { type: "output", handle: record.handle, chunk: outputChunk });
      if (stream === "stdout" && this.#mode === "claude-jsonl") this.#observeJsonl(record, text);
    };
    child.stdout?.on("data", capture("stdout"));
    child.stderr?.on("data", capture("stderr"));
    child.stdin?.on("error", (error) => {
      record.stdinError = error;
      this.#appendOutput(record, { stream: "stderr", text: `worker stdin error: ${error.message}\n`, at: new Date().toISOString() });
    });
    child.once("spawn", () => {
      record.spawnedSuccessfully = true;
      resolveSpawn();
    });
    child.once("error", (error) => {
      if (!record.spawnedSuccessfully) {
        record.spawnError = error;
        record.exitCode = -1;
        rejectSpawn(error);
        this.#appendOutput(record, { stream: "stderr", text: `worker spawn error: ${error.message}\n`, at: new Date().toISOString() });
        record.activeRequests = 0;
        record.resolveExit();
      } else {
        record.runtimeError = error;
        this.#appendOutput(record, { stream: "stderr", text: `worker runtime error: ${error.message}\n`, at: new Date().toISOString() });
      }
    });
    child.once("exit", (code, signal) => {
      if (!record.spawnError) {
        record.exitCode = code;
        record.signal = signal ?? undefined;
      }
      record.activeRequests = 0;
      this.#emit(record, { type: "exited", handle: record.handle, exitCode: record.exitCode, signal: record.signal });
      record.resolveExit();
      void this.#ensureGroupCleanup(record).catch((error) => {
        record.cleanupError = error instanceof Error ? error : new Error(String(error));
      });
    });
    try {
      await record.spawned;
      await this.#attachCgroup(record);
    } catch (error) {
      try { await this.#ensureGroupCleanup(record); } catch (cleanupError) { record.cleanupError = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)); }
      const startupError = error instanceof Error ? error : new Error(String(error));
      if (record.cleanupError) {
        startupError.message = `${startupError.message}; startup cleanup failed: ${record.cleanupError.message}`;
        Object.defineProperty(startupError, "workerHandle", { value: handle, enumerable: false });
        Object.defineProperty(startupError, "workerCleanupRequired", { value: true, enumerable: false });
      }
      throw startupError;
    }
    if (input.task) {
      record.lastInputAt = new Date().toISOString();
      try {
        await this.#writeInput(record, this.#encodeMessage(input.task));
      } catch (error) {
        let cleanupError: unknown;
        try { await this.stop(handle, "initial worker input failed"); }
        catch (stopError) { cleanupError = stopError; }
        if (cleanupError) {
          const startupError = error instanceof Error ? error : new Error(String(error));
          startupError.message = `${startupError.message}; startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
          Object.defineProperty(startupError, "workerHandle", { value: handle, enumerable: false });
          Object.defineProperty(startupError, "workerCleanupRequired", { value: true, enumerable: false });
          throw startupError;
        }
        throw error;
      }
    }
    return handle;
  }

  async getStatus(handle: WorkerHandle): Promise<WorkerStatus> {
    const record = this.#record(handle);
    const running = record.exitCode === undefined;
    if (!running && record.groupCleanup) {
      try {
        await record.groupCleanup;
      } catch (error) {
        record.cleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
    return {
      handle: record.handle,
      running,
      exitCode: record.exitCode,
      signal: record.signal,
      lastOutputAt: record.lastOutputAt,
      lastInputAt: record.lastInputAt,
      activeRequests: this.#mode === "claude-jsonl" ? record.activeRequests : undefined,
      exitReason: running ? undefined : record.signal ? "crashed" : record.exitCode === 0 ? "completed" : "failed",
      processGroupCleaned: record.groupCleanupComplete,
      cgroupCleaned: record.cgroupPath ? record.groupCleanupComplete : undefined,
      cgroupError: record.cgroupError?.message,
      cleanupError: record.cleanupError?.message,
      runtimeError: record.runtimeError?.message,
      outputTruncated: record.outputTruncated,
    };
  }

  subscribe(handle: WorkerHandle, listener: WorkerEventListener): () => void {
    const record = this.#record(handle);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  async respondPermission(handle: WorkerHandle, requestId: string, toolUseId: string, decision: PermissionDecision, updatedInput?: unknown): Promise<void> {
    const record = this.#record(handle);
    if (this.#mode !== "claude-jsonl") throw new Error("permission responses require claude-jsonl transport");
    if (record.permissionResponses.has(requestId)) return;
    if (record.exitCode !== undefined) throw new Error("worker is not running");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = record.inputTail;
    record.inputTail = previous.then(() => gate);
    await previous;
    try {
      if (record.stopping) throw new Error("worker is stopping");
      if (record.exitCode !== undefined) throw new Error("worker is not running");
      const response = {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: decision.behavior === "allow"
            ? { behavior: "allow", updatedInput }
            : { behavior: "deny", message: decision.message ?? "permission denied by supervisor" },
          toolUseID: toolUseId,
        },
      };
      await this.#writeInput(record, `${JSON.stringify(response)}\n`);
      record.permissionResponses.add(requestId);
      record.lastInputAt = new Date().toISOString();
    } finally {
      release();
    }
  }

  async readOutput(handle: WorkerHandle): Promise<WorkerOutputChunk[]> {
    const record = this.#record(handle);
    const output = record.output.splice(0);
    return output;
  }

  async restoreOutput(handle: WorkerHandle, chunks: WorkerOutputChunk[]): Promise<void> {
    const record = this.#record(handle);
    const pending = [...chunks, ...record.output];
    record.output = [];
    record.outputBytes = 0;
    for (const chunk of pending) this.#appendOutput(record, chunk);
  }

  async send(handle: WorkerHandle, message: string, idempotencyKey: string): Promise<void> {
    const record = this.#record(handle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = record.inputTail;
    record.inputTail = previous.then(() => gate);
    await previous;
    try {
      if (record.stopping) throw new Error("worker is stopping");
      if (record.sentKeys.has(idempotencyKey)) return;
      if (record.exitCode !== undefined) throw new Error("worker is not running");
      if (this.#mode === "claude-jsonl") record.activeRequests += 1;
      try {
        await this.#writeInput(record, this.#encodeMessage(message));
      } catch (error) {
        if (this.#mode === "claude-jsonl") record.activeRequests = Math.max(0, record.activeRequests - 1);
        throw error;
      }
      record.sentKeys.add(idempotencyKey);
      record.lastInputAt = new Date().toISOString();
    } finally {
      release();
    }
  }

  async pause(handle: WorkerHandle): Promise<void> {
    this.#signal(handle, "SIGSTOP");
  }

  async resume(handle: WorkerHandle): Promise<void> {
    this.#signal(handle, "SIGCONT");
  }

  async stop(handle: WorkerHandle, _reason: string): Promise<void> {
    const record = this.#record(handle);
    record.stopping = true;
    await Promise.race([record.inputTail, delay(this.#terminationGraceMs)]);
    if (record.exitCode === undefined) {
      record.child.kill("SIGTERM");
      await Promise.race([record.exited, delay(this.#terminationGraceMs)]);
    }
    // The leader may have exited while descendants remain in its detached group.
    // Always clean the group so stop is also an orphan cleanup operation.
    await this.killProcessGroup(handle, "worker stop cleanup");
    await Promise.race([record.exited, delay(this.#killGraceMs)]);
  }

  async killProcessGroup(handle: WorkerHandle, _reason: string): Promise<void> {
    const record = this.#record(handle);
    await this.#ensureGroupCleanup(record);
  }

  async resumeSession(_sessionId: string): Promise<WorkerHandle> {
    throw new Error("process-pipe transport does not support session resume");
  }

  async #writeInput(record: ProcessRecord, message: string): Promise<void> {
    const stdin = record.child.stdin;
    if (record.stdinError) throw new Error(`worker stdin is unavailable: ${record.stdinError.message}`);
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw new Error("worker stdin is unavailable");
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const onError = (error: Error) => {
        clearTimeout(timeout);
        stdin.off("error", onError);
        reject(error);
      };
      stdin.once("error", onError);
      timeout = setTimeout(() => {
        stdin.off("error", onError);
        reject(new Error("worker stdin write timed out"));
      }, this.#inputWriteTimeoutMs);
      try {
        stdin.write(message, (error?: Error | null) => {
          clearTimeout(timeout);
          stdin.off("error", onError);
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        clearTimeout(timeout);
        stdin.off("error", onError);
        reject(error);
      }
    });
  }

  #encodeMessage(message: string): string {
    if (this.#mode === "claude-jsonl") {
      return `${JSON.stringify({ type: "user", message: { role: "user", content: message } })}\n`;
    }
    return `${message}\n`;
  }

  #observeJsonl(record: ProcessRecord, chunk: string): void {
    record.protocolBuffer += chunk;
    let newline = record.protocolBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = record.protocolBuffer.slice(0, newline).trim();
      record.protocolBuffer = record.protocolBuffer.slice(newline + 1);
      if (line) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          this.#emit(record, { type: "jsonl", handle: record.handle, record: event });
          if (event.type === "control_request") {
            const request = event.request;
            if (isPermissionRequest(event, request)) {
              this.#emit(record, {
                type: "permission_request",
                handle: record.handle,
                request: {
                  requestId: String(event.request_id),
                  toolUseId: request.tool_use_id,
                  toolName: request.tool_name,
                  input: request.input,
                  raw: event,
                },
              });
            }
          }
          if (event.type === "result") {
            record.activeRequests = Math.max(0, record.activeRequests - 1);
            record.turnSequence += 1;
            this.#emit(record, { type: "turn_completed", handle: record.handle, result: event, sequence: record.turnSequence });
          }
        } catch {
          // Keep raw output for diagnostics; malformed output is not a completion signal.
        }
      }
      newline = record.protocolBuffer.indexOf("\n");
    }
  }

  #emit(record: ProcessRecord, event: Parameters<WorkerEventListener>[0]): void {
    for (const listener of record.listeners) {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch(() => { /* event consumers must not affect the worker */ });
        }
      } catch {
        // Event consumers are observers; transport lifecycle must continue.
      }
    }
  }

  #appendOutput(record: ProcessRecord, chunk: WorkerOutputChunk): void {
    let text = chunk.text;
    if (Buffer.byteLength(text, "utf8") > this.#maxOutputBytes) {
      text = Buffer.from(text, "utf8").subarray(-this.#maxOutputBytes).toString("utf8");
      record.outputTruncated = true;
    }
    const retained = { ...chunk, text };
    record.output.push(retained);
    record.outputBytes += Buffer.byteLength(text, "utf8");
    while (record.output.length > this.#maxOutputChunks || record.outputBytes > this.#maxOutputBytes) {
      const removed = record.output.shift();
      if (!removed) break;
      record.outputBytes -= Buffer.byteLength(removed.text, "utf8");
      record.outputTruncated = true;
    }
  }

  async #attachCgroup(record: ProcessRecord): Promise<void> {
    if (this.#cgroupMode === "off") return;
    let path: string | undefined;
    try {
      if (process.platform !== "linux") throw new Error("cgroup v2 descendant cleanup requires Linux");
      if (!record.handle.pid) throw new Error("worker PID is unavailable for cgroup attachment");
      const parent = await currentCgroupPath();
      path = `${parent}/pi-claude-supervisor-${record.handle.id}`;
      await mkdir(path);
      await writeFile(`${path}/cgroup.procs`, `${record.handle.pid}\n`);
      record.cgroupPath = path;
    } catch (error) {
      if (path) await rm(path, { recursive: true, force: true }).catch(() => {});
      record.cgroupError = error instanceof Error ? error : new Error(String(error));
      if (this.#cgroupMode === "required") {
        // A fast-exiting leader may have started best-effort cleanup from its
        // exit handler before attachment failed. Invalidate that result: a
        // required boundary failure must never inherit a fallback success.
        record.cgroupRequiredUnavailable = true;
        record.groupCleanupComplete = false;
        record.groupCleanup = undefined;
        throw new Error(`unable to attach worker to a cgroup: ${record.cgroupError.message}`, { cause: record.cgroupError });
      }
    }
  }

  #record(handle: WorkerHandle): ProcessRecord {
    const record = this.#records.get(handle.id);
    if (!record) throw new Error(`unknown worker handle: ${handle.id}`);
    return record;
  }

  #ensureGroupCleanup(record: ProcessRecord): Promise<void> {
    if (record.groupCleanup) return record.groupCleanup;
    record.cleanupError = undefined;
    const cleanup = this.#cleanupProcessGroup(record);
    record.groupCleanup = cleanup.catch((error) => {
      // A timed-out cleanup must remain retryable; callers such as shutdown
      // may have a later opportunity to reap the group.
      record.groupCleanup = undefined;
      throw error;
    });
    return record.groupCleanup;
  }

  async #cleanupProcessGroup(record: ProcessRecord): Promise<void> {
    if (record.cgroupRequiredUnavailable) {
      await this.#bestEffortProcessGroupKill(record);
      throw new Error(`required cgroup cleanup was unavailable; descendant cleanup is not confirmed${record.cgroupError ? `: ${record.cgroupError.message}` : ""}`);
    }
    if (record.cgroupPath) {
      await cleanupCgroup(record.cgroupPath, this.#killGraceMs);
      record.groupCleanupComplete = true;
      return;
    }
    await this.#bestEffortProcessGroupKill(record);
    record.groupCleanupComplete = true;
  }

  async #bestEffortProcessGroupKill(record: ProcessRecord): Promise<void> {
    const pid = record.handle.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !/ESRCH/u.test(error.message)) throw error;
      return;
    }
    const deadline = Date.now() + this.#killGraceMs;
    while (Date.now() <= deadline) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (error instanceof Error && /ESRCH/u.test(error.message)) return;
        throw error;
      }
      await delay(Math.min(10, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`worker process group ${pid} did not exit before cleanup deadline`);
  }

  #signal(handle: WorkerHandle, signal: NodeJS.Signals): void {
    const record = this.#record(handle);
    if (record.exitCode !== undefined || !record.handle.pid) return;
    process.kill(-record.handle.pid, signal);
  }
}

function claudeJsonlArgs(args: readonly string[] = []): string[] {
  const result = [...args];
  if (!result.includes("-p") && !result.includes("--print")) result.push("-p");
  ensureOption(result, "--input-format", "stream-json");
  ensureOption(result, "--output-format", "stream-json");
  ensureOption(result, "--permission-prompt-tool", "stdio");
  if (!result.includes("--verbose")) result.push("--verbose");
  return result;
}

function ensureOption(args: string[], option: string, expected: string): void {
  const index = args.indexOf(option);
  if (index < 0) {
    args.push(option, expected);
    return;
  }
  if (args[index + 1] !== expected) throw new Error(`${option} must be ${expected} in claude-jsonl mode`);
}

async function currentCgroupPath(): Promise<string> {
  const contents = await readFile("/proc/self/cgroup", "utf8");
  const match = contents.match(/^0::([^\n]*)$/mu);
  if (!match) throw new Error("cgroup v2 is not active");
  // /proc/self/cgroup uses the same escaped component spelling as the cgroup
  // filesystem (for example, a literal `\\x2d` in a systemd scope name).
  return `/sys/fs/cgroup${match[1]}`;
}

async function cleanupCgroup(path: string, graceMs: number): Promise<void> {
  try {
    await writeFile(`${path}/cgroup.kill`, "1\n");
  } catch (error) {
    if (error instanceof Error && /ENOENT/u.test(error.message)) return;
    throw error;
  }
  // cgroup.kill is asynchronous and the kernel may need more than the
  // process-group grace period to reap descendants under load. Keep the
  // cleanup bounded, but do not make a 25/100ms test or embedding delay the
  // deadline for the descendant boundary itself.
  const deadline = Date.now() + Math.max(graceMs, 2_000);
  while (Date.now() <= deadline) {
    try {
      const events = await readFile(`${path}/cgroup.events`, "utf8");
      if (/^populated 0$/mu.test(events)) {
        await rm(path, { recursive: true, force: true });
        return;
      }
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) return;
      throw error;
    }
    await delay(Math.min(10, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`worker cgroup ${path} did not empty before cleanup deadline`);
}

function isPermissionRequest(event: Record<string, unknown>, request: unknown): request is { subtype: "can_use_tool"; tool_use_id: string; tool_name: string; input: unknown } {
  if (event.type !== "control_request" || typeof event.request_id !== "string" || !request || typeof request !== "object") return false;
  const value = request as { subtype?: unknown; tool_use_id?: unknown; tool_name?: unknown; input?: unknown };
  return value.subtype === "can_use_tool"
    && typeof value.tool_use_id === "string"
    && typeof value.tool_name === "string"
    && "input" in value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("process termination delays must be finite and non-negative");
  return value;
}

function boundedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
