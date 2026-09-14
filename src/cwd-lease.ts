import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redactSensitive } from "./redaction.ts";

export type CwdLeaseTransport = "process-pipe" | "jsonl" | "pty" | "tmux";

export interface CwdLeaseWorker {
  transport: CwdLeaseTransport;
  pid?: number;
  startTime?: string;
  sessionName?: string;
  tmuxSocket?: string;
  ownership?: "owned" | "adopted";
  cgroupPath?: string;
  tmuxTarget?: string;
  tmuxPaneId?: string;
  paneStartTime?: string;
  paneCommand?: string;
}

export interface CwdLeaseRecord {
  version: 1;
  leaseId: string;
  taskId: string;
  cwd: string;
  ownerPid: number;
  ownerStartTime?: string;
  acquiredAt: string;
  updatedAt: string;
  worker?: CwdLeaseWorker;
}

export interface CwdLeaseHandoff {
  sessionName: string;
  tmuxSocket?: string;
}

/**
 * Explicit recovery takeover. This is intentionally separate from ordinary
 * acquisition: an old Pi owner may have died while its Worker survived.
 */
export interface CwdLeaseTakeover {
  taskId: string;
  /** Run before the old lease is removed; failure leaves the old lease intact. */
  beforeReplace?: (lease: CwdLeaseRecord) => Promise<void>;
}

export interface CwdLeaseAcquireOptions {
  handoff?: CwdLeaseHandoff;
  takeover?: CwdLeaseTakeover;
}

export interface CwdLeaseHandle {
  readonly record: CwdLeaseRecord;
  /** Task id whose lease was explicitly handed off/taken over, if any. */
  readonly replacedTaskId?: string;
  updateWorker(worker: CwdLeaseWorker): Promise<void>;
  release(): Promise<void>;
}

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5_000;

/**
 * Cross-process working-directory lease registry.
 *
 * A lease is deliberately not reclaimed merely because its owner process died:
 * a worker may have survived the Pi process. The operator must clean up an
 * unconfirmed lease explicitly after verifying the old worker is gone.
 */
