import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, stat, writeFile, rename } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { redactSensitive } from "./redaction.ts";

export type CwdLeaseTransport = "process-pipe" | "jsonl" | "pty" | "tmux";

export interface CwdLeaseWorker {
  transport: CwdLeaseTransport;
  pid?: number;
  startTime?: string;
  sessionName?: string;
  tmuxSocket?: string;
  ownership?: "owned" | "adopted";
  workerId?: string;
  cgroupPath?: string;
  cgroupIdentity?: { device: string; inode: string };
  retainCgroupUntilLeaseRelease?: boolean;
  tmuxServerPid?: number;
  tmuxServerStartTime?: string;
  tmuxTarget?: string;
  tmuxPaneId?: string;
  paneStartTime?: string;
  paneCommand?: string;
}

export interface CwdLeaseCleanup {
  /** prepared = old record; replacement = new task record in the same file. */
  phase: "prepared" | "replacement";
  transport: CwdLeaseTransport;
  workerId: string;
  cgroupPath: string;
  cgroupIdentity: { device: string; inode: string };
  /** Set only after the verified cgroup directory has been removed. */
  cgroupCleaned?: boolean;
  sessionName?: string;
  tmuxSocket?: string;
  tmuxServerPid?: number;
  tmuxServerStartTime?: string;
  socketMarkerIdentity?: { device: string; inode: string };
  /** Startup recovery may have no tmux server identity before the server is recorded. */
  startupResource?: boolean;
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
  /** Automatic adapter startup has not yet persisted its final pre-spawn identity. */
  pendingStartup?: { transport: CwdLeaseTransport };
  /** Durable takeover transaction state; never start a new Worker while set. */
  pendingCleanup?: CwdLeaseCleanup;
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
  /** Run before the replacement is committed; failure leaves the old lease intact. */
  beforeReplace?: (lease: CwdLeaseRecord) => Promise<void>;
}

export interface CwdLeaseAcquireOptions {
  handoff?: CwdLeaseHandoff;
  takeover?: CwdLeaseTakeover;
  /** Persist the no-spawn startup phase as part of lease acquisition. */
  startup?: boolean;
}

export interface CwdLeaseHandle {
  readonly record: CwdLeaseRecord;
  /** Task id whose lease was explicitly handed off/taken over, if any. */
  readonly replacedTaskId?: string;
  updateWorker(worker: CwdLeaseWorker, options?: { preserveStartup?: boolean }): Promise<void>;
  release(): Promise<void>;
}

type LockIdentity = {
  device: number;
  inode: number;
  token: string;
};

type SocketReservation = {
  identity: { device: string; inode: string };
  release(): Promise<boolean>;
};

type TakeoverProof = {
  /** Undefined for a durable pre-spawn lease reclaim with no Worker yet. */
  pendingCleanup?: CwdLeaseCleanup;
  startupOnly?: boolean;
  reserve(): Promise<boolean>;
  cleanup(): Promise<boolean>;
  release(): Promise<boolean>;
};

type TakeoverTransaction = {
  proof: TakeoverProof;
  replacementWritten: boolean;
  cleanupFinalized: boolean;
};

