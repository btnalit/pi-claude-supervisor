import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { redactSensitive } from "./redaction.ts";

export interface SupervisorEvent {
  seq: number;
  at: string;
  type: string;
  taskId?: string;
  workerId?: string;
  idempotencyKey?: string;
  data?: Record<string, unknown>;
}

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_KEEP_ROTATED = 5;
const TAIL_WINDOW_BYTES = 256 * 1024;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_SCAN_BYTES = 128 * 1024 * 1024;
const ROTATED_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/u;

export class EventLog {
  #seq = 0;
  #initialized = false;
  readonly #path?: string;
  readonly #maxBytes: number;
  readonly #keepRotated: number;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path?: string, options: { maxBytes?: number; keepRotated?: number } = {}) {
    this.#path = path;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#keepRotated = options.keepRotated ?? DEFAULT_KEEP_ROTATED;
  }

  async append(event: Omit<SupervisorEvent, "seq" | "at">): Promise<SupervisorEvent> {
    const operation = this.#writeTail.then(async () => {
      return this.#path
        ? this.#withFileLock(async () => {
            await this.#initialize();
            await this.#refreshSequence();
            await this.#rotateIfNeeded();
            return this.#appendEntry(event);
          })
        : this.#appendEntry(event);
    });
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #appendEntry(event: Omit<SupervisorEvent, "seq" | "at">): Promise<SupervisorEvent> {
    const entry: SupervisorEvent = {
      ...redactEvent(event),
      seq: ++this.#seq,
      at: new Date().toISOString(),
    };
    const serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized, "utf8") > Math.min(MAX_EVENT_BYTES, this.#maxBytes)) throw new Error("event exceeds the safe size limit");
    if (this.#path) {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(dirname(this.#path), "event log directory");
      await chmod(dirname(this.#path), 0o700);
      await appendSecure(this.#path, `${serialized}\n`);
    }
    return entry;
  }

  async #withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#path) return operation();
    const lockPath = `${this.#path}.lock`;
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(dirname(this.#path), "event log directory");
    await chmod(dirname(this.#path), 0o700);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const lockToken = randomUUID();
    let lockIdentity: { device: number; inode: number } | undefined;
    while (true) {
      try {
        await mkdir(lockPath);
        await assertPrivateDirectory(lockPath, "event log lock");
        await writeExclusive(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid, token: lockToken, at: new Date().toISOString() }));
        const lockInfo = await lstat(lockPath);
        lockIdentity = { device: lockInfo.dev, inode: lockInfo.ino };
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/EEXIST/u.test(error.message)) throw error;
        if (await this.#removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) throw new Error(`event log lock timeout: ${lockPath}`);
        await delay(25);
      }
    }
    try {
      return await operation();
    } finally {
      if (lockIdentity) await releaseEventLock(lockPath, lockIdentity, lockToken);
    }
  }

  async #removeStaleLock(lockPath: string): Promise<boolean> {
    let lockInfo;
    try {
      lockInfo = await lstat(lockPath);
      if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) return false;
    } catch (error) {
      return error instanceof Error && /ENOENT/u.test(error.message);
    }
    const ownerPath = `${lockPath}/owner.json`;
    let ownerMtime = lockInfo.mtimeMs;
    let token: string | undefined;
    try {
      const ownerInfo = await lstat(ownerPath);
      if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink()) return false;
      ownerMtime = ownerInfo.mtimeMs;
      const owner = JSON.parse(await readSecure(ownerPath)) as { pid?: unknown; token?: unknown };
      if (typeof owner.token === "string" && owner.token) token = owner.token;
      if (typeof owner.pid === "number") {
        try {
          process.kill(owner.pid, 0);
          return false;
        } catch (error) {
          if (error instanceof Error && /EPERM/u.test(error.message)) return false;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") return false;
      if (!code && !(error instanceof SyntaxError)) return false;
    }
    if (Date.now() - ownerMtime < STALE_LOCK_MS) return false;
    return reclaimEventLock(lockPath, { device: lockInfo.dev, inode: lockInfo.ino }, token);
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    await this.#fullScan();
  }

  // Full scan of the log: reads and validates every line, repairing a
  // partial last line left behind by a crashed writer. Only safe to run
  // once per process (on #initialize) or as a fallback from the tail-only
  // #refreshSequence below, since it is O(file size).
  async #fullScan(): Promise<void> {
    if (!this.#path) return;
    try {
      const info = await lstat(this.#path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("event log is not a regular file");
      if (info.size > Math.min(this.#maxBytes, MAX_EVENT_SCAN_BYTES)) throw new Error("event log exceeds the safe scan size limit");
      const contents = await readSecure(this.#path);
      const lines = contents.split("\n");
      let firstCorruptLine = -1;
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].trim()) continue;
        try {
          JSON.parse(lines[index]);
        } catch {
          firstCorruptLine = index;
          break;
        }
      }
      if (firstCorruptLine >= 0) {
        // A partial write is only safe to recover by removing it and anything
        // after it; otherwise future appends would remain unreplayable JSONL.
        const repaired = `${lines.slice(0, firstCorruptLine).join("\n").replace(/\n+$/u, "")}\n`;
        await writeExistingSecure(this.#path, repaired);
        lines.length = firstCorruptLine;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        const seq = (JSON.parse(line) as { seq?: unknown }).seq;
        if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
          this.#seq = Math.max(this.#seq, seq);
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT/u.test(error.message)) throw error;
    }
  }

  // Per-append sequence sync: reads only a tail window of the file so that
  // append cost stays flat as the log grows, instead of re-parsing the
  // whole file (and holding the cross-process lock) on every append.
  async #refreshSequence(): Promise<void> {
    if (!this.#path) return;
    let size: number;
    try {
      const info = await lstat(this.#path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("event log is not a regular file");
      size = info.size;
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT/u.test(error.message)) throw error;
      // File is missing (e.g. right after rotation): keep #seq as-is.
      return;
    }
    if (size === 0) return;
    let window = Math.min(TAIL_WINDOW_BYTES, size);
    while (true) {
      const start = size - window;
      let text: string;
      const handle = await openRegular(this.#path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(window);
        const { bytesRead } = await handle.read(buffer, 0, window, start);
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
      if (start > 0) {
        // The window may start mid-line; discard the (possibly partial)
        // first line and rely on the next window growth if that leaves
        // nothing usable.
        const firstNewline = text.indexOf("\n");
        text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
      }
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length === 0) {
        if (window >= size) {
          await this.#fullScan();
          return;
        }
        window = Math.min(window * 2, size);
        continue;
      }
      const lastLine = lines[lines.length - 1];
      try {
        const seq = (JSON.parse(lastLine) as { seq?: unknown }).seq;
        if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
          this.#seq = Math.max(this.#seq, seq);
        }
      } catch {
        // The last line is a partial write from a crashed writer; fall back
        // to the full scan, which repairs the corrupt tail.
        await this.#fullScan();
      }
      return;
    }
  }

  async #rotateIfNeeded(): Promise<void> {
    if (!this.#path) return;
    let size: number;
    try {
      const info = await lstat(this.#path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("event log is not a regular file");
      size = info.size;
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT/u.test(error.message)) throw error;
      return;
    }
    if (size < this.#maxBytes) return;
    // Two rotations within one millisecond must not clobber each other via
    // rename(2), so the timestamp carries a random suffix as well.
    const stamp = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(4).toString("hex")}`;
    await rename(this.#path, `${this.#path}.${stamp}`);
    await this.#pruneRotated();
  }

  async #pruneRotated(): Promise<void> {
    if (!this.#path) return;
    const dir = dirname(this.#path);
    const base = basename(this.#path);
    const lockName = `${base}.lock`;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    const rotated: string[] = [];
    for (const name of entries) {
      if (name === base || name === lockName) continue;
      if (!name.startsWith(`${base}.`)) continue;
      if (!ROTATED_STAMP_PATTERN.test(name.slice(base.length + 1))) continue;
      let entryStat;
      try {
        entryStat = await lstat(join(dir, name));
      } catch {
        continue;
      }
      if (!entryStat.isFile() || entryStat.isSymbolicLink()) continue;
      rotated.push(name);
    }
    rotated.sort();
    const toRemove = rotated.slice(0, Math.max(0, rotated.length - this.#keepRotated));
    for (const name of toRemove) {
      await rm(join(dir, name), { force: true });
    }
  }
}

async function releaseEventLock(path: string, identity: { device: number; inode: number }, token: string): Promise<void> {
  try {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.device || current.ino !== identity.inode) return;
    const owner = JSON.parse(await readSecure(join(path, "owner.json"))) as { token?: unknown };
    if (owner.token !== token) return;
    await reclaimEventLock(path, identity, token);
  } catch {
    // Leave uncertain lock state for the stale-lock path; never remove an
    // entry whose inode or owner token cannot be verified.
  }
}

async function reclaimEventLock(path: string, identity: { device: number; inode: number }, token?: string): Promise<boolean> {
  const quarantine = `${path}.reap-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, quarantine);
    const moved = await lstat(quarantine);
    if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== identity.device || moved.ino !== identity.inode) {
      await rename(quarantine, path).catch(() => {});
      return false;
    }
    if (token !== undefined) {
      const owner = JSON.parse(await readSecure(join(quarantine, "owner.json"))) as { token?: unknown };
      if (owner.token !== token) {
        await rename(quarantine, path).catch(() => {});
        return false;
      }
    }
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } catch {
    await rename(quarantine, path).catch(() => {});
    return false;
  }
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a real directory: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${label} is owned by another user: ${path}`);
}

async function openRegular(path: string, flags: number, mode?: number) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("secure event-log opening is unavailable");
  const handle = await open(path, flags | fsConstants.O_NOFOLLOW, mode);
  const info = await handle.stat();
  if (!info.isFile() || info.isSymbolicLink()) {
    await handle.close().catch(() => {});
    throw new Error(`event log entry is not a regular file: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    await handle.close().catch(() => {});
    throw new Error(`event log entry is owned by another user: ${path}`);
  }
  if (info.nlink > 1) {
    await handle.close().catch(() => {});
    throw new Error(`event log entry is a hard-link alias: ${path}`);
  }
  return handle;
}

async function readSecure(path: string): Promise<string> {
  const handle = await openRegular(path, fsConstants.O_RDONLY);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()); }
  finally { await handle.close().catch(() => {}); }
}

async function writeExclusive(path: string, contents: string, mode = 0o600): Promise<void> {
  const handle = await openRegular(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
  try { await handle.writeFile(contents, "utf8"); await handle.chmod(mode); }
  finally { await handle.close().catch(() => {}); }
}

async function appendSecure(path: string, contents: string): Promise<void> {
  const handle = await openRegular(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
  try { await handle.writeFile(contents, "utf8"); await handle.chmod(0o600); }
  finally { await handle.close().catch(() => {}); }
}

async function writeExistingSecure(path: string, contents: string): Promise<void> {
  const handle = await openRegular(path, fsConstants.O_WRONLY | fsConstants.O_TRUNC);
  try { await handle.writeFile(contents, "utf8"); await handle.chmod(0o600); }
  finally { await handle.close().catch(() => {}); }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactEvent<T extends Omit<SupervisorEvent, "seq" | "at">>(event: T): T {
  return redactSensitive(event) as T;
}