export class CwdLeaseStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  get directory(): string {
    return this.#directory;
  }

  async acquire(cwd: string, taskId: string, transport: CwdLeaseTransport, options: CwdLeaseAcquireOptions = {}): Promise<CwdLeaseHandle> {
    assertTaskId(taskId);
    if (options.takeover) assertTaskId(options.takeover.taskId);
    const canonicalCwd = await realpath(resolve(cwd));
    const now = new Date().toISOString();
    const lease: CwdLeaseRecord = {
      version: 1,
      leaseId: randomUUID(),
      taskId,
      cwd: canonicalCwd,
      ownerPid: process.pid,
      ownerStartTime: await processStartTime(process.pid),
      acquiredAt: now,
      updatedAt: now,
      worker: { transport },
    };
    let replacedTaskId: string | undefined;
    await this.#withLock(async () => {
      const leases = await this.#readAll();
      let handoffLease: CwdLeaseRecord | undefined;
      for (const existing of leases) {
        if (options.handoff && existing.cwd === canonicalCwd && await matchesHandoff(existing, options.handoff)) {
          if (handoffLease) throw new Error("multiple matching tmux cwd leases; refusing ambiguous handoff");
          handoffLease = existing;
          lease.worker = { ...existing.worker!, transport };
          continue;
        }
        if (!pathsOverlap(existing.cwd, canonicalCwd)) continue;
        if (options.takeover?.taskId === existing.taskId
          && existing.cwd === canonicalCwd
          && await canTakeoverLease(existing)) {
          await options.takeover.beforeReplace?.(existing);
          replacedTaskId = existing.taskId;
          await rm(this.#path(existing.leaseId), { force: true });
          continue;
        }
        throw new Error(`working-directory lease is held by task ${existing.taskId}: ${redactText(existing.cwd)}`);
      }
      await this.#write(lease);
      if (handoffLease) {
        replacedTaskId = handoffLease.taskId;
        await rm(this.#path(handoffLease.leaseId), { force: true });
      }
    });
    return this.#handle(lease, replacedTaskId);
  }

  async list(): Promise<CwdLeaseRecord[]> {
    return this.#withLock(() => this.#readAll());
  }

  #handle(initial: CwdLeaseRecord, replacedTaskId?: string): CwdLeaseHandle {
    let current = { ...initial, worker: initial.worker ? { ...initial.worker } : undefined };
    let released = false;
    return {
      get record() { return current; },
      get replacedTaskId() { return replacedTaskId; },
      updateWorker: async (worker) => {
        if (released) throw new Error("cwd lease has already been released");
        assertWorker(worker);
        const next = { ...current, worker: { ...worker }, updatedAt: new Date().toISOString() };
        await this.#withLock(async () => {
          const leases = await this.#readAll();
          const existing = leases.find((lease) => lease.leaseId === current.leaseId);
          if (!existing) throw new Error("cwd lease disappeared before worker identity could be recorded");
          if (existing.cwd !== current.cwd || existing.taskId !== current.taskId) throw new Error("cwd lease identity changed; refusing update");
          await this.#write(next);
        });
        current = next;
      },
      release: async () => {
        if (released) return;
        await this.#withLock(async () => {
          const leases = await this.#readAll();
          const existing = leases.find((lease) => lease.leaseId === current.leaseId);
          if (!existing) throw new Error("cwd lease disappeared before release");
          await rm(this.#path(existing.leaseId), { force: true });
        });
        released = true;
      },
    };
  }

  async #readAll(): Promise<CwdLeaseRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) return [];
      throw error;
    }
    const leases: CwdLeaseRecord[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const leasePath = join(this.#directory, name);
      const leaseInfo = await lstat(leasePath);
      if (!leaseInfo.isFile()) throw new Error(`cwd lease entry is not a regular file: ${redactText(leasePath)}`);
      const value = JSON.parse(await readFile(leasePath, "utf8")) as Partial<CwdLeaseRecord>;
      const lease = normalizeLease(value);
      // A missing or replaced cwd invalidates the registry evidence. Do not
      // silently drop that record and allow a second worker to start.
      lease.cwd = await realpath(lease.cwd);
      leases.push(lease);
    }
    return leases;
  }

  async #write(lease: CwdLeaseRecord): Promise<void> {
    await this.#ensureDirectory();
    const target = this.#path(lease.leaseId);
    const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(lease, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  #path(leaseId: string): string {
    return join(this.#directory, `${leaseId}.json`);
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.#ensureDirectory();
    const lockPath = join(this.#directory, ".lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(lockPath);
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          startTime: await processStartTime(process.pid),
          at: new Date().toISOString(),
        }), { mode: 0o600 });
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/EEXIST/u.test(error.message)) throw error;
        if (await removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) throw new Error(`cwd lease lock timeout: ${redactText(lockPath)}`);
        await delay(25);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory()) throw new Error(`cwd lease registry is not a directory: ${redactText(this.#directory)}`);
    await chmod(this.#directory, 0o700);
  }
}

