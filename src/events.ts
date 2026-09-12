import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

export class EventLog {
  #seq = 0;
  #initialized = false;
  readonly #path?: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path?: string) {
    this.#path = path;
  }

  async append(event: Omit<SupervisorEvent, "seq" | "at">): Promise<SupervisorEvent> {
    const operation = this.#writeTail.then(async () => {
      return this.#path
        ? this.#withFileLock(async () => {
            await this.#initialize();
            await this.#refreshSequence();
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
        await writeFile(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
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
      let owner: { pid?: unknown };
      try {
        owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")) as { pid?: unknown };
      } catch {
        await rm(lockPath, { recursive: true, force: true });
        return true;
      }
      if (typeof owner.pid === "number") {
        try {
          process.kill(owner.pid, 0);
          return false;
        } catch (error) {
          if (error instanceof Error && /EPERM/u.test(error.message)) return false;
        }
      }
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
    await this.#refreshSequence();
  }

  async #refreshSequence(): Promise<void> {
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
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactEvent<T extends Omit<SupervisorEvent, "seq" | "at">>(event: T): T {
  return redactValue(event, undefined) as T;
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string") {
    if (key && /(password|secret|token|api[-_]?key|authorization|credential)/iu.test(key)) return "[REDACTED]";
    return value
      .replace(/\b(sk-ant-[A-Za-z0-9_-]+)\b/gu, "[REDACTED]")
      .replace(/\b(Bearer\s+)[^\s]+/giu, "$1[REDACTED]")
      .replace(/\b((?:ANTHROPIC|OPENAI|AWS)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET))=([^\s]+)/gu, "$1=[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactValue(childValue, childKey)]));
  }
  return value;
}
