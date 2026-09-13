import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkerAdapter,
  WorkerCapabilities,
  WorkerEventListener,
  WorkerHandle,
  WorkerOutputChunk,
  WorkerStartInput,
  WorkerStatus,
} from "../types.ts";
import { assertSafeWorkerCommand } from "../policy.ts";
import { redactSensitive } from "../redaction.ts";
import { workerEnvironment } from "./environment.ts";

export interface TmuxWorkerAdapterOptions {
  /** Directory for launcher and output state. */
  stateDir?: string;
  /** tmux executable. */
  tmuxBinary?: string;
  /** Time allowed for Claude's interactive prompt to become ready. */
  startupTimeoutMs?: number;
  /** Poll interval used to detect prompt completion and pane exit. */
  pollIntervalMs?: number;
  /** Time allowed for an interactive /exit before killing the owned server. */
  terminationGraceMs?: number;
}

interface TmuxRecord {
  handle: WorkerHandle;
  sessionName: string;
  socketPath?: string;
  target: string;
  logPath: string;
  runtimeDir: string;
  owned: boolean;
  pipeAttached: boolean;
  outputOffset: number;
  output: WorkerOutputChunk[];
  outputBytes: number;
  outputTruncated: boolean;
  lastOutputAt?: string;
  lastInputAt?: string;
  activeRequests: number;
  turnSequence: number;
  readyStreak: number;
  turnObservedOutput: boolean;
  inputAt?: number;
  sentKeys: Set<string>;
  inputTail: Promise<void>;
  outputTail: Promise<void>;
  listeners: Set<WorkerEventListener>;
  monitor?: NodeJS.Timeout;
  monitorInFlight: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  stopping: boolean;
  starting: boolean;
  abortRequested: boolean;
  released: boolean;
  cleanupComplete: boolean;
  sessionCreated?: boolean;
  serverKilled?: boolean;
  cleanupError?: Error;
  panePid?: number;
  paneStartTime?: string;
  paneCommand?: string;
  replacementPaneStartTime?: string;
  replacementPaneCommand?: string;
  paneDead?: boolean;
}

interface TmuxPaneStatus {
  dead: boolean;
  exitCode?: number;
  pid?: number;
}

/**
 * Interactive Claude Code transport backed by a private tmux server and PTY.
 *
 * The adapter owns sessions it starts, while an explicitly adopted session is
 * never killed by stop/release. Tmux is a transport boundary only: policy,
 * watchdog, Decision Worker and verification remain in Supervisor.
 */
export class TmuxWorkerAdapter implements WorkerAdapter {
  readonly #records = new Map<string, TmuxRecord>();
  readonly #stateDir: string;
  readonly #tmuxBinary: string;
  readonly #startupTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #terminationGraceMs: number;
  readonly #maxOutputBytes = 8 * 1024 * 1024;
  readonly #maxLogBytes = 16 * 1024 * 1024;
  readonly #commandTimeoutMs = 10_000;

  constructor(options: TmuxWorkerAdapterOptions = {}) {
    this.#stateDir = options.stateDir ?? join(tmpdir(), "pi-claude-supervisor");
    this.#tmuxBinary = options.tmuxBinary ?? "tmux";
    this.#startupTimeoutMs = boundedDelay(options.startupTimeoutMs ?? 60_000);
    this.#pollIntervalMs = boundedDelay(options.pollIntervalMs ?? 500);
    this.#terminationGraceMs = boundedDelay(options.terminationGraceMs ?? 2_000);
  }

  capabilities(): WorkerCapabilities {
    return {
      transport: "tmux",
      interactiveInput: true,
      pause: true,
      resumeSession: false,
      processGroupControl: false,
      persistentSession: true,
    };
  }

