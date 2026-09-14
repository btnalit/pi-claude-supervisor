import { createHash, randomUUID } from "node:crypto";
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
  /** Maximum UTF-8 bytes retained for an incomplete Claude JSONL record. */
  maxProtocolBufferBytes?: number;
  /** Maximum time a blocked stdin write may hold lifecycle operations. */
  inputWriteTimeoutMs?: number;
  /** Linux descendant cleanup mode; auto uses cgroup v2 when available. */
  cgroupMode?: "off" | "auto" | "required";
  /** Override the detected cgroup parent for controlled integration tests. */
  cgroupParentPath?: string;
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
  requestSequence: number;
  activeRequestSequence?: number;
  seenResultIds: Set<string>;
  seenPermissionRequestIds: Set<string>;
  protocolBuffer: string;
  discardProtocolLine: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  spawnError?: Error;
  stdinError?: Error;
  groupCleanup?: Promise<void>;
  groupCleanupComplete?: boolean;
  cleanupError?: Error;
  cgroupPath?: string;
  cgroupError?: Error;
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
  starting: boolean;
  abortRequested: boolean;
  startupToken?: string;
  abortListener?: () => void;
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
  readonly #maxProtocolBufferBytes: number;
  readonly #inputWriteTimeoutMs: number;
  readonly #cgroupMode: "off" | "auto" | "required";
  readonly #cgroupParentPath?: string;

  constructor(options: ProcessWorkerAdapterOptions = {}) {
    this.#mode = options.mode ?? "process-pipe";
    this.#terminationGraceMs = boundedDelay(options.terminationGraceMs ?? 2_000);
    this.#killGraceMs = boundedDelay(options.killGraceMs ?? 500);
    this.#maxOutputChunks = boundedPositiveInteger(options.maxOutputChunks ?? 10_000, "maxOutputChunks");
    this.#maxOutputBytes = boundedPositiveInteger(options.maxOutputBytes ?? 8 * 1024 * 1024, "maxOutputBytes");
    this.#maxProtocolBufferBytes = boundedPositiveInteger(options.maxProtocolBufferBytes ?? 256 * 1024, "maxProtocolBufferBytes");
    this.#inputWriteTimeoutMs = boundedDelay(options.inputWriteTimeoutMs ?? 10_000);
    this.#cgroupMode = options.cgroupMode ?? "auto";
    this.#cgroupParentPath = options.cgroupParentPath;
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
    if (input.abortSignal?.aborted) throw new Error("worker startup aborted before spawn");
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
      requestSequence: input.task ? 1 : 0,
      activeRequestSequence: input.task ? 1 : undefined,
      seenResultIds: new Set(),
      seenPermissionRequestIds: new Set(),
      protocolBuffer: "",
      discardProtocolLine: false,
      exited,
      resolveExit,
      sentKeys: new Set(),
      groupCleanupComplete: child.pid === undefined,
      spawned,
      spawnedSuccessfully: false,
      inputTail: Promise.resolve(),
      listeners: new Set(input.eventListener ? [input.eventListener] : []),
      permissionResponses: new Set(),
      starting: true,
      abortRequested: false,
      startupToken: input.startupToken,
    };
    const abortListener = () => {
      record.abortRequested = true;
      record.stopping = true;
      if (record.exitCode === undefined) {
        try { record.child.kill("SIGTERM"); } catch { /* cleanup below remains authoritative */ }
      }
    };
    record.abortListener = abortListener;
    input.abortSignal?.addEventListener("abort", abortListener, { once: true });
    this.#records.set(handle.id, record);
    if (input.abortSignal?.aborted) abortListener();
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
      try {
        await record.spawned;
        this.#assertNotAborted(record);
        await this.#attachCgroup(record);
        this.#assertNotAborted(record);
      } catch (error) {
        try {
          await this.#ensureGroupCleanup(record);
        } catch (cleanupError) {
          record.cleanupError = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        }
        const startupError = error instanceof Error ? error : new Error(String(error));
        if (record.cleanupError) {
          startupError.message = `${startupError.message}; startup cleanup failed: ${record.cleanupError.message}`;
          Object.defineProperty(startupError, "workerHandle", { value: handle, enumerable: false });
          Object.defineProperty(startupError, "workerCleanupRequired", { value: true, enumerable: false });
        }
        throw startupError;
      }
      if (input.task) {
        this.#assertNotAborted(record);
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
    } finally {
      record.starting = false;
      if (record.abortListener) input.abortSignal?.removeEventListener("abort", record.abortListener);
      record.abortListener = undefined;
    }
  }

  async abortStart(reason = "startup aborted", startupToken?: string): Promise<void> {
    const records = [...this.#records.values()].filter((record) => record.starting && (startupToken === undefined || record.startupToken === startupToken));
    for (const record of records) {
      record.abortRequested = true;
      record.stopping = true;
      if (record.exitCode === undefined) {
        try { record.child.kill("SIGTERM"); } catch { /* cleanup below remains authoritative */ }
      }
    }
    const deadline = Date.now() + Math.max(this.#terminationGraceMs, 1_000);
    while (records.some((record) => record.starting) && Date.now() < deadline) await delay(10);
    for (const record of records) {
      if (record.exitCode === undefined) {
        try { await this.#ensureGroupCleanup(record); }
        catch (error) { record.cleanupError = error instanceof Error ? error : new Error(`${reason}: ${String(error)}`); }
      }
    }
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
      cgroupRequired: this.#cgroupMode === "required",
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
      if (this.#mode === "claude-jsonl") {
        record.activeRequests += 1;
        record.activeRequestSequence = ++record.requestSequence;
      }
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

  #assertNotAborted(record: ProcessRecord): void {
    if (record.abortRequested) throw new Error("worker startup aborted");
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
    let offset = 0;
    while (offset < chunk.length) {
      if (record.discardProtocolLine) {
        const newline = chunk.indexOf("\n", offset);
        if (newline < 0) return;
        record.discardProtocolLine = false;
        record.protocolBuffer = "";
        offset = newline + 1;
        continue;
      }
      const newline = chunk.indexOf("\n", offset);
      if (newline < 0) {
        const tail = chunk.slice(offset);
        if (Buffer.byteLength(record.protocolBuffer, "utf8") + Buffer.byteLength(tail, "utf8") > this.#maxProtocolBufferBytes) {
          record.protocolBuffer = "";
          record.discardProtocolLine = true;
          record.outputTruncated = true;
        } else {
          record.protocolBuffer += tail;
        }
        return;
      }
      const linePart = chunk.slice(offset, newline);
      if (Buffer.byteLength(record.protocolBuffer, "utf8") + Buffer.byteLength(linePart, "utf8") > this.#maxProtocolBufferBytes) {
        record.outputTruncated = true;
      } else {
        this.#processJsonlLine(record, `${record.protocolBuffer}${linePart}`.trim());
      }
      record.protocolBuffer = "";
      offset = newline + 1;
    }
  }

  #processJsonlLine(record: ProcessRecord, line: string): void {
    if (!line) return;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      this.#emit(record, { type: "jsonl", handle: record.handle, record: event });
      if (event.type === "control_request") {
        const request = event.request;
        if (isPermissionRequest(event, request)) {
          const requestId = String(event.request_id);
          if (!record.seenPermissionRequestIds.has(requestId)) {
            rememberBounded(record.seenPermissionRequestIds, requestId);
            this.#emit(record, {
              type: "permission_request",
              handle: record.handle,
              request: {
                requestId,
                toolUseId: request.tool_use_id,
                toolName: request.tool_name,
                input: request.input,
                raw: event,
              },
            });
          }
        }
      }
      if (event.type === "result" && record.activeRequests > 0) {
        const resultId = jsonlRecordId(event, record.activeRequestSequence);
        if (!record.seenResultIds.has(resultId)) {
          rememberBounded(record.seenResultIds, resultId);
          record.activeRequests = Math.max(0, record.activeRequests - 1);
          record.activeRequestSequence = undefined;
          record.turnSequence += 1;
          this.#emit(record, { type: "turn_completed", handle: record.handle, result: event, sequence: record.turnSequence });
        }
      }
    } catch {
      // Keep raw output for diagnostics; malformed output is not a completion signal.
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
    if (!record.handle.pid) {
      const error = new Error("worker pid was unavailable for cgroup attachment");
      record.cgroupError = error;
      if (this.#cgroupMode === "required") throw new Error(`unable to attach worker to a cgroup: ${error.message}`, { cause: error });
      throw error;
    }
    if (process.platform !== "linux") {
      const error = new Error("cgroups are unavailable on this platform");
      record.cgroupError = error;
      if (this.#cgroupMode === "required") throw new Error(`unable to attach worker to a cgroup: ${error.message}`, { cause: error });
      return;
    }
    let path: string | undefined;
    try {
      const parent = this.#cgroupParentPath ?? await currentCgroupPath();
      path = `${parent}/pi-claude-supervisor-${record.handle.id}`;
      await mkdir(path);
      await writeFile(`${path}/cgroup.procs`, `${record.handle.pid}\n`);
      record.cgroupPath = path;
      record.handle.cgroupPath = path;
    } catch (error) {
      if (path) await rm(path, { recursive: true, force: true }).catch(() => {});
      record.cgroupError = error instanceof Error ? error : new Error(String(error));
      if (this.#cgroupMode === "required") {
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
    if (record.cgroupPath) {
      await cleanupCgroup(record.cgroupPath, this.#killGraceMs);
      record.groupCleanupComplete = true;
      return;
    }
    const pid = record.handle.pid;
    if (!pid) {
      record.groupCleanupComplete = true;
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !/ESRCH/u.test(error.message)) throw error;
      record.groupCleanupComplete = true;
      return;
    }
    const deadline = Date.now() + this.#killGraceMs;
    while (Date.now() <= deadline) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (error instanceof Error && /ESRCH/u.test(error.message)) {
          record.groupCleanupComplete = true;
          return;
        }
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
  const deadline = Date.now() + graceMs;
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

function rememberBounded(values: Set<string>, value: string, limit = 2_000): void {
  values.add(value);
  while (values.size > limit) {
    const first = values.values().next().value;
    if (first === undefined) break;
    values.delete(first);
  }
}

function jsonlRecordId(record: Record<string, unknown>, requestSequence?: number): string {
  for (const key of ["uuid", "request_id"]) {
    if (typeof record[key] === "string" && record[key]) return `${key}:${record[key]}`;
  }
  const digest = createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 32);
  return `request:${requestSequence ?? "unknown"}:${digest}`;
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
