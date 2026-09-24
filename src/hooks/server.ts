import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, readdir, readlink, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CLAUDE_HOOK_EVENT_NAMES, type ClaudeHookEvent, type ClaudeHookEventName, type HookEventSource, type HookRelayReply, type HookRelayRequest } from "./types.ts";

const MAX_LINE_BYTES = 1024 * 1024;

const VALID_EVENT_NAMES: ReadonlySet<string> = new Set<ClaudeHookEventName>(CLAUDE_HOOK_EVENT_NAMES);

type HookHandler = (request: HookRelayRequest) => Promise<HookRelayReply | undefined>;

/** `<stateDir>/hooks` — where a HookServer's socket and per-cwd symlinks live. */
export function hookSocketDirectory(stateDir: string): string {
  return join(resolve(stateDir), "hooks");
}

/** Linux limits a unix socket path to 108 bytes (`sun_path`); leave headroom for the pid suffix. */
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
 * relay only needs the task directory to find its Supervisor. See
 * src/hooks/types.ts for the full routing contract.
 */
export class HookServer implements HookEventSource {
  readonly #directory: string;
  readonly #handlers = new Map<string, HookHandler>();
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #socketPath: string | undefined;

  readonly #socketDirectory: string;

  constructor(options: { directory: string; socketDirectory?: string }) {
    this.#socketDirectory = options.socketDirectory ?? hookSocketRuntimeDirectory();
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
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    await mkdir(this.#socketDirectory, { recursive: true, mode: 0o700 });
    const socketDirectoryInfo = await lstat(this.#socketDirectory);
    if (!socketDirectoryInfo.isDirectory() || socketDirectoryInfo.isSymbolicLink()) throw new Error(`hook socket directory is not a real directory: ${this.#socketDirectory}`);
    if (typeof process.getuid === "function" && socketDirectoryInfo.uid !== process.getuid()) throw new Error(`hook socket directory is owned by another user: ${this.#socketDirectory}`);
    await chmod(this.#socketDirectory, 0o700);
    const socketPath = join(this.#socketDirectory, `${process.pid}.sock`);
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

  async subscribe(cwd: string, handler: HookHandler): Promise<() => Promise<void>> {
    if (!this.#socketPath) throw new Error("hook server is not listening");
    const socketPath = this.#socketPath;
    const hash = hashCwd(await canonicalize(cwd));
    this.#handlers.set(hash, handler);
    await this.#linkByCwd(hash, socketPath);
    let unsubscribed = false;
    return async () => {
      if (unsubscribed) return;
      unsubscribed = true;
      // Only ever remove a handler this call installed: a takeover could
      // already have replaced it under the same hash.
      if (this.#handlers.get(hash) === handler) this.#handlers.delete(hash);
      await this.#unlinkByCwd(hash, socketPath);
    };
  }

  async close(): Promise<void> {
    const server = this.#server;
    const socketPath = this.#socketPath;
    this.#server = undefined;
    this.#socketPath = undefined;
    this.#handlers.clear();
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

  async #linkByCwd(hash: string, socketPath: string): Promise<void> {
    const byCwdDir = join(this.#directory, "by-cwd");
    await mkdir(byCwdDir, { recursive: true, mode: 0o700 });
    const target = join(byCwdDir, hash);
    const temporary = join(byCwdDir, `${hash}.tmp.${process.pid}.${randomUUID()}`);
    await symlink(socketPath, temporary);
    await rename(temporary, target);
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
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => {
      try { socket.destroy(); } catch { /* already closed */ }
    });
    let buffer = "";
    let bytes = 0;
    let done = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_LINE_BYTES) {
        done = true;
        socket.destroy();
        return;
      }
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      done = true;
      void this.#respond(socket, buffer.slice(0, newlineIndex));
    });
  }

  async #respond(socket: Socket, line: string): Promise<void> {
    let reply: HookRelayReply | Record<string, never> = {};
    try {
      const request = parseRequest(line);
      if (request) {
        const handler = this.#handlers.get(hashCwd(await canonicalize(request.routeCwd ?? request.event.cwd)));
        if (handler) reply = (await handler(request)) ?? {};
      }
    } catch {
      reply = {};
    }
    try {
      socket.end(`${JSON.stringify(reply)}\n`);
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

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSocket()) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  if (typeof request.pid !== "number" || typeof request.ppid !== "number") return undefined;
  if (request.routeCwd !== undefined && (typeof request.routeCwd !== "string" || !isAbsolute(request.routeCwd))) return undefined;
  const event = request.event as Partial<ClaudeHookEvent> | undefined;
  if (!event || typeof event !== "object") return undefined;
  if (typeof event.cwd !== "string" || !event.cwd) return undefined;
  if (typeof event.hook_event_name !== "string" || !VALID_EVENT_NAMES.has(event.hook_event_name)) return undefined;
  if (typeof event.session_id !== "string") return undefined;
  return request as HookRelayRequest;
}
