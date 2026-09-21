import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { TextDecoder } from "node:util";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
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
import { automaticWorkerEnvironment, workerEnvironment } from "./environment.ts";
import { nodeScriptCommand } from "./runtime.ts";

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

interface ProcessGroupIdentity {
  pid: number;
  pgid: number;
  startTime: string;
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
  stdoutDecoder: TextDecoder;
  stderrDecoder: TextDecoder;
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  spawnError?: Error;
  stdinError?: Error;
  groupCleanup?: Promise<void>;
  groupCleanupComplete?: boolean;
  cleanupError?: Error;
  cgroupPath?: string;
  cgroupError?: Error;
  processGroupIdentity?: ProcessGroupIdentity;
  processGroupIdentityError?: Error;
  runtimeError?: Error;
  spawned: Promise<void>;
  spawnedSuccessfully: boolean;
  exited: Promise<void>;
  resolveExit: () => void;
  sentKeys: Set<string>;
  inputTail: Promise<void>;
  listeners: Set<WorkerEventListener>;
  permissionResponses: Set<string>;
  automatic: boolean;
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
  readonly #pendingStartupAborts = new Map<string, string>();
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
      repairableSession: this.#mode === "claude-jsonl",
    };
  }

  async preflight(input: Pick<WorkerStartInput, "cwd" | "command" | "args" | "env" | "approval" | "automatic">): Promise<void> {
    const args = this.#mode === "claude-jsonl" ? claudeJsonlArgs(input.args) : (input.args ?? []);
    assertSafeWorkerCommand(input.command, args, input.approval);
    await assertWorkerCwd(input.cwd);
    await assertExecutable(input.command, input.env?.PATH ?? process.env.PATH);
    if (this.#cgroupMode === "required" || input.automatic) await this.#preflightRequiredCgroup();
  }

  async start(input: WorkerStartInput): Promise<WorkerHandle> {
    if (input.abortSignal?.aborted) throw new Error("worker startup aborted before spawn");
    const args = this.#mode === "claude-jsonl" ? claudeJsonlArgs(input.args) : (input.args ?? []);
    assertSafeWorkerCommand(input.command, args, input.approval);
    if (this.#cgroupMode === "required" || input.automatic) await this.preflight(input);
    const handle: WorkerHandle = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      cwd: input.cwd,
    };
    const workerEnv = input.automatic
      ? automaticWorkerEnvironment(input.env)
      : workerEnvironment(process.env, input.env);
    await assertExecutable(input.command, workerEnv.PATH);
    if (input.automatic && process.platform === "linux") {
      handle.cgroupPath = await this.#plannedCgroupPath(handle.id);
      if (input.retainCgroupUntilLeaseRelease) handle.retainCgroupUntilLeaseRelease = true;
      // Persist the generated path before mkdir. A crash after cgroup
      // creation but before inode registration can then be reconciled by the
      // lease takeover path instead of being mistaken for a no-resource start.
      await input.onWorkerStartup?.(handle);
    }
    const pendingAbortReason = input.startupToken ? this.#pendingStartupAborts.get(input.startupToken) : undefined;
    if (input.startupToken) this.#pendingStartupAborts.delete(input.startupToken);
    if (pendingAbortReason !== undefined) throw new Error(`worker startup aborted: ${pendingAbortReason}`);
    let cgroupPath: string | undefined;
    let cgroupError: Error | undefined;
    if (input.automatic && this.#cgroupMode === "off") throw new Error("automatic supervision requires cgroup containment");
    if ((this.#cgroupMode !== "off" || input.automatic) && process.platform === "linux") {
      try {
        cgroupPath = await this.#createCgroup(handle.id, handle.cgroupPath);
        handle.cgroupPath = cgroupPath;
        if (input.automatic && input.retainCgroupUntilLeaseRelease) handle.retainCgroupUntilLeaseRelease = true;
      } catch (error) {
        cgroupError = error instanceof Error ? error : new Error(String(error));
        if (this.#cgroupMode === "required" || input.automatic) throw new Error(`unable to create a worker cgroup: ${cgroupError.message}`, { cause: cgroupError });
      }
    }
    if (input.automatic && cgroupPath) {
      try {
        await input.onWorkerPrepared?.(handle);
      } catch (error) {
        // The durable identity callback did not complete, so there is no
        // lease-bound evidence with which to retain this startup cgroup.
        await cleanupCgroup(cgroupPath, this.#killGraceMs, false).catch(() => {});
        throw error;
      }
    }
    const cleanupStartupCgroup = async () => {
      if (!cgroupPath) return;
      if (input.automatic && input.retainCgroupUntilLeaseRelease) await cleanupCgroup(cgroupPath, this.#killGraceMs, true).catch(() => {});
      else await removeCgroupDirectory(cgroupPath).catch(() => {});
    };
    const delayedAbortReason = input.startupToken ? this.#pendingStartupAborts.get(input.startupToken) : undefined;
    if (input.startupToken) this.#pendingStartupAborts.delete(input.startupToken);
    if (input.abortSignal?.aborted || delayedAbortReason !== undefined) {
      if (cgroupPath) await removeCgroupDirectory(cgroupPath).catch(() => {});
      throw new Error(`worker startup aborted${delayedAbortReason ? `: ${delayedAbortReason}` : " before spawn"}`);
    }
    const parentStartTime = process.platform === "linux" ? readProcessStartTimeSync(process.pid) : undefined;
    if (input.automatic && process.platform === "linux" && !parentStartTime) {
      if (cgroupPath) await removeCgroupDirectory(cgroupPath).catch(() => {});
      throw new Error("automatic worker parent identity is unavailable");
    }
    const useGuardedBootstrap = process.platform === "linux" && Boolean(parentStartTime) && Boolean(cgroupPath);
    const launch = useGuardedBootstrap
      ? guardedBootstrapLaunch(input.command, args, input.cwd, workerEnv, cgroupPath, process.pid, parentStartTime!, input.retainCgroupUntilLeaseRelease === true)
      : { command: input.command, args, env: workerEnv };
    try {
      // This is the last asynchronous operation before spawn. Automatic mode
      // uses it for an exact repository HEAD assertion; adapters that add
      // setup work must invoke the hook only after that work is complete.
      await input.preSpawnCheck?.(handle);
    } catch (error) {
      await cleanupStartupCgroup();
      throw error;
    }
    const finalAbortReason = input.startupToken ? this.#pendingStartupAborts.get(input.startupToken) : undefined;
    if (input.startupToken) this.#pendingStartupAborts.delete(input.startupToken);
    if (input.abortSignal?.aborted || finalAbortReason !== undefined) {
      await cleanupStartupCgroup();
      throw new Error(`worker startup aborted${finalAbortReason ? `: ${finalAbortReason}` : " before spawn"}`);
    }
    const guardedLaunch = useGuardedBootstrap;
    let bootstrapReady = !guardedLaunch;
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: input.cwd,
        env: launch.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      await cleanupStartupCgroup();
      throw error;
    }
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
      stdoutDecoder: new TextDecoder("utf-8", { fatal: true }),
      stderrDecoder: new TextDecoder("utf-8", { fatal: true }),
      exited,
      resolveExit,
      sentKeys: new Set(),
      groupCleanupComplete: child.pid === undefined,
      cgroupPath,
      cgroupError,
      spawned,
      spawnedSuccessfully: false,
      inputTail: Promise.resolve(),
      listeners: new Set(input.eventListener ? [input.eventListener] : []),
      permissionResponses: new Set(),
      automatic: Boolean(input.automatic),
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
      const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      let text: string;
      try {
        text = (stream === "stdout" ? record.stdoutDecoder : record.stderrDecoder).decode(raw, { stream: true });
      } catch (error) {
        record.runtimeError ??= new Error(`worker emitted invalid UTF-8 on ${stream}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        record.stopping = true;
        try { record.child.kill("SIGKILL"); } catch { /* exit lifecycle remains authoritative */ }
        text = "[invalid UTF-8 output]\n";
      }
      if (guardedLaunch && stream === "stderr" && text.includes(BOOTSTRAP_READY_MARKER)) {
        text = text.replaceAll(`${BOOTSTRAP_READY_MARKER}\n`, "").replaceAll(BOOTSTRAP_READY_MARKER, "");
        bootstrapReady = true;
        resolveSpawn();
      }
      if (!text) return;
      if (Buffer.byteLength(text, "utf8") > this.#maxOutputBytes) {
        text = utf8Tail(text, this.#maxOutputBytes);
        record.outputTruncated = true;
      }
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
      if (child.pid !== undefined && process.platform === "linux") {
        try {
          record.processGroupIdentity = readProcessGroupIdentitySync(child.pid);
        } catch (error) {
          record.processGroupIdentityError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (!guardedLaunch) resolveSpawn();
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
      for (const [stream, decoder] of [["stdout", record.stdoutDecoder], ["stderr", record.stderrDecoder]] as const) {
        try {
          const tail = decoder.decode();
          if (tail) capture(stream)(tail);
        } catch (error) {
          record.runtimeError ??= new Error(`worker emitted incomplete UTF-8 on ${stream}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }
      if (guardedLaunch && !bootstrapReady && !record.spawnError) {
        const error = new Error("worker bootstrap exited before reporting readiness");
        record.spawnError = error;
        rejectSpawn(error);
      }
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
    if (startupToken !== undefined && records.length === 0) this.#pendingStartupAborts.set(startupToken, reason);
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
      exitReason: running ? undefined : record.runtimeError ? "failed" : record.stopping ? "stopped" : record.signal ? "crashed" : record.exitCode === 0 ? "completed" : "failed",
      processGroupCleaned: record.groupCleanupComplete,
      cgroupCleaned: record.cgroupPath ? record.groupCleanupComplete : undefined,
      cgroupRequired: this.#cgroupMode === "required" || record.automatic,
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
    await this.#signal(handle, "SIGSTOP");
  }

  async resume(handle: WorkerHandle): Promise<void> {
    await this.#signal(handle, "SIGCONT");
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
      text = utf8Tail(text, this.#maxOutputBytes);
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

  async #preflightRequiredCgroup(): Promise<void> {
    await preflightCgroupContainment(this.#cgroupParentPath);
  }

  async #plannedCgroupPath(id: string): Promise<string> {
    const parent = this.#cgroupParentPath ?? await currentCgroupPath();
    await assertCgroupDirectory(parent);
    return `${parent}/pi-claude-supervisor-${id}`;
  }

  async #createCgroup(id: string, plannedPath?: string): Promise<string> {
    const path = plannedPath ?? await this.#plannedCgroupPath(id);
    if (basename(resolve(path)) !== `pi-claude-supervisor-${id}`) throw new Error("worker cgroup identity has an unexpected name");
    await assertCgroupDirectory(dirname(resolve(path)));
    await mkdir(path);
    try {
      await access(`${path}/cgroup.procs`, fsConstants.R_OK | fsConstants.W_OK);
      await access(`${path}/cgroup.events`, fsConstants.R_OK);
      await access(`${path}/cgroup.kill`, fsConstants.W_OK);
    } catch (error) {
      await removeCgroupDirectory(path).catch(() => {});
      throw new Error(`worker cgroup controls are unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return path;
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
    const errors: Error[] = [];
    if (record.cgroupPath) {
      try { await cleanupCgroup(record.cgroupPath, this.#killGraceMs, Boolean(record.automatic && record.handle.retainCgroupUntilLeaseRelease)); }
      catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
    }
    try { await this.#cleanupProcessGroupOnly(record); }
    catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "worker descendant cleanup failed");
    record.groupCleanupComplete = true;
  }

  async #cleanupProcessGroupOnly(record: ProcessRecord): Promise<void> {
    const pid = record.handle.pid;
    if (!pid) return;
    if (process.platform === "linux") {
      if (!await assertProcessGroupIdentity(record, pid)) return;
    }
    try {
      // detached:true binds this worker's process group to its handle PID;
      // this second boundary catches descendants spawned before cgroup attach.
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !/ESRCH/u.test(error.message)) throw error;
      return;
    }
    const deadline = Date.now() + this.#killGraceMs;
    while (Date.now() <= deadline) {
      if (!(await processGroupHasLiveMember(pid))) return;
      await delay(Math.min(10, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`worker process group ${pid} did not exit before cleanup deadline`);
  }

  async #signal(handle: WorkerHandle, signal: NodeJS.Signals): Promise<void> {
    const record = this.#record(handle);
    if (record.exitCode !== undefined || !record.handle.pid) return;
    if (process.platform === "linux" && !await assertProcessGroupIdentity(record, record.handle.pid)) return;
    process.kill(-record.handle.pid, signal);
  }
}

const BOOTSTRAP_READY_MARKER = "PI_CLAUDE_SUPERVISOR_BOOTSTRAP_READY";

const BOOTSTRAP_KEYS = {
  command: "PI_CLAUDE_SUPERVISOR_BOOTSTRAP_COMMAND",
  args: "PI_CLAUDE_SUPERVISOR_BOOTSTRAP_ARGS",
  cwd: "PI_CLAUDE_SUPERVISOR_BOOTSTRAP_CWD",
  cgroup: "PI_CLAUDE_SUPERVISOR_BOOTSTRAP_CGROUP",
  parentPid: "PI_CLAUDE_SUPERVISOR_BOOTSTRAP_PARENT_PID",
  parentStartTime: "PI_CLAUDE_SUPERVISOR_BOOTSTRAP_PARENT_START",
  retainCgroup: "PI_CLAUDE_SUPERVISOR_BOOTSTRAP_RETAIN_CGROUP",
} as const;

/**
 * Keep the worker in a small bootstrap process group which watches the
 * Supervisor's PID/start-time identity. A SIGKILL cannot run cleanup in the
 * Supervisor itself, so the detached worker must notice that its owner died
 * and terminate its own descendants. The cgroup path remains an additional
 * descendant boundary when v2 is available. Parent-death cleanup leaves an
 * empty cgroup for explicit lease takeover to verify and reclaim; automatic
 * worker exit may retain the verified empty directory until its cwd lease is
 * released.
 */
const GUARDED_BOOTSTRAP_SCRIPT = `
const { spawn } = require("node:child_process");
const { readFileSync, rmSync, rmdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const keys = ${JSON.stringify(Object.values(BOOTSTRAP_KEYS))};
const decode = (key) => Buffer.from(process.env[key] || "", "base64").toString("utf8");
const readStart = (pid) => {
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    return close < 0 ? undefined : stat.slice(close + 2).trim().split(/\\s+/u)[19];
  } catch { return undefined; }
};
const parentPid = Number(decode(${JSON.stringify(BOOTSTRAP_KEYS.parentPid)}));
const parentStart = decode(${JSON.stringify(BOOTSTRAP_KEYS.parentStartTime)});
const retainCgroup = decode(${JSON.stringify(BOOTSTRAP_KEYS.retainCgroup)}) === "1";
const cgroup = decode(${JSON.stringify(BOOTSTRAP_KEYS.cgroup)});
const parentCgroup = cgroup ? dirname(cgroup) : undefined;
const parentAlive = () => Boolean(parentPid > 0 && process.ppid === parentPid && (() => {
  try { process.kill(parentPid, 0); } catch { return false; }
  return !parentStart || readStart(parentPid) === parentStart;
})());
const moveOutOfCgroup = () => {
  if (!parentCgroup) return;
  try { writeFileSync(parentCgroup + "/cgroup.procs", String(process.pid) + "\\n"); } catch {}
};
const removeCgroup = () => {
  if (!cgroup) return;
  try { rmdirSync(cgroup); return; } catch {}
  try { rmSync(cgroup, { recursive: true, force: true }); } catch {}
  try { rmdirSync(cgroup); } catch {}
};
const killGroup = (signal) => {
  try { process.kill(-process.pid, signal); } catch {}
};
const finishAfterCgroup = (code, signal, retainCgroup) => {
  const finish = () => {
    if (!retainCgroup) removeCgroup();
    if (signal) {
      for (const forwarded of ["SIGTERM", "SIGINT", "SIGQUIT"]) process.removeAllListeners(forwarded);
      try { process.kill(process.pid, signal); } catch {}
      setTimeout(() => process.exit(128), 50).unref();
      return;
    }
    process.exit(code ?? 1);
  };
  if (!cgroup) { killGroup("SIGKILL"); return; }
  try { writeFileSync(cgroup + "/cgroup.kill", "1\\n"); } catch {}
  const deadline = Date.now() + 250;
  const reap = () => {
    let empty = false;
    try { empty = /^populated 0$/mu.test(readFileSync(cgroup + "/cgroup.events", "utf8")); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") { finish(); return; }
    }
    if (empty || Date.now() >= deadline) { finish(); return; }
    setTimeout(reap, 25);
  };
  reap();
};
let child;
let finished = false;
let orphaning = false;
let parentWatch;
const stopParentlessWorker = () => {
  if (orphaning || finished) return;
  orphaning = true;
  if (parentWatch) clearInterval(parentWatch);
  try { child?.kill("SIGTERM"); } catch {}
  // Move the bootstrap out first so cgroup.kill cannot kill the cleanup code.
  moveOutOfCgroup();
  setTimeout(() => finishAfterCgroup(143, undefined, true), 250);
};
try {
  if (cgroup) writeFileSync(cgroup + "/cgroup.procs", String(process.pid) + "\\n");
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  child = spawn(
    decode(${JSON.stringify(BOOTSTRAP_KEYS.command)}),
    JSON.parse(decode(${JSON.stringify(BOOTSTRAP_KEYS.args)})),
    { cwd: decode(${JSON.stringify(BOOTSTRAP_KEYS.cwd)}), env, stdio: "inherit" },
  );
} catch (error) {
  console.error("worker bootstrap failed:", error instanceof Error ? error.message : String(error));
  moveOutOfCgroup();
  finishAfterCgroup(125, undefined, retainCgroup);
}
if (child) {
process.stderr.write("${BOOTSTRAP_READY_MARKER}\\n");
parentWatch = setInterval(() => { if (!parentAlive()) stopParentlessWorker(); }, 100);
// Keep the parent-death watcher referenced: after the child exits it owns the
// only remaining cleanup path and must finish the cgroup reap before exiting.
const forwardedSignals = ["SIGTERM", "SIGINT", "SIGQUIT"];
for (const signal of forwardedSignals) process.on(signal, () => { try { child.kill(signal); } catch {} });
child.once("error", (error) => {
  if (finished || orphaning) return;
  finished = true;
  clearInterval(parentWatch);
  console.error("worker bootstrap child failed:", error.message);
  moveOutOfCgroup();
  finishAfterCgroup(127, undefined, retainCgroup);
});
child.once("exit", (code, signal) => {
  if (finished || orphaning) return;
  finished = true;
  clearInterval(parentWatch);
  moveOutOfCgroup();
  finishAfterCgroup(code ?? 1, signal, retainCgroup);
});
}
`;

export const PROCESS_EMBEDDED_SCRIPTS = { guardedBootstrap: GUARDED_BOOTSTRAP_SCRIPT } as const;

function guardedBootstrapLaunch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, cgroupPath: string | undefined, parentPid: number, parentStartTime: string, retainCgroup: boolean): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  return {
    command: nodeScriptCommand(),
    args: ["-e", GUARDED_BOOTSTRAP_SCRIPT],
    env: {
      ...env,
      [BOOTSTRAP_KEYS.command]: encode(command),
      [BOOTSTRAP_KEYS.args]: encode(JSON.stringify(args)),
      [BOOTSTRAP_KEYS.cwd]: encode(cwd),
      [BOOTSTRAP_KEYS.cgroup]: encode(cgroupPath ?? ""),
      [BOOTSTRAP_KEYS.parentPid]: encode(String(parentPid)),
      [BOOTSTRAP_KEYS.parentStartTime]: encode(parentStartTime),
      [BOOTSTRAP_KEYS.retainCgroup]: encode(retainCgroup ? "1" : "0"),
    },
  };
}

export function claudeJsonlArgs(args: readonly string[] = []): string[] {
  const result = [...args];
  if (!result.includes("-p") && !result.includes("--print")) result.push("-p");
  ensureOption(result, "--input-format", "stream-json");
  ensureOption(result, "--output-format", "stream-json");
  ensureOption(result, "--permission-prompt-tool", "stdio");
  ensureOption(result, "--permission-prompts", "host");
  if (!result.includes("--verbose")) result.push("--verbose");
  return result;
}

function ensureOption(args: string[], option: string, expected: string): void {
  const equalPrefix = `${option}=`;
  const indexes = args.flatMap((value, index) => value === option || value.startsWith(equalPrefix) ? [index] : []);
  if (indexes.length > 1) throw new Error(`${option} may not be repeated in claude-jsonl mode`);
  const index = indexes[0];
  if (index === undefined) {
    args.push(option, expected);
    return;
  }
  if (args[index] === equalPrefix + expected) {
    args.splice(index, 1, option, expected);
    return;
  }
  if (args[index] !== option || args[index + 1] !== expected) throw new Error(`${option} must be ${expected} in claude-jsonl mode`);
}

async function assertWorkerCwd(cwd: string): Promise<void> {
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error(`Worker cwd is not a directory: ${cwd}`);
  await access(cwd, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
}

async function assertExecutable(command: string, pathValue: string | undefined): Promise<void> {
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [command]
    : (pathValue ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`worker executable preflight failed (ENOENT): ${command}`);
}

export async function currentCgroupPath(): Promise<string> {
  const contents = await readFile("/proc/self/cgroup", "utf8");
  const match = contents.match(/^0::([^\n]*)$/mu);
  if (!match || !match[1]!.startsWith("/")) throw new Error("cgroup v2 is not active");
  // /proc/self/cgroup uses the same escaped component spelling as the cgroup
  // filesystem (for example, a literal `\\x2d` in a systemd scope name).
  const path = `/sys/fs/cgroup${match[1]}`;
  await assertCgroupDirectory(path);
  return path;
}

export async function assertCgroupDirectory(path: string): Promise<void> {
  const root = resolve("/sys/fs/cgroup");
  const candidate = resolve(path);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) throw new Error("cgroup path is outside the kernel cgroup root");
  let current = root;
  for (const component of candidate.slice(root.length + 1).split("/")) {
    if (!component) continue;
    current = join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("cgroup path is not a real directory");
  }
}

export async function preflightCgroupContainment(parentPath?: string): Promise<void> {
  if (process.platform !== "linux") throw new Error("required cgroup cleanup is unavailable on this platform");
  let probePath: string | undefined;
  let probeChild: ChildProcess | undefined;
  try {
    const parent = parentPath ?? await currentCgroupPath();
    await assertCgroupDirectory(parent);
    await access(parent, fsConstants.W_OK);
    probePath = `${parent}/pi-claude-supervisor-preflight-${process.pid}-${randomUUID()}`;
    await mkdir(probePath);
    await stat(`${probePath}/cgroup.kill`);
    await stat(`${probePath}/cgroup.events`);
    const script = "const fs=require('node:fs'); fs.writeFileSync(process.env.PI_CLAUDE_SUPERVISOR_PREFLIGHT_CGROUP + '/cgroup.procs', String(process.pid) + String.fromCharCode(10)); setInterval(() => {}, 10000);";
    probeChild = spawn(nodeScriptCommand(), ["-e", script], {
      env: { PATH: process.env.PATH ?? "", PI_CLAUDE_SUPERVISOR_PREFLIGHT_CGROUP: probePath },
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("preflight child did not join cgroup")), 1_000);
      const poll = async (): Promise<void> => {
        if (!probeChild || probeChild.exitCode !== null) {
          clearTimeout(timer);
          reject(new Error("preflight cgroup probe exited before joining"));
          return;
        }
        try {
          const members = await readFile(`${probePath}/cgroup.procs`, "utf8");
          if (members.split(/\s+/u).includes(String(probeChild.pid))) {
            clearTimeout(timer);
            resolve();
            return;
          }
        } catch {
          // Retry until the bounded probe deadline.
        }
        setTimeout(() => { void poll(); }, 10).unref();
      };
      void poll();
    });
    await writeFile(`${probePath}/cgroup.kill`, "1" + String.fromCharCode(10));
    const deadline = Date.now() + 1_000;
    let empty = false;
    while (Date.now() <= deadline) {
      const events = await readFile(`${probePath}/cgroup.events`, "utf8");
      if (/^populated 0$/mu.test(events)) { empty = true; break; }
      await delay(10);
    }
    if (!empty) throw new Error("preflight cgroup did not report populated 0");
  } catch (error) {
    throw new Error(`required cgroup preflight failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (probePath) {
      try { await writeFile(`${probePath}/cgroup.kill`, "1" + String.fromCharCode(10)); } catch {}
    }
    const child = probeChild;
    if (child && child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch {}
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        delay(250),
      ]);
    }
    if (probePath) await removeCgroupDirectory(probePath).catch(() => {});
  }
}

function parseProcessGroupIdentity(contents: string, pid: number): ProcessGroupIdentity {
  const closeParen = contents.lastIndexOf(")");
  if (closeParen < 0) throw new Error(`unable to read process identity for ${pid}`);
  const fields = contents.slice(closeParen + 2).trim().split(/\s+/u);
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (!Number.isSafeInteger(pgid) || !startTime) throw new Error(`invalid process identity for ${pid}`);
  return { pid, pgid, startTime };
}

function readProcessGroupIdentitySync(pid: number): ProcessGroupIdentity {
  return parseProcessGroupIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
}

function readProcessStartTimeSync(pid: number): string | undefined {
  try { return parseProcessGroupIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"), pid).startTime; }
  catch { return undefined; }
}

async function readProcessGroupIdentity(pid: number): Promise<ProcessGroupIdentity> {
  return parseProcessGroupIdentity(await readFile(`/proc/${pid}/stat`, "utf8"), pid);
}

async function assertProcessGroupIdentity(record: ProcessRecord, pid: number): Promise<boolean> {
  const identity = record.processGroupIdentity;
  if (record.processGroupIdentityError) throw new Error(`worker process-group identity unavailable: ${record.processGroupIdentityError.message}`);
  if (!identity || identity.pid !== pid || identity.pgid !== pid) throw new Error(`worker process-group identity was not established for ${pid}`);
  try {
    const current = await readProcessGroupIdentity(pid);
    if (current.startTime !== identity.startTime || current.pgid !== identity.pgid) {
      throw new Error(`worker process-group identity changed for ${pid}`);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && /ENOENT/u.test(error.message)) return false;
    throw error;
  }
}

async function removeCgroupDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
    return;
  } catch (error) {
    if (error instanceof Error && /ENOENT/u.test(error.message)) return;
  }
  // cgroupfs control files cannot be unlinked, so a plain recursive rm fails
  // on a non-empty cgroup. Only nested directories are ever real subgroups;
  // remove those bottom-up and leave the control files for rmdir to reap.
  await removeEmptyCgroupChildDirectories(path);
  try { await rmdir(path); }
  catch (error) {
    if (!(error instanceof Error && /ENOENT/u.test(error.message))) throw error;
  }
}

async function removeEmptyCgroupChildDirectories(path: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && /ENOENT/u.test(error.message)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = `${path}/${entry.name}`;
    await removeEmptyCgroupChildDirectories(child);
    try { await rmdir(child); }
    catch (error) {
      if (!(error instanceof Error && /ENOENT/u.test(error.message))) throw error;
    }
  }
}

export async function cleanupCgroup(path: string, graceMs: number, retainDirectory = false): Promise<void> {
  try {
    await assertCgroupDirectory(path);
  } catch (error) {
    if (error instanceof Error && /ENOENT/u.test(error.message)) return;
    throw error;
  }
  try {
    await stat(path);
  } catch (error) {
    if (error instanceof Error && /ENOENT/u.test(error.message)) return;
    throw error;
  }
  try {
    await writeFile(`${path}/cgroup.kill`, "1\n");
  } catch (error) {
    if (error instanceof Error && /ENOENT/u.test(error.message)) {
      // ENOENT is success only when the cgroup directory itself disappeared.
      try { await stat(path); }
      catch (directoryError) {
        if (directoryError instanceof Error && /ENOENT/u.test(directoryError.message)) return;
        throw directoryError;
      }
      throw new Error(`cgroup.kill is missing from live cgroup ${path}`);
    }
    throw error;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() <= deadline) {
    try {
      const events = await readFile(`${path}/cgroup.events`, "utf8");
      if (/^populated 0$/mu.test(events)) {
        if (!retainDirectory) await removeCgroupDirectory(path);
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

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
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

export async function processGroupHasLiveMember(pgid: number): Promise<boolean> {
  if (process.platform !== "linux") {
    try { process.kill(-pgid, 0); return true; }
    catch (error) {
      if (error instanceof Error && /ESRCH/u.test(error.message)) return false;
      throw error;
    }
  }
  let names: string[];
  try { names = await readdir("/proc"); }
  catch { return true; }
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const statText = await readFile(`/proc/${name}/stat`, "utf8");
      const closeParen = statText.lastIndexOf(")");
      if (closeParen < 0) continue;
      const fields = statText.slice(closeParen + 2).trim().split(/\s+/u);
      const state = fields[0];
      const processGroup = Number(fields[2]);
      if (processGroup === pgid && state !== "Z") return true;
    } catch {
      // A process can disappear between /proc enumeration and stat read.
    }
  }
  return false;
}
