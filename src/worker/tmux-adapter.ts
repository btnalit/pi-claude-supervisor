import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
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
import { claudeJsonlArgs, cleanupCgroup, currentCgroupPath, preflightCgroupContainment } from "./process-adapter.ts";
import { isClaudeLauncherProcess, readProcess } from "./process-tree.ts";

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
  /** Linux cgroup mode for automatic tmux bridge descendants. */
  cgroupMode?: "off" | "auto" | "required";
}

interface TmuxRecord {
  handle: WorkerHandle;
  sessionName: string;
  socketPath?: string;
  target: string;
  expectedIdentity?: WorkerStartInput["tmuxExpectedIdentity"];
  logPath: string;
  runtimeDir: string;
  owned: boolean;
  pipeAttached: boolean;
  outputOffset: number;
  output: WorkerOutputChunk[];
  outputBytes: number;
  outputTruncated: boolean;
  structured: boolean;
  eventBuffer: string;
  seenResultIds: Set<string>;
  seenPermissionRequestIds: Set<string>;
  permissionResponses: Set<string>;
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
  startupToken?: string;
  abortListener?: () => void;
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
  guardianPid?: number;
  guardianStartTime?: string;
  cgroupPath?: string;
  cgroupError?: Error;
  cgroupCleaned?: boolean;
  runtimeError?: Error;
}

interface TmuxPaneStatus {
  dead: boolean;
  exitCode?: number;
  pid?: number;
}

const BRIDGE_KEYS = {
  command: "PI_CLAUDE_SUPERVISOR_TMUX_COMMAND",
  args: "PI_CLAUDE_SUPERVISOR_TMUX_ARGS",
  cgroup: "PI_CLAUDE_SUPERVISOR_TMUX_CGROUP",
} as const;
const BRIDGE_EVENT_START = "\u001bPPI_CLAUDE_SUPERVISOR_EVENT;";
const BRIDGE_INPUT_START = "\u001bPPI_CLAUDE_SUPERVISOR_INPUT;";
const BRIDGE_EVENT_END = "\u001b\\";

/**
 * A single process in the tmux pane owns both the interactive display and the
 * Claude stream-json control channel. Human input is ordinary text; Supervisor
 * input/permission responses use private @pi:* lines, so the same pane remains
 * live and attachable without making the safety-critical event stream a second
 * worker process.
 */
const TMUX_PANE_BOOTSTRAP_SCRIPT = `
const { writeFileSync } = require("node:fs");
const key = ${JSON.stringify(BRIDGE_KEYS.cgroup)};
const cgroup = Buffer.from(process.env[key] || "", "base64").toString("utf8");
if (cgroup) {
  try { writeFileSync(cgroup + "/cgroup.procs", String(process.pid) + "\\n"); }
  catch (error) { process.stderr.write("tmux pane bootstrap failed: " + (error instanceof Error ? error.message : String(error)) + "\\n"); process.exit(125); }
}
process.stdin.resume();
setInterval(() => {}, 10_000).unref();
`;