  async start(input: WorkerStartInput): Promise<WorkerHandle> {
    const id = randomUUID();
    const owned = !input.tmuxSession;
    const sessionName = input.tmuxSession ?? `pi-supervisor-${id}`;
    if (!/^[A-Za-z0-9_.-]+$/u.test(sessionName)) throw new Error("tmux session names must contain only letters, numbers, dot, underscore or hyphen");
    const socketPath = input.tmuxSession ? input.tmuxSocket : join(tmpdir(), `pi-cs-${id}.sock`);
    // Resolve the active window dynamically; users may configure base-index=1.
    const target = sessionName;
    const runtimeDir = join(this.#stateDir, "tmux", id);
    const logPath = join(runtimeDir, `worker-${id}.log`);
    const handle: WorkerHandle = {
      id,
      startedAt: new Date().toISOString(),
      cwd: input.cwd,
      sessionName,
      tmuxSocket: socketPath,
      ownership: owned ? "owned" : "adopted",
    };
    const record: TmuxRecord = {
      handle,
      sessionName,
      socketPath,
      target,
      logPath,
      runtimeDir,
      owned,
      pipeAttached: false,
      outputOffset: 0,
      output: [],
      outputBytes: 0,
      outputTruncated: false,
      activeRequests: 0,
      turnSequence: 0,
      readyStreak: 0,
      turnObservedOutput: false,
      sentKeys: new Set(),
      inputTail: Promise.resolve(),
      outputTail: Promise.resolve(),
      listeners: new Set(input.eventListener ? [input.eventListener] : []),
      monitorInFlight: false,
      stopping: false,
      starting: true,
      abortRequested: false,
      released: false,
      cleanupComplete: false,
    };
    this.#records.set(id, record);

    try {
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      await writeFile(logPath, "", { mode: 0o600 });
      if (owned) {
        assertSafeWorkerCommand(input.command, input.args ?? [], input.approval);
        assertNoCredentialArguments(input.command, input.args ?? []);
        const launcherPath = join(runtimeDir!, "launcher.mjs");
        await writeFile(launcherPath, launcherSource({ command: input.command, args: input.args ?? [], cwd: input.cwd }), { mode: 0o600 });
        const env = workerEnvironment(process.env, input.env);
        // Create the window with its shell first so remain-on-exit is set
        // before the launcher can finish instantly.
        await this.#run(record, ["new-session", "-d", "-s", sessionName, "-x", "140", "-y", "40", "-c", input.cwd], undefined, env);
        record.sessionCreated = true;
        await this.#run(record, ["set-window-option", "-t", sessionName, "remain-on-exit", "on"]);
        await this.#run(record, ["respawn-pane", "-k", "-t", target, "--", process.execPath, launcherPath]);
        await this.#pinTarget(record);
        const ownedPane = await this.#paneStatus(record);
        record.paneDead = ownedPane.dead;
        if (!ownedPane.dead) {
          record.panePid = ownedPane.pid;
          record.handle.pid = ownedPane.pid;
          await this.#rememberPaneIdentity(record, ownedPane.pid);
        }
      } else {
        await this.#assertExistingSession(record, input.cwd, input.approval);
        const pipe = await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_pipe}"]);
        if (pipe.stdout.trim() === "1") throw new Error("cannot adopt a tmux pane that already has an output pipe");
      }
      await this.#run(record, ["pipe-pane", "-o", "-t", record.target, `cat >> ${shellQuote(logPath)}`]);
      record.pipeAttached = true;
      const attachedPipe = await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_pipe}"]);
      if (attachedPipe.stdout.trim() !== "1") throw new Error("tmux output pipe could not be attached to the pinned pane");
      if (input.sendInitialInput !== false || !input.tmuxSession) await this.#waitForReady(record);
      if (input.sendInitialInput !== false) {
        await this.#send(record, input.task, `${id}:initial`);
      } else if (input.tmuxSession) {
        const screen = await this.#capture(record);
        if (!isReadyScreen(screen)) {
          record.activeRequests = 1;
          record.lastInputAt = new Date().toISOString();
          record.inputAt = Date.now();
          // A non-prompt screen indicates that adoption is observing an
          // already-running turn; an idle prompt stays inactive.
          record.turnObservedOutput = true;
        }
      } else {
        // Explicit idle startup is used by recovery; do not create a blank
        // Claude turn and do not manufacture a completion event.
        record.activeRequests = 0;
      }
      this.#assertNotAborted(record);
      this.#startMonitor(record);
      record.starting = false;
      return handle;
    } catch (error) {
      let cleanupFailure: unknown;
      try { await this.#cleanup(record, true); }
      catch (cleanupError) { cleanupFailure = cleanupError; }
      record.starting = false;
      const startupError = error instanceof Error ? error : new Error(String(error));
      const cleanupMessage = record.cleanupError?.message ?? (cleanupFailure instanceof Error ? cleanupFailure.message : undefined);
      if (cleanupMessage) startupError.message = `${startupError.message}; startup cleanup failed: ${cleanupMessage}`;
      Object.defineProperty(startupError, "workerHandle", { value: handle, enumerable: false });
      throw startupError;
    }
  }

