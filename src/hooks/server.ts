import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { trustedExecutablePath } from "../worker/environment.ts";
import { BLOCKING_HOOK_EVENTS } from "./types.ts";
import type { ClaudeHookEvent, ClaudeHookEventName, HookEventSource, HookRelayReply, HookRelayRequest } from "./types.ts";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_HOOK_STRING_BYTES = 256 * 1024;
const MAX_HOOK_VALUE_BYTES = 512 * 1024;
const MAX_CONNECTION_IDLE_MS = 180_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PEER_CREDENTIAL_TIMEOUT_MS = 2_000;
const PEER_CREDENTIAL_SCRIPT = [
  "import os, socket, struct, sys",
  "try:",
  "    peer = socket.socket(fileno=3)",
  "    pid, uid, gid = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))",
  "    print(pid, uid, gid, flush=True)",
  "except Exception:",
  "    sys.exit(125)",
].join("\n");

type PeerCredentials = { pid: number; uid: number; gid: number };
type SocketWithHandle = Socket & { _handle?: { fd?: number } };

const VALID_EVENT_NAMES: ReadonlySet<string> = new Set<ClaudeHookEventName>([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "Notification",
]);

type HookHandler = (request: HookRelayRequest) => Promise<HookRelayReply | undefined>;

/** `<stateDir>/hooks` — where a HookServer's socket and per-cwd symlinks live. */
export function hookSocketDirectory(stateDir: string): string {
  return join(resolve(stateDir), "hooks");
}

/** Linux limits a unix socket path to 108 bytes (`sun_path`); leave headroom for the pid/start-time suffix. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Where the listening socket itself lives. The state directory can be
 * arbitrarily deep (`~/.pi/agent/claude-supervisor/hooks/by-cwd/<sha256>` is
 * already past the limit), so the socket goes to a short per-user runtime
 * directory and the `by-cwd` symlinks in the state directory point at it.
 */
export function hookSocketRuntimeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  return runtime ? join(runtime, "pi-claude-supervisor") : join(tmpdir(), `pi-claude-supervisor-${uid}`);
}

/**
 * One socket per Pi process, with a per-cwd symlink under `by-cwd/` so a
 * relay only needs the event's cwd to find its Supervisor. See
 * src/hooks/types.ts for the full routing contract.
 */
export class HookServer implements HookEventSource {
  readonly #directory: string;
  readonly #handlers = new Map<string, HookHandler>();
  /** Capability routing survives a Claude `cd` whose hook cwd no longer has a by-cwd link. */
  readonly #capabilityHandlers = new Map<string, HookHandler>();
  readonly #sockets = new Set<Socket>();
  #subscriptionTail: Promise<void> = Promise.resolve();
  #server: Server | undefined;
  #socketPath: string | undefined;

  readonly #socketDirectory: string;
  #peerCredentialCommand: string | undefined;

  constructor(options: { directory: string; socketDirectory?: string }) {
    this.#socketDirectory = resolve(options.socketDirectory ?? hookSocketRuntimeDirectory());
    this.#directory = resolve(options.directory);
  }

  get directory(): string {
    return this.#directory;
  }

  get socketPath(): string | undefined {
    return this.#socketPath;
  }