export function pathsOverlap(first: string, second: string): boolean {
  const left = resolve(first);
  const right = resolve(second);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export async function workerIdentity(worker: Pick<CwdLeaseWorker, "pid" | "cgroupPath" | "tmuxTarget" | "tmuxPaneId" | "paneStartTime" | "paneCommand">): Promise<Pick<CwdLeaseWorker, "pid" | "startTime" | "cgroupPath" | "tmuxTarget" | "tmuxPaneId" | "paneStartTime" | "paneCommand">> {
  return {
    pid: worker.pid,
    startTime: worker.pid ? await processStartTime(worker.pid) : undefined,
    cgroupPath: worker.cgroupPath,
    tmuxTarget: worker.tmuxTarget,
    tmuxPaneId: worker.tmuxPaneId,
    paneStartTime: worker.paneStartTime,
    paneCommand: worker.paneCommand,
  };
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockInfo = await lstat(lockPath);
    if (!lockInfo.isDirectory()) throw new Error("cwd lease lock is not a directory");
    const ownerPath = join(lockPath, "owner.json");
    const ownerInfo = await lstat(ownerPath);
    if (!ownerInfo.isFile()) throw new Error("cwd lease lock owner is not a regular file");
    const info = await stat(ownerPath);
    if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown; startTime?: unknown };
    if (typeof owner.pid === "number") {
      const currentStart = await processStartTime(owner.pid);
      if (currentStart && typeof owner.startTime === "string" && currentStart === owner.startTime) return false;
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
    if (error instanceof Error && /ENOENT/u.test(error.message)) return true;
    return false;
  }
}

async function processIdentityLive(pid: number, expectedStartTime?: string): Promise<boolean> {
  const currentStartTime = await processStartTime(pid);
  if (currentStartTime && expectedStartTime) return currentStartTime === expectedStartTime;
  if (currentStartTime) return true;
  return processExists(pid);
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && /EPERM/u.test(error.message);
  }
}

async function processGroupExists(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && /EPERM/u.test(error.message);
  }
}

async function cgroupHasProcesses(path: string): Promise<boolean> {
  // Lease files are untrusted state. Never read an arbitrary path during
  // takeover; only a real, canonical cgroup below the kernel cgroup root is
  // eligible for this check. Missing/unreadable evidence is not proof of an
  // empty cgroup: a descendant may have escaped before the cgroup disappeared.
  const cgroupRoot = resolve("/sys/fs/cgroup");
  const cgroupPath = resolve(path);
  if (cgroupPath === cgroupRoot || !cgroupPath.startsWith(`${cgroupRoot}/`)) return true;
  try {
    const cgroupInfo = await lstat(cgroupPath);
    if (!cgroupInfo.isDirectory() || cgroupInfo.isSymbolicLink()) return true;
    const canonicalPath = await realpath(cgroupPath);
    if (canonicalPath !== cgroupPath || !canonicalPath.startsWith(`${cgroupRoot}/`)) return true;
    const procsPath = join(canonicalPath, "cgroup.procs");
    const procsInfo = await lstat(procsPath);
    if (!procsInfo.isFile() || procsInfo.isSymbolicLink()) return true;
    const contents = await readFile(procsPath, "utf8");
    return contents.split(/\s+/u).some((pid) => /^\d+$/u.test(pid));
  } catch {
    return true;
  }
}

async function canTakeoverLease(lease: CwdLeaseRecord): Promise<boolean> {
  // The old supervisor owner must be gone. A dead owner is not enough when
  // the detached Worker itself is still alive.
  if (await processExists(lease.ownerPid)) return false;
  const worker = lease.worker;
  if (!worker) return false;
  if (worker.transport === "tmux") return false;
  if (!worker.pid) return false;
  if (await processExists(worker.pid)) return false;
  if (await processGroupExists(worker.pid)) return false;
  // A process-group check cannot see a setsid descendant. Explicit takeover
  // therefore requires the verified cgroup boundary used by the adapter.
  if (!worker.cgroupPath || !resolve(worker.cgroupPath).startsWith(`${resolve("/sys/fs/cgroup")}/`)) return false;
  if (await cgroupHasProcesses(worker.cgroupPath)) return false;
  return true;
}

async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    const fields = closeParen >= 0 ? statText.slice(closeParen + 2).trim().split(/\s+/u) : [];
    const startTime = fields[19];
    return startTime && /^\d+$/u.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