const TMUX_BRIDGE_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
const decode = (key) => Buffer.from(process.env[key] || "", "base64").toString("utf8");
const command = decode("${BRIDGE_KEYS.command}");
const args = JSON.parse(decode("${BRIDGE_KEYS.args}"));
const bridgeKeys = ${JSON.stringify(Object.values(BRIDGE_KEYS))};
const cgroup = decode("${BRIDGE_KEYS.cgroup}");
const eventStart = String.fromCharCode(27) + "PPI_CLAUDE_SUPERVISOR_EVENT;";
const inputStart = String.fromCharCode(27) + "PPI_CLAUDE_SUPERVISOR_INPUT;";
const eventEnd = String.fromCharCode(27) + "\\\\";
// Claude text is untrusted and shares the PTY with the Supervisor's private
// DCS event stream. Strip every ESC from display text so a model cannot forge a
// frame, including by splitting an escape sequence across output records.
const output = (value) => { process.stdout.write(String(value).split(String.fromCharCode(27)).join("")); };
const control = (value) => { process.stdout.write(String(value)); };
// Structured records share the bridge's PTY with the human-readable display.
// DCS is ignored by normal terminals, while pipe-pane preserves it for the
// Supervisor's parser; there is no independent JSONL event sidecar.
const writeEvent = (value) => {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  control(eventStart + payload + eventEnd);
};
if (cgroup) {
  try { writeFileSync(cgroup + "/cgroup.procs", String(process.pid) + "\\n"); }
  catch (error) {
    writeEvent({ type: "bridge_exit", code: 125, error: error instanceof Error ? error.message : String(error) });
    process.exit(125);
  }
}
const prompt = () => output("\\n> ");
const decodeLine = (value) => Buffer.from(value, "base64").toString("utf8");
const clearSupervisorInput = () => control("\\x1b[1A\\r\\x1b[2K\\x1b[1B\\r");
const childEnv = { ...process.env };
for (const key of bridgeKeys) delete childEnv[key];
let child;
let inputActive = false;
let stdoutBuffer = "";
try {
  child = spawn(command, args, { cwd: process.cwd(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
} catch (error) {
  writeEvent({ type: "bridge_exit", code: 125, error: error instanceof Error ? error.message : String(error) });
  process.exit(125);
}
const render = (record) => {
  if (record.type === "stream_event") {
    const event = record.event;
    const delta = event && typeof event === "object" ? event.delta : undefined;
    if (delta && typeof delta === "object" && delta.type === "text_delta" && typeof delta.text === "string") output(delta.text);
    return;
  }
  if (record.type === "assistant") {
    const content = record.message && typeof record.message === "object" ? record.message.content : undefined;
    if (Array.isArray(content)) for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") output(block.text);
      else if (block && block.type === "tool_use") output("\\n[tool " + String(block.name || "unknown") + "]\\n");
    }
    return;
  }
  if (record.type === "control_request") {
    const request = record.request;
    const name = request && typeof request === "object" ? request.tool_name : "unknown";
    output("\\n[permission requested: " + String(name) + "]\\n");
    return;
  }
  if (record.type === "result") {
    inputActive = false;
    output("\\n[result " + String(record.subtype || "completed") + "]");
    prompt();
    return;
  }
  if (record.type === "system") output("\\n[system " + String(record.subtype || "event") + "]\\n");
};
const processLine = (line) => {
  if (!line) return;
  let record;
  try { record = JSON.parse(line); } catch { output("\\n[invalid Claude JSONL output]\\n"); return; }
  writeEvent(record);
  render(record);
};
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += String(chunk);
  let newline;
  while ((newline = stdoutBuffer.indexOf("\\n")) >= 0) {
    processLine(stdoutBuffer.slice(0, newline).replace(/\\r$/u, ""));
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => output("\\n[claude stderr] " + String(chunk)));
child.once("error", (error) => {
  writeEvent({ type: "bridge_exit", code: 127, error: error.message });
  process.exit(127);
});
child.once("exit", (code, signal) => {
  if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
  writeEvent({ type: "bridge_exit", code, signal });
  output("\\n[Claude exited " + String(code === null ? signal : code) + "]\\n");
  process.exit(code ?? 1);
});
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.startsWith(inputStart)) {
    const end = line.indexOf(eventEnd, inputStart.length);
    if (end >= 0) {
      try {
        const frame = JSON.parse(Buffer.from(line.slice(inputStart.length, end), "base64").toString("utf8"));
        if (frame.type === "user") {
          inputActive = true;
          child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: String(frame.message || "") } }) + "\\n");
        } else if (frame.type === "json") {
          child.stdin.write(String(frame.message || "").replace(/\\n$/u, "") + "\\n");
        } else if (frame.type === "stop") {
          try { child.kill("SIGTERM"); } catch {}
        }
      } catch (error) {
        output("\\n[invalid Supervisor input frame: " + (error instanceof Error ? error.message : String(error)) + "]\\n");
      }
      return;
    }
  }
  if (line.startsWith("@pi:user ")) {
    clearSupervisorInput();
    inputActive = true;
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: decodeLine(line.slice("@pi:user ".length)) } }) + "\\n");
    return;
  }
  if (line.startsWith("@pi:json ")) {
    clearSupervisorInput();
    const message = decodeLine(line.slice("@pi:json ".length));
    child.stdin.write(message.endsWith("\\n") ? message : message + "\\n");
    return;
  }
  if (line === "@pi:stop") {
    clearSupervisorInput();
    try { child.kill("SIGTERM"); } catch {}
    return;
  }
  if (!line.trim()) return;
  inputActive = true;
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: line } }) + "\\n");
});
input.on("close", () => { try { child.kill("SIGTERM"); } catch {} });
prompt();
`;

const GUARDIAN_KEYS = {
  tmux: "PI_CLAUDE_SUPERVISOR_TMUX_BINARY",
  socket: "PI_CLAUDE_SUPERVISOR_TMUX_SOCKET",
  session: "PI_CLAUDE_SUPERVISOR_TMUX_SESSION",
  cgroup: "PI_CLAUDE_SUPERVISOR_TMUX_CGROUP",
  parentPid: "PI_CLAUDE_SUPERVISOR_TMUX_PARENT_PID",
  parentStart: "PI_CLAUDE_SUPERVISOR_TMUX_PARENT_START",
} as const;

const TMUX_GUARDIAN_SCRIPT = `
const { spawnSync } = require("node:child_process");
const { readFileSync, rmSync, rmdirSync, writeFileSync } = require("node:fs");
const decode = (key) => Buffer.from(process.env[key] || "", "base64").toString("utf8");
const tmux = decode("${GUARDIAN_KEYS.tmux}");
const socket = decode("${GUARDIAN_KEYS.socket}");
const session = decode("${GUARDIAN_KEYS.session}");
const cgroup = decode("${GUARDIAN_KEYS.cgroup}");
const parentPid = Number(decode("${GUARDIAN_KEYS.parentPid}"));
const parentStart = decode("${GUARDIAN_KEYS.parentStart}");
const readStart = (pid) => {
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    return close < 0 ? undefined : stat.slice(close + 2).trim().split(/\\s+/u)[19];
  } catch { return undefined; }
};
const alive = () => Boolean(parentPid > 0 && (() => {
  try { process.kill(parentPid, 0); } catch { return false; }
  return !parentStart || readStart(parentPid) === parentStart;
})());
const timer = setInterval(() => {
  if (alive()) return;
  clearInterval(timer);
  try { spawnSync(tmux, ["-S", socket, "kill-session", "-t", session], { stdio: "ignore" }); } catch {}
  if (cgroup) {
    try { writeFileSync(cgroup + "/cgroup.kill", "1\\n"); } catch {}
    const reap = () => {
      try {
        if (/^populated 0$/mu.test(readFileSync(cgroup + "/cgroup.events", "utf8"))) {
          try { rmdirSync(cgroup); } catch { try { rmSync(cgroup, { recursive: true, force: true }); } catch {} }
          process.exit(0);
          return;
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
          process.exit(0);
          return;
        }
      }
      setTimeout(reap, 50).unref();
    };
    reap();
  } else process.exit(0);
}, 100);
`;

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
  readonly #cgroupMode: "off" | "auto" | "required";
  readonly #maxOutputBytes = 8 * 1024 * 1024;
  readonly #maxLogBytes = 16 * 1024 * 1024;
  readonly #commandTimeoutMs = 10_000;

  constructor(options: TmuxWorkerAdapterOptions = {}) {
    this.#stateDir = options.stateDir ?? join(tmpdir(), "pi-claude-supervisor");
    this.#tmuxBinary = options.tmuxBinary ?? "tmux";
    this.#startupTimeoutMs = boundedDelay(options.startupTimeoutMs ?? 60_000);
    this.#pollIntervalMs = boundedDelay(options.pollIntervalMs ?? 500);
    this.#terminationGraceMs = boundedDelay(options.terminationGraceMs ?? 2_000);
    this.#cgroupMode = options.cgroupMode ?? "auto";
  }

  async preflight(input: Pick<WorkerStartInput, "cwd" | "command" | "args" | "env" | "approval" | "automatic">): Promise<void> {
    const args = input.automatic ? claudeJsonlArgs(input.args) : (input.args ?? []);
    assertSafeWorkerCommand(input.command, args, input.approval);
    await assertDirectory(input.cwd);
    if (process.platform !== "linux") throw new Error("tmux supervision currently requires Linux process identity and cleanup support");
    await assertExecutableAvailable(input.command, input.env?.PATH ?? process.env.PATH);
    await assertExecutableAvailable(this.#tmuxBinary, process.env.PATH);
    if (input.automatic) {
      if (process.platform !== "linux") throw new Error("automatic tmux supervision requires Linux cgroup v2 and a parent-death guardian");
      if (this.#cgroupMode === "off") throw new Error("automatic tmux supervision requires cgroup containment");
      await preflightCgroupContainment();
      const parent = await processIdentity(process.pid);
      if (!parent?.startTime) throw new Error("automatic tmux supervision cannot verify the parent process identity");
    }
    await mkdir(this.#stateDir, { recursive: true, mode: 0o700 });
    const stateInfo = await lstat(this.#stateDir);
    if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) throw new Error(`tmux state directory is not a real directory: ${this.#stateDir}`);
    await chmod(this.#stateDir, 0o700);
  }

  capabilities(): WorkerCapabilities {
    return {
      transport: "tmux",
      interactiveInput: true,
      pause: true,
      resumeSession: false,
      processGroupControl: false,
      persistentSession: true,
      repairableSession: true,
    };
  }

  async start(input: WorkerStartInput): Promise<WorkerHandle> {
    const id = randomUUID();
    const owned = !input.tmuxSession;
    const structured = Boolean(input.automatic);
    if (input.tmuxSession && input.sendInitialInput === true) throw new Error("adopted tmux sessions cannot replay the original task");
    if (structured && !owned) throw new Error("automatic tmux supervision requires a Supervisor-owned tmux bridge; adopted sessions are manual-only");
    const sendInitialInput = owned && input.sendInitialInput !== false;
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
      tmuxTarget: target,
    };
    if (process.platform !== "linux") throw new Error("tmux supervision currently requires Linux process identity and cleanup support");
    const record: TmuxRecord = {
      handle,
      sessionName,
      socketPath,
      target,
      expectedIdentity: input.tmuxExpectedIdentity,
      logPath,
      runtimeDir,
      owned,
      pipeAttached: false,
      outputOffset: 0,
      output: [],
      outputBytes: 0,
      outputTruncated: false,
      structured,
      eventBuffer: "",
      seenResultIds: new Set(),
      seenPermissionRequestIds: new Set(),
      permissionResponses: new Set(),
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
      startupToken: input.startupToken,
      released: false,
      cleanupComplete: false,
    };
    const abortListener = () => {
      record.abortRequested = true;
      record.stopping = true;
    };
    record.abortListener = abortListener;
    input.abortSignal?.addEventListener("abort", abortListener, { once: true });
    this.#records.set(id, record);
    if (input.abortSignal?.aborted) abortListener();

    try {
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      await writeFile(logPath, "", { mode: 0o600 });
      if (owned) {
        if (process.platform !== "linux") throw new Error("owned tmux supervision requires a Linux parent-death guardian");
        if (structured && this.#cgroupMode === "off") throw new Error("automatic tmux supervision requires cgroup containment");
        if (structured) {
          try {
            record.cgroupPath = await this.#createCgroup(id);
            record.handle.cgroupPath = record.cgroupPath;
          } catch (error) {
            record.cgroupError = asError(error);
            throw new Error(`automatic tmux cgroup setup failed: ${record.cgroupError.message}`, { cause: record.cgroupError });
          }
        }
        const env = workerEnvironment(process.env, input.env);
        const workerArgs = structured ? claudeJsonlArgs(input.args) : (input.args ?? []);
        assertSafeWorkerCommand(input.command, workerArgs, input.approval);
        assertNoCredentialArguments(input.command, workerArgs);
        const bridgeEnv = structured
          ? bridgeEnvironment(env, input.command, workerArgs, record.cgroupPath)
          : env;
        // Arm the guardian before creating the session. If the Supervisor dies
        // in the tmux startup window, the guardian removes any server created
        // after it and also reaps the automatic bridge cgroup.
        if (!socketPath) throw new Error("owned tmux startup did not allocate a private socket");
        await this.#startGuardian(record, socketPath);
        if (record.cleanupError) throw record.cleanupError;
        const paneBootstrap = [process.execPath, "-e", TMUX_PANE_BOOTSTRAP_SCRIPT];
        await this.#run(record, ["new-session", "-d", "-s", sessionName, "-x", "140", "-y", "40", "-c", input.cwd, "--", ...paneBootstrap], undefined, bridgeEnv);
        record.sessionCreated = true;
        await this.#run(record, ["set-window-option", "-t", sessionName, "remain-on-exit", "on"]);
        await input.preSpawnCheck?.();
        const launch = structured
          ? [process.execPath, "-e", TMUX_BRIDGE_SCRIPT]
          : [input.command, ...workerArgs];
        await this.#run(record, ["respawn-pane", "-k", "-t", target, "--", ...launch], undefined, bridgeEnv);
        await this.#pinTarget(record);
        const ownedPane = await this.#paneStatus(record);
        record.paneDead = ownedPane.dead;
        if (!ownedPane.dead) {
          // respawn-pane may still be replacing the old shell when the first
          // pane_pid is observed. Pin the identity only after the bridge has
          // rendered its ready prompt below; #send repeats the check immediately
          // before input reservation.
          record.panePid = ownedPane.pid;
          record.handle.pid = ownedPane.pid;
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
      if (sendInitialInput || !input.tmuxSession) await this.#waitForReady(record);
      if (owned) {
        const readyPane = await this.#paneStatus(record);
        if (readyPane.dead) throw new Error("tmux worker exited before identity could be pinned");
        record.paneDead = false;
        record.panePid = readyPane.pid;
        record.handle.pid = readyPane.pid;
        await this.#rememberPaneIdentity(record, readyPane.pid);
      }
      if (sendInitialInput) {
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
    } finally {
      if (record.abortListener) input.abortSignal?.removeEventListener("abort", record.abortListener);
      record.abortListener = undefined;
    }
  }

  async abortStart(_reason: string, startupToken?: string): Promise<void> {
    const starts = [...this.#records.values()].filter((record) => record.starting && (startupToken === undefined || record.startupToken === startupToken));
    for (const record of starts) {
      record.abortRequested = true;
      record.stopping = true;
      if (record.owned) {
        await this.#stopGuardian(record).catch((error) => { record.cleanupError ??= asError(error); });
        await this.#run(record, ["kill-server"], undefined, undefined, true).catch(() => {});
      } else await this.#detachPipe(record);
    }
    const deadline = Date.now() + 25_000;
    while (starts.some((record) => record.starting) && Date.now() < deadline) await delay(25);
  }

  async getStatus(handle: WorkerHandle): Promise<WorkerStatus> {
    const record = this.#record(handle);
    if (record.released) {
      try {
        const pane = await this.#paneStatus(record);
        record.paneDead = pane.dead;
        record.panePid = pane.pid;
        if (pane.dead) record.cleanupError = undefined;
        else await this.#rememberPaneIdentity(record, pane.pid);
      } catch (error) {
        if (isMissingSession(error)) {
          record.paneDead = true;
          record.cleanupError = undefined;
        } else if (isPaneIdentityError(error)) {
          record.paneDead = false;
          record.cleanupComplete = false;
          record.cleanupError = asError(error);
        } else {
          record.cleanupComplete = false;
          record.cleanupError = asError(error);
        }
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
        record.cleanupError = undefined;
        if (!record.cleanupComplete && record.owned) await this.#cleanup(record, false);
      } else {
        record.cleanupError = asError(error);
        if (isPaneIdentityError(error)) record.paneDead = false;
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

  async respondPermission(handle: WorkerHandle, requestId: string, toolUseId: string, decision: { behavior: "allow" | "deny"; message?: string }, updatedInput?: unknown): Promise<void> {
    const record = this.#record(handle);
    if (!record.structured) throw new Error("permission responses require the automated tmux bridge");
    if (record.permissionResponses.has(requestId)) return;
    if (record.released || record.stopping) throw new Error("tmux worker is no longer supervised");
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
    await this.#sendControl(record, response);
    record.permissionResponses.add(requestId);
    record.lastInputAt = new Date().toISOString();
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
          if (record.structured) await this.#sendControl(record, undefined, "@pi:stop");
          else await this.#sendRaw(record, "/exit");
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
    if (!record.structured) {
      try { await this.#stopGuardian(record); }
      catch (error) { record.cleanupError ??= asError(error); }
    }
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
    record.cleanupComplete = !record.cleanupError;
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
    if (!record.pipeAttached || record.paneDead) {
      record.pipeAttached = false;
      return;
    }
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
    if (record.structured) {
      const encoded = Buffer.from(safeTmuxMessage(message), "utf8").toString("base64");
      await this.#sendLine(record, `@pi:user ${encoded}`);
      return;
    }
    const safeMessage = safeTmuxMessage(message);
    const bufferName = `pi-cs-${record.handle.id}`;
    // Ask tmux to emit a real bracketed paste. Embedding the escape markers
    // in the buffer makes Claude's TUI render them literally instead of
    // entering paste mode.
    await this.#run(record, ["load-buffer", "-b", bufferName, "-"], safeMessage);
    await this.#run(record, ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", record.target]);
    await this.#run(record, ["send-keys", "-t", record.target, "Enter"]);
  }

  async #sendControl(record: TmuxRecord, value?: Record<string, unknown>, rawCommand?: string): Promise<void> {
    if (!record.structured) throw new Error("tmux control messages require the automated bridge");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = record.inputTail;
    record.inputTail = previous.then(() => gate);
    await previous;
    try {
      const encoded = rawCommand ?? `@pi:json ${Buffer.from(`${JSON.stringify(value)}\n`, "utf8").toString("base64")}`;
      await this.#sendLine(record, encoded);
    } finally {
      release();
    }
  }

  async #sendLine(record: TmuxRecord, line: string): Promise<void> {
    const safeLine = safeTmuxMessage(line);
    const bufferName = `pi-cs-${record.handle.id}`;
    await this.#run(record, ["load-buffer", "-b", bufferName, "-"], safeLine);
    await this.#run(record, ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", record.target]);
    await this.#run(record, ["send-keys", "-t", record.target, "Enter"]);
  }

  #startMonitor(record: TmuxRecord): void {
    record.monitor = setInterval(() => {
      void this.#monitor(record).catch((error) => {
        if (isPaneIdentityError(error)) record.paneDead = false;
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
      // Inspect the pane before capturing its screen. A normal stop or an
      // externally killed pane can remove the bridge between these two reads;
      // treating that expected exit as a runtime failure would turn successful
      // cleanup into a false error.
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
      if (record.structured) {
        if (record.activeRequests === 0 && hasBridgePromptInput(screen)) {
          // A human may have typed directly into the attached bridge prompt.
          record.activeRequests = 1;
          record.inputAt = Date.now();
          record.lastInputAt = new Date().toISOString();
        }
        return;
      }
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
    const expected = record.expectedIdentity;
    if (expected?.pid !== undefined && pane.pid !== expected.pid) throw new Error("tmux pane pid changed; refusing identity-unverified handoff");
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
    const argsText = processArgs.stdout.trim();
    const commandLine = `${command} ${argsText}`.trim();
    const paneProcess = await readProcess(pane.pid);
    if (!argsText || !paneProcess || !isClaudeLauncherProcess(paneProcess)) {
      throw new Error(`tmux pane is not a Claude Code executable: ${redactSensitiveText(commandLine || "unknown")}`);
    }
    assertSafeWorkerCommand(command, [argsText], approval);
    await this.#rememberPaneIdentity(record, pane.pid);
    if (expected?.startTime && record.paneStartTime !== expected.startTime) throw new Error("tmux pane process start time changed; refusing identity-unverified handoff");
    if (expected?.paneStartTime && record.paneStartTime !== expected.paneStartTime) throw new Error("tmux pane identity changed; refusing identity-unverified handoff");
    if (expected?.paneCommand && record.paneCommand !== expected.paneCommand) throw new Error("tmux pane command changed; refusing identity-unverified handoff");
  }

  async #pinTarget(record: TmuxRecord): Promise<void> {
    if (record.expectedIdentity?.tmuxTarget && record.expectedIdentity.tmuxTarget !== record.sessionName) throw new Error("tmux session target changed; refusing identity-unverified handoff");
    const pane = await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_id}"]);
    const paneId = pane.stdout.trim();
    if (!/^%[0-9]+$/u.test(paneId)) throw new Error("tmux did not return a stable pane id");
    if (record.expectedIdentity?.tmuxPaneId && record.expectedIdentity.tmuxPaneId !== paneId) throw new Error("tmux pane target changed; refusing identity-unverified handoff");
    record.handle.tmuxPaneId = paneId;
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
      record.handle.paneStartTime = startTime;
      record.handle.paneCommand = command;
    } catch (error) {
      if (error instanceof Error && /tmux pane identity changed/u.test(error.message)) throw error;
      throw new Error(`tmux pane identity unavailable for pid ${pid}`);
    }
  }

  async #createCgroup(id: string): Promise<string> {
    const parent = await currentCgroupPath();
    const path = `${parent}/pi-claude-supervisor-tmux-${id}`;
    await mkdir(path);
    return path;
  }

  async #startGuardian(record: TmuxRecord, socketPath: string): Promise<void> {
    if (process.platform !== "linux") return;
    const parent = await processIdentity(process.pid);
    if (!parent?.startTime) throw new Error("cannot start tmux parent-death guardian without a parent process identity");
    const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      [GUARDIAN_KEYS.tmux]: encode(this.#tmuxBinary),
      [GUARDIAN_KEYS.socket]: encode(socketPath),
      [GUARDIAN_KEYS.session]: encode(record.sessionName),
      [GUARDIAN_KEYS.cgroup]: encode(record.cgroupPath ?? ""),
      [GUARDIAN_KEYS.parentPid]: encode(String(process.pid)),
      [GUARDIAN_KEYS.parentStart]: encode(parent.startTime),
    };
    const child = spawn(process.execPath, ["-e", TMUX_GUARDIAN_SCRIPT], { detached: true, stdio: "ignore", env });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("tmux parent-death guardian did not expose a pid");
    record.guardianPid = child.pid;
    const identity = await processIdentity(child.pid);
    if (!identity?.startTime) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
      throw new Error("tmux parent-death guardian identity is unavailable");
    }
    record.guardianStartTime = identity.startTime;
    child.once("exit", () => {
      if (!record.cleanupComplete && !record.stopping && !record.paneDead) record.cleanupError ??= new Error("tmux parent-death guardian exited unexpectedly");
    });
    child.unref();
    await delay(10);
    if (!isPidAlive(child.pid) || await isZombie(child.pid)) throw new Error("tmux parent-death guardian exited during startup");
  }

  async #stopGuardian(record: TmuxRecord): Promise<void> {
    const pid = record.guardianPid;
    if (!pid) return;
    record.guardianPid = undefined;
    if (!isPidAlive(pid) || await isZombie(pid)) return;
    const identity = await processIdentity(pid);
    if (!identity || !record.guardianStartTime || identity.startTime !== record.guardianStartTime) {
      throw new Error(`refusing to terminate an unverified tmux guardian process: ${pid}`);
    }
    try { process.kill(pid, "SIGTERM"); }
    catch (error) { if (!(error instanceof Error) || !/ESRCH/u.test(error.message)) throw error; }
    for (let attempt = 0; attempt < 20 && isPidAlive(pid); attempt += 1) await delay(25);
    if (isPidAlive(pid) && !(await isZombie(pid))) {
      const replacement = await processIdentity(pid);
      if (replacement?.startTime !== record.guardianStartTime) throw new Error(`tmux guardian identity changed during cleanup: ${pid}`);
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error) || !/ESRCH/u.test(error.message)) throw error; }
    }
    for (let attempt = 0; attempt < 20 && isPidAlive(pid); attempt += 1) await delay(25);
    if (isPidAlive(pid) && !(await isZombie(pid))) throw new Error(`tmux parent-death guardian did not exit: ${pid}`);
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
    try { await this.#stopGuardian(record); }
    catch (error) { record.cleanupError ??= asError(error); }
    try {
      await this.#run(record, ["kill-server"], undefined, undefined, true);
      record.serverKilled = true;
    } catch (error) {
      if (isMissingSession(error)) record.serverKilled = true;
      else record.cleanupError = asError(error);
    }
    if (!record.serverKilled) await this.#ensurePaneGone(record);
    if (record.cgroupPath) {
      try {
        await cleanupCgroup(record.cgroupPath, this.#terminationGraceMs);
        record.cgroupCleaned = true;
      } catch (error) {
        record.cgroupError ??= asError(error);
        record.cleanupError ??= record.cgroupError;
      }
    }
    try { await rm(record.runtimeDir, { recursive: true, force: true }); }
    catch (error) { record.cleanupError ??= asError(error); }
    record.cleanupComplete = !record.cleanupError && (record.serverKilled || !record.sessionCreated) && (!record.cgroupPath || record.cgroupCleaned === true);
  }

  async #ensurePaneGone(record: TmuxRecord): Promise<void> {
    const pid = record.panePid ?? record.handle.pid;
    if (!pid || !record.paneStartTime) {
      if (record.serverKilled && (!record.sessionCreated || record.paneDead)) return;
      record.cleanupError = new Error("owned tmux cleanup lacks a verifiable pane identity");
      return;
    }
    if (!isPidAlive(pid) || await isZombie(pid)) return;
    if (!(await sameProcess(record, pid))) {
      await this.#markReplacement(record, pid);
      return;
    }
    signalProcessGroup(pid, "SIGTERM");
    for (let attempt = 0; attempt < 10 && isPidAlive(pid); attempt += 1) await delay(50);
    if (isPidAlive(pid) && !(await isZombie(pid))) {
      if (!(await sameProcess(record, pid))) {
        await this.#markReplacement(record, pid);
        return;
      }
      signalProcessGroup(pid, "SIGKILL");
    }
    for (let attempt = 0; attempt < 10 && isPidAlive(pid); attempt += 1) await delay(50);
    if (isPidAlive(pid) && !(await isZombie(pid))) {
      if (await sameProcess(record, pid)) record.cleanupError = new Error(`tmux pane process did not exit: ${pid}`);
      else await this.#markReplacement(record, pid);
    }
  }

  async #markReplacement(record: TmuxRecord, pid: number): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await isZombie(pid)) return;
      const identity = await processIdentity(pid);
      if (identity) {
        record.replacementPaneStartTime = identity.startTime;
        record.replacementPaneCommand = identity.command;
        record.cleanupError = new Error(`owned tmux cleanup refused replacement pane process pid=${pid} start=${identity.startTime} command=${identity.command}`);
        return;
      }
      if (!isPidAlive(pid)) return;
      await delay(25);
    }
    record.cleanupError = new Error(`owned tmux cleanup refused an unverified replacement pane process pid=${pid}`);
  }

  #assertNotAborted(record: TmuxRecord): void {
    if (record.abortRequested) throw new Error("tmux worker startup was aborted");
  }

  async #run(record: TmuxRecord, args: string[], input?: string, env = workerEnvironment(process.env), ignoreAbort = false): Promise<{ stdout: string; stderr: string }> {
    if (record.abortRequested && !ignoreAbort) throw new Error("tmux worker startup was aborted");
    const tmuxArgs = record.socketPath
      ? [...(record.structured ? ["-f", "/dev/null"] : []), "-S", record.socketPath, ...args]
      : args;
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
            const rawText = buffer.subarray(0, bytesRead).toString("utf8");
            record.outputOffset = start + bytesRead;
            record.lastOutputAt = new Date().toISOString();
            const text = record.structured ? this.#consumeBridgeStream(record, rawText) : rawText;
            if (text) this.#appendOutput(record, { stream: "stdout", text, at: record.lastOutputAt });
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

  #consumeBridgeStream(record: TmuxRecord, text: string): string {
    record.eventBuffer += text;
    if (Buffer.byteLength(record.eventBuffer, "utf8") > this.#maxLogBytes) {
      record.eventBuffer = "";
      record.outputTruncated = true;
      return "";
    }
    let visible = "";
    while (record.eventBuffer) {
      const eventStart = record.eventBuffer.indexOf(BRIDGE_EVENT_START);
      const inputStart = record.eventBuffer.indexOf(BRIDGE_INPUT_START);
      const candidates = [
        ...(eventStart >= 0 ? [{ index: eventStart, prefix: BRIDGE_EVENT_START, structured: true }] : []),
        ...(inputStart >= 0 ? [{ index: inputStart, prefix: BRIDGE_INPUT_START, structured: false }] : []),
      ].sort((left, right) => left.index - right.index);
      const candidate = candidates[0];
      if (!candidate) {
        const keep = Math.max(
          partialFramePrefixLength(record.eventBuffer, BRIDGE_EVENT_START),
          partialFramePrefixLength(record.eventBuffer, BRIDGE_INPUT_START),
        );
        visible += record.eventBuffer.slice(0, record.eventBuffer.length - keep);
        record.eventBuffer = keep ? record.eventBuffer.slice(-keep) : "";
        break;
      }
      visible += record.eventBuffer.slice(0, candidate.index);
      const end = record.eventBuffer.indexOf(BRIDGE_EVENT_END, candidate.index + candidate.prefix.length);
      if (end < 0) {
        record.eventBuffer = record.eventBuffer.slice(candidate.index);
        break;
      }
      const payload = record.eventBuffer.slice(candidate.index + candidate.prefix.length, end);
      record.eventBuffer = record.eventBuffer.slice(end + BRIDGE_EVENT_END.length);
      if (!candidate.structured) continue;
      try {
        const parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.#handleStructuredEvent(record, parsed as Record<string, unknown>);
      } catch {
        record.outputTruncated = true;
      }
    }
    return stripInternalBridgeEcho(visible);
  }

  #handleStructuredEvent(record: TmuxRecord, event: Record<string, unknown>): void {
    this.#emit(record, { type: "jsonl", handle: record.handle, record: event });
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
    if (event.type === "result" && record.activeRequests > 0) {
      const resultId = jsonlRecordId(event, record.turnSequence + 1);
      if (!record.seenResultIds.has(resultId)) {
        rememberBounded(record.seenResultIds, resultId);
        record.activeRequests = Math.max(0, record.activeRequests - 1);
        record.turnSequence += 1;
        this.#emit(record, { type: "turn_completed", handle: record.handle, result: event, sequence: record.turnSequence });
      }
    }
    if (event.type === "bridge_exit") record.activeRequests = 0;
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
      exitReason: running ? undefined : record.runtimeError ? "failed" : record.stopping ? "stopped" : record.exitCode === 0 ? "completed" : "failed",
      processGroupCleaned: record.cleanupComplete,
      cleanupError: record.cleanupError?.message,
      runtimeError: record.runtimeError?.message,
      cgroupCleaned: record.cgroupPath ? record.cgroupCleaned : undefined,
      cgroupRequired: record.cgroupPath ? true : undefined,
      cgroupError: record.cgroupError?.message,
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