  async listen(): Promise<void> {
    if (this.#server) throw new Error("hook server is already listening");
    // Node's public net API does not expose native Unix peer credentials. The
    // hook boundary therefore supports Linux only: use a Supervisor-resolved
    // helper to ask the kernel for the accepted socket's peer pid/uid/gid;
    // unsupported platforms and missing helpers fail closed, never falling
    // back to client-supplied identity fields.
    if (process.platform !== "linux") throw new Error("hook server requires Linux native Unix-socket peer credentials");
    this.#peerCredentialCommand = await trustedExecutablePath("python3");
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.#directory, "hook state directory");
    await chmod(this.#directory, 0o700);
    await assertPrivatePermissions(this.#directory, "hook state directory");
    await mkdir(this.#socketDirectory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.#socketDirectory, "hook socket directory");
    await chmod(this.#socketDirectory, 0o700);
    await assertPrivatePermissions(this.#socketDirectory, "hook socket directory");
    const startTime = await processStartTime(process.pid);
    const socketPath = join(this.#socketDirectory, `${process.pid}-${startTime}.sock`);
    if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) throw new Error(`hook socket path exceeds the unix socket limit: ${socketPath}`);
    await removeStaleSocket(socketPath);
    const server = createServer((socket) => this.#handleConnection(socket));
    server.on("error", (error) => {
      // Once listening, a server-level error is otherwise unobserved; an
      // unhandled "error" event would crash the whole Supervisor process.
      console.error(`pi-claude-supervisor hook server error: ${error instanceof Error ? error.message : String(error)}`);
    });
    await new Promise<void>((resolveListen, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.removeListener("error", onError);
        resolveListen();
      });
    });
    await chmod(socketPath, 0o600);
    this.#server = server;
    this.#socketPath = socketPath;
  }

  async subscribe(cwd: string, handler: HookHandler, options: { capability?: string } = {}): Promise<() => Promise<void>> {
    const hash = hashCwd(await canonicalize(cwd));
    const capability = options.capability;
    return this.#withSubscriptionLock(async () => {
      if (!this.#socketPath) throw new Error("hook server is not listening");
      const socketPath = this.#socketPath;
      if (capability !== undefined && !/^[A-Za-z0-9_-]{16,256}$/u.test(capability)) throw new Error("hook subscription capability has an invalid shape");
      if (capability !== undefined && this.#capabilityHandlers.has(capability)) throw new Error("hook subscription capability is already in use");
      this.#handlers.set(hash, handler);
      if (capability !== undefined) this.#capabilityHandlers.set(capability, handler);
      try {
        await this.#linkByCwd(hash, socketPath);
      } catch (error) {
        if (this.#handlers.get(hash) === handler) this.#handlers.delete(hash);
        if (capability !== undefined && this.#capabilityHandlers.get(capability) === handler) this.#capabilityHandlers.delete(capability);
        throw error;
      }
      let unsubscribed = false;
      return async () => {
        if (unsubscribed) return;
        await this.#withSubscriptionLock(async () => {
          if (unsubscribed) return;
          unsubscribed = true;
          // Only ever remove a handler this call installed: a takeover could
          // already have replaced it under the same hash. In particular, do
          // not unlink a successor's cwd route when an older subscription is
          // closing.
          const ownsCwdRoute = this.#handlers.get(hash) === handler;
          if (ownsCwdRoute) this.#handlers.delete(hash);
          if (capability !== undefined && this.#capabilityHandlers.get(capability) === handler) this.#capabilityHandlers.delete(capability);
          if (ownsCwdRoute) await this.#unlinkByCwd(hash, socketPath);
        });
      };
    });
  }

  async close(): Promise<void> {
    const { server, socketPath } = await this.#withSubscriptionLock(async () => {
      const server = this.#server;
      const socketPath = this.#socketPath;
      this.#server = undefined;
      this.#socketPath = undefined;
      this.#handlers.clear();
      this.#capabilityHandlers.clear();
      return { server, socketPath };
    });
    if (server) {
      // net.Server#close only resolves once every accepted socket has ended;
      // a relay parked on a slow handler must not pin Supervisor shutdown.
      // Destroying them makes the relay fail open to "no decision" (empty
      // stdout), the documented behavior for a lost connection.
      for (const socket of this.#sockets) {
        try { socket.destroy(); } catch { /* already closed */ }
      }
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (socketPath) {
      await rm(socketPath, { force: true });
      await this.#removeSymlinksTo(socketPath);
    }
  }

  async #withSubscriptionLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const previous = this.#subscriptionTail;
    this.#subscriptionTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #linkByCwd(hash: string, socketPath: string): Promise<void> {
    const byCwdDir = join(this.#directory, "by-cwd");
    await mkdir(byCwdDir, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(byCwdDir, "hook by-cwd directory");
    await chmod(byCwdDir, 0o700);
    await assertPrivatePermissions(byCwdDir, "hook by-cwd directory");
    const target = join(byCwdDir, hash);
    const temporary = join(byCwdDir, `${hash}.tmp.${process.pid}.${randomUUID()}`);
    try {
      await symlink(socketPath, temporary);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async #unlinkByCwd(hash: string, socketPath: string): Promise<void> {
    const target = join(this.#directory, "by-cwd", hash);
    try {
      const link = await readlink(target);
      if (link === socketPath) await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #removeSymlinksTo(socketPath: string): Promise<void> {
    const byCwdDir = join(this.#directory, "by-cwd");
    let entries: string[];
    try {
      entries = await readdir(byCwdDir);
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const entryPath = join(byCwdDir, entry);
      try {
        const link = await readlink(entryPath);
        if (link === socketPath) await unlink(entryPath);
      } catch {
        /* not a symlink, or already gone */
      }
    }));
  }

  #handleConnection(socket: Socket): void {
    this.#sockets.add(socket);
    // A client may connect and never send a line; consume lookup failures here
    // so resource or descriptor errors cannot become unhandled rejections.
    const peer = readPeerCredentials(socket, this.#peerCredentialCommand!).catch(() => undefined);
    // A relay's blocking timeout is slightly shorter than this. The server
    // must not retain an attacker-controlled connection and up to 1 MiB of
    // partial input forever if the peer never sends a newline.
    socket.setTimeout(MAX_CONNECTION_IDLE_MS, () => socket.destroy());
    const connectionDeadline = setTimeout(() => socket.destroy(), MAX_CONNECTION_IDLE_MS);
    connectionDeadline.unref?.();
    socket.on("close", () => {
      clearTimeout(connectionDeadline);
      this.#sockets.delete(socket);
    });
    socket.on("error", () => {
      try { socket.destroy(); } catch { /* already closed */ }
    });
    let buffer = Buffer.alloc(0);
    let bytes = 0;
    let done = false;
    socket.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const bytesChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += bytesChunk.byteLength;
      if (bytes > MAX_LINE_BYTES) {
        done = true;
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, bytesChunk]);
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex === -1) return;
      done = true;
      let line: string;
      try {
        line = UTF8_DECODER.decode(buffer.subarray(0, newlineIndex));
      } catch {
        socket.destroy();
        return;
      }
      void this.#respond(socket, line, peer);
    });
  }

  async #respond(socket: Socket, line: string, peerPromise: Promise<PeerCredentials | undefined>): Promise<void> {
    let reply: HookRelayReply | Record<string, never> = {};
    try {
      const peer = await peerPromise;
      const request = parseRequest(line);
      if (request && await peerBindsToRequest(peer, request)) {
        // Capability routing is preferred when present: a persistent Claude
        // session may report the cwd of a subdirectory after `cd`, while its
        // original by-cwd symlink remains the discovery route.
        const handler = (request.capability ? this.#capabilityHandlers.get(request.capability) : undefined)
          ?? this.#handlers.get(hashCwd(await canonicalize(request.event.cwd)));
        if (handler) reply = (await handler(request)) ?? {};
      }
    } catch {
      reply = {};
    }
    try {
      const encoded = JSON.stringify(reply);
      socket.end(`${Buffer.byteLength(encoded, "utf8") <= MAX_LINE_BYTES ? encoded : "{}"}\n`);
    } catch {
      /* the relay may already have disconnected (fire-and-forget events) */
    }
  }
}

function hashCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

async function canonicalize(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return cwd;
  }
}

async function processStartTime(pid: number): Promise<string> {
  const statText = await readFile(`/proc/${pid}/stat`, "utf8");
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) throw new Error("hook server process identity is unavailable");
  const fields = statText.slice(closeParen + 2).trim().split(/\s+/u);
  const start = fields[19];
  if (!start || !/^\d+$/u.test(start)) throw new Error("hook server process start time is unavailable");
  return start;
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a real directory: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${label} is owned by another user: ${path}`);
  if (await realpath(path) !== resolve(path)) throw new Error(`${label} contains a symlink: ${path}`);
}

async function assertPrivatePermissions(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label} is not private: ${path}`);
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSocket()
      && (typeof process.getuid !== "function" || info.uid === process.getuid())
      && info.nlink === 1) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readPeerCredentials(socket: Socket, command: string): Promise<PeerCredentials> {
  const fd = (socket as SocketWithHandle)._handle?.fd;
  if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 0) throw new Error("hook socket peer descriptor is unavailable");
  const descriptor = fd;
  return new Promise<PeerCredentials>((resolvePeer, rejectPeer) => {
    let settled = false;
    let output = Buffer.alloc(0);
    const child = spawn(command, ["-c", PEER_CREDENTIAL_SCRIPT], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1" },
      stdio: ["ignore", "pipe", "pipe", descriptor],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      rejectPeer(new Error("hook socket peer credential lookup timed out"));
    }, PEER_CREDENTIAL_TIMEOUT_MS);
    timer.unref();
    child.stderr?.resume();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      output = Buffer.concat([output, bytes]);
      if (output.byteLength > 1024) {
        settled = true;
        clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        rejectPeer(new Error("hook socket peer credential output exceeded the safety bound"));
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPeer(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectPeer(new Error(`hook socket peer credential lookup failed (${code ?? "unknown"})`));
        return;
      }
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(output).trim(); }
      catch (error) {
        rejectPeer(new Error("hook socket peer credential output was not valid UTF-8", { cause: error }));
        return;
      }
      const fields = text.split(/\s+/u);
      const values = fields.map(Number);
      if (fields.length !== 3 || values.some((value) => !Number.isSafeInteger(value) || value < 0) || values[0] === 0) {
        rejectPeer(new Error("hook socket peer credentials were malformed"));
        return;
      }
      resolvePeer({ pid: values[0]!, uid: values[1]!, gid: values[2]! });
    });
  });
}

