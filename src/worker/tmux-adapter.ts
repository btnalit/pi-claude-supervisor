import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { constants as fsConstants, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { access, chmod, lstat, mkdir, open, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  PermissionDecision,
  WorkerAdapter,
  WorkerCapabilities,
  WorkerEventListener,
  WorkerHandle,
  WorkerOutputChunk,
  WorkerStartInput,
  WorkerStatus,
} from "../types.ts";
import type { ClaudeHookEvent, HookEventSource, HookRelayReply, HookRelayRequest } from "../hooks/types.ts";
import { HOOK_TIMEOUT_SECONDS } from "../hooks/types.ts";
import { assertSafeWorkerCommand, sameDirectory, shellQuote } from "../policy.ts";
import { redactSensitive } from "../redaction.ts";
import { automaticWorkerEnvironment, claudeConfigDir, trustedAbsoluteExecutablePath, trustedExecutablePath, workerEnvironment } from "./environment.ts";
import { assertCgroupDirectory, claudeJsonlArgs, cleanupCgroup, currentCgroupPath, preflightCgroupContainment } from "./process-adapter.ts";
import { isClaudeLauncherProcess, readProcess, type ProcessTreeEntry } from "./process-tree.ts";
import { nodeScriptCommand } from "./runtime.ts";

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
  /** Keeps multibyte PTY characters intact and rejects malformed output. */
  outputDecoder: TextDecoder;
  eventBuffer: string;
  seenResultIds: Set<string>;
  seenPermissionRequestIds: Set<string>;
  permissionResponses: Set<string>;
  lastOutputAt?: string;
  lastInputAt?: string;
  activeRequests: number;
  turnSequence: number;
  /** Monotonic counter for prompt-phase permission request ids. */
  promptSequence: number;
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
  /**
   * Set once an owned interactive `release()` has migrated every process out
   * of the Worker cgroup and handed the tmux session back to the operator.
   * The pane process is intentionally still alive; `detached` is the signal
   * that the Supervisor owes no further cleanup and the cwd lease may go.
   */
  detached?: boolean;
  sessionCreated?: boolean;
  serverKilled?: boolean;
  cleanupError?: Error;
  panePid?: number;
  paneStartTime?: string;
  paneCommand?: string;
  /**
   * The actual Claude Code process pid/start time, for hook binding only. An
   * adopted launcher-wrapped pane (`panePid` is the launcher, Claude is its
   * child) pins this to the Claude child; otherwise it mirrors `panePid`.
   * `tmuxExpectedIdentity`/pause/resume/replacement-detection keep using
   * `panePid`, which is the pane's actual occupant.
   */
  claudePid?: number;
  claudeStartTime?: string;
  replacementPaneStartTime?: string;
  replacementPaneCommand?: string;
  paneDead?: boolean;
  guardianPid?: number;
  guardianStartTime?: string;
  bridgeGeneration?: string;
  serverPid?: number;
  serverStartTime?: string;
  cgroupPath?: string;
  cgroupError?: Error;
  cgroupCleaned?: boolean;
  runtimeError?: Error;
  /** Hook-driven interactive TUI mode (a subset of `structured`'s automatic parent). */
  interactive: boolean;
  hookUnsubscribe?: () => Promise<void>;
  claudeSessionId?: string;
  transcriptPath?: string;
  /**
   * The configuration directory of the adopted Claude process itself, read from
   * its environment at adoption: a session started with another
   * `CLAUDE_CONFIG_DIR` or `HOME` keeps its memory there, not where this
   * Supervisor's environment says. Absent for an owned session, whose
   * environment is this process's.
   */
  claudeConfigDir?: string;
  /** Claude Code's per-session scratchpad directory (from SessionStart); an extra write root for the policy. */
  scratchpadDir?: string;
  /** Primary readiness signal for interactive startup: SessionStart observed. */
  sessionStartReceived: boolean;
  /** Messages the adapter itself pasted, awaiting UserPromptSubmit acknowledgement. */
  pendingSentMessages: string[];
  pendingPermissionRequests: Map<string, { phase: "pre" | "prompt"; fingerprint?: string; resolve: (reply: HookRelayReply) => void }>;
  /** Per-worker capability carried by the relay, when this launch supplied one. */
  hookCapability?: string;
  /** Hook requests that did not bind to this pane's identity, for diagnostics. */
  ignoredHookRequests: number;
}

interface TmuxPaneStatus {
  dead: boolean;
  exitCode?: number;
  pid?: number;
}