function bridgeEnvironment(env: NodeJS.ProcessEnv, command: string, args: readonly string[], cgroupPath?: string): NodeJS.ProcessEnv {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  return {
    ...env,
    [BRIDGE_KEYS.command]: encode(command),
    [BRIDGE_KEYS.args]: encode(JSON.stringify(args)),
    [BRIDGE_KEYS.cgroup]: encode(cgroupPath ?? ""),
  };
}

export function attachCommand(handle: Pick<WorkerHandle, "tmuxSocket" | "sessionName">): string {
  const target = shellQuote(handle.sessionName ?? "");
  return handle.tmuxSocket ? `tmux -S ${shellQuote(handle.tmuxSocket)} attach -t ${target}` : `tmux attach -t ${target}`;
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

function hasBridgePromptInput(screen: string): boolean {
  const lines = stripAnsi(screen).replaceAll("\u00a0", " ").split(/\r?\n/u).map((line) => line.trim());
  // Supervisor input is echoed by the PTY after the bridge prompt. A long
  // base64 frame can wrap, and the bridge's one-line erase then leaves the
  // first `> @pi:user ...` line visible after the result. It is stale control
  // input, not a human turn; counting it would leave activeRequests stuck at 1.
  return lines.some((line) => /^>\s+.+$/u.test(line) && !/^>\s+@pi:(?:user|json)\s+/u.test(line));
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

function stripInternalBridgeEcho(value: string): string {
  return value
    .replaceAll("\u001b[1A\r\u001b[2K\u001b[1B\r", "")
    .replace(/(?:^|\r?\n)[^\r\n]*@pi:(?:user|json) [A-Za-z0-9+/=]+\r?(?=\n|$)/gu, "\n")
    .replace(/(?:^|\r?\n)[^\r\n]*@pi:stop\r?(?=\n|$)/gu, "\n");
}

function partialFramePrefixLength(value: string, prefix: string): number {
  const limit = Math.min(value.length, prefix.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(prefix.slice(0, length))) return length;
  }
  return 0;
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
}

async function isZombie(pid: number): Promise<boolean> {
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    const fields = closeParen >= 0 ? statText.slice(closeParen + 2).trim().split(/\s+/u) : [];
    return fields[0] === "Z";
  } catch {
    return false;
  }
}