  async abortStart(_reason: string): Promise<void> {
    const starts = [...this.#records.values()].filter((record) => record.starting);
    for (const record of starts) {
      record.abortRequested = true;
      record.stopping = true;
      if (record.owned) await this.#run(record, ["kill-server"], undefined, undefined, true).catch(() => {});
      else await this.#detachPipe(record);
    }
    const deadline = Date.now() + 25_000;
    while ([...this.#records.values()].some((record) => record.starting) && Date.now() < deadline) await delay(25);
  }

  async getStatus(handle: WorkerHandle): Promise<WorkerStatus> {
    const record = this.#record(handle);
    if (record.released) {
      try {
        const pane = await this.#paneStatus(record);
        record.paneDead = pane.dead;
        record.panePid = pane.pid;
        if (!pane.dead) await this.#rememberPaneIdentity(record, pane.pid);
      } catch (error) {
        if (isMissingSession(error) || isPaneIdentityError(error)) record.paneDead = true;
        else record.cleanupError = asError(error);
      }
      return this.#status(record, !record.paneDead);
    }
    try {
      const pane = await this.#paneStatus(record);
      record.paneDead = pane.dead;
      record.panePid = pane.pid;
      if (!pane.dead) {
        record.handle.pid = pane.pid;
        await this.#rememberPaneIdentity(record, pane.pid);
      }
      if (pane.exitCode !== undefined) record.exitCode = pane.exitCode;
      if (pane.dead && !record.cleanupComplete) await this.#cleanup(record, false);
    } catch (error) {
      if (isMissingSession(error)) {
        record.paneDead = true;
        if (!record.cleanupComplete && record.owned) await this.#cleanup(record, false);
      } else {
        record.cleanupError = asError(error);
        if (isPaneIdentityError(error)) record.paneDead = true;
      }
    }
    return this.#status(record, !record.paneDead && !record.released);
  }

  async readOutput(handle: WorkerHandle): Promise<WorkerOutputChunk[]> {
    const record = this.#record(handle);
    return this.#withOutputLock(record, async () => {
      await this.#collectOutputUnlocked(record);
      const output = record.output.splice(0);
      record.outputBytes = 0;
      return output;
    });
  }

  subscribe(handle: WorkerHandle, listener: WorkerEventListener): () => void {
    const record = this.#record(handle);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  async restoreOutput(handle: WorkerHandle, chunks: WorkerOutputChunk[]): Promise<void> {
    const record = this.#record(handle);
    await this.#withOutputLock(record, async () => {
      record.output.unshift(...chunks);
      record.outputBytes += chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"), 0);
    });
  }

  async send(handle: WorkerHandle, message: string, idempotencyKey: string): Promise<void> {
    const record = this.#record(handle);
    if (record.sentKeys.has(idempotencyKey)) return;
    if (record.released) throw new Error("tmux worker is no longer supervised");
    if (record.activeRequests > 0) throw new Error("tmux worker has an active turn; wait for its prompt before sending another turn");
    await this.#send(record, message, idempotencyKey);
  }

  async pause(handle: WorkerHandle): Promise<void> {
    const record = this.#record(handle);
    if (record.released) throw new Error("tmux worker is no longer supervised");
    const pane = await this.#paneStatus(record);
    if (pane.dead) throw new Error("cannot pause a dead tmux pane");
    await this.#rememberPaneIdentity(record, pane.pid);
    if (!pane.pid) throw new Error("tmux worker pane pid is unavailable");
    signalProcessGroup(pane.pid, "SIGSTOP");
  }

  async resume(handle: WorkerHandle): Promise<void> {
    const record = this.#record(handle);
    if (record.released) throw new Error("tmux worker is no longer supervised");
    const pane = await this.#paneStatus(record);
    if (pane.dead) throw new Error("cannot resume a dead tmux pane");
    await this.#rememberPaneIdentity(record, pane.pid);
    if (!pane.pid) throw new Error("tmux worker pane pid is unavailable");
    signalProcessGroup(pane.pid, "SIGCONT");
  }

  async stop(handle: WorkerHandle, _reason: string): Promise<void> {
    const record = this.#record(handle);
    if (record.released || !record.owned) {
      await this.release(handle, "adopted tmux session is not owned by Supervisor");
      return;
    }
    record.stopping = true;
    record.cleanupError = undefined;
    try { await this.#waitForInput(record); }
    catch (error) { record.cleanupError = asError(error); }
    try {
      await this.#collectOutput(record);
      if (!record.paneDead) {
        try {
          await this.#sendRaw(record, "/exit");
          await this.#waitForPaneExit(record, this.#terminationGraceMs);
        } catch {
          // The private tmux server is still the authoritative cleanup boundary.
        }
        await this.#collectOutput(record);
      }
    } catch (error) {
      record.cleanupError ??= asError(error);
    } finally {
      await this.#detachPipe(record);
      try { await this.#flushOutput(record); }
      catch (error) { record.cleanupError ??= asError(error); }
      const operationError = record.cleanupError;
      record.cleanupError = undefined;
      try { await this.#cleanup(record, true); }
      catch (error) { record.cleanupError ??= asError(error); }
      record.cleanupError ??= operationError;
    }
    if (record.cleanupError || !record.cleanupComplete) throw new Error(`tmux worker cleanup failed: ${record.cleanupError?.message ?? "cleanup was not confirmed"}`);
  }

  async release(handle: WorkerHandle, _reason: string): Promise<void> {
    const record = this.#record(handle);
    record.stopping = true;
    record.cleanupError = undefined;
    record.released = true;
    try { await this.#waitForInput(record); }
    catch (error) { record.cleanupError = asError(error); }
    if (record.monitor) clearInterval(record.monitor);
    record.monitor = undefined;
    record.listeners.clear();
    try { await this.#collectOutput(record); }
    catch (error) { record.cleanupError ??= asError(error); }
    finally {
      await this.#detachPipe(record);
      try { await this.#flushOutput(record); }
      catch (error) { record.cleanupError ??= asError(error); }
    }
    if (!record.owned) {
      try { await rm(record.runtimeDir, { recursive: true, force: true }); }
      catch (error) { record.cleanupError ??= asError(error); }
    }
    if (record.cleanupError) throw new Error(`tmux supervision release failed: ${record.cleanupError.message}`);
    // A released tmux worker is intentionally left running. It can be adopted
    // again explicitly after Pi restarts, and the user's attached window stays open.
  }

  async killProcessGroup(handle: WorkerHandle, _reason: string): Promise<void> {
    const record = this.#record(handle);
    if (!record.owned) throw new Error("cannot kill an adopted tmux session without explicit ownership");
    await this.#cleanup(record, true);
  }

  async resumeSession(_sessionId: string): Promise<WorkerHandle> {
    throw new Error("tmux session recovery requires an explicit tmux session name");
  }

  async #waitForInput(record: TmuxRecord): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for tmux input serialization")), this.#commandTimeoutMs);
      timer.unref();
      record.inputTail.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  async #detachPipe(record: TmuxRecord): Promise<void> {
    if (!record.pipeAttached) return;
    try { await this.#run(record, ["pipe-pane", "-t", record.target], undefined, undefined, true); }
    catch (error) { if (!isMissingSession(error)) record.cleanupError = asError(error); }
    record.pipeAttached = false;
  }

  async #send(record: TmuxRecord, message: string, idempotencyKey: string): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = record.inputTail;
    record.inputTail = previous.then(() => gate);
    await previous;
    try {
      if (record.stopping || record.released) throw new Error("tmux worker is stopping or released");
      const pane = await this.#paneStatus(record);
      if (pane.dead) throw new Error("tmux worker is not running");
      record.handle.pid = pane.pid;
      await this.#rememberPaneIdentity(record, pane.pid);
      await this.#collectOutput(record);
      const finalPane = await this.#paneStatus(record);
      if (finalPane.dead) throw new Error("tmux worker exited before input reservation");
      await this.#rememberPaneIdentity(record, finalPane.pid);
      // This is the final reservation check immediately before paste. A
      // human typing after this point is inherently outside tmux's control;
      // takeover mode is the explicit exclusion mechanism for automation.
      const screen = await this.#capture(record);
      if (!isReadyScreen(screen)) throw new Error("tmux worker prompt is not stable; refusing to race interactive input");
      record.activeRequests = 1;
      record.readyStreak = 0;
      record.turnObservedOutput = false;
      record.inputAt = Date.now();
      try {
        await this.#sendRaw(record, message);
        record.sentKeys.add(idempotencyKey);
        record.lastInputAt = new Date().toISOString();
      } catch (error) {
        record.activeRequests = 0;
        record.readyStreak = 0;
        throw error;
      }
    } finally {
      release();
    }
  }

  async #sendRaw(record: TmuxRecord, message: string): Promise<void> {
    const safeMessage = safeTmuxMessage(message);
    const bufferName = `pi-cs-${record.handle.id}`;
    // Bracketed paste keeps newlines and ordinary text from being interpreted
    // as individual terminal key presses by Claude's TUI.
    const pasted = `\u001b[200~${safeMessage}\u001b[201~`;
    await this.#run(record, ["load-buffer", "-b", bufferName, "-"], pasted);
    await this.#run(record, ["paste-buffer", "-d", "-b", bufferName, "-t", record.target]);
    await this.#run(record, ["send-keys", "-t", record.target, "Enter"]);
  }

  #startMonitor(record: TmuxRecord): void {
    record.monitor = setInterval(() => {
      void this.#monitor(record).catch((error) => {
        if (isPaneIdentityError(error)) record.paneDead = true;
        if (!record.cleanupComplete && !isMissingSession(error)) record.cleanupError = asError(error);
      });
    }, this.#pollIntervalMs);
    record.monitor.unref();
  }

  async #monitor(record: TmuxRecord): Promise<void> {
    if (record.monitorInFlight || record.released) return;
    record.monitorInFlight = true;
    try {
      const outputBeforeInput = record.lastOutputAt;
      await this.#collectOutput(record);
      if (record.inputAt && record.lastOutputAt && Date.parse(record.lastOutputAt) >= record.inputAt && record.lastOutputAt !== outputBeforeInput) record.turnObservedOutput = true;
      const pane = await this.#paneStatus(record);
      record.paneDead = pane.dead;
      record.panePid = pane.pid;
      if (!pane.dead) {
        record.handle.pid = pane.pid;
        await this.#rememberPaneIdentity(record, pane.pid);
      }
      if (pane.exitCode !== undefined) record.exitCode = pane.exitCode;
      if (pane.dead) {
        await this.#cleanup(record, false);
        this.#emit(record, { type: "exited", handle: record.handle, exitCode: record.exitCode, signal: record.signal });
        return;
      }
      const screen = await this.#capture(record);
      if (record.activeRequests === 0 && hasPromptInput(screen)) {
        // A human may have typed directly into the attached PTY. Treat that
        // input as an active turn so automatic sends cannot race it.
        record.activeRequests = 1;
        record.turnObservedOutput = false;
        record.inputAt = Date.now();
        record.lastInputAt = new Date().toISOString();
        record.readyStreak = 0;
      }
      if (record.activeRequests > 0) {
        const ready = isReadyScreen(screen);
        if (ready && record.turnObservedOutput && Date.now() - (record.inputAt ?? Date.now()) >= 500) record.readyStreak += 1;
        else if (!ready) record.readyStreak = 0;
        if (record.readyStreak >= 2) {
          record.activeRequests = 0;
          record.readyStreak = 0;
          record.turnSequence += 1;
          this.#emit(record, {
            type: "turn_completed",
            handle: record.handle,
            sequence: record.turnSequence,
            result: {
              type: "result",
              terminal_reason: "completed",
              transport: "tmux",
              session_name: record.sessionName,
              screen_tail: boundText(stripAnsi(screen), 12_000),
            },
          });
        }
      }
    } finally {
      record.monitorInFlight = false;
    }
  }

  async #waitForReady(record: TmuxRecord): Promise<void> {
    const deadline = Date.now() + this.#startupTimeoutMs;
    while (Date.now() < deadline) {
      this.#assertNotAborted(record);
      const screen = await this.#capture(record);
      if (isReadyScreen(screen)) return;
      await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    this.#assertNotAborted(record);
    throw new Error(`tmux Claude session did not reach an input prompt before startup timeout; attach with ${attachCommand(record)}`);
  }

  async #waitForPaneExit(record: TmuxRecord, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pane = await this.#paneStatus(record).catch(() => ({ dead: true } as TmuxPaneStatus));
      if (pane.dead) {
        record.paneDead = true;
        return;
      }
      await delay(50);
    }
  }

  async #assertExistingSession(record: TmuxRecord, cwd: string, approval?: { actor: "human"; reason: string }): Promise<void> {
    await this.#pinTarget(record);
    const pane = await this.#paneStatus(record);
    if (pane.dead) throw new Error("cannot adopt a dead tmux pane");
    record.handle.pid = pane.pid;
    const currentPath = await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_current_path}"]);
    if (currentPath.stdout.trim() !== cwd) throw new Error(`tmux session cwd mismatch: expected ${cwd}, got ${currentPath.stdout.trim()}`);
    const command = (await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_current_command}"])).stdout.trim();
    let processArgs: { stdout: string; stderr: string };
    if (!pane.pid) throw new Error("tmux pane pid is unavailable; refusing to adopt without command inspection");
    try {
      processArgs = await runCommand("ps", ["-o", "args=", "-p", String(pane.pid)], undefined, workerEnvironment(process.env), this.#commandTimeoutMs);
    } catch (error) {
      throw new Error(`cannot inspect tmux pane command: ${error instanceof Error ? error.message : String(error)}`);
    }
    const commandName = command.split(/[\\/]/u).at(-1) ?? command;
    const argsText = processArgs.stdout.trim();
    const processExecutable = argsText.split(/\s+/u)[0] ?? "";
    const processExecutableName = processExecutable.split(/[\\/]/u).at(-1) ?? processExecutable;
    const commandLine = `${command} ${argsText}`.trim();
    if (commandName !== "claude" || !argsText || processExecutableName !== "claude") {
      throw new Error(`tmux pane is not a Claude Code executable: ${redactSensitiveText(commandLine || "unknown")}`);
    }
    assertSafeWorkerCommand(command, [argsText], approval);
    await this.#rememberPaneIdentity(record, pane.pid);
  }

  async #pinTarget(record: TmuxRecord): Promise<void> {
    const pane = await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_id}"]);
    const paneId = pane.stdout.trim();
    if (!/^%[0-9]+$/u.test(paneId)) throw new Error("tmux did not return a stable pane id");
    record.target = paneId;
  }

  async #capture(record: TmuxRecord): Promise<string> {
    const result = await this.#run(record, ["capture-pane", "-p", "-J", "-t", record.target, "-S", "-120"]);
    return result.stdout;
  }

  async #paneStatus(record: TmuxRecord): Promise<TmuxPaneStatus> {
    const result = await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_dead}:#{pane_exit_status}:#{pane_pid}"]);
    const [dead, exitCode, pid] = result.stdout.trim().split(":");
    return {
      dead: dead === "1",
      exitCode: exitCode && exitCode !== "-1" ? Number(exitCode) : undefined,
      pid: pid ? Number(pid) : undefined,
    };
  }

  async #rememberPaneIdentity(record: TmuxRecord, pid: number | undefined): Promise<void> {
    if (!pid || !Number.isInteger(pid) || pid <= 0) throw new Error("tmux pane pid is unavailable; refusing unverified control");
    try {
      const statText = await readFile(`/proc/${pid}/stat`, "utf8");
      const closeParen = statText.lastIndexOf(")");
      const fields = closeParen >= 0 ? statText.slice(closeParen + 2).trim().split(/\s+/u) : [];
      const startTime = fields[19];
      const command = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
      if (!startTime) throw new Error(`cannot identify tmux pane pid ${pid}`);
      if (record.paneStartTime && (record.paneStartTime !== startTime || record.paneCommand !== command)) {
        throw new Error("tmux pane identity changed; refusing to control a replacement process");
      }
      record.paneStartTime = startTime;
      record.paneCommand = command;
    } catch (error) {
      if (error instanceof Error && /tmux pane identity changed/u.test(error.message)) throw error;
      throw new Error(`tmux pane identity unavailable for pid ${pid}`);
    }
  }

  async #cleanup(record: TmuxRecord, _force: boolean): Promise<void> {
    if (record.cleanupComplete) return;
    // A later cleanup call is a retry, so do not let a transient prior error
    // permanently poison a successful retry. The caller preserves errors from
    // the current stop attempt around this boundary.
    record.cleanupError = undefined;
    if (!record.owned) {
      if (record.monitor) clearInterval(record.monitor);
      record.monitor = undefined;
      await this.#detachPipe(record);
      try { await this.#flushOutput(record); }
      catch (error) { record.cleanupError ??= asError(error); }
      try { await rm(record.runtimeDir, { recursive: true, force: true }); }
      catch (error) { record.cleanupError ??= asError(error); }
      record.cleanupComplete = !record.cleanupError;
      return;
    }
    if (record.monitor) clearInterval(record.monitor);
    record.monitor = undefined;
    await this.#detachPipe(record);
    try { await this.#flushOutput(record); }
    catch (error) { record.cleanupError ??= asError(error); }
    record.monitor = undefined;
    try {
      await this.#run(record, ["kill-server"], undefined, undefined, true);
      record.serverKilled = true;
    } catch (error) {
      if (isMissingSession(error)) record.serverKilled = true;
      else record.cleanupError = asError(error);
    }
    await this.#ensurePaneGone(record);
    try { await rm(record.runtimeDir, { recursive: true, force: true }); }
    catch (error) { record.cleanupError ??= asError(error); }
    record.cleanupComplete = !record.cleanupError && Boolean(record.paneStartTime || (record.serverKilled && (!record.sessionCreated || record.paneDead)));
  }

  async #ensurePaneGone(record: TmuxRecord): Promise<void> {
    const pid = record.panePid ?? record.handle.pid;
    if (!pid || !record.paneStartTime) {
      if (record.serverKilled && (!record.sessionCreated || record.paneDead)) return;
      record.cleanupError = new Error("owned tmux cleanup lacks a verifiable pane identity");
      return;
    }
    if (!(await isPidAlive(pid))) return;
    if (!(await sameProcess(record, pid))) {
      await this.#markReplacement(record, pid);
      return;
    }
    signalProcessGroup(pid, "SIGTERM");
    for (let attempt = 0; attempt < 10 && await isPidAlive(pid); attempt += 1) await delay(50);
    if (await isPidAlive(pid)) {
      if (!(await sameProcess(record, pid))) {
        await this.#markReplacement(record, pid);
        return;
      }
      signalProcessGroup(pid, "SIGKILL");
    }
    for (let attempt = 0; attempt < 10 && await isPidAlive(pid); attempt += 1) await delay(50);
    if (await isPidAlive(pid)) {
      if (await sameProcess(record, pid)) record.cleanupError = new Error(`tmux pane process did not exit: ${pid}`);
      else await this.#markReplacement(record, pid);
    }
  }

  async #markReplacement(record: TmuxRecord, pid: number): Promise<void> {
    const identity = await processIdentity(pid);
    if (identity) {
      record.replacementPaneStartTime = identity.startTime;
      record.replacementPaneCommand = identity.command;
      record.cleanupError = new Error(`owned tmux cleanup refused replacement pane process pid=${pid} start=${identity.startTime} command=${identity.command}`);
    } else {
      record.cleanupError = new Error(`owned tmux cleanup refused an unverified replacement pane process pid=${pid}`);
    }
  }

  #assertNotAborted(record: TmuxRecord): void {
    if (record.abortRequested) throw new Error("tmux worker startup was aborted");
  }

  async #run(record: TmuxRecord, args: string[], input?: string, env = workerEnvironment(process.env), ignoreAbort = false): Promise<{ stdout: string; stderr: string }> {
    if (record.abortRequested && !ignoreAbort) throw new Error("tmux worker startup was aborted");
    const tmuxArgs = record.socketPath ? ["-S", record.socketPath, ...args] : args;
    const result = await runCommand(this.#tmuxBinary, tmuxArgs, input, env, this.#commandTimeoutMs);
    if (record.abortRequested && !ignoreAbort) throw new Error("tmux worker startup was aborted");
    return result;
  }

  async #collectOutput(record: TmuxRecord): Promise<WorkerOutputChunk[]> {
    return this.#withOutputLock(record, async () => this.#collectOutputUnlocked(record));
  }

  async #flushOutput(record: TmuxRecord): Promise<void> {
    let previousSize = -1;
    let stableReads = 0;
    for (let attempt = 0; attempt < 20 && stableReads < 2; attempt += 1) {
      await this.#collectOutput(record);
      try {
        const size = (await stat(record.logPath)).size;
        stableReads = size === previousSize ? stableReads + 1 : 0;
        previousSize = size;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        return;
      }
      if (stableReads < 2) await delay(25);
    }
  }

  async #collectOutputUnlocked(record: TmuxRecord): Promise<WorkerOutputChunk[]> {
    try {
      const initial = await stat(record.logPath);
      if (initial.size > this.#maxLogBytes) {
        await truncate(record.logPath, 0);
        record.outputOffset = 0;
        record.outputTruncated = true;
      }
      const snapshot = await stat(record.logPath);
      if (record.outputOffset > snapshot.size) record.outputOffset = 0;
      const start = Math.max(record.outputOffset, snapshot.size - this.#maxLogBytes);
      if (start > record.outputOffset) {
        record.outputOffset = start;
        record.outputTruncated = true;
      }
      const length = snapshot.size - start;
      if (length > 0) {
        const file = await open(record.logPath, "r");
        try {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await file.read(buffer, 0, length, start);
          if (bytesRead > 0) {
            const text = buffer.subarray(0, bytesRead).toString("utf8");
            record.outputOffset = start + bytesRead;
            record.lastOutputAt = new Date().toISOString();
            this.#appendOutput(record, { stream: "stdout", text, at: record.lastOutputAt });
          }
        } finally {
          await file.close();
        }
      }
      const after = await stat(record.logPath);
      if (after.size > this.#maxLogBytes) {
        await truncate(record.logPath, 0);
        record.outputOffset = 0;
        record.outputTruncated = true;
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return [...record.output];
  }

  async #withOutputLock<T>(record: TmuxRecord, operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = record.outputTail;
    record.outputTail = previous.then(() => gate);
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  #appendOutput(record: TmuxRecord, chunk: WorkerOutputChunk): void {
    let text = chunk.text;
    if (Buffer.byteLength(text, "utf8") > this.#maxOutputBytes) {
      text = Buffer.from(text, "utf8").subarray(-this.#maxOutputBytes).toString("utf8");
      record.outputTruncated = true;
    }
    record.output.push({ ...chunk, text });
    record.outputBytes += Buffer.byteLength(text, "utf8");
    while (record.outputBytes > this.#maxOutputBytes) {
      const removed = record.output.shift();
      if (!removed) break;
      record.outputBytes -= Buffer.byteLength(removed.text, "utf8");
      record.outputTruncated = true;
    }
  }

  #status(record: TmuxRecord, running: boolean): WorkerStatus {
    return {
      handle: record.handle,
      running,
      exitCode: record.exitCode,
      signal: record.signal,
      lastOutputAt: record.lastOutputAt,
      lastInputAt: record.lastInputAt,
      activeRequests: record.activeRequests,
      exitReason: running ? undefined : record.stopping ? "stopped" : record.exitCode === 0 ? "completed" : "failed",
      processGroupCleaned: record.cleanupComplete,
      cleanupError: record.cleanupError?.message,
      outputTruncated: record.outputTruncated,
    };
  }

  #record(handle: WorkerHandle): TmuxRecord {
    const record = this.#records.get(handle.id);
    if (!record) throw new Error(`unknown tmux worker handle: ${handle.id}`);
    return record;
  }

  #emit(record: TmuxRecord, event: Parameters<WorkerEventListener>[0]): void {
    for (const listener of record.listeners) {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).catch === "function") void (result as Promise<void>).catch(() => {});
      } catch {
        // Lifecycle observers must not break the PTY transport.
      }
    }
  }
}