const execFileAsync = promisify(execFile);
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
      ...(options.startup ? { pendingStartup: { transport } } : {}),
    };
    let replacedTaskId: string | undefined;
    const takeoverTransactions: TakeoverTransaction[] = [];
    try {
      await this.#withLock(async () => {
        const leases = await this.#readAll();
        let handoffLease: CwdLeaseRecord | undefined;
        let takeoverLease: CwdLeaseRecord | undefined;
        let takeoverProof: TakeoverProof | undefined;
        for (const existing of leases) {
          if (options.handoff && existing.cwd === canonicalCwd && !existing.pendingCleanup && await matchesHandoff(existing, options.handoff)) {
            if (handoffLease) throw new Error("multiple matching tmux cwd leases; refusing ambiguous handoff");
            handoffLease = existing;
            // Adopt in place so a crash cannot leave both the old and new
            // overlapping lease records between write and deletion.
            lease.leaseId = existing.leaseId;
            lease.worker = { ...existing.worker!, transport };
            if (options.startup) lease.pendingStartup = { transport };
            else delete lease.pendingStartup;
            continue;
          }
          if (!pathsOverlap(existing.cwd, canonicalCwd)) continue;
          if (options.takeover?.taskId === existing.taskId
            && existing.cwd === canonicalCwd
            && !existing.pendingCleanup) {
            const proof = await canTakeoverLease(existing);
            if (proof) {
              if (takeoverLease) throw new Error("multiple matching cwd leases; refusing ambiguous takeover");
              takeoverLease = existing;
              takeoverProof = proof;
              continue;
            }
          }
          throw new Error(`working-directory lease is held by task ${existing.taskId}: ${redactText(existing.cwd)}`);
        }
        if (takeoverLease && takeoverProof) {
          if (takeoverProof.startupOnly) {
            // Startup recovery proved that no adapter-owned resource remains
            // (the planned cgroup/socket were either never created or are
            // already gone). A replacement can be committed in place without
            // inventing a cleanup proof.
            try {
              await options.takeover!.beforeReplace?.(takeoverLease);
            } catch (error) {
              await this.#write(takeoverLease).catch(() => {});
              throw error;
            }
            lease.leaseId = takeoverLease.leaseId;
            lease.pendingStartup = { transport };
            replacedTaskId = takeoverLease.taskId;
            await this.#write(lease);
          } else {
            const pendingCleanup = takeoverProof.pendingCleanup;
            if (!pendingCleanup) throw new Error("automatic takeover cleanup proof is incomplete");
            const transaction: TakeoverTransaction = { proof: takeoverProof, replacementWritten: false, cleanupFinalized: false };
            takeoverTransactions.push(transaction);

            // Persist the transaction before reserving the socket. If the
            // Supervisor dies in any later startup window, the next lease
            // reader can verify and finish this cleanup instead of losing
            // the recovery evidence.
            await this.#write({ ...takeoverLease, pendingCleanup, updatedAt: new Date().toISOString() });
            if (!await takeoverProof.reserve()) throw new Error(`working-directory lease is held by task ${takeoverLease.taskId}: automatic takeover socket reservation failed`);
            // Persist the marker identity immediately after mkdir. Recovery
            // refuses to remove an unbound directory, so a failure in this
            // write is fail-closed rather than silently guessing ownership.
            await this.#write({ ...takeoverLease, pendingCleanup, updatedAt: new Date().toISOString() });
            try {
              await options.takeover!.beforeReplace?.(takeoverLease);
            } catch (error) {
              // Restore the active record when the hook rejects. If the
              // restore itself fails, the pending transaction remains the
              // safer durable state and will be reconciled on the next read.
              await this.#write(takeoverLease).catch(() => {});
              throw error;
            }

            // Reuse the old filename and replace it atomically. There is
            // never a durable interval with two overlapping cwd leases.
            pendingCleanup.phase = "replacement";
            lease.leaseId = takeoverLease.leaseId;
            lease.pendingCleanup = pendingCleanup;
            replacedTaskId = takeoverLease.taskId;
            await this.#write(lease);
            transaction.replacementWritten = true;

            // The cgroup/socket cleanup occurs only after the replacement
            // lease is durable. Keep pendingCleanup until every cleanup
            // proof is complete so a crash can resume it safely.
            if (!await takeoverProof.cleanup()) {
              throw new Error("automatic takeover cleanup remains pending; refusing Worker startup");
            }
            // Persist the cleanup stage before releasing the socket marker. If
            // the process dies after cgroup removal, recovery can distinguish
            // our verified removal from an unexplained missing cgroup.
            pendingCleanup.cgroupCleaned = true;
            await this.#write(lease);
            if (!await takeoverProof.release()) {
              throw new Error("automatic takeover cleanup remains pending; refusing Worker startup");
            }
            delete lease.pendingCleanup;
            await this.#write(lease);
            transaction.cleanupFinalized = true;
          }
        } else {
          await this.#write(lease);
          if (handoffLease) replacedTaskId = handoffLease.taskId;
        }
      });
    } finally {
      await Promise.allSettled(takeoverTransactions.map((transaction) => {
        if (transaction.replacementWritten && !transaction.cleanupFinalized) return Promise.resolve(true);
        return transaction.proof.release();
      }));
    }
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
      updateWorker: async (worker, options = {}) => {
        if (released) throw new Error("cwd lease has already been released");
        assertWorker(worker);
        const next = {
          ...current,
          worker: { ...worker },
          ...(options.preserveStartup && current.pendingStartup ? { pendingStartup: current.pendingStartup } : { pendingStartup: undefined }),
          updatedAt: new Date().toISOString(),
        };
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
          if (existing.cwd !== current.cwd || existing.taskId !== current.taskId) throw new Error("cwd lease identity changed; refusing release");
          if (existing.worker?.retainCgroupUntilLeaseRelease) await releaseRetainedCgroup(existing.worker);
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
      let lease = normalizeLease(value);
      if (lease.pendingCleanup) {
        // A takeover transaction is not usable until the old cgroup/session
        // and any socket marker have been independently confirmed clean.
        const cgroupCleanedBefore = lease.pendingCleanup.cgroupCleaned === true;
        let cleanupComplete = await cleanupPendingLease(lease.pendingCleanup);
        // Reconciliation may have removed the cgroup successfully but failed
        // on a later marker operation. Persist that stage before returning a
        // still-pending record, so the next reader can continue fail-closed.
        if (!cgroupCleanedBefore && lease.pendingCleanup.cgroupCleaned === true) {
          await this.#write({ ...lease, updatedAt: new Date().toISOString() });
          // The first pass deliberately stops before socket-marker removal;
          // the cleanup stage must be durable before that second proof.
          cleanupComplete = await cleanupPendingLease(lease.pendingCleanup);
        }
        if (cleanupComplete) {
          if (lease.pendingCleanup.phase === "replacement") {
            // The replacement is the live lease after recovery. Clear only
            // its transaction marker; do not delete the cwd reservation.
            delete lease.pendingCleanup;
            await this.#write(lease);
          } else {
            // The old record was still in the preparation phase, so no new
            // Worker lease exists to retain after cleanup.
            await rm(leasePath, { force: true });
            continue;
          }
        }
      }
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
    const lockToken = randomUUID();
    let lockIdentity: LockIdentity | undefined;
    while (true) {
      try {
        await mkdir(lockPath);
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          startTime: await processStartTime(process.pid),
          token: lockToken,
          at: new Date().toISOString(),
        }), { mode: 0o600 });
        const acquired = await lstat(lockPath);
        if (!acquired.isDirectory()) throw new Error("cwd lease lock is not a directory");
        lockIdentity = { device: acquired.dev, inode: acquired.ino, token: lockToken };
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
      if (lockIdentity) await removeOwnedLock(lockPath, lockIdentity);
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