const BRIDGE_KEYS = {
  command: "PI_CLAUDE_SUPERVISOR_TMUX_COMMAND",
  args: "PI_CLAUDE_SUPERVISOR_TMUX_ARGS",
  cwd: "PI_CLAUDE_SUPERVISOR_TMUX_CWD",
  cgroup: "PI_CLAUDE_SUPERVISOR_TMUX_CGROUP",
} as const;
const BRIDGE_EVENT_START = "\u001bPPI_CLAUDE_SUPERVISOR_EVENT;";
const BRIDGE_INPUT_START = "\u001bPPI_CLAUDE_SUPERVISOR_INPUT;";
const BRIDGE_EVENT_END = "\u001b\\";
const BRIDGE_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
const { randomBytes } = require("node:crypto");
const { TextDecoder } = require("node:util");
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { homedir } = require("node:os");
const readline = require("node:readline");
const decode = (key) => Buffer.from(process.env[key] || "", "base64").toString("utf8");
const command = decode("${BRIDGE_KEYS.command}");
const args = JSON.parse(decode("${BRIDGE_KEYS.args}"));
const cwd = decode("${BRIDGE_KEYS.cwd}");
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
// Each bridge process gets a private in-memory generation. A response that was
// queued for an older bridge can therefore never be forwarded by a respawned
// bridge, even if it reaches the replacement pane after the PID check.
const bridgeGeneration = randomBytes(32).toString("hex");
const supervisorControlPrefix = "@pi:control ";
const supervisorChunkPrefix = "@pi:chunk ";
const supervisorChunks = new Map();
const MAX_SUPERVISOR_CHUNKS = 4096;
const MAX_SUPERVISOR_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_SUPERVISOR_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_CLAUDE_LINE_BYTES = 2 * 1024 * 1024;
writeEvent({ type: "bridge_generation", generation: bridgeGeneration });
const prompt = () => output("\\n> ");
const decodeLine = (value) => Buffer.from(value, "base64").toString("utf8");
const clearSupervisorInput = () => control("\\x1b[1A\\r\\x1b[2K\\x1b[1B\\r");
const childEnv = { ...process.env };
for (const key of bridgeKeys) delete childEnv[key];
const isBashRule = (value) => (Array.isArray(value) ? value : [value]).some((item) => typeof item === "string" && item.split(/[\\s,]+/u).some((rule) => /^Bash(?:$|\\()/iu.test(rule)));
const unsafeMode = (value) => typeof value === "string" && ["auto", "bypasspermissions", "dontask"].includes(value.replace(/[-_]/gu, "").toLowerCase());
const settingsBash = (value) => {
  if (!value || typeof value !== "object") return false;
  const permissions = value.permissions && typeof value.permissions === "object" ? value.permissions : undefined;
  return isBashRule(value.allowedTools) || isBashRule(permissions && permissions.allow);
};
const settingsUnsafeMode = (value) => {
  if (!value || typeof value !== "object") return false;
  const permissions = value.permissions && typeof value.permissions === "object" ? value.permissions : undefined;
  return [value.permissionMode, permissions && permissions.defaultMode].some(unsafeMode);
};
const readSettings = (path, label = path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw new Error("automatic supervision could not inspect Claude settings (" + label + ")");
  }
};
const inspectPermissionConfiguration = () => {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const inlineAllowed = value.match(/^--allowed(?:tools|[-_]tools?)=(.*)$/iu);
    if (inlineAllowed && isBashRule(inlineAllowed[1])) throw new Error("automatic supervision refuses --allowedTools Bash preauthorization; Bash must remain visible to the Supervisor permission policy");
    if (!/^--allowed(?:tools|[-_]tools?)$/iu.test(value)) continue;
    for (let next = index + 1; next < args.length && !args[next].startsWith("-"); next += 1) {
      if (isBashRule(args[next])) throw new Error("automatic supervision refuses --allowedTools Bash preauthorization; Bash must remain visible to the Supervisor permission policy");
    }
  }
  let cliPermissionMode;
  let cliPermissionModeSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const inline = value.match(/^--permission-mode=(.*)$/iu);
    if (inline) {
      if (cliPermissionModeSeen) throw new Error("automatic supervision refuses duplicate --permission-mode arguments");
      if (!inline[1].trim()) throw new Error("automatic supervision refuses an empty --permission-mode value");
      cliPermissionModeSeen = true;
      cliPermissionMode = inline[1];
      continue;
    }
    if (/^--permission-mode$/iu.test(value)) {
      if (cliPermissionModeSeen) throw new Error("automatic supervision refuses duplicate --permission-mode arguments");
      const next = args[index + 1];
      if (next === undefined || next.startsWith("-")) throw new Error("automatic supervision refuses a missing --permission-mode value");
      cliPermissionModeSeen = true;
      cliPermissionMode = next;
      index += 1;
    }
  }
  if (unsafeMode(cliPermissionMode)) throw new Error("automatic supervision refuses Claude permission mode " + cliPermissionMode + "; the Supervisor must retain the host permission boundary");
  const settings = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const inline = argument.match(/^--settings=(.*)$/u);
    const value = inline ? inline[1] : argument === "--settings" ? args[index + 1] : undefined;
    if (value === undefined) continue;
    if (!inline) index += 1;
    const trimmed = value.trim();
    settings.push(trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : JSON.parse(readFileSync(resolve(cwd, trimmed), "utf8")));
  }
  const effectiveHome = process.env.HOME && process.env.HOME.trim() ? resolve(process.env.HOME) : homedir();
  const configDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(effectiveHome, ".claude");
  const paths = new Set([join(configDir, "settings.json"), "/etc/claude-code/managed-settings.json"]);
  let directory = resolve(cwd);
  while (true) {
    paths.add(join(directory, ".claude", "settings.json"));
    paths.add(join(directory, ".claude", "settings.local.json"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const path of paths) {
    const value = readSettings(path);
    if (value !== undefined) settings.push(value);
  }
  if (settings.some((value) => settingsBash(value) || (cliPermissionMode === undefined && settingsUnsafeMode(value)))) {
    throw new Error("automatic supervision refuses Claude settings that bypass Supervisor Bash permission events (pre-spawn bridge check)");
  }
};
let child;
let inputActive = false;
let stdoutBuffer = "";
try {
  inspectPermissionConfiguration();
  child = spawn(command, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
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
const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
const stderrDecoder = new TextDecoder("utf-8", { fatal: true });
let invalidUtf8 = false;
const failInvalidUtf8 = (label, error) => {
  if (invalidUtf8) return;
  invalidUtf8 = true;
  writeEvent({ type: "bridge_exit", code: 125, error: label + ": " + (error instanceof Error ? error.message : String(error)) });
  try { child.kill("SIGTERM"); } catch {}
};
child.stdout.on("data", (chunk) => {
  let decoded;
  try { decoded = stdoutDecoder.decode(chunk, { stream: true }); }
  catch (error) { failInvalidUtf8("Claude JSONL output was not valid UTF-8", error); return; }
  stdoutBuffer += decoded;
  if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_CLAUDE_LINE_BYTES) {
    stdoutBuffer = "";
    writeEvent({ type: "bridge_exit", code: 125, error: "Claude JSONL output line exceeded the safety bound" });
    try { child.kill("SIGTERM"); } catch {}
    return;
  }
  let newline;
  while ((newline = stdoutBuffer.indexOf("\\n")) >= 0) {
    const line = stdoutBuffer.slice(0, newline).replace(/\\r$/u, "");
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (Buffer.byteLength(line, "utf8") > MAX_CLAUDE_LINE_BYTES) {
      writeEvent({ type: "bridge_exit", code: 125, error: "Claude JSONL output line exceeded the safety bound" });
      try { child.kill("SIGTERM"); } catch {}
      return;
    }
    processLine(line);
  }
});
child.stderr.on("data", (chunk) => {
  try { output("\\n[claude stderr] " + stderrDecoder.decode(chunk, { stream: true })); }
  catch (error) { failInvalidUtf8("Claude stderr was not valid UTF-8", error); }
});
child.once("error", (error) => {
  writeEvent({ type: "bridge_exit", code: 127, error: error.message });
  process.exit(127);
});
child.once("exit", (code, signal) => {
  try {
    const tail = stdoutDecoder.decode();
    stdoutBuffer += tail;
    const stderrTail = stderrDecoder.decode();
    if (stderrTail) output("\\n[claude stderr] " + stderrTail);
  } catch (error) {
    failInvalidUtf8("Claude output ended with incomplete UTF-8", error);
  }
  if (!invalidUtf8 && stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
  if (!invalidUtf8) writeEvent({ type: "bridge_exit", code, signal });
  output("\\n[Claude exited " + String(code === null ? signal : code) + "]\\n");
  process.exit(code ?? 1);
});
const forwardSupervisorCommand = (commandLine) => {
  if (commandLine.startsWith("@pi:user ")) {
    inputActive = true;
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: decodeLine(commandLine.slice("@pi:user ".length)) } }) + "\\n");
    return;
  }
  if (commandLine.startsWith("@pi:json ")) {
    const message = decodeLine(commandLine.slice("@pi:json ".length));
    child.stdin.write(message.endsWith("\\n") ? message : message + "\\n");
    return;
  }
  if (commandLine === "@pi:stop") {
    try { child.kill("SIGTERM"); } catch {}
    return;
  }
  output("\\n[invalid Supervisor control command]\\n");
};
const rejectSupervisorChunks = (chunkId) => {
  if (chunkId) supervisorChunks.delete(chunkId);
  output("\\n[invalid Supervisor input chunks rejected]\\n");
};
const forwardSupervisorChunk = (line) => {
  const fields = line.slice(supervisorChunkPrefix.length).split(" ");
  if (fields.length !== 4) return rejectSupervisorChunks();
  const [chunkId, indexText, totalText, payload] = fields;
  const index = Number(indexText);
  const total = Number(totalText);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(chunkId) || !Number.isSafeInteger(index) || !Number.isSafeInteger(total)
    || total < 1 || total > MAX_SUPERVISOR_CHUNKS || index < 0 || index >= total
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) || payload.length === 0) return rejectSupervisorChunks(chunkId);
  let state = supervisorChunks.get(chunkId);
  if (index === 0) {
    if (state) return rejectSupervisorChunks(chunkId);
    state = { total, next: 0, parts: [], bytes: 0 };
    supervisorChunks.set(chunkId, state);
  }
  if (!state || state.total !== total || state.next !== index) return rejectSupervisorChunks(chunkId);
  state.parts.push(payload);
  state.next += 1;
  state.bytes += payload.length;
  const bufferedBytes = Array.from(supervisorChunks.values()).reduce((sum, pending) => sum + pending.bytes, 0);
  if (state.bytes > MAX_SUPERVISOR_CHUNK_BYTES * 2 || bufferedBytes > MAX_SUPERVISOR_BUFFER_BYTES) {
    supervisorChunks.clear();
    return rejectSupervisorChunks(chunkId);
  }
  if (state.next !== total) return;
  supervisorChunks.delete(chunkId);
  try {
    const encoded = state.parts.join("");
    if (encoded.length % 4 !== 0) throw new Error("invalid base64 length");
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.byteLength > MAX_SUPERVISOR_CHUNK_BYTES) throw new Error("Supervisor input is too large");
    const commandLine = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    forwardSupervisorCommand(commandLine);
  } catch {
    rejectSupervisorChunks(chunkId);
  }
};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.startsWith(supervisorControlPrefix)) {
    const separator = line.indexOf(" ", supervisorControlPrefix.length);
    const generation = separator >= 0 ? line.slice(supervisorControlPrefix.length, separator) : "";
    const commandLine = separator >= 0 ? line.slice(separator + 1) : "";
    clearSupervisorInput();
    if (generation !== bridgeGeneration) {
      output("\\n[stale Supervisor input rejected]\\n");
      return;
    }
    if (commandLine.startsWith(supervisorChunkPrefix)) {
      forwardSupervisorChunk(commandLine);
    } else {
      forwardSupervisorCommand(commandLine);
    }
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

const HOOK_CAPABILITY_KEY = "PI_CLAUDE_SUPERVISOR_HOOK_CAPABILITY";
const INTERACTIVE_KEYS = {
  ...BRIDGE_KEYS,
  settings: "PI_CLAUDE_SUPERVISOR_TMUX_SETTINGS",
} as const;

/**
 * Owned interactive launch joins the cgroup exactly like the pane bootstrap
 * script, then runs the real Claude TUI synchronously with `--settings`
 * pointing at the Supervisor's hook configuration. Unlike the bridge, this
 * process never touches stdin/stdout framing; the pane is Claude's own PTY.
 */
const TMUX_INTERACTIVE_LAUNCHER_SCRIPT = `
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const decode = (key) => Buffer.from(process.env[key] || "", "base64").toString("utf8");
const command = decode(${JSON.stringify(INTERACTIVE_KEYS.command)});
const args = JSON.parse(decode(${JSON.stringify(INTERACTIVE_KEYS.args)}));
const cwd = decode(${JSON.stringify(INTERACTIVE_KEYS.cwd)});
const cgroup = decode(${JSON.stringify(INTERACTIVE_KEYS.cgroup)});
const settings = decode(${JSON.stringify(INTERACTIVE_KEYS.settings)});
const keys = ${JSON.stringify(Object.values(INTERACTIVE_KEYS))};
if (cgroup) {
  try { writeFileSync(cgroup + "/cgroup.procs", String(process.pid) + "\\n"); }
  catch (error) {
    process.stderr.write("tmux interactive launcher failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
    process.exit(125);
  }
}
const childEnv = { ...process.env };
for (const key of keys) delete childEnv[key];
const result = spawnSync(command, [...args, "--settings", settings], { cwd, env: childEnv, stdio: "inherit" });
if (result.error) {
  process.stderr.write("tmux interactive launcher spawn failed: " + result.error.message + "\\n");
  process.exit(127);
}
process.exit(result.status === null ? (result.signal ? 128 : 1) : result.status);
`;

const GUARDIAN_READY_MARKER = "PI_CLAUDE_SUPERVISOR_GUARDIAN_READY";

const TMUX_GUARDIAN_SCRIPT = `
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
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
process.stdout.write(${JSON.stringify(GUARDIAN_READY_MARKER)} + "\\n");
const timer = setInterval(() => {
  if (alive()) return;
  clearInterval(timer);
  try { spawnSync(tmux, ["-S", socket, "kill-session", "-t", session], { stdio: "ignore" }); } catch {}
  if (cgroup) {
    try { writeFileSync(cgroup + "/cgroup.kill", "1\\n"); } catch {}
    const reap = () => {
      try {
        if (/^populated 0$/mu.test(readFileSync(cgroup + "/cgroup.events", "utf8"))) {
          // Leave the verified empty cgroup for explicit automatic recovery to
          // inspect. The recovering Supervisor removes it only after the
          // tmux session and Worker identities are also confirmed gone.
          process.exit(0);
          return;
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          process.exit(0);
          return;
        }
      }
      setTimeout(reap, 50);
    };
    reap();
  } else process.exit(0);
}, 100);
`;

export const TMUX_EMBEDDED_SCRIPTS = {
  paneBootstrap: TMUX_PANE_BOOTSTRAP_SCRIPT,
  bridge: TMUX_BRIDGE_SCRIPT,
  interactiveLauncher: TMUX_INTERACTIVE_LAUNCHER_SCRIPT,
  guardian: TMUX_GUARDIAN_SCRIPT,
} as const;

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
  #trustedTmuxBinary?: string;
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

  async preflight(input: Pick<WorkerStartInput, "cwd" | "command" | "args" | "env" | "approval" | "automatic" | "interactive">): Promise<void> {
    // Interactive mode drives the real Claude TUI with ordinary interactive
    // args; only the structured stream-json bridge needs claudeJsonlArgs.
    const args = input.automatic && !input.interactive ? claudeJsonlArgs(input.args) : (input.args ?? []);
    assertSafeWorkerCommand(input.command, args, input.approval);
    await assertDirectory(input.cwd);
    if (process.platform !== "linux") throw new Error("tmux supervision currently requires Linux process identity and cleanup support");
    await assertExecutableAvailable(input.command, input.env?.PATH ?? process.env.PATH);
    this.#trustedTmuxBinary = this.#tmuxBinary.includes("/") || this.#tmuxBinary.includes("\\")
      ? await trustedAbsoluteExecutablePath(this.#tmuxBinary)
      : await trustedExecutablePath(this.#tmuxBinary);
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
    if (typeof process.getuid === "function" && stateInfo.uid !== process.getuid()) throw new Error(`tmux state directory is owned by another user: ${this.#stateDir}`);
    if (await realpath(this.#stateDir) !== this.#stateDir) throw new Error(`tmux state directory contains a symlink: ${this.#stateDir}`);
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
    await this.preflight(input);
    const id = randomUUID();
    const owned = !input.tmuxSession;
    const interactive = Boolean(input.automatic && input.interactive);
    const structured = Boolean(input.automatic) && !interactive;
    if (input.tmuxSession && input.sendInitialInput === true) throw new Error("adopted tmux sessions cannot replay the original task");
    if (structured && !owned) throw new Error("automatic tmux supervision requires a Supervisor-owned tmux bridge; adopted sessions are manual-only");
    if (interactive) {
      if (!input.hookSource) throw new Error("interactive tmux supervision requires a hook event source");
      if (owned && !input.hookSettingsPath) throw new Error("owned interactive tmux supervision requires hookSettingsPath");
    }
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
      outputDecoder: new TextDecoder("utf-8", { fatal: true }),
      eventBuffer: "",
      seenResultIds: new Set(),
      seenPermissionRequestIds: new Set(),
      permissionResponses: new Set(),
      activeRequests: 0,
      turnSequence: 0,
      promptSequence: 0,
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
      interactive,
      hookCapability: interactive && owned ? (input.hookCapability ?? randomUUID()) : input.hookCapability,
      sessionStartReceived: false,
      pendingSentMessages: [],
      pendingPermissionRequests: new Map(),
      ignoredHookRequests: 0,
    };
    const abortListener = () => {
      record.abortRequested = true;
      record.stopping = true;
    };
    record.abortListener = abortListener;
    input.abortSignal?.addEventListener("abort", abortListener, { once: true });
    this.#records.set(id, record);
    if (input.abortSignal?.aborted) abortListener();
    let cgroupIdentityPersisted = false;

    try {
      await mkdir(dirname(runtimeDir), { recursive: true, mode: 0o700 });
      const runtimeParentInfo = await lstat(dirname(runtimeDir));
      if (!runtimeParentInfo.isDirectory() || runtimeParentInfo.isSymbolicLink()) throw new Error(`tmux runtime parent is not a real directory: ${dirname(runtimeDir)}`);
      if (typeof process.getuid === "function" && runtimeParentInfo.uid !== process.getuid()) throw new Error(`tmux runtime parent is owned by another user: ${dirname(runtimeDir)}`);
      if (await realpath(dirname(runtimeDir)) !== dirname(runtimeDir)) throw new Error(`tmux runtime parent contains a symlink: ${dirname(runtimeDir)}`);
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      const runtimeInfo = await lstat(runtimeDir);
      if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) throw new Error(`tmux runtime directory is not a real directory: ${runtimeDir}`);
      if (typeof process.getuid === "function" && runtimeInfo.uid !== process.getuid()) throw new Error(`tmux runtime directory is owned by another user: ${runtimeDir}`);
      if (await realpath(runtimeDir) !== runtimeDir) throw new Error(`tmux runtime directory contains a symlink: ${runtimeDir}`);
      await chmod(runtimeDir, 0o700);
      await writeFile(logPath, "", { mode: 0o600, flag: "wx" });
      if ((structured || interactive) && owned) {
        handle.cgroupPath = await this.#plannedCgroupPath(id);
        if (input.retainCgroupUntilLeaseRelease) handle.retainCgroupUntilLeaseRelease = true;
        await input.onWorkerStartup?.(handle);
      }
      if (owned) {
        if (process.platform !== "linux") throw new Error("owned tmux supervision requires a Linux parent-death guardian");
        if ((structured || interactive) && this.#cgroupMode === "off") throw new Error("automatic tmux supervision requires cgroup containment");
        if (structured || interactive) {
          try {
            record.cgroupPath = await this.#createCgroup(id, record.handle.cgroupPath);
            record.handle.cgroupPath = record.cgroupPath;
            if (input.retainCgroupUntilLeaseRelease) record.handle.retainCgroupUntilLeaseRelease = true;
            await input.onWorkerPrepared?.(record.handle);
            cgroupIdentityPersisted = true;
          } catch (error) {
            // Without a completed durable identity callback, remove the
            // startup cgroup rather than retaining an unbound resource.
            if (record.cgroupPath && !cgroupIdentityPersisted) {
              record.handle.retainCgroupUntilLeaseRelease = false;
              await cleanupCgroup(record.cgroupPath, this.#terminationGraceMs, false).catch(() => {});
            }
            record.cgroupError = asError(error);
            throw new Error(`automatic tmux cgroup setup failed: ${record.cgroupError.message}`, { cause: error });
          }
        }
        const env = (structured || interactive)
          ? automaticWorkerEnvironment(input.env)
          : workerEnvironment(process.env, input.env);
        const workerArgs = structured ? claudeJsonlArgs(input.args) : (input.args ?? []);
        assertSafeWorkerCommand(input.command, workerArgs, input.approval);
        assertNoCredentialArguments(input.command, workerArgs);
        const bridgeEnv = structured
          ? bridgeEnvironment(env, input.cwd, input.command, workerArgs, record.cgroupPath)
          : interactive
            ? bridgeEnvironment(env, input.cwd, input.command, workerArgs, record.cgroupPath, input.hookSettingsPath, record.hookCapability)
            : env;
        // Arm the guardian before creating the session. If the Supervisor dies
        // in the tmux startup window, the guardian removes any server created
        // after it and kills the automatic bridge cgroup, leaving an empty
        // cgroup for verified recovery to reclaim.
        if (!socketPath) throw new Error("owned tmux startup did not allocate a private socket");
        await this.#startGuardian(record, socketPath);
        if (record.cleanupError) throw record.cleanupError;
        const paneBootstrap = [nodeScriptCommand(), "-e", TMUX_PANE_BOOTSTRAP_SCRIPT];
        await this.#run(record, ["new-session", "-d", "-s", sessionName, "-x", "140", "-y", "40", "-c", input.cwd, "--", ...paneBootstrap], undefined, bridgeEnv);
        record.sessionCreated = true;
        if (interactive) record.hookUnsubscribe = await input.hookSource!.subscribe(input.cwd, (request) => this.#handleHookRequest(record, request), { capability: record.hookCapability });
        await this.#rememberServerIdentity(record);
        // Persist the server identity while pendingStartup is still present;
        // a crash before the final pre-spawn callback can then use normal
        // identity-bound tmux takeover checks.
        await input.onWorkerPrepared?.(record.handle);
        await this.#run(record, ["set-window-option", "-t", sessionName, "remain-on-exit", "on"]);
        await input.preSpawnCheck?.(record.handle);
        // Attach the output pipe before respawn-pane starts the bridge so its
        // first generation frame cannot be lost before startup observes it.
        await this.#attachPipe(record);
        const launch = interactive
          ? [nodeScriptCommand(), "-e", TMUX_INTERACTIVE_LAUNCHER_SCRIPT]
          : structured
            ? [nodeScriptCommand(), "-e", TMUX_BRIDGE_SCRIPT]
            : [input.command, ...workerArgs];
        await this.#run(record, ["respawn-pane", "-k", "-c", input.cwd, "-t", target, "--", ...launch], undefined, bridgeEnv);
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
        await this.#rememberServerIdentity(record);
        if (interactive) record.hookUnsubscribe = await input.hookSource!.subscribe(input.cwd, (request) => this.#handleHookRequest(record, request), { capability: record.hookCapability });
        const pipe = await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_pipe}"]);
        if (pipe.stdout.trim() === "1") throw new Error("cannot adopt a tmux pane that already has an output pipe");
        await this.#attachPipe(record);
      }
      if (sendInitialInput || !input.tmuxSession) {
        if (interactive && owned) await this.#waitForInteractiveReady(record, input.cwd);
        else await this.#waitForReady(record);
      }
      if (structured) await this.#waitForBridgeGeneration(record);
      if (owned) {
        const readyPane = await this.#paneStatus(record);
        if (readyPane.dead) throw new Error("tmux worker exited before identity could be pinned");
        record.paneDead = false;
        await this.#rememberPaneIdentity(record, readyPane.pid);
        record.panePid = readyPane.pid;
        record.handle.pid = readyPane.pid;
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
        } else if (interactive && input.task.trim()) {
          // Babysitting an idle interactive session: nobody else will start the
          // work, so the task is typed in now. A session caught mid-turn keeps
          // its current work and is judged on its next Stop instead.
          await this.#send(record, input.task, `${id}:initial`);
          this.#logOutput(record, "[supervisor] adopted session was idle; task sent\n");
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
        removeDeadTmuxSocket(record.handle.tmuxSocket);
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
        if (pane.dead) record.cleanupError = undefined;
        else {
          await this.#rememberPaneIdentity(record, pane.pid);
          record.panePid = pane.pid;
        }
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
      if (!pane.dead) {
        await this.#rememberPaneIdentity(record, pane.pid);
        record.panePid = pane.pid;
        record.handle.pid = pane.pid;
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
      const restored: WorkerOutputChunk[] = [];
      for (const chunk of chunks) {
        if (!chunk || typeof chunk.text !== "string" || typeof chunk.stream !== "string" || typeof chunk.at !== "string") continue;
        const text = Buffer.byteLength(chunk.text, "utf8") > this.#maxOutputBytes ? utf8Tail(chunk.text, this.#maxOutputBytes) : chunk.text;
        restored.push({ ...chunk, text });
        record.outputBytes += Buffer.byteLength(text, "utf8");
      }
      record.output.unshift(...restored);
      while (record.outputBytes > this.#maxOutputBytes) {
        const removed = record.output.pop();
        if (!removed) break;
        record.outputBytes -= Buffer.byteLength(removed.text, "utf8");
        record.outputTruncated = true;
      }
    });
  }

  async send(handle: WorkerHandle, message: string, idempotencyKey: string): Promise<void> {
    const record = this.#record(handle);
    if (record.sentKeys.has(idempotencyKey)) return;
    if (record.released) throw new Error("tmux worker is no longer supervised");
    if (record.activeRequests > 0) throw new Error("tmux worker has an active turn; wait for its prompt before sending another turn");
    await this.#send(record, message, idempotencyKey);
  }

  async respondPermission(handle: WorkerHandle, requestId: string, toolUseId: string, decision: PermissionDecision, updatedInput?: unknown): Promise<void> {
    const record = this.#record(handle);
    if (record.interactive) {
      if (record.permissionResponses.has(requestId)) return;
      const pending = record.pendingPermissionRequests.get(requestId);
      if (!pending) throw new Error(`unknown tmux hook permission request: ${requestId}`);
      record.pendingPermissionRequests.delete(requestId);
      record.permissionResponses.add(requestId);
      record.lastInputAt = new Date().toISOString();
      if (decision.defer) { pending.resolve({}); return; }
      if (decision.behavior === "deny") {
        pending.resolve({ permissionDecision: "deny", permissionDecisionReason: decision.message ?? "permission denied by supervisor" });
        return;
      }
      pending.resolve({ permissionDecision: "allow", permissionDecisionReason: decision.message });
      return;
    }
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
    await signalProcessGroup(pane.pid, record.paneStartTime, record.paneCommand, "SIGSTOP");
  }

  async resume(handle: WorkerHandle): Promise<void> {
    const record = this.#record(handle);
    if (record.released) throw new Error("tmux worker is no longer supervised");
    const pane = await this.#paneStatus(record);
    if (pane.dead) throw new Error("cannot resume a dead tmux pane");
    await this.#rememberPaneIdentity(record, pane.pid);
    if (!pane.pid) throw new Error("tmux worker pane pid is unavailable");
    await signalProcessGroup(pane.pid, record.paneStartTime, record.paneCommand, "SIGCONT");
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
      await this.#unsubscribeHooks(record);
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
      if (record.interactive && record.owned) {
        // Hand the processes back to the operator instead of killing them:
        // migrate every process out of the Worker cgroup so the cwd lease's
        // process-boundary requirement is satisfied while the pane keeps running.
        try { await this.#detachCgroup(record); }
        catch (error) { record.cleanupError ??= asError(error); }
      }
    }
    await this.#unsubscribeHooks(record);
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
    // A released/detached record already reports cleanupComplete=true (the
    // Supervisor's own obligations are done), but the tmux session and pane
    // process are intentionally still alive; force #cleanup to actually run
    // rather than short-circuiting on that flag. #cleanup already tolerates a
    // missing (already-migrated-out) cgroup, falling back to tmux
    // kill-session plus the pane process-tree kill below it.
    record.cleanupComplete = false;
    await this.#cleanup(record, true);
    if (record.cleanupComplete) record.detached = false;
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

  async #attachPipe(record: TmuxRecord): Promise<void> {
    await this.#run(record, ["pipe-pane", "-o", "-t", record.target, `cat >> ${shellQuote(record.logPath)}`]);
    record.pipeAttached = true;
    const attachedPipe = await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_pipe}"]);
    if (attachedPipe.stdout.trim() !== "1") throw new Error("tmux output pipe could not be attached to the pinned pane");
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
      if (record.interactive) {
        record.pendingSentMessages.push(message);
        while (record.pendingSentMessages.length > 50) record.pendingSentMessages.shift();
      }
      try {
        await this.#sendRaw(record, message);
        record.sentKeys.add(idempotencyKey);
        record.lastInputAt = new Date().toISOString();
      } catch (error) {
        if (record.interactive) {
          const index = record.pendingSentMessages.lastIndexOf(message);
          if (index >= 0) record.pendingSentMessages.splice(index, 1);
        }
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
      await this.#sendLine(record, this.#bridgeControl(record, `@pi:user ${encoded}`));
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
      // Permission decisions are asynchronous and may be queued behind a
      // monitor interval. Revalidate the exact pane process after acquiring
      // the input gate, not merely at the last status poll.
      await this.#assertControlPaneIdentity(record);
      const command = rawCommand ?? `@pi:json ${Buffer.from(`${JSON.stringify(value)}\n`, "utf8").toString("base64")}`;
      await this.#sendLine(record, this.#bridgeControl(record, command));
    } finally {
      release();
    }
  }

  #bridgeControl(record: TmuxRecord, commandLine: string): string {
    if (!record.bridgeGeneration) throw new Error("tmux bridge generation is not established for control input");
    return `@pi:control ${record.bridgeGeneration} ${commandLine}`;
  }

  async #sendLine(record: TmuxRecord, line: string): Promise<void> {
    const safeLine = safeTmuxMessage(line);
    if (!record.bridgeGeneration) throw new Error("tmux bridge generation is not established for control input");
    // Linux's PTY line discipline caps a single canonical input line at about
    // 4 KiB. Send a base64-framed Supervisor command as several short lines so
    // a large task or permission payload cannot be silently truncated in the
    // pane before the bridge sees it.
    const controlPrefix = `@pi:control ${record.bridgeGeneration} `;
    if (!safeLine.startsWith(controlPrefix)) throw new Error("tmux bridge control frame has an invalid generation prefix");
    const encoded = Buffer.from(safeLine.slice(controlPrefix.length), "utf8").toString("base64");
    const chunkSize = 1_800;
    if (encoded.length > chunkSize) {
      const chunkId = randomUUID().replaceAll("-", "");
      const total = Math.ceil(encoded.length / chunkSize);
      if (total > 4_096) throw new Error("tmux bridge input is too large to deliver safely");
      for (let index = 0; index < total; index += 1) {
        await this.#sendPhysicalLine(record, `${supervisorChunkLinePrefix(record.bridgeGeneration, chunkId, index, total)}${encoded.slice(index * chunkSize, (index + 1) * chunkSize)}`);
      }
      return;
    }
    await this.#sendPhysicalLine(record, safeLine);
  }

  async #sendPhysicalLine(record: TmuxRecord, line: string): Promise<void> {
    const bufferName = `pi-cs-${record.handle.id}`;
    await this.#run(record, ["load-buffer", "-b", bufferName, "-"], line);
    // A pane can be respawned between any two tmux commands. Check again
    // immediately before each command that delivers the buffered line.
    await this.#assertControlPaneIdentity(record);
    await this.#run(record, ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", record.target]);
    await this.#assertControlPaneIdentity(record);
    await this.#run(record, ["send-keys", "-t", record.target, "Enter"]);
    // The generation token above is the semantic guard if the pane changes
    // during send-keys. Report that race to the caller as well, rather than
    // marking a permission response as delivered without a live owner.
    await this.#assertControlPaneIdentity(record);
  }

  async #assertControlPaneIdentity(record: TmuxRecord): Promise<void> {
    if (record.runtimeError) throw record.runtimeError;
    const pane = await this.#paneStatus(record);
    if (pane.dead || !pane.pid) throw new Error("tmux pane is no longer available for control input");
    if (record.panePid === undefined || !record.paneStartTime || !record.paneCommand) {
      throw new Error("tmux pane identity is not established for control input");
    }
    if (pane.pid !== record.panePid) throw new Error("tmux pane identity changed (pid); refusing control input to a replacement process");
    await this.#rememberPaneIdentity(record, pane.pid);
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
        // `respawn-pane -k` briefly exposes a dead pane while tmux replaces
        // the process. Do not tear down the private server on that transient
        // observation: a queued control response still needs to reach the
        // identity check, which must reject a replacement rather than race a
        // Supervisor-owned cleanup. A second dead read is the exit proof.
        await delay(Math.max(25, this.#pollIntervalMs));
        let replacement: TmuxPaneStatus;
        try {
          replacement = await this.#paneStatus(record);
        } catch (error) {
          if (isMissingSession(error)) {
            await this.#cleanup(record, false);
            this.#emit(record, { type: "exited", handle: record.handle, exitCode: record.exitCode, signal: record.signal });
            return;
          }
          throw error;
        }
        if (!replacement.dead) {
          record.paneDead = false;
          record.panePid = replacement.pid;
          if (replacement.pid) record.handle.pid = replacement.pid;
          if (replacement.exitCode !== undefined) record.exitCode = replacement.exitCode;
          try { await this.#rememberPaneIdentity(record, replacement.pid); }
          catch (error) { if (isPaneIdentityError(error)) record.cleanupError = asError(error); else throw error; }
          return;
        }
        await this.#cleanup(record, false);
        this.#emit(record, { type: "exited", handle: record.handle, exitCode: record.exitCode, signal: record.signal });
        return;
      }
      if (record.interactive) {
        // Hooks are authoritative for activeRequests/turn_completed in
        // interactive mode; the poll loop here is only pane-death detection
        // and log collection, both already handled above.
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

  async #waitForBridgeGeneration(record: TmuxRecord): Promise<void> {
    const deadline = Date.now() + this.#startupTimeoutMs;
    while (Date.now() < deadline) {
      await this.#collectOutput(record);
      if (record.runtimeError) throw record.runtimeError;
      if (record.bridgeGeneration) return;
      await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error("automatic tmux bridge did not publish a generation identity");
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

  /**
   * Owned interactive startup waits for two independent signals: the hook
   * source's SessionStart (primary; proves Claude's own process is alive and
   * has registered) and a stable ready screen (secondary; the human/Supervisor
   * paste path is safe). A fresh cwd may show Claude's one-time workspace
   * trust dialog first; accept it once so startup is not stuck behind a
   * prompt only a human would normally answer.
   */
  async #waitForInteractiveReady(record: TmuxRecord, cwd: string): Promise<void> {
    const deadline = Date.now() + this.#startupTimeoutMs;
    let trustDialogHandled = false;
    while (Date.now() < deadline) {
      this.#assertNotAborted(record);
      const screen = await this.#capture(record);
      if (!trustDialogHandled && /Yes, I trust this folder/u.test(stripAnsi(screen))) {
        let paneCwd: string | undefined;
        try { paneCwd = (await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pane_current_path}"])).stdout.trim(); }
        catch { paneCwd = undefined; }
        // A symlinked cwd still shows the dialog for the resolved path tmux
        // reports; compare real paths, falling back to the raw string when
        // either side cannot be resolved.
        let matchesCwd = paneCwd === cwd;
        if (paneCwd !== undefined && !matchesCwd) {
          try { matchesCwd = (await realpath(paneCwd)) === (await realpath(cwd)); }
          catch { /* keep the raw comparison result */ }
        }
        if (matchesCwd) {
          await this.#run(record, ["send-keys", "-t", record.target, "Down"]);
          await this.#run(record, ["send-keys", "-t", record.target, "Enter"]);
          trustDialogHandled = true;
          this.#logOutput(record, "[supervisor] accepted the workspace trust dialog\n");
        }
      }
      if (record.sessionStartReceived && isReadyScreen(screen)) return;
      await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    this.#assertNotAborted(record);
    throw new Error(`tmux Claude interactive session did not reach an input prompt before startup timeout; attach with ${attachCommand(record)}`);
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
    // Compared as reported, not by inode identity: the hook relay routes events
    // by the SHA-256 of realpath(cwd), so a pane whose cwd merely *resolves* to
    // the same directory under a different spelling would be adopted and then
    // never deliver a single hook event -- an unsupervised Worker that looks
    // supervised. A mismatch means the pane cannot be governed, so it is refused.
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
    if (!argsText || !paneProcess) {
      throw new Error(`tmux pane is not a Claude Code executable: ${redactSensitiveText(commandLine || "unknown")}`);
    }
    let claudePid = pane.pid;
    let claudeStartTime = paneProcess.startTime;
    if (!isClaudeLauncherProcess(paneProcess)) {
      // A recovered owned interactive session runs the launcher in the pane
      // (`node -e TMUX_INTERACTIVE_LAUNCHER_SCRIPT`), whose only child is the
      // real Claude process; the launcher's own argv never looks like Claude.
      const claudeChild = await this.#findClaudeChild(pane.pid);
      if (!claudeChild) throw new Error(`tmux pane is not a Claude Code executable: ${redactSensitiveText(commandLine || "unknown")}`);
      claudePid = claudeChild.pid;
      claudeStartTime = claudeChild.startTime;
    }
    assertSafeWorkerCommand(command, [argsText], approval);
    await this.#rememberPaneIdentity(record, pane.pid);
    record.panePid = pane.pid;
    // Pinned separately from `panePid` (the pane's own occupant, which
    // pause/resume/replacement-detection and tmuxExpectedIdentity all key
    // off) so a launcher-wrapped adoption binds hook requests to the actual
    // Claude pid rather than the launcher.
    record.claudePid = claudePid;
    record.claudeStartTime = claudeStartTime;
    record.claudeConfigDir = await processConfigDir(claudePid);
    if (record.interactive && !record.hookCapability) record.hookCapability = await processEnvironmentValue(claudePid, HOOK_CAPABILITY_KEY);
    if (record.interactive && !record.hookCapability) throw new Error("automatic interactive tmux adoption requires a Supervisor hook capability in the Claude process");
    if (expected?.startTime && record.paneStartTime !== expected.startTime) throw new Error("tmux pane process start time changed; refusing identity-unverified handoff");
    if (expected?.paneStartTime && record.paneStartTime !== expected.paneStartTime) throw new Error("tmux pane identity changed; refusing identity-unverified handoff");
    if (expected?.paneCommand && record.paneCommand !== expected.paneCommand) throw new Error("tmux pane command changed; refusing identity-unverified handoff");
  }

  /**
   * Direct children of `panePid` whose executable identity looks like Claude
   * Code (`isClaudeLauncherProcess`, the same predicate used for the pane's
   * own process above). Recovery accepts the pane only when exactly one
   * matches; zero or several is refused as an unverified handoff.
   */
  async #findClaudeChild(panePid: number): Promise<ProcessTreeEntry | undefined> {
    const childPids = await this.#directChildPids(panePid);
    const children: ProcessTreeEntry[] = [];
    for (const pid of childPids) {
      const entry = await readProcess(pid);
      if (entry) children.push(entry);
    }
    const claudeChildren = children.filter((entry) => isClaudeLauncherProcess(entry));
    return claudeChildren.length === 1 ? claudeChildren[0] : undefined;
  }

  async #directChildPids(pid: number): Promise<number[]> {
    try {
      const raw = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
      return raw.trim().split(/\s+/u).filter(Boolean).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
    } catch {
      // Some kernels/containers do not expose /proc/<pid>/task/<pid>/children;
      // fall back to scanning /proc for entries whose ppid matches, the way
      // process-adapter.ts's processGroupHasLiveMember walks /proc.
    }
    const children: number[] = [];
    let names: string[];
    try { names = await readdir("/proc"); }
    catch { return children; }
    for (const name of names) {
      if (!/^\d+$/u.test(name)) continue;
      try {
        const statText = await readFile(`/proc/${name}/stat`, "utf8");
        const closeParen = statText.lastIndexOf(")");
        if (closeParen < 0) continue;
        const fields = statText.slice(closeParen + 2).trim().split(/\s+/u);
        if (Number(fields[1]) === pid) children.push(Number(name));
      } catch {
        // A process can disappear between /proc enumeration and stat read.
      }
    }
    return children;
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

  async #rememberServerIdentity(record: TmuxRecord): Promise<void> {
    const result = await this.#run(record, ["display-message", "-p", "-t", record.target, "#{pid}"]);
    const pid = Number(result.stdout.trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("tmux server pid is unavailable; refusing unverified recovery");
    const identity = await processIdentity(pid);
    if (!identity?.startTime) throw new Error(`tmux server identity unavailable for pid ${pid}`);
    if (record.serverPid !== undefined && (record.serverPid !== pid || record.serverStartTime !== identity.startTime)) {
      throw new Error("tmux server identity changed; refusing to control a replacement server");
    }
    record.serverPid = pid;
    record.serverStartTime = identity.startTime;
    record.handle.tmuxServerPid = pid;
    record.handle.tmuxServerStartTime = identity.startTime;
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
      const pgid = Number(fields[2]);
      const command = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
      if (!startTime || pgid !== pid) throw new Error(`cannot identify tmux pane process group ${pid}`);
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

  async #plannedCgroupPath(id: string): Promise<string> {
    const parent = await currentCgroupPath();
    await assertCgroupDirectory(parent);
    return `${parent}/pi-claude-supervisor-tmux-${id}`;
  }

  async #createCgroup(id: string, plannedPath?: string): Promise<string> {
    const path = plannedPath ?? await this.#plannedCgroupPath(id);
    if (basename(resolve(path)) !== `pi-claude-supervisor-tmux-${id}`) throw new Error("tmux cgroup identity has an unexpected name");
    await assertCgroupDirectory(dirname(resolve(path)));
    await mkdir(path);
    try {
      await access(join(path, "cgroup.procs"), fsConstants.R_OK | fsConstants.W_OK);
      await access(join(path, "cgroup.events"), fsConstants.R_OK);
      await access(join(path, "cgroup.kill"), fsConstants.W_OK);
    } catch (error) {
      await rmdir(path).catch(() => {});
      throw new Error(`tmux cgroup controls are unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return path;
  }

  /**
   * Hand every process in the Worker cgroup back to its parent cgroup rather
   * than killing them, mirroring the guarded bootstrap script's own
   * self-migration (`moveOutOfCgroup` in process-adapter.ts): a process is
   * migrated into a cgroup by writing its pid to the destination's
   * `cgroup.procs`, which requires write access to both the source and
   * destination `cgroup.procs` files. The Supervisor created both cgroups, so
   * it can do this directly instead of asking a process inside the cgroup to
   * move itself. Removes the now-empty Worker cgroup unless the cwd lease
   * still needs to verify and reclaim it itself.
   */
  async #detachCgroup(record: TmuxRecord): Promise<void> {
    const cgroupPath = record.cgroupPath;
    if (!cgroupPath) {
      record.detached = true;
      return;
    }
    const parentCgroup = dirname(cgroupPath);
    const deadline = Date.now() + 2_000;
    for (;;) {
      let procsText: string;
      try {
        procsText = await readFile(`${cgroupPath}/cgroup.procs`, "utf8");
      } catch (error) {
        if (isMissingFile(error)) { record.detached = true; return; }
        throw error;
      }
      for (const pid of procsText.split(/\s+/u).filter(Boolean)) {
        try { await writeFile(`${parentCgroup}/cgroup.procs`, `${pid}\n`); }
        catch {
          // A pid can exit, or already have been migrated, between listing
          // and migration; the populated-0 poll below is the authoritative check.
        }
      }
      let eventsText: string;
      try {
        eventsText = await readFile(`${cgroupPath}/cgroup.events`, "utf8");
      } catch (error) {
        if (isMissingFile(error)) { record.detached = true; return; }
        throw error;
      }
      if (/^populated 0$/mu.test(eventsText)) break;
      if (Date.now() >= deadline) throw new Error(`worker cgroup ${cgroupPath} did not empty before detach deadline`);
      await delay(25);
    }
    if (!record.handle.retainCgroupUntilLeaseRelease) {
      try { await rmdir(cgroupPath); }
      catch {
        // Leave it for a later explicit cleanup; a verified-empty cgroup
        // directory left behind is harmless.
      }
    }
    record.detached = true;
  }

  async #startGuardian(record: TmuxRecord, socketPath: string): Promise<void> {
    if (process.platform !== "linux") return;
    const parent = await processIdentity(process.pid);
    if (!parent?.startTime) throw new Error("cannot start tmux parent-death guardian without a parent process identity");
    const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      [GUARDIAN_KEYS.tmux]: encode(this.#trustedTmuxBinary ?? this.#tmuxBinary),
      [GUARDIAN_KEYS.socket]: encode(socketPath),
      [GUARDIAN_KEYS.session]: encode(record.sessionName),
      [GUARDIAN_KEYS.cgroup]: encode(record.cgroupPath ?? ""),
      [GUARDIAN_KEYS.parentPid]: encode(String(process.pid)),
      [GUARDIAN_KEYS.parentStart]: encode(parent.startTime),
    };
    const child = spawn(nodeScriptCommand(), ["-e", TMUX_GUARDIAN_SCRIPT], { detached: true, stdio: ["ignore", "pipe", "ignore"], env });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("tmux parent-death guardian did not expose a pid");
    record.guardianPid = child.pid;
    const ready = await new Promise<boolean>((resolve) => {
      let buffer = "";
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("exit", onExit);
        resolve(value);
      };
      const onData = (chunk: Buffer | string) => {
        buffer += String(chunk);
        if (buffer.includes(GUARDIAN_READY_MARKER)) finish(true);
      };
      const onExit = () => finish(false);
      const timer = setTimeout(() => finish(false), 2_000);
      child.stdout?.on("data", onData);
      child.once("exit", onExit);
    });
    if (!ready) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
      throw new Error("tmux parent-death guardian did not become ready");
    }
    child.stdout?.destroy();
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
    await this.#unsubscribeHooks(record);
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
    if (record.serverKilled) removeDeadTmuxSocket(record.handle.tmuxSocket);
    if (!record.serverKilled) await this.#ensurePaneGone(record);
    if (record.cgroupPath) {
      try {
        await cleanupCgroup(record.cgroupPath, this.#terminationGraceMs, Boolean((record.structured || record.interactive) && record.handle.retainCgroupUntilLeaseRelease));
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

  async #unsubscribeHooks(record: TmuxRecord): Promise<void> {
    const unsubscribe = record.hookUnsubscribe;
    record.hookUnsubscribe = undefined;
    for (const [requestId, pending] of record.pendingPermissionRequests) {
      record.pendingPermissionRequests.delete(requestId);
      pending.resolve({});
    }
    if (!unsubscribe) return;
    try { await unsubscribe(); }
    catch (error) { record.cleanupError ??= asError(error); }
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
    await signalProcessGroup(pid, record.paneStartTime, record.paneCommand, "SIGTERM");
    for (let attempt = 0; attempt < 10 && isPidAlive(pid); attempt += 1) await delay(50);
    if (isPidAlive(pid) && !(await isZombie(pid))) {
      if (!(await sameProcess(record, pid))) {
        await this.#markReplacement(record, pid);
        return;
      }
      await signalProcessGroup(pid, record.paneStartTime, record.paneCommand, "SIGKILL");
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
      ? [...((record.structured || record.interactive) ? ["-f", "/dev/null"] : []), "-S", record.socketPath, ...args]
      : args;
    const result = await runCommand(this.#trustedTmuxBinary ?? this.#tmuxBinary, tmuxArgs, input, env, this.#commandTimeoutMs);
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
        const info = await lstat(record.logPath);
        assertOwnedLogFile(info);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("tmux worker log is not a regular file");
        const size = info.size;
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
      const initial = await lstat(record.logPath);
      assertOwnedLogFile(initial);
      if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("tmux worker log is not a regular file");
      if (initial.size > this.#maxLogBytes) {
        await truncateRegular(record.logPath, initial);
        record.outputOffset = 0;
        record.outputDecoder = new TextDecoder("utf-8", { fatal: true });
        record.outputTruncated = true;
      }
      const snapshot = await lstat(record.logPath);
      assertOwnedLogFile(snapshot);
      if (!snapshot.isFile() || snapshot.isSymbolicLink()) throw new Error("tmux worker log is not a regular file");
      assertSameLogIdentity(initial, snapshot);
      if (record.outputOffset > snapshot.size) {
        record.outputOffset = 0;
        record.outputDecoder = new TextDecoder("utf-8", { fatal: true });
      }
      const start = Math.max(record.outputOffset, snapshot.size - this.#maxLogBytes);
      if (start > record.outputOffset) {
        record.outputOffset = start;
        record.outputDecoder = new TextDecoder("utf-8", { fatal: true });
        record.outputTruncated = true;
      }
      const length = snapshot.size - start;
      if (length > 0) {
        const file = await open(record.logPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const fileInfo = await file.stat();
          assertOwnedLogFile(fileInfo);
          if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("tmux worker log is not a regular file");
          assertSameLogIdentity(snapshot, fileInfo);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await file.read(buffer, 0, length, start);
          if (bytesRead > 0) {
            const rawText = record.outputDecoder.decode(buffer.subarray(0, bytesRead), { stream: true });
            record.outputOffset = start + bytesRead;
            record.lastOutputAt = new Date().toISOString();
            const text = record.structured ? this.#consumeBridgeStream(record, rawText) : rawText;
            if (text) this.#appendOutput(record, { stream: "stdout", text, at: record.lastOutputAt });
          }
        } finally {
          await file.close();
        }
      }
      const after = await lstat(record.logPath);
      assertOwnedLogFile(after);
      if (!after.isFile() || after.isSymbolicLink()) throw new Error("tmux worker log is not a regular file");
      assertSameLogIdentity(snapshot, after);
      if (after.size > this.#maxLogBytes) {
        await truncateRegular(record.logPath, after);
        record.outputOffset = 0;
        record.outputDecoder = new TextDecoder("utf-8", { fatal: true });
        record.outputTruncated = true;
      }
      if (record.exitCode !== undefined) record.outputDecoder.decode();
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
        if (payload.length > Math.ceil(this.#maxLogBytes * 4 / 3) || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) throw new Error("invalid tmux bridge frame encoding");
        const parsed = JSON.parse(BRIDGE_UTF8_DECODER.decode(Buffer.from(payload, "base64"))) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.#handleStructuredEvent(record, parsed as Record<string, unknown>);
      } catch {
        record.outputTruncated = true;
      }
    }
    return stripInternalBridgeEcho(visible);
  }

  #handleStructuredEvent(record: TmuxRecord, event: Record<string, unknown>): void {
    if (event.type === "bridge_generation") {
      const generation = event.generation;
      if (typeof generation !== "string" || !/^[a-f0-9]{64}$/u.test(generation)) {
        record.runtimeError ??= new Error("tmux bridge published an invalid generation identity");
      } else if (record.bridgeGeneration && record.bridgeGeneration !== generation) {
        record.runtimeError ??= new Error("tmux bridge generation changed; refusing control input to a replacement bridge");
      } else {
        record.bridgeGeneration = generation;
      }
      return;
    }
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
      text = utf8Tail(text, this.#maxOutputBytes);
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

  #logOutput(record: TmuxRecord, text: string): void {
    const at = new Date().toISOString();
    this.#appendOutput(record, { stream: "stdout", text, at });
    record.lastOutputAt = at;
  }

  /**
   * A hook relay's `ppid` is the Claude Code process pid; an owned launch
   * runs Claude as a child of the pane's launcher process, so the pane pid is
   * an ancestor, not the direct parent. Walk the `/proc` ppid chain (bounded)
   * the way process-tree.ts does rather than requiring an exact pid match.
   */
  async #ppidDescendsFrom(pid: number, ancestorPid: number): Promise<boolean> {
    let current = pid;
    for (let depth = 0; depth < 32; depth += 1) {
      if (current === ancestorPid) return true;
      const entry = await readProcess(current);
      if (!entry || entry.ppid <= 1 || entry.ppid === current) return false;
      current = entry.ppid;
    }
    return false;
  }

  async #bindsToRecord(record: TmuxRecord, request: HookRelayRequest): Promise<boolean> {
    // A capability is generated for Supervisor-owned interactive launches and
    // is copied only into that Claude process's hook environment. It is an
    // additional task binding, not a replacement for process identity.
    if (record.hookCapability !== undefined && request.capability !== record.hookCapability) return false;
    // A bound process may report a child cwd after `cd`, but it must remain
    // inside the leased task root. Do this check at the adapter boundary too;
    // the socket route is discovery, not an authorization decision.
    const expectedCwd = await realpath(record.handle.cwd).catch(() => resolve(record.handle.cwd));
    const eventCwd = await realpath(request.event.cwd).catch(() => resolve(request.event.cwd));
    const relativeCwd = relative(expectedCwd, eventCwd);
    if (relativeCwd !== "" && (relativeCwd.startsWith("..") || isAbsolute(relativeCwd))) return false;
    // The relay's ppid is transported as untrusted JSON. Descent from the
    // pinned Claude process (or its launcher) is the local identity check;
    // the capability above prevents a hook from another task crossing the cwd
    // route even when both sessions share a user and pane server.
    const anchor = record.claudePid ?? record.panePid;
    if (anchor !== undefined) return this.#ppidDescendsFrom(request.ppid, anchor);
    // Pre-identity window (owned startup, a few hundred ms): the pane id is the
    // only evidence available; it is client-supplied, so it is never trusted
    // once a pid anchor exists.
    return Boolean(record.handle.tmuxPaneId && request.tmuxPane && request.tmuxPane === record.handle.tmuxPaneId);
  }

  #completeTurn(record: TmuxRecord, result: Record<string, unknown>): void {
    record.activeRequests = 0;
    record.lastOutputAt = new Date().toISOString();
    record.turnSequence += 1;
    // Every message pasted before this turn ended has been consumed; a
    // confirmation that never arrived must not shadow a later human prompt.
    record.pendingSentMessages.length = 0;
    this.#emit(record, { type: "turn_completed", handle: record.handle, sequence: record.turnSequence, result });
  }

  async #handleHookRequest(record: TmuxRecord, request: HookRelayRequest): Promise<HookRelayReply | undefined> {
    if (!(await this.#bindsToRecord(record, request))) {
      record.ignoredHookRequests += 1;
      return {};
    }
    record.lastOutputAt = new Date().toISOString();
    const event = request.event;
    // Hook lifecycle events belong to one Claude session. A missing initial
    // SessionStart is normal during adoption, so the first bound event pins the
    // session id; later mismatches cannot mutate this task's state.
    if (record.claudeSessionId !== undefined && record.claudeSessionId !== event.session_id) {
      record.ignoredHookRequests += 1;
      return {};
    }
    record.claudeSessionId ??= event.session_id;
    // Every hook event carries `transcript_path`, and an adopted session never
    // replays SessionStart, so capture it here rather than only at startup:
    // it is what locates Claude's own per-project memory directory below.
    // Only a path that locates *this* task's memory root is kept: the first
    // event after adoption may come from a subagent, whose transcript sits
    // under `<slug>/<session>/subagents/` and would otherwise freeze a path
    // `memoryRootFor` rejects for the task's whole lifetime.
    if (!record.transcriptPath && isSafeAbsolutePath(event.transcript_path) && memoryRootFor(event.transcript_path, record.handle.cwd, record.claudeConfigDir ?? claudeConfigDir())) record.transcriptPath = event.transcript_path;
    switch (event.hook_event_name) {
      case "SessionStart": {
        record.handle.sessionId = event.session_id;
        if (!record.transcriptPath && isSafeAbsolutePath(event.transcript_path)) record.transcriptPath = event.transcript_path;
        if (!record.scratchpadDir && isSafeScratchpadPath(event.scratchpad_dir)) record.scratchpadDir = event.scratchpad_dir;
        record.sessionStartReceived = true;
        return {};
      }
      case "UserPromptSubmit": {
        const prompt = event.prompt ?? "";
        const matchedIndex = record.pendingSentMessages.findIndex((pending) => matchesPendingMessage(pending, prompt));
        if (matchedIndex >= 0) {
          record.pendingSentMessages.splice(matchedIndex, 1);
          return {};
        }
        // Claude Code delivers its own background-task, monitor and agent
        // completions through this hook as a user-role message; nobody typed it.
        if (!isClaudeRuntimePrompt(prompt)) {
          this.#emit(record, { type: "human_input", handle: record.handle, text: boundTextHead(prompt, 4_096) });
        }
        record.activeRequests = 1;
        record.inputAt = Date.now();
        record.lastInputAt = new Date().toISOString();
        return {};
      }
      case "PreToolUse": {
        const requestId = event.tool_use_id ?? randomUUID();
        return this.#awaitPermissionDecision(record, event, "pre", requestId, `pre:${requestId}`);
      }
      case "PermissionRequest": {
        const digest = createHash("sha256").update(`${event.session_id}${event.tool_name ?? ""}${JSON.stringify(event.tool_input ?? null)}`).digest("hex").slice(0, 16);
        const fingerprint = `prompt:${digest}`;
        // Keep byte-identical requests distinct after the previous one has been
        // answered, but never supersede a still-pending request. A duplicate
        // hook invocation gets no decision while the original remains open.
        if ([...record.pendingPermissionRequests.values()].some((pending) => pending.fingerprint === fingerprint)) return {};
        record.promptSequence += 1;
        return this.#awaitPermissionDecision(record, event, "prompt", `${fingerprint}:${record.promptSequence}`, fingerprint);
      }
      case "Stop": {
        this.#completeTurn(record, { subtype: "stop", result: event.last_assistant_message ?? "", stop_hook_active: Boolean(event.stop_hook_active) });
        return {};
      }
      case "StopFailure": {
        // An API/model error ended the turn and no Stop will follow. Surface it
        // as an errored turn so the Decision Worker can retry or park instead
        // of the task idling until the no-output watchdog.
        this.#completeTurn(record, { subtype: "error", is_error: true, result: describeHookError(event.error) });
        return {};
      }
      case "Notification": {
        if (event.notification_type === "permission_prompt") {
          const hasPendingPrompt = [...record.pendingPermissionRequests.values()].some((pending) => pending.phase === "prompt");
          if (!hasPendingPrompt) this.#logOutput(record, "[supervisor] Claude is waiting at a permission prompt the hook did not intercept\n");
        } else if (event.notification_type === "idle_prompt" && record.activeRequests > 0) {
          // Claude has been idle at its prompt for a minute with no Stop
          // delivered (interrupted turn, lost hook): close the turn so the
          // Supervisor is not left waiting for a completion that will not come.
          this.#logOutput(record, "[supervisor] Claude went idle without a Stop hook; treating the turn as finished\n");
          this.#completeTurn(record, { subtype: "idle", result: "" });
        }
        return {};
      }
      case "SessionEnd":
        // The existing pane-death poll emits `exited`; do not emit a second one.
        return {};
      default:
        return {};
    }
  }

  async #awaitPermissionDecision(record: TmuxRecord, event: ClaudeHookEvent, phase: "pre" | "prompt", requestId: string, fingerprint?: string): Promise<HookRelayReply> {
    if (record.permissionResponses.has(requestId) || record.pendingPermissionRequests.has(requestId)) return {};
    if (fingerprint && [...record.pendingPermissionRequests.values()].some((pending) => pending.fingerprint === fingerprint)) return {};
    record.permissionResponses.delete(requestId);
    const toolUseId = event.tool_use_id ?? requestId;
    const writeRoots = writeRootsOf(record);
    this.#emit(record, {
      type: "permission_request",
      handle: record.handle,
      request: {
        requestId,
        toolUseId,
        toolName: event.tool_name ?? "unknown",
        input: event.tool_input,
        raw: event as unknown as Record<string, unknown>,
        phase,
        ...(writeRoots.length > 0 ? { writeRoots } : {}),
      },
    });
    return new Promise<HookRelayReply>((resolve) => {
      const timeoutMs = Math.max(0, (HOOK_TIMEOUT_SECONDS - 10) * 1_000);
      const timer = setTimeout(() => {
        record.pendingPermissionRequests.delete(requestId);
        this.#logOutput(record, `[supervisor] permission request ${requestId} timed out waiting for a Supervisor decision\n`);
        resolve({});
      }, timeoutMs);
      timer.unref?.();
      record.pendingPermissionRequests.set(requestId, {
        phase,
        ...(fingerprint ? { fingerprint } : {}),
        resolve: (reply) => { clearTimeout(timer); resolve(reply); },
      });
    });
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
      // A detached record's processes are intentionally still alive; do not
      // claim the process-group boundary was cleaned. `detached` is the
      // signal callers must check instead.
      processGroupCleaned: record.detached ? false : record.cleanupComplete,
      cleanupError: record.cleanupError?.message,
      runtimeError: record.runtimeError?.message,
      cgroupCleaned: record.cgroupPath ? record.cgroupCleaned : undefined,
      cgroupRequired: record.cgroupPath ? true : undefined,
      cgroupError: record.cgroupError?.message,
      outputTruncated: record.outputTruncated,
      detached: record.detached,
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

function bridgeEnvironment(env: NodeJS.ProcessEnv, cwd: string, command: string, args: readonly string[], cgroupPath?: string, hookSettingsPath?: string, hookCapability?: string): NodeJS.ProcessEnv {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const result: NodeJS.ProcessEnv = {
    ...env,
    [BRIDGE_KEYS.command]: encode(command),
    [BRIDGE_KEYS.args]: encode(JSON.stringify(args)),
    [BRIDGE_KEYS.cwd]: encode(cwd),
    [BRIDGE_KEYS.cgroup]: encode(cgroupPath ?? ""),
  };
  if (hookSettingsPath !== undefined) result[INTERACTIVE_KEYS.settings] = encode(hookSettingsPath);
  if (hookCapability !== undefined) result[HOOK_CAPABILITY_KEY] = hookCapability;
  return result;
}

/** Same shape the decision-session registry requires of an untrusted absolute path. */
function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0")
    && isAbsolute(value) && String(redactSensitiveText(value)) === value;
}

/**
 * The directory name Claude gives a project under `<config>/projects/`: every
 * character outside `[A-Za-z0-9]` becomes `-` (`cwd.replace(/[^a-zA-Z0-9]/g, "-")`
 * in the Claude Code bundle), so `/srv/foo.bar` and `/home/u/my_app` are
 * `-srv-foo-bar` and `-home-u-my-app`, not merely the slashes swapped.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

/**
 * Claude's per-project memory directory for this task, or undefined when the
 * reported transcript path is not this project's session transcript.
 *
 * `transcript_path` is untrusted hook input, so the shape is checked rather
 * than trusted: it must be `<config>/projects/<slug>/<session>.jsonl` where
 * `<config>` is Claude's real configuration directory (`CLAUDE_CONFIG_DIR` or
 * `~/.claude`, compared by real path) and `<slug>` is the one Claude derives
 * from this task's cwd. That rejects a subagent transcript
 * (`<slug>/<session>/subagents/agent-*.jsonl`, which would otherwise freeze a
 * bogus root), any path naming another project, and a forged
 * `<anywhere>/.claude/projects/<slug>/x.jsonl` that only imitates the shape.
 */
export function memoryRootFor(transcriptPath: string | undefined, cwd: string, configDir: string = claudeConfigDir()): string | undefined {
  if (!transcriptPath || !cwd) return undefined;
  const sessionDir = dirname(transcriptPath);
  const projectsDir = dirname(sessionDir);
  if (!sameDirectory(projectsDir, join(configDir, "projects"), "lexical")) return undefined;
  if (basename(sessionDir) !== claudeProjectSlug(cwd)) return undefined;
  // The configured Claude directory itself may be a deliberate symlink, but a
  // symlink at `projects`, the project slug, or its memory child would turn a
  // hook-reported transcript into an arbitrary extra write root. Missing
  // components are allowed because Claude creates `memory` on first write;
  // existing components must be inspected without following them.
  if (!isNonSymlinkDirectory(projectsDir) || !isNonSymlinkDirectory(sessionDir) || !isNonSymlinkDirectory(join(sessionDir, "memory"))) return undefined;
  return join(sessionDir, "memory");
}

/**
 * The configuration directory a running Claude process uses, from its own
 * environment (`/proc/<pid>/environ`, readable for a same-user process), or
 * undefined when it cannot be read — then this process's own derivation
 * applies, which is right for every session this Supervisor started.
 */
async function processEnvironmentValue(pid: number, name: string): Promise<string | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, "utf8");
    for (const entry of raw.split("\0")) {
      if (entry.startsWith(`${name}=`)) return entry.slice(name.length + 1);
    }
  } catch {
    // A process can exit or hide its environment during adoption.
  }
  return undefined;
}

async function processConfigDir(pid: number): Promise<string | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`);
    const env: NodeJS.ProcessEnv = {};
    for (const entry of raw.toString("utf8").split("\0")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) continue;
      const name = entry.slice(0, separator);
      if (name === "CLAUDE_CONFIG_DIR" || name === "HOME") env[name] = entry.slice(separator + 1);
    }
    const dir = claudeConfigDir(env);
    return isAbsolute(dir) && !dir.includes("\0") ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directories outside the task cwd that the Worker may still write: its own
 * per-session scratchpad, and Claude's per-project memory directory.
 */
function isNonSymlinkDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function isSafeScratchpadPath(value: unknown): value is string {
  if (!isSafeAbsolutePath(value)) return false;
  const tempRoot = resolve(tmpdir());
  if (!isNonSymlinkDirectory(tempRoot)) return false;
  const candidate = resolve(value);
  const remainder = relative(tempRoot, candidate);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder)) return false;
  const parts = remainder.split(/[\\/]+/u).filter(Boolean);
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : undefined;
  if (!uid || parts[0] !== `claude-${uid}` || parts.at(-1) !== "scratchpad") return false;
  // The scratchpad root is reported by the Worker-side hook, so accept only
  // Claude's conventional per-user temporary tree, and never a symlinked
  // component that would turn the advertised root into another directory.
  let current = tempRoot;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) return false;
      if (!info.isDirectory() && part !== parts.at(-1)) return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") break;
      return false;
    }
  }
  return true;
}

export function writeRootsOf(record: { scratchpadDir?: string; transcriptPath?: string; claudeConfigDir?: string; handle?: { cwd: string } }, configDir: string = record.claudeConfigDir ?? claudeConfigDir()): string[] {
  const roots: string[] = [];
  if (isSafeScratchpadPath(record.scratchpadDir)) roots.push(record.scratchpadDir);
  const memory = memoryRootFor(record.transcriptPath, record.handle?.cwd ?? "", configDir);
  if (memory) roots.push(memory);
  return roots;
}

export function attachCommand(handle: Pick<WorkerHandle, "tmuxSocket" | "sessionName">): string {
  const target = shellQuote(handle.sessionName ?? "");
  return handle.tmuxSocket ? `tmux -S ${shellQuote(handle.tmuxSocket)} attach -t ${target}` : `tmux attach -t ${target}`;
}

const MAX_TMUX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

function runCommand(command: string, args: string[], input: string | undefined, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const decoders = { stdout: new TextDecoder("utf-8", { fatal: true }), stderr: new TextDecoder("utf-8", { fatal: true }) };
    const append = (kind: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (settled) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (kind === "stdout") stdoutBytes += bytes.byteLength; else stderrBytes += bytes.byteLength;
      if (stdoutBytes + stderrBytes > MAX_TMUX_COMMAND_OUTPUT_BYTES) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`tmux command output exceeded ${MAX_TMUX_COMMAND_OUTPUT_BYTES} bytes`));
        return;
      }
      try {
        const text = decoders[kind].decode(bytes, { stream: true });
        if (kind === "stdout") stdout += text; else stderr += text;
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`tmux command emitted invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`tmux command timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      if (code === 0) {
        try {
          stdout += decoders.stdout.decode();
          stderr += decoders.stderr.decode();
          settled = true;
          resolve({ stdout, stderr });
        } catch (error) {
          settled = true;
          reject(new Error(`tmux command emitted incomplete UTF-8: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        }
      } else {
        settled = true;
        reject(new Error(`tmux command failed (${code ?? signal ?? "unknown"}): ${stderr.trim() || args.join(" ")}`));
      }
    });
    child.stdin.end(input);
  });
}

function assertOwnedLogFile(info: { isFile(): boolean; isSymbolicLink(): boolean; uid: number; nlink: number }): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("tmux worker log is owned by another user");
  if (info.nlink > 1) throw new Error("tmux worker log is a hard-link alias");
}

function assertSameLogIdentity(first: { dev: number; ino: number }, second: { dev: number; ino: number }): void {
  if (first.dev !== second.dev || first.ino !== second.ino) throw new Error("tmux worker log was replaced during collection");
}

async function truncateRegular(path: string, expected?: { dev: number; ino: number }): Promise<void> {
  const file = await open(path, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    assertOwnedLogFile(info);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("tmux worker log is not a regular file");
    if (expected) assertSameLogIdentity(expected, info);
    await file.truncate(0);
  } finally {
    await file.close().catch(() => {});
  }
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

function supervisorChunkLinePrefix(generation: string, chunkId: string, index: number, total: number): string {
  return `@pi:control ${generation} @pi:chunk ${chunkId} ${index} ${total} `;
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
    .replace(/(?:^|\r?\n)[^\r\n]*@pi:chunk [A-Za-z0-9_-]+ \d+ \d+ [A-Za-z0-9+/=]+\r?(?=\n|$)/gu, "\n")
    .replace(/(?:^|\r?\n)[^\r\n]*@pi:stop\r?(?=\n|$)/gu, "\n");
}

function partialFramePrefixLength(value: string, prefix: string): number {
  const limit = Math.min(value.length, prefix.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(prefix.slice(0, length))) return length;
  }
  return 0;
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function boundText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes ? value : utf8Tail(value, maxBytes);
}

function boundTextHead(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
    const first = bytes[start]!;
    const width = first < 0x80 ? 1 : (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : 4;
    if (start + width <= end) break;
    end = start;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function normalizeForMatch(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/**
 * A tmux server removes its socket when it exits normally, but not when it is
 * killed with its cgroup; a dead `pi-cs-*.sock` is unlinked once no server
 * answers on it. `sweepDeadTmuxSockets` does the same for every socket the
 * adapter's naming scheme left behind in the temp directory.
 */
function removeDeadTmuxSocket(socketPath: string | undefined): void {
  if (!socketPath || !/[\\/]pi-cs-[0-9a-f-]+\.sock$/u.test(socketPath)) return;
  try {
    const info = lstatSync(socketPath);
    if (!info.isSocket() || (typeof process.getuid === "function" && info.uid !== process.getuid())) return;
    const probe = spawnSync("tmux", ["-S", socketPath, "list-sessions"], { stdio: "ignore", timeout: 2_000 });
    // A server that answers, or a socket something else holds open (the probe
    // timed out), is left alone.
    if (probe.status === 0 || probe.signal) return;
    unlinkSync(socketPath);
  } catch { /* already gone, or not ours to remove */ }
}

export function sweepDeadTmuxSockets(directory = tmpdir()): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  for (const name of names) {
    if (!/^pi-cs-[0-9a-f-]+\.sock$/u.test(name)) continue;
    const socketPath = join(directory, name);
    try {
      const info = lstatSync(socketPath);
      if (!info.isSocket() || (typeof process.getuid === "function" && info.uid !== process.getuid())) continue;
      const probe = spawnSync("tmux", ["-S", socketPath, "list-sessions"], { stdio: "ignore", timeout: 2_000 });
      if (probe.status === 0 || probe.signal) continue;
      unlinkSync(socketPath);
      removed += 1;
    } catch { /* skip */ }
  }
  return removed;
}

/**
 * True for a prompt Claude Code injected itself, which a human never typed:
 * `<task-notification>`, `<system-reminder>`, `<agent-message …>` and the
 * other hyphenated runtime wrappers it frames delivered content with. A
 * person's own message does not begin with such a tag.
 */
function isClaudeRuntimePrompt(prompt: string): boolean {
  return /^\s*<[a-z]+(?:-[a-z]+)+(?:\s|>)/u.test(prompt);
}

/**
 * A UserPromptSubmit hook reports the prompt as Claude's TUI captured it,
 * which can reflow long pasted text. Treat it as the adapter's own send only
 * when the complete normalized text matches. A prefix match would let a human
 * who repeats the beginning of a Supervisor instruction bypass human-takeover
 * detection; a formatting mismatch fails closed as human input.
 */
function describeHookError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, 2_000);
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; type?: unknown; status?: unknown };
    const parts = [record.type, record.status, record.message].filter((part) => part !== undefined && part !== null).map(String);
    if (parts.length > 0) return parts.join(" ").slice(0, 2_000);
    try { return JSON.stringify(error).slice(0, 2_000); } catch { /* unserializable */ }
  }
  return "Claude Code reported a turn failure";
}

function matchesPendingMessage(pending: string, prompt: string): boolean {
  const normalizedPending = normalizeForMatch(pending);
  const normalizedPrompt = normalizeForMatch(prompt);
  return Boolean(normalizedPending && normalizedPrompt && normalizedPending === normalizedPrompt);
}

async function signalProcessGroup(pid: number, expectedStartTime: string | undefined, expectedCommand: string | undefined, signal: NodeJS.Signals): Promise<void> {
  const identity = await processIdentity(pid);
  if (!identity) return;
  if (identity.pgid !== pid || (expectedStartTime !== undefined && identity.startTime !== expectedStartTime) || (expectedCommand !== undefined && identity.command !== expectedCommand)) {
    throw new Error(`tmux pane identity changed; refusing to signal process group ${pid}`);
  }
  try { process.kill(-pid, signal); }
  catch (error) {
    if (error instanceof Error && /ESRCH/u.test(error.message)) return;
    throw error;
  }
}

interface ProcessIdentity {
  startTime: string;
  pgid: number;
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
    const pgid = Number(fields[2]);
    const command = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
    return startTime && Number.isSafeInteger(pgid) && command ? { startTime, pgid, command } : undefined;
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
  return error instanceof Error && /tmux pane identity changed|pane identity unavailable|cannot identify tmux pane (?:pid|process group)/iu.test(error.message);
}

function isMissingSession(error: unknown): boolean {
  // tmux leaves its socket behind on exit ("no server running") unless it was
  // unlinked, in which case it reports "error connecting … (No such file or
  // directory)"; both mean the same thing here.
  return error instanceof Error && /(can't find session|no server running|session not found|target pane has exited|failed to connect|error connecting to [^\n]*No such file or directory)/iu.test(error.message);
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