async function matchesHandoff(lease: CwdLeaseRecord, handoff: CwdLeaseHandoff): Promise<boolean> {
  const worker = lease.worker;
  if (worker?.transport !== "tmux"
    || worker.sessionName !== handoff.sessionName
    || worker.tmuxSocket !== handoff.tmuxSocket
    || worker.tmuxTarget !== handoff.sessionName
    || !worker.pid
    || !worker.startTime
    || !worker.tmuxPaneId
    || !worker.paneStartTime
    || !worker.paneCommand) return false;
  // A live owner is still an active supervisor. Do not let another Pi consume
  // its lease merely because the tmux session name is known.
  return !(await processIdentityLive(lease.ownerPid, lease.ownerStartTime));
}

function assertTaskId(taskId: string): void {
  if (!/^[0-9a-f-]{36}$/iu.test(taskId)) throw new Error("invalid cwd lease task id");
}

function assertWorker(worker: CwdLeaseWorker): void {
  if (!["process-pipe", "jsonl", "pty", "tmux"].includes(worker.transport)
    || (worker.pid !== undefined && (!Number.isSafeInteger(worker.pid) || worker.pid < 1))
    || (worker.startTime !== undefined && !/^\d+$/u.test(worker.startTime))
    || (worker.tmuxPaneId !== undefined && !/^%\d+$/u.test(worker.tmuxPaneId))
    || (worker.cgroupPath !== undefined && !worker.cgroupPath.startsWith("/"))) {
    throw new Error("invalid cwd lease worker identity");
  }
}

function normalizeLease(value: Partial<CwdLeaseRecord>): CwdLeaseRecord {
  if (value.version !== 1 || typeof value.leaseId !== "string" || !/^[0-9a-f-]{36}$/iu.test(value.leaseId)
    || typeof value.taskId !== "string" || !/^[0-9a-f-]{36}$/iu.test(value.taskId)
    || typeof value.cwd !== "string" || !value.cwd.startsWith("/")
    || !Number.isSafeInteger(value.ownerPid) || (value.ownerPid ?? 0) < 1
    || typeof value.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt))
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.ownerStartTime !== undefined && (typeof value.ownerStartTime !== "string" || !/^\d+$/u.test(value.ownerStartTime)))) {
    throw new Error("invalid cwd lease record");
  }
  const worker = value.worker;
  if (worker && (typeof worker !== "object" || !["process-pipe", "jsonl", "pty", "tmux"].includes(worker.transport as string))) throw new Error("invalid cwd lease worker identity");
  const ownerPid = value.ownerPid!;
  return {
    version: 1,
    leaseId: value.leaseId,
    taskId: value.taskId,
    cwd: resolve(value.cwd),
    ownerPid,
    ownerStartTime: typeof value.ownerStartTime === "string" ? value.ownerStartTime : undefined,
    acquiredAt: value.acquiredAt,
    updatedAt: value.updatedAt,
    worker: worker ? {
      transport: worker.transport!,
      pid: Number.isSafeInteger(worker.pid) && worker.pid! > 0 ? worker.pid : undefined,
      startTime: typeof worker.startTime === "string" && /^\d+$/u.test(worker.startTime) ? worker.startTime : undefined,
      sessionName: typeof worker.sessionName === "string" ? worker.sessionName : undefined,
      tmuxSocket: typeof worker.tmuxSocket === "string" ? worker.tmuxSocket : undefined,
      ownership: worker.ownership === "owned" || worker.ownership === "adopted" ? worker.ownership : undefined,
      cgroupPath: typeof worker.cgroupPath === "string" ? worker.cgroupPath : undefined,
      tmuxTarget: typeof worker.tmuxTarget === "string" ? worker.tmuxTarget : undefined,
      tmuxPaneId: typeof worker.tmuxPaneId === "string" && /^%\d+$/u.test(worker.tmuxPaneId) ? worker.tmuxPaneId : undefined,
      paneStartTime: typeof worker.paneStartTime === "string" ? worker.paneStartTime : undefined,
      paneCommand: typeof worker.paneCommand === "string" ? worker.paneCommand : undefined,
    } : undefined,
  };
}

function redactText(value: string): string {
  return String(redactSensitive(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