type WorkerIdentityInput = Pick<CwdLeaseWorker, "pid" | "cgroupPath" | "tmuxTarget" | "tmuxPaneId" | "paneStartTime" | "paneCommand" | "tmuxServerPid" | "tmuxServerStartTime" | "cgroupIdentity" | "workerId" | "retainCgroupUntilLeaseRelease"> & { id?: string };

type WorkerIdentityResult = Pick<CwdLeaseWorker, "workerId" | "pid" | "startTime" | "cgroupPath" | "cgroupIdentity" | "tmuxServerPid" | "tmuxServerStartTime" | "tmuxTarget" | "tmuxPaneId" | "paneStartTime" | "paneCommand" | "retainCgroupUntilLeaseRelease">;

export async function workerIdentity(worker: WorkerIdentityInput): Promise<WorkerIdentityResult> {
  const cgroupIdentity = worker.cgroupPath ? await readCgroupIdentity(worker.cgroupPath) : undefined;
  return {
    workerId: worker.workerId ?? worker.id,
    pid: worker.pid,
    startTime: worker.pid ? await processStartTime(worker.pid) : undefined,
    cgroupPath: worker.cgroupPath,
    cgroupIdentity,
    retainCgroupUntilLeaseRelease: worker.retainCgroupUntilLeaseRelease,
    tmuxServerPid: worker.tmuxServerPid,
    tmuxServerStartTime: worker.tmuxServerStartTime,
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
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown; startTime?: unknown; token?: unknown };
    if (typeof owner.token !== "string" || owner.token.length === 0) return false;
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

    // Never recursively remove the path that was inspected. Move exactly that
    // lock-directory instance to a private quarantine name first; another
    // acquirer may create a new lock at lockPath while quarantine is removed.
    // The inode and optional owner token bind cleanup to the observed owner.
    const quarantine = `${lockPath}.reap-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockPath, quarantine);
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) return true;
      return false;
    }
    try {
      const restore = () => rename(quarantine, lockPath).catch(() => {});
      const quarantinedInfo = await lstat(quarantine);
      if (!quarantinedInfo.isDirectory() || quarantinedInfo.dev !== lockInfo.dev || quarantinedInfo.ino !== lockInfo.ino) {
        await restore();
        return false;
      }
      const quarantinedOwner = JSON.parse(await readFile(join(quarantine, "owner.json"), "utf8")) as { token?: unknown };
      if (quarantinedOwner.token !== owner.token) {
        await restore();
        return false;
      }
      await rm(quarantine, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) return true;
      return false;
    }
  } catch (error) {
    if (error instanceof Error && /ENOENT/u.test(error.message)) return true;
    return false;
  }
}

async function removeOwnedLock(lockPath: string, identity: LockIdentity): Promise<void> {
  // Rename the exact directory instance away before deleting it. A check
  // followed by recursive rm would let a waiter replace the path between the
  // two syscalls and could delete the waiter's new lock.
  const quarantine = `${lockPath}.release-${process.pid}-${randomUUID()}`;
  try {
    const current = await lstat(lockPath);
    if (!current.isDirectory() || current.dev !== identity.device || current.ino !== identity.inode) return;
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { token?: unknown };
    if (owner.token !== identity.token) return;
    await rename(lockPath, quarantine);
    const restore = () => rename(quarantine, lockPath).catch(() => {});
    const quarantined = await lstat(quarantine);
    if (!quarantined.isDirectory() || quarantined.dev !== identity.device || quarantined.ino !== identity.inode) {
      await restore();
      return;
    }
    const quarantinedOwner = JSON.parse(await readFile(join(quarantine, "owner.json"), "utf8")) as { token?: unknown };
    if (quarantinedOwner.token !== identity.token) {
      await restore();
      return;
    }
    await rm(quarantine, { recursive: true, force: true });
  } catch {
    // Another process may already have quarantined or removed this instance.
    // Any uncertain ownership is intentionally left for stale-lock handling.
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
    const canonicalPath = await canonicalCgroupPath(cgroupPath);
    if (!canonicalPath.startsWith(`${cgroupRoot}/`)) return true;
    const eventsPath = join(canonicalPath, "cgroup.events");
    const eventsInfo = await lstat(eventsPath);
    if (!eventsInfo.isFile() || eventsInfo.isSymbolicLink()) return true;
    if (!/^populated 0$/mu.test(await readFile(eventsPath, "utf8"))) return true;
    const procsPath = join(canonicalPath, "cgroup.procs");
    const procsInfo = await lstat(procsPath);
    if (!procsInfo.isFile() || procsInfo.isSymbolicLink()) return true;
    const contents = await readFile(procsPath, "utf8");
    return contents.split(/\s+/u).some((pid) => /^\d+$/u.test(pid));
  } catch {
    return true;
  }
}

async function canTakeoverLease(lease: CwdLeaseRecord): Promise<TakeoverProof | undefined> {
  // The old supervisor owner must be gone. A dead owner is not enough when
  // the detached Worker itself is still alive. Compare start time as well as
  // PID so a reused PID cannot be mistaken for the recorded owner.
  if (lease.pendingCleanup || await processIdentityLive(lease.ownerPid, lease.ownerStartTime)) return undefined;
  const worker = lease.worker;
  if (lease.pendingStartup && lease.pendingStartup.transport === worker?.transport
    && !worker.workerId && !worker.cgroupPath && worker.pid === undefined) {
    // The startup callback has not even persisted the adapter's planned
    // resource identity, so no adapter-owned cgroup/session can exist yet.
    return startupOnlyTakeoverProof();
  }
  if (!worker) return undefined;

  // The adapter persists a generated cgroup path before creating it, then
  // persists its inode after creation. If recovery sees the marker during that
  // interval, inspect and clean the planned resource rather than assuming it
  // does not exist. Tmux may also have a server without its identity callback
  // having completed, so its private session/socket are checked here too.
  if (lease.pendingStartup && lease.pendingStartup.transport === worker.transport
    && worker.workerId && worker.cgroupPath && worker.pid === undefined
    && (!worker.cgroupIdentity || (worker.transport === "tmux" && !worker.tmuxServerPid && !worker.tmuxServerStartTime))) {
    return startupResourceTakeoverProof(worker);
  }

  // A provisional automatic identity is persisted before spawn and has no
  // leader PID yet. Its generated cgroup is the cleanup boundary; a populated
  // boundary still blocks takeover. Once a PID exists, retain the stronger
  // process and process-group identity checks as well.
  if (worker.pid !== undefined) {
    if (await processExists(worker.pid)) return undefined;
    if (await processGroupExists(worker.pid)) return undefined;
  } else if (!worker.retainCgroupUntilLeaseRelease) {
    return undefined;
  }
  if (worker.tmuxServerPid && worker.tmuxServerStartTime && await processIdentityLive(worker.tmuxServerPid, worker.tmuxServerStartTime)) return undefined;
  // A process-group check cannot see a setsid descendant. Explicit takeover
  // therefore requires the verified cgroup boundary used by the adapter.
  if (!worker.workerId || !worker.cgroupPath || !isCgroupPath(worker.cgroupPath)
    || !matchesGeneratedCgroupName(worker.cgroupPath, worker.transport, worker.workerId)
    || !worker.cgroupIdentity) return undefined;
  if (!await cgroupIdentityMatches(worker.cgroupPath, worker.cgroupIdentity)) return undefined;
  if (await cgroupHasProcesses(worker.cgroupPath)) return undefined;

  const pendingCleanup: CwdLeaseCleanup = {
    phase: "prepared",
    transport: worker.transport,
    workerId: worker.workerId,
    cgroupPath: worker.cgroupPath,
    cgroupIdentity: worker.cgroupIdentity,
  };
  if (worker.transport === "tmux") {
    // Only Supervisor-owned automatic sessions may be reclaimed. Adopted
    // native TUI sessions intentionally remain human-owned and require an
    // explicit identity-bound handoff instead.
    if (worker.ownership !== "owned"
      || worker.sessionName !== `pi-supervisor-${worker.workerId}`
      || !worker.tmuxSocket
      || basename(resolve(worker.tmuxSocket)) !== `pi-cs-${worker.workerId}.sock`
      || !worker.tmuxServerPid
      || !worker.tmuxServerStartTime
      || !await tmuxSessionGone(worker.tmuxSocket, worker.sessionName)) return undefined;
    pendingCleanup.sessionName = worker.sessionName;
    pendingCleanup.tmuxSocket = worker.tmuxSocket;
    pendingCleanup.tmuxServerPid = worker.tmuxServerPid;
    pendingCleanup.tmuxServerStartTime = worker.tmuxServerStartTime;
    let reservation: SocketReservation | undefined;
    return {
      pendingCleanup,
      reserve: async () => {
        reservation = await reserveTmuxSocket(worker.tmuxSocket!);
        if (!reservation) return false;
        pendingCleanup.socketMarkerIdentity = reservation.identity;
        return true;
      },
      cleanup: async () => removeEmptyCgroup(worker.cgroupPath!, worker.cgroupIdentity!),
      release: async () => reservation ? reservation.release() : true,
    };
  }
  // The guarded automatic process bootstrap follows the same contract as the
  // tmux guardian after a parent death: it leaves an empty cgroup for recovery.
  return {
    pendingCleanup,
    reserve: async () => true,
    cleanup: async () => removeEmptyCgroup(worker.cgroupPath!, worker.cgroupIdentity!),
    release: async () => true,
  };
}

function startupOnlyTakeoverProof(): TakeoverProof {
  return {
    startupOnly: true,
    reserve: async () => true,
    cleanup: async () => true,
    release: async () => true,
  };
}

async function startupResourceTakeoverProof(worker: CwdLeaseWorker): Promise<TakeoverProof | undefined> {
  if (!worker.workerId || !worker.cgroupPath || !isCgroupPath(worker.cgroupPath)
    || !matchesGeneratedCgroupName(worker.cgroupPath, worker.transport, worker.workerId)
    || worker.pid !== undefined || !worker.retainCgroupUntilLeaseRelease) return undefined;
  if (worker.tmuxServerPid && worker.tmuxServerStartTime
    && await processIdentityLive(worker.tmuxServerPid, worker.tmuxServerStartTime)) return undefined;

  let cgroupIdentity: { device: string; inode: string };
  try {
    cgroupIdentity = await readCgroupIdentity(worker.cgroupPath);
    if (worker.cgroupIdentity
      && (worker.cgroupIdentity.device !== cgroupIdentity.device || worker.cgroupIdentity.inode !== cgroupIdentity.inode)) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    // The adapter can have completed guardian cleanup after the startup plan
    // was persisted. Missing cgroup plus a gone private tmux session is a
    // verified no-resource startup, not permission to ignore a live session.
    if (worker.transport === "tmux") {
      if (worker.ownership !== "owned"
        || worker.sessionName !== `pi-supervisor-${worker.workerId}`
        || !worker.tmuxSocket
        || basename(resolve(worker.tmuxSocket)) !== `pi-cs-${worker.workerId}.sock`
        || !await tmuxSessionGone(worker.tmuxSocket, worker.sessionName)) return undefined;
      // A socket with no matching session can still belong to a live tmux
      // server. Startup-only replacement is allowed only once the private
      // socket itself has disappeared (or can be atomically reserved below).
      try {
        await lstat(worker.tmuxSocket);
        return undefined;
      } catch (socketError) {
        if ((socketError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
    }
    return startupOnlyTakeoverProof();
  }
  if (await cgroupHasProcesses(worker.cgroupPath)) return undefined;

  const pendingCleanup: CwdLeaseCleanup = {
    phase: "prepared",
    transport: worker.transport,
    workerId: worker.workerId,
    cgroupPath: worker.cgroupPath,
    cgroupIdentity,
    ...(worker.transport === "tmux" ? { startupResource: true } : {}),
  };
  if (worker.transport === "tmux") {
    if (worker.ownership !== "owned"
      || worker.sessionName !== `pi-supervisor-${worker.workerId}`
      || !worker.tmuxSocket
      || basename(resolve(worker.tmuxSocket)) !== `pi-cs-${worker.workerId}.sock`
      || !await tmuxSessionGone(worker.tmuxSocket, worker.sessionName)) return undefined;
    pendingCleanup.sessionName = worker.sessionName;
    pendingCleanup.tmuxSocket = worker.tmuxSocket;
    let reservation: SocketReservation | undefined;
    return {
      pendingCleanup,
      reserve: async () => {
        reservation = await reserveTmuxSocket(worker.tmuxSocket!);
        if (!reservation) return false;
        pendingCleanup.socketMarkerIdentity = reservation.identity;
        return true;
      },
      cleanup: async () => removeEmptyCgroup(worker.cgroupPath!, cgroupIdentity),
      release: async () => reservation ? reservation.release() : true,
    };
  }
  return {
    pendingCleanup,
    reserve: async () => true,
    cleanup: async () => removeEmptyCgroup(worker.cgroupPath!, cgroupIdentity),
    release: async () => true,
  };
}

async function cleanupPendingLease(cleanup: CwdLeaseCleanup): Promise<boolean> {
  if (!isCgroupPath(cleanup.cgroupPath) || !matchesGeneratedCgroupName(cleanup.cgroupPath, cleanup.transport, cleanup.workerId)) return false;
  if (cleanup.transport === "tmux") {
    if (!cleanup.sessionName || !cleanup.tmuxSocket) return false;
    if (!cleanup.startupResource) {
      if (!cleanup.tmuxServerPid || !cleanup.tmuxServerStartTime) return false;
      if (await processIdentityLive(cleanup.tmuxServerPid, cleanup.tmuxServerStartTime)) return false;
    }
    if (!await tmuxSessionGoneOrReserved(cleanup.tmuxSocket, cleanup.sessionName, cleanup.socketMarkerIdentity)) return false;
  }
  const cgroupWasCleaned = cleanup.cgroupCleaned === true;
  if (!await cgroupGoneOrCleaned(cleanup)) return false;
  // Persist cgroupCleaned before removing a tmux marker. A crash after marker
  // removal but before the record write must remain recoverable on the next
  // lease read.
  if (!cgroupWasCleaned && cleanup.cgroupCleaned === true) return false;
  return cleanup.transport !== "tmux" || await removeSocketMarker(cleanup.tmuxSocket!, cleanup.socketMarkerIdentity);
}

async function cgroupGoneOrCleaned(cleanup: CwdLeaseCleanup): Promise<boolean> {
  try {
    await lstat(cleanup.cgroupPath);
  } catch (error) {
    // A missing cgroup is not proof of cleanup unless the transaction already
    // durably recorded that this Supervisor removed the verified empty one.
    return (error as NodeJS.ErrnoException).code === "ENOENT" && cleanup.cgroupCleaned === true;
  }
  const removed = await removeEmptyCgroup(cleanup.cgroupPath, cleanup.cgroupIdentity);
  if (removed) cleanup.cgroupCleaned = true;
  return removed;
}

async function tmuxSessionGoneOrReserved(socket: string, session: string, markerIdentity?: { device: string; inode: string }): Promise<boolean> {
  try {
    const info = await lstat(socket);
    if (info.isDirectory()) {
      return Boolean(markerIdentity)
        && String(info.dev) === markerIdentity!.device
        && String(info.ino) === markerIdentity!.inode;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  return tmuxSessionGone(socket, session);
}

async function removeSocketMarker(socket: string, markerIdentity?: { device: string; inode: string }): Promise<boolean> {
  if (!markerIdentity) return false;
  const quarantine = `${socket}.release-${process.pid}-${randomUUID()}`;
  try {
    const current = await lstat(socket);
    if (!current.isDirectory() || current.isSymbolicLink()) return false;
    if (String(current.dev) !== markerIdentity.device || String(current.ino) !== markerIdentity.inode) return false;
    if ((await readdir(socket)).length !== 0) return false;
    // Move the observed marker instance before removing it. A path check
    // followed by rmdir could delete a replacement directory created by a
    // competing recovery process.
    await rename(socket, quarantine);
    const moved = await lstat(quarantine);
    if (!moved.isDirectory() || moved.isSymbolicLink()
      || String(moved.dev) !== markerIdentity.device || String(moved.ino) !== markerIdentity.inode) {
      await rename(quarantine, socket).catch(() => {});
      return false;
    }
    if ((await readdir(quarantine)).length !== 0) {
      await rename(quarantine, socket).catch(() => {});
      return false;
    }
    await rmdir(quarantine);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function isCgroupPath(path: string): boolean {
  const root = resolve("/sys/fs/cgroup");
  const candidate = resolve(path);
  return candidate !== root && candidate.startsWith(`${root}/`);
}

/**
 * Bun's realpath implementation decodes systemd's literal `\\x2d` cgroup
 * escapes and then reports ENOENT. Verify every cgroup component with lstat
 * instead; this also rejects symlinked components without relying on realpath.
 */
async function canonicalCgroupPath(path: string): Promise<string> {
  const root = resolve("/sys/fs/cgroup");
  const candidate = resolve(path);
  if (candidate === root || !candidate.startsWith(`${root}/`)) throw new Error("invalid cgroup path");
  let current = root;
  for (const component of candidate.slice(root.length + 1).split("/")) {
    current = join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("cgroup path is not a real directory");
  }
  return candidate;
}

function matchesGeneratedCgroupName(path: string, transport: CwdLeaseTransport, workerId: string): boolean {
  const prefix = transport === "tmux" ? "pi-claude-supervisor-tmux-" : "pi-claude-supervisor-";
  return basename(resolve(path)) === `${prefix}${workerId}`;
}

async function readCgroupIdentity(path: string): Promise<{ device: string; inode: string }> {
  if (!isCgroupPath(path)) throw new Error("invalid cgroup path");
  const candidate = await canonicalCgroupPath(path);
  const info = await lstat(candidate);
  return { device: String(info.dev), inode: String(info.ino) };
}

async function cgroupIdentityMatches(path: string, expected: { device: string; inode: string }): Promise<boolean> {
  try {
    const actual = await readCgroupIdentity(path);
    return actual.device === expected.device && actual.inode === expected.inode;
  } catch {
    return false;
  }
}

async function removeEmptyCgroup(path: string, expected: { device: string; inode: string }): Promise<boolean> {
  // Re-check both the persisted directory identity and emptiness immediately
  // before removal. The initial checks only authorize attempting takeover;
  // they must not be reused after the pre-replacement hook has run.
  if (!await cgroupIdentityMatches(path, expected) || await cgroupHasProcesses(path)) return false;
  try {
    await rmdir(resolve(path));
    return true;
  } catch {
    return false;
  }
}

async function releaseRetainedCgroup(worker: CwdLeaseWorker): Promise<void> {
  if (!worker.workerId || !worker.cgroupPath
    || !isCgroupPath(worker.cgroupPath)
    || !matchesGeneratedCgroupName(worker.cgroupPath, worker.transport, worker.workerId)) {
    throw new Error("retained Worker cgroup identity is invalid");
  }
  if (!worker.cgroupIdentity) {
    try {
      await lstat(worker.cgroupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("retained Worker cgroup identity is unavailable");
  }
  try {
    await lstat(worker.cgroupPath);
  } catch (error) {
    // Startup failure cleanup may have removed the cgroup before the lease
    // release reached this path. Recovery takeover remains stricter and never
    // treats a missing cgroup as proof unless its cleanup stage is persisted.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!await removeEmptyCgroup(worker.cgroupPath, worker.cgroupIdentity)) {
    throw new Error("retained Worker cgroup cleanup could not be confirmed");
  }
}

async function reserveTmuxSocket(socket: string): Promise<SocketReservation | undefined> {
  try {
    const existing = await lstat(socket);
    // A private socket must have disappeared before it can be reserved. Do
    // not unlink a live or replaced socket as part of takeover.
    if (existing) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  try {
    // tmux removes a regular stale socket path before binding its own socket;
    // a directory is an atomic reservation that tmux cannot replace. If a
    // competing process wins the mkdir race, fail closed instead.
    await mkdir(socket, { mode: 0o700 });
    const markerInfo = await lstat(socket);
    if (!markerInfo.isDirectory() || markerInfo.isSymbolicLink()) {
      await rmdir(socket).catch(() => {});
      return undefined;
    }
    let released = false;
    const identity = { device: String(markerInfo.dev), inode: String(markerInfo.ino) };
    const release = async () => {
      if (released) return true;
      released = true;
      return removeSocketMarker(socket, identity);
    };
    return { identity, release };
  } catch {
    return undefined;
  }
}

async function tmuxSessionGone(socket: string, session: string): Promise<boolean> {
  // Automatic sessions always use a private absolute socket and a generated
  // safe session name. Never pass lease-controlled strings through a shell.
  if (!socket.startsWith("/") || socket.includes("\0") || !/^[A-Za-z0-9_.-]+$/u.test(session)) return false;
  try {
    const socketInfo = await lstat(socket);
    if (!socketInfo.isSocket()) return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    await execFileAsync("tmux", ["-S", socket, "has-session", "-t", session], { timeout: 5_000, maxBuffer: 8 * 1024 });
    return false;
  } catch (error) {
    const details = error as NodeJS.ErrnoException & { stderr?: string };
    if (String(details.code) !== "1") return false;
    return /no server|can't find session|no such file|connection refused/iu.test(String(details.stderr ?? ""));
  }
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
    || (worker.workerId !== undefined && !/^[0-9a-f-]{36}$/iu.test(worker.workerId))
    || (worker.pid !== undefined && (!Number.isSafeInteger(worker.pid) || worker.pid < 1))
    || (worker.startTime !== undefined && !/^\d+$/u.test(worker.startTime))
    || (worker.tmuxServerPid !== undefined && (!Number.isSafeInteger(worker.tmuxServerPid) || worker.tmuxServerPid < 1))
    || (worker.tmuxServerStartTime !== undefined && !/^\d+$/u.test(worker.tmuxServerStartTime))
    || (worker.tmuxPaneId !== undefined && !/^%\d+$/u.test(worker.tmuxPaneId))
    || (worker.cgroupPath !== undefined && !worker.cgroupPath.startsWith("/"))
    || (worker.cgroupIdentity !== undefined && (!/^\d+$/u.test(worker.cgroupIdentity.device) || !/^\d+$/u.test(worker.cgroupIdentity.inode)))
    || (worker.retainCgroupUntilLeaseRelease !== undefined && typeof worker.retainCgroupUntilLeaseRelease !== "boolean")) {
    throw new Error("invalid cwd lease worker identity");
  }
}

function normalizeCleanup(value: unknown): CwdLeaseCleanup | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("invalid cwd lease cleanup state");
  const cleanup = value as Partial<CwdLeaseCleanup>;
  if (cleanup.phase !== "prepared" && cleanup.phase !== "replacement"
    || !cleanup.transport || !["process-pipe", "jsonl", "pty", "tmux"].includes(cleanup.transport)
    || typeof cleanup.workerId !== "string" || !/^[0-9a-f-]{36}$/iu.test(cleanup.workerId)
    || typeof cleanup.cgroupPath !== "string" || !isCgroupPath(cleanup.cgroupPath)
    || !matchesGeneratedCgroupName(cleanup.cgroupPath, cleanup.transport, cleanup.workerId)
    || !cleanup.cgroupIdentity || typeof cleanup.cgroupIdentity !== "object"
    || typeof cleanup.cgroupIdentity.device !== "string" || !/^\d+$/u.test(cleanup.cgroupIdentity.device)
    || typeof cleanup.cgroupIdentity.inode !== "string" || !/^\d+$/u.test(cleanup.cgroupIdentity.inode)
    || (cleanup.cgroupCleaned !== undefined && cleanup.cgroupCleaned !== true)) {
    throw new Error("invalid cwd lease cleanup state");
  }
  if (cleanup.transport === "tmux"
    && (typeof cleanup.sessionName !== "string" || cleanup.sessionName !== `pi-supervisor-${cleanup.workerId}`
      || typeof cleanup.tmuxSocket !== "string" || !cleanup.tmuxSocket.startsWith("/")
      || basename(resolve(cleanup.tmuxSocket)) !== `pi-cs-${cleanup.workerId}.sock`
      || (cleanup.startupResource !== true
        && (!Number.isSafeInteger(cleanup.tmuxServerPid) || cleanup.tmuxServerPid! < 1
          || typeof cleanup.tmuxServerStartTime !== "string" || !/^\d+$/u.test(cleanup.tmuxServerStartTime))))) {
    throw new Error("invalid cwd lease cleanup state");
  }
  if (cleanup.transport !== "tmux" && (cleanup.sessionName !== undefined || cleanup.tmuxSocket !== undefined
    || cleanup.tmuxServerPid !== undefined || cleanup.tmuxServerStartTime !== undefined || cleanup.socketMarkerIdentity !== undefined
    || cleanup.startupResource !== undefined)) {
    throw new Error("invalid cwd lease cleanup state");
  }
  if (cleanup.startupResource !== undefined && cleanup.startupResource !== true) throw new Error("invalid cwd lease cleanup state");
  if (cleanup.socketMarkerIdentity !== undefined
    && (typeof cleanup.socketMarkerIdentity !== "object"
      || typeof cleanup.socketMarkerIdentity.device !== "string" || !/^\d+$/u.test(cleanup.socketMarkerIdentity.device)
      || typeof cleanup.socketMarkerIdentity.inode !== "string" || !/^\d+$/u.test(cleanup.socketMarkerIdentity.inode))) {
    throw new Error("invalid cwd lease cleanup state");
  }
  return {
    phase: cleanup.phase,
    transport: cleanup.transport,
    workerId: cleanup.workerId,
    cgroupPath: cleanup.cgroupPath,
    cgroupIdentity: { device: cleanup.cgroupIdentity.device, inode: cleanup.cgroupIdentity.inode },
    ...(cleanup.cgroupCleaned ? { cgroupCleaned: true } : {}),
    ...(cleanup.sessionName ? { sessionName: cleanup.sessionName } : {}),
    ...(cleanup.tmuxSocket ? { tmuxSocket: cleanup.tmuxSocket } : {}),
    ...(cleanup.tmuxServerPid !== undefined ? { tmuxServerPid: cleanup.tmuxServerPid } : {}),
    ...(cleanup.tmuxServerStartTime ? { tmuxServerStartTime: cleanup.tmuxServerStartTime } : {}),
    ...(cleanup.socketMarkerIdentity ? { socketMarkerIdentity: { ...cleanup.socketMarkerIdentity } } : {}),
    ...(cleanup.startupResource ? { startupResource: true } : {}),
  };
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
  const pendingStartup = value.pendingStartup;
  if (pendingStartup !== undefined
    && (!pendingStartup || typeof pendingStartup !== "object" || !["process-pipe", "jsonl", "pty", "tmux"].includes(pendingStartup.transport))) {
    throw new Error("invalid cwd lease startup state");
  }
  const pendingCleanup = normalizeCleanup(value.pendingCleanup);
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
      workerId: typeof worker.workerId === "string" && /^[0-9a-f-]{36}$/iu.test(worker.workerId) ? worker.workerId : undefined,
      pid: Number.isSafeInteger(worker.pid) && worker.pid! > 0 ? worker.pid : undefined,
      startTime: typeof worker.startTime === "string" && /^\d+$/u.test(worker.startTime) ? worker.startTime : undefined,
      sessionName: typeof worker.sessionName === "string" ? worker.sessionName : undefined,
      tmuxSocket: typeof worker.tmuxSocket === "string" ? worker.tmuxSocket : undefined,
      ownership: worker.ownership === "owned" || worker.ownership === "adopted" ? worker.ownership : undefined,
      cgroupPath: typeof worker.cgroupPath === "string" ? worker.cgroupPath : undefined,
      cgroupIdentity: worker.cgroupIdentity && typeof worker.cgroupIdentity === "object"
        && typeof worker.cgroupIdentity.device === "string" && /^\d+$/u.test(worker.cgroupIdentity.device)
        && typeof worker.cgroupIdentity.inode === "string" && /^\d+$/u.test(worker.cgroupIdentity.inode)
        ? { device: worker.cgroupIdentity.device, inode: worker.cgroupIdentity.inode }
        : undefined,
      retainCgroupUntilLeaseRelease: worker.retainCgroupUntilLeaseRelease === true ? true : undefined,
      tmuxServerPid: Number.isSafeInteger(worker.tmuxServerPid) && worker.tmuxServerPid! > 0 ? worker.tmuxServerPid : undefined,
      tmuxServerStartTime: typeof worker.tmuxServerStartTime === "string" && /^\d+$/u.test(worker.tmuxServerStartTime) ? worker.tmuxServerStartTime : undefined,
      tmuxTarget: typeof worker.tmuxTarget === "string" ? worker.tmuxTarget : undefined,
      tmuxPaneId: typeof worker.tmuxPaneId === "string" && /^%\d+$/u.test(worker.tmuxPaneId) ? worker.tmuxPaneId : undefined,
      paneStartTime: typeof worker.paneStartTime === "string" ? worker.paneStartTime : undefined,
      paneCommand: typeof worker.paneCommand === "string" ? worker.paneCommand : undefined,
    } : undefined,
    ...(pendingStartup ? { pendingStartup: { transport: pendingStartup.transport } } : {}),
    pendingCleanup,
  };
}

function redactText(value: string): string {
  return String(redactSensitive(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