async function peerBindsToRequest(peer: PeerCredentials | undefined, request: HookRelayRequest): Promise<boolean> {
  if (!peer || request.pid !== peer.pid || (typeof process.getuid === "function" && peer.uid !== process.getuid())) return false;
  try {
    const statText = await readFile(`/proc/${peer.pid}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    if (closeParen < 0) return false;
    const fields = statText.slice(closeParen + 2).trim().split(/\s+/u);
    const ppid = Number(fields[1]);
    return Number.isSafeInteger(ppid) && ppid > 0 && ppid === request.ppid;
  } catch (error) {
    // Non-blocking hooks intentionally close their relay process immediately
    // after writing. Native SO_PEERCRED already bound the request to that
    // process; its /proc entry may disappear before this supplemental PPID
    // check. Blocking decisions fail closed when PPID cannot be confirmed;
    // fire-and-forget lifecycle events can use the native PID/UID binding.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      && !BLOCKING_HOOK_EVENTS.has(request.event.hook_event_name);
  }
}

function parseRequest(line: string): HookRelayRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const request = value as Partial<HookRelayRequest>;
  if (request.version !== 1) return undefined;
  if (typeof request.pid !== "number" || !Number.isSafeInteger(request.pid) || request.pid <= 0) return undefined;
  if (typeof request.ppid !== "number" || !Number.isSafeInteger(request.ppid) || request.ppid <= 0) return undefined;
  if (request.tmuxPane !== undefined && !boundedHookString(request.tmuxPane, 256, true)) return undefined;
  if (request.capability !== undefined && (typeof request.capability !== "string" || !/^[A-Za-z0-9_-]{16,256}$/u.test(request.capability))) return undefined;
  const event = request.event as Partial<ClaudeHookEvent> | undefined;
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  if (typeof event.cwd !== "string" || !boundedHookString(event.cwd, 4_096, true)) return undefined;
  if (typeof event.hook_event_name !== "string" || !VALID_EVENT_NAMES.has(event.hook_event_name)) return undefined;
  if (typeof event.session_id !== "string" || !boundedHookString(event.session_id, 512, true)) return undefined;
  const stringFields: Array<[keyof ClaudeHookEvent, number, boolean]> = [
    ["transcript_path", 4_096, true], ["permission_mode", 256, true], ["source", 256, false], ["reason", 256, false],
    ["prompt", MAX_HOOK_STRING_BYTES, false], ["tool_name", 256, true], ["tool_use_id", 512, true],
    ["last_assistant_message", MAX_HOOK_STRING_BYTES, false], ["notification_type", 256, true], ["message", MAX_HOOK_STRING_BYTES, false],
    ["scratchpad_dir", 4_096, true],
  ];
  for (const [field, limit, rejectControls] of stringFields) {
    const fieldValue = event[field];
    if (fieldValue !== undefined && !boundedHookString(fieldValue, limit, rejectControls)) return undefined;
  }
  if (event.stop_hook_active !== undefined && typeof event.stop_hook_active !== "boolean") return undefined;
  for (const field of ["tool_input", "error"] as const) {
    const fieldValue = event[field];
    if (fieldValue === undefined) continue;
    try {
      if (Buffer.byteLength(JSON.stringify(fieldValue) ?? "null", "utf8") > MAX_HOOK_VALUE_BYTES) return undefined;
    } catch {
      return undefined;
    }
  }
  // Drop extension fields before the event reaches the adapter and event log;
  // the line bound is not a durable per-field bound, and Claude may add future
  // fields containing arbitrary payloads.
  const allowedFields = new Set<keyof ClaudeHookEvent>([
    "hook_event_name", "session_id", "cwd", "transcript_path", "permission_mode", "source", "scratchpad_dir", "reason",
    "prompt", "tool_name", "tool_input", "tool_use_id", "last_assistant_message", "stop_hook_active", "error", "notification_type", "message",
  ]);
  const sanitizedEvent = Object.fromEntries(Object.entries(event).filter(([field]) => allowedFields.has(field as keyof ClaudeHookEvent))) as unknown as ClaudeHookEvent;
  return {
    version: 1,
    pid: request.pid,
    ppid: request.ppid,
    ...(request.tmuxPane !== undefined ? { tmuxPane: request.tmuxPane } : {}),
    ...(request.capability !== undefined ? { capability: request.capability } : {}),
    event: sanitizedEvent,
  };
}

function boundedHookString(value: unknown, maxBytes: number, rejectControls: boolean): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !value.includes("\0")
    && (!rejectControls || !/[\u0001-\u001f\u007f]/u.test(value));
}