export function attachCommand(handle: Pick<WorkerHandle, "tmuxSocket" | "sessionName">): string {
  const target = shellQuote(handle.sessionName ?? "");
  return handle.tmuxSocket ? `tmux -S ${shellQuote(handle.tmuxSocket)} attach -t ${target}` : `tmux attach -t ${target}`;
}

function launcherSource(spec: { command: string; args: string[]; cwd: string }): string {
  return `import { spawn } from "node:child_process";\nconst spec = ${JSON.stringify(spec)};\nconst child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, stdio: "inherit" });\nchild.once("error", (error) => { console.error(error.message); process.exitCode = 127; });\nchild.once("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });\n`;
}

function runCommand(command: string, args: string[], input: string | undefined, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`tmux command timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`tmux command failed (${code ?? signal ?? "unknown"}): ${stderr.trim() || args.join(" ")}`));
    });
    child.stdin.end(input);
  });
}

function isReadyScreen(screen: string): boolean {
  const normalized = stripAnsi(screen).replaceAll("\u00a0", " ");
  // Claude keeps an empty input line visible while it is thinking. The status
  // bar's interrupt affordance is stronger evidence than that prompt glyph.
  if (/esc to interrupt/iu.test(normalized.slice(-800))) return false;
  return latestPrompt(normalized) === "ready";
}

function hasPromptInput(screen: string): boolean {
  // `>` is retained as a fixture-compatible ready marker, but is too common in
  // arbitrary command output to identify human typing. Claude's TUI uses ❯/›.
  return latestPrompt(stripAnsi(screen).replaceAll("\u00a0", " "), false) === "input";
}

function latestPrompt(screen: string, allowAsciiMarker = true): "ready" | "input" | "none" {
  const lines = screen.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(-24);
  const marker = allowAsciiMarker ? "❯|›|>" : "❯|›";
  const promptLines = lines.filter((line) => new RegExp(`^(?:${marker})(?:\\s.*)?$`, "u").test(line));
  const latest = promptLines.at(-1);
  if (latest === undefined) return "none";
  if (latest === ">") return "ready";
  if (/^(?:❯|›)$/u.test(latest)) {
    const promptIndex = lines.lastIndexOf(latest);
    const hasInputSeparator = lines.slice(promptIndex + 1).some((line) => /^[-─]{20,}$/u.test(line));
    if (!hasInputSeparator) return "none";
  }
  return /^(?:❯|›)$/u.test(latest) ? "ready" : "input";
}

function stripAnsi(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:][\d]{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu, "");
}

function assertNoCredentialArguments(command: string, args: string[]): void {
  const values = [command, ...args];
  if (values.some((value) => /(?:sk-ant-|(?:api[-_]?key|token|secret|password|authorization)(?:=|$)|(?:ANTHROPIC|OPENAI|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)=)/iu.test(value))) {
    throw new Error("tmux launcher refuses credential-shaped command arguments; pass credentials through the explicit worker environment");
  }
}

function redactSensitiveText(value: string): string {
  return String(redactSensitive(value));
}

function safeTmuxMessage(value: string): string {
  const normalized = value.replaceAll(String.fromCharCode(13, 10), "\n");
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 8 || code === 11 || code === 12 || (code >= 13 && code <= 31) || code === 127 || (code >= 128 && code <= 159)) {
      throw new Error("tmux input contains terminal control bytes; refusing to send it");
    }
  }
  return normalized;
}

function boundText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(-maxBytes).toString("utf8");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) {
    if (error instanceof Error && /ESRCH/u.test(error.message)) {
      try { process.kill(pid, signal); } catch (fallback) {
        if (!(fallback instanceof Error) || !/ESRCH/u.test(fallback.message)) throw fallback;
      }
      return;
    }
    throw error;
  }
}

interface ProcessIdentity {
  startTime: string;
  command: string;
  state: string;
}

async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    const fields = closeParen >= 0 ? statText.slice(closeParen + 2).trim().split(/\s+/u) : [];
    const state = fields[0];
    const startTime = fields[19];
    const command = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
    return startTime && command && state ? { startTime, command, state } : undefined;
  } catch {
    return undefined;
  }
}

async function sameProcess(record: TmuxRecord, pid: number): Promise<boolean> {
  const identity = await processIdentity(pid);
  return Boolean(identity && identity.startTime === record.paneStartTime && (!record.paneCommand || identity.command === record.paneCommand));
}

async function isPidAlive(pid: number): Promise<boolean> {
  const identity = await processIdentity(pid);
  if (identity) return identity.state !== "Z" && identity.state !== "X";
  try {
    process.kill(pid, 0);
    // The PID is signalable but /proc was not readable. Treat it as alive so
    // cleanup fails closed instead of guessing that a replacement is gone.
    return true;
  } catch (error) {
    return error instanceof Error && /EPERM/u.test(error.message);
  }
}

function boundedDelay(value: number): number {
  if (!Number.isFinite(value) || value < 1) throw new Error("tmux adapter delays must be positive finite numbers");
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isPaneIdentityError(error: unknown): boolean {
  return error instanceof Error && /tmux pane identity changed|pane identity unavailable|cannot identify tmux pane pid/iu.test(error.message);
}

function isMissingSession(error: unknown): boolean {
  return error instanceof Error && /(can't find session|no server running|session not found|failed to connect)/iu.test(error.message);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && /ENOENT/u.test(error.message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