async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    const fields = closeParen >= 0 ? statText.slice(closeParen + 2).trim().split(/\s+/u) : [];
    const startTime = fields[19];
    const command = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
    return startTime && command ? { startTime, command } : undefined;
  } catch {
    return undefined;
  }
}

async function sameProcess(record: TmuxRecord, pid: number): Promise<boolean> {
  const identity = await processIdentity(pid);
  return Boolean(identity && identity.startTime === record.paneStartTime && (!record.paneCommand || identity.command === record.paneCommand));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && /EPERM/u.test(error.message);
  }
}

async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`Worker cwd is not a directory: ${path}`);
  await access(path, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
}

async function assertExecutableAvailable(command: string, pathValue: string | undefined): Promise<void> {
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
  throw new Error(`executable preflight failed (ENOENT): ${command}`);
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

function rememberBounded(values: Set<string>, value: string, limit = 2_000): void {
  values.add(value);
  while (values.size > limit) {
    const first = values.values().next().value;
    if (first === undefined) break;
    values.delete(first);
  }
}

function jsonlRecordId(record: Record<string, unknown>, sequence?: number): string {
  for (const key of ["uuid", "request_id"]) {
    if (typeof record[key] === "string" && record[key]) return `${key}:${record[key]}`;
  }
  return `result:${sequence ?? "unknown"}:${JSON.stringify(record).slice(0, 512)}`;
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
