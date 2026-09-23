import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { currentLockOwner, lockOwnerAlive } from "./lock-owner.ts";
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
    if (this.#path) {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await appendFile(this.#path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      await chmod(this.#path, 0o600);
    }
    return entry;
  }

  async #withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#path) return operation();
    const lockPath = `${this.#path}.lock`;
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(lockPath);
        await writeFile(`${lockPath}/owner.json`, JSON.stringify(await currentLockOwner()));
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
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async #removeStaleLock(lockPath: string): Promise<boolean> {
    try {
      const info = await stat(`${lockPath}/owner.json`);
      if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
      let owner: unknown;
      try {
        owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8"));
      } catch {
        await rm(lockPath, { recursive: true, force: true });
        return true;
      }
      if (await lockOwnerAlive(owner)) return false;
      await rm(lockPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) {
        try {
          const lockInfo = await stat(lockPath);
          if (Date.now() - lockInfo.mtimeMs >= STALE_LOCK_MS) {
            await rm(lockPath, { recursive: true, force: true });
            return true;
          }
        } catch {
          return true;
        }
      }
      return false;
    }
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
      const contents = await readFile(this.#path, "utf8");
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
        await writeFile(this.#path, repaired, { mode: 0o600 });
        await chmod(this.#path, 0o600);
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
      size = (await stat(this.#path)).size;
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
      const handle = await open(this.#path, "r");
      try {
        const buffer = Buffer.alloc(window);
        const { bytesRead } = await handle.read(buffer, 0, window, start);
        text = buffer.subarray(0, bytesRead).toString("utf8");
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
      size = (await stat(this.#path)).size;
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
        entryStat = await stat(join(dir, name));
      } catch {
        continue;
      }
      if (!entryStat.isFile()) continue;
      rotated.push(name);
    }
    rotated.sort();
    const toRemove = rotated.slice(0, Math.max(0, rotated.length - this.#keepRotated));
    for (const name of toRemove) {
      await rm(join(dir, name), { force: true });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactEvent<T extends Omit<SupervisorEvent, "seq" | "at">>(event: T): T {
  return redactSensitive(event) as T;
}
