import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSensitive } from "./redaction.ts";
import { normalizeTaskSpec } from "./acceptance.ts";
import type { TaskSpec } from "./types.ts";

/**
 * Two lists of URL strings and nothing else; a persisted baseline is data the
 * grant trusts, so its shape is checked. Empty lists are valid: they record
 * that the remote had no URL when the task started, which refuses a grant.
 */
function isRemoteBaseline(value: unknown): value is { fetch: string[]; push: string[] } {
  const urls = (list: unknown): list is string[] => Array.isArray(list) && list.length <= 32 && list.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 4_096);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && urls((value as { fetch?: unknown }).fetch) && urls((value as { push?: unknown }).push);
}

export type DecisionRecoveryState = "ready" | "starting" | "registered" | "recovered_idle" | "interrupted";

export interface DecisionRecoveryWorker {
  id: string;
  pid?: number;
  startedAt: string;
}

export interface DecisionSessionRecord {
  version: 1;
  taskId: string;
  task: string;
  spec?: TaskSpec;
  cwd: string;
  command: string;
  args: string[];
  approval?: { actor: "human"; reason: string };
  decisionSessionFile: string;
  maxTurns: number;
  deadlineMs: number;
  noOutputTimeoutMs: number;
  startedAt: string;
  baseCommit?: string;
  baseBranch?: string;
  /** The granted remote's resolved URLs when the task first started; the publish grant requires the same two. */
  remoteBaseline?: { fetch: string[]; push: string[] };
  /** Real executable identity pinned by automatic startup and recovery. */
  resolvedExecutable?: string;
  turn: number;
  repairRound?: number;
  lastFindingSignature?: string;
  /** Cumulative Claude Worker API cost so far; recovery seeds the next Worker's budget accounting with it. */
  workerCostUsd?: number;
  state: "active" | "closed";
  recoveryState: DecisionRecoveryState;
  recoveryAttempt: number;
  recoveryOwnerPid?: number;
  recoveryOwnerStartTime?: string;
  recoveryWorker?: DecisionRecoveryWorker;
  updatedAt: string;
}

export type DecisionSessionRecordInput = Omit<DecisionSessionRecord, "version" | "updatedAt" | "recoveryState" | "recoveryAttempt" | "recoveryOwnerPid" | "recoveryOwnerStartTime"> & Partial<Pick<DecisionSessionRecord, "updatedAt" | "recoveryState" | "recoveryAttempt" | "recoveryOwnerPid" | "recoveryOwnerStartTime">>;

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5_000;

/**
 * Small crash-tolerant registry for Decision Worker sessions.
 * The Pi session JSONL remains the source of conversation history; this file
 * only maps a supervisor task to that history and the restart parameters.
 *
 * Registry mutations use a process-bound lock and atomic record replacement so
 * recovery state cannot be silently lost when two Pi processes race.
 */
export class DecisionSessionStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  get directory(): string {
    return this.#directory;
  }

  sessionDirectory(taskId: string): string {
    assertTaskId(taskId);
    return join(this.#directory, taskId);
  }

  async save(record: DecisionSessionRecordInput): Promise<void> {
    assertTaskId(record.taskId);
    const decisionSessionFile = resolve(record.decisionSessionFile);
    await assertTaskDirectorySafe(this.#directory, record.taskId);
    assertSessionPath(decisionSessionFile, this.#directory, record.taskId);
    assertNoCredentialPath(decisionSessionFile);
    assertNoCredentialPath(record.cwd);
    if (record.resolvedExecutable !== undefined) assertResolvedExecutable(record.resolvedExecutable);
    await this.#withLock(() => this.#saveUnlocked({ ...record, decisionSessionFile }));
  }

  async close(taskId: string): Promise<void> {
    assertTaskId(taskId);
    await this.#withLock(async () => {
      const record = await this.#loadUnlocked(taskId);
      if (!record) return;
      await this.#saveUnlocked({ ...record, state: "closed", updatedAt: new Date().toISOString() });
    });
  }

  /**
   * Remove closed records (and their session directories) whose last update is
   * older than maxAgeMs. Active records are never touched. A record whose
   * directory cannot be safely identified as its own task directory (moved,
   * missing, or replaced by a symlink) is left in place and logged, not removed.
   */
  async prune(options: { maxAgeMs: number; now?: number }): Promise<{ removed: string[] }> {
    if (options.maxAgeMs <= 0) return { removed: [] };
    const now = options.now ?? Date.now();
    return this.#withLock(async () => {
      const removed: string[] = [];
      for (const record of await this.list()) {
        if (record.state !== "closed") continue;
        const updatedAtMs = Date.parse(record.updatedAt);
        if (!Number.isFinite(updatedAtMs) || now - updatedAtMs < options.maxAgeMs) continue;
        try {
          const directory = resolve(dirname(record.decisionSessionFile));
          if (directory !== this.sessionDirectory(record.taskId)) {
            throw new Error("session directory does not match its task id");
          }
          const relativeToStore = relative(this.#directory, directory);
          if (isAbsolute(relativeToStore) || relativeToStore === ".." || relativeToStore.startsWith(`..${sep}`)) {
            throw new Error("session directory escaped the store directory");
          }
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("session directory is not a real directory");
          await rm(directory, { recursive: true, force: true });
          await rm(this.#recordPath(record.taskId), { force: true });
          removed.push(record.taskId);
        } catch (error) {
          console.error(`pi-claude-supervisor could not prune Decision Worker session ${record.taskId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { removed };
    });
  }

  async update(taskId: string, patch: Partial<Pick<DecisionSessionRecord, "turn" | "repairRound" | "lastFindingSignature" | "workerCostUsd" | "updatedAt">>): Promise<void> {
    assertTaskId(taskId);
    await this.#withLock(async () => {
      const record = await this.#loadUnlocked(taskId);
      if (!record || record.state !== "active") return;
      await this.#saveUnlocked({ ...record, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() });
    });
  }

  /** Claim an active record for one explicit recovery attempt. */
  async beginRecovery(taskId: string): Promise<DecisionSessionRecord> {
    assertTaskId(taskId);
    return this.#withLock(async () => {
      const record = await this.#loadUnlocked(taskId);
      if (!record || record.state !== "active") throw new Error(`No active Decision Worker session: ${taskId}`);
      if (record.recoveryState !== "ready" && record.recoveryState !== "interrupted") {
        throw new Error(`Decision Worker recovery is already in progress or attached: ${taskId}`);
      }
      const next: DecisionSessionRecord = {
        ...record,
        recoveryState: "starting",
        recoveryAttempt: record.recoveryAttempt + 1,
        recoveryOwnerPid: process.pid,
        recoveryOwnerStartTime: await processStartTime(process.pid),
        recoveryWorker: undefined,
        updatedAt: new Date().toISOString(),
      };
      await this.#saveUnlocked(next);
      return next;
    });
  }

  /** Persist the new Worker identity before exposing the recovered session. */
  async recordRecoveryWorker(taskId: string, worker: DecisionRecoveryWorker): Promise<void> {
    assertTaskId(taskId);
    assertRecoveryWorker(worker);
    await this.#withLock(async () => {
      const record = await this.#loadUnlocked(taskId);
      if (!record) throw new Error(`Decision Worker recovery record is missing: ${taskId}`);
      if (record.state !== "active") throw new Error(`Decision Worker recovery record is closed: ${taskId}`);
      if (record.recoveryState !== "starting") throw new Error(`Decision Worker recovery is not in startup state: ${taskId}`);
      await this.#saveUnlocked({
        ...record,
        recoveryState: "registered",
        recoveryWorker: { ...worker },
        updatedAt: new Date().toISOString(),
      });
    });
  }

  /** Mark a registered recovery as an idle, human-controlled session. */
  async markRecoveryIdle(taskId: string): Promise<void> {
    assertTaskId(taskId);
    await this.#withLock(async () => {
      const record = await this.#loadUnlocked(taskId);
      if (!record) throw new Error(`Decision Worker recovery record is missing: ${taskId}`);
      if (record.state !== "active") throw new Error(`Decision Worker recovery record is closed: ${taskId}`);
      if (record.recoveryState === "recovered_idle") return;
      if (record.recoveryState !== "registered" && record.recoveryState !== "starting") {
        throw new Error(`Decision Worker recovery cannot become idle from ${record.recoveryState}: ${taskId}`);
      }
      await this.#saveUnlocked({ ...record, recoveryState: "recovered_idle", updatedAt: new Date().toISOString() });
    });
  }

  /**
   * Reconcile a stale attempt only after the cwd-lease takeover has proved the
   * old supervisor/Worker boundary is gone. The owner identity check remains
   * here as a second independent guard.
   */
  async reconcileStaleRecovery(taskId: string): Promise<void> {
    assertTaskId(taskId);
    await this.#withLock(async () => {
      const record = await this.#loadUnlocked(taskId);
      if (!record || record.state !== "active") throw new Error(`Decision Worker recovery record is unavailable: ${taskId}`);
      if (record.recoveryState === "ready" || record.recoveryState === "interrupted") return;
      if (!record.recoveryOwnerPid || !record.recoveryOwnerStartTime) {
        throw new Error(`Decision Worker recovery owner identity is unavailable: ${taskId}`);
      }
      const currentOwnerStartTime = await processStartTime(record.recoveryOwnerPid);
      if (currentOwnerStartTime === record.recoveryOwnerStartTime) {
        throw new Error(`Decision Worker recovery owner is still live: ${taskId}`);
      }
      if (!currentOwnerStartTime && await processExists(record.recoveryOwnerPid)) {
        throw new Error(`Decision Worker recovery owner identity is unavailable: ${taskId}`);
      }
      await this.#saveUnlocked({
        ...record,
        recoveryState: "interrupted",
        recoveryWorker: undefined,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  /** Leave an active record visibly recoverable after an interrupted attempt. */
  async markRecoveryInterrupted(taskId: string): Promise<void> {
    assertTaskId(taskId);
    await this.#withLock(async () => {
      const record = await this.#loadUnlocked(taskId);
      if (!record || record.state !== "active") return;
      if (record.recoveryState === "interrupted") return;
      await this.#saveUnlocked({
        ...record,
        recoveryState: "interrupted",
        recoveryWorker: undefined,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  /** Reset a claimed record only when no Worker was spawned. */
  async resetRecovery(taskId: string): Promise<void> {
    assertTaskId(taskId);
    await this.#withLock(async () => {
      const record = await this.#loadUnlocked(taskId);
      if (!record || record.state !== "active") return;
      if (record.recoveryState === "ready") return;
      await this.#saveUnlocked({
        ...record,
        recoveryState: "ready",
        recoveryWorker: undefined,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async sessionFileExists(taskId: string): Promise<boolean> {
    const record = await this.load(taskId);
    if (!record) return false;
    try {
      const [directoryInfo, fileInfo] = await Promise.all([lstat(this.sessionDirectory(taskId)), lstat(record.decisionSessionFile)]);
      return !directoryInfo.isSymbolicLink() && fileInfo.isFile() && !fileInfo.isSymbolicLink() && fileInfo.size > 0;
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) return false;
      throw error;
    }
  }

  async load(taskId: string): Promise<DecisionSessionRecord | undefined> {
    assertTaskId(taskId);
    return this.#loadUnlocked(taskId);
  }

  async list(options: { activeOnly?: boolean } = {}): Promise<DecisionSessionRecord[]> {
    try {
      const directoryInfo = await lstat(this.#directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Decision Worker session registry is not a real directory");
      const names = await readdir(this.#directory);
      const records: DecisionSessionRecord[] = [];
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        try {
          const expectedTaskId = name.slice(0, -".json".length);
          assertTaskId(expectedTaskId);
          const value = JSON.parse(await readRecordFile(join(this.#directory, name))) as Partial<DecisionSessionRecord>;
          assertNoCredentialPath(typeof value.decisionSessionFile === "string" ? resolve(value.decisionSessionFile) : "");
          const record = normalizeRecord(redactRecord(value), this.#directory, expectedTaskId);
          if (!options.activeOnly || record.state === "active") records.push(record);
        } catch {
          // A torn, misnamed, or manually edited registry record is not recoverable.
        }
      }
      return records.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) return [];
      throw error;
    }
  }

  async #loadUnlocked(taskId: string): Promise<DecisionSessionRecord | undefined> {
    try {
      const value = JSON.parse(await readRecordFile(this.#recordPath(taskId))) as Partial<DecisionSessionRecord>;
      assertNoCredentialPath(typeof value.decisionSessionFile === "string" ? resolve(value.decisionSessionFile) : "");
      return normalizeRecord(redactRecord(value), this.#directory, taskId);
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) return undefined;
      throw error;
    }
  }

  async #saveUnlocked(record: DecisionSessionRecordInput | DecisionSessionRecord): Promise<void> {
    assertTaskId(record.taskId);
    const decisionSessionFile = resolve(record.decisionSessionFile);
    await assertTaskDirectorySafe(this.#directory, record.taskId);
    assertSessionPath(decisionSessionFile, this.#directory, record.taskId);
    assertNoCredentialPath(decisionSessionFile);
    assertNoCredentialPath(record.cwd);
    assertRecoveryState(record.recoveryState);
    assertRecoveryAttempt(record.recoveryAttempt);
    assertRecoveryOwner(record.recoveryOwnerPid, record.recoveryOwnerStartTime);
    if (record.recoveryWorker) assertRecoveryWorker(record.recoveryWorker);
    const safeRecord = redactRecord(record);
    const normalized: DecisionSessionRecord = {
      ...safeRecord,
      version: 1,
      recoveryState: safeRecord.recoveryState ?? "ready",
      recoveryAttempt: safeRecord.recoveryAttempt ?? 0,
      ...(safeRecord.recoveryOwnerPid !== undefined ? { recoveryOwnerPid: safeRecord.recoveryOwnerPid } : {}),
      ...(safeRecord.recoveryOwnerStartTime !== undefined ? { recoveryOwnerStartTime: safeRecord.recoveryOwnerStartTime } : {}),
      updatedAt: safeRecord.updatedAt ?? new Date().toISOString(),
      args: [...safeRecord.args],
      decisionSessionFile,
      ...(safeRecord.recoveryWorker ? { recoveryWorker: { ...safeRecord.recoveryWorker } } : {}),
    } as DecisionSessionRecord;
    await this.#ensureDirectory();
    const target = this.#recordPath(record.taskId);
    const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeJson(temporary, normalized);
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.#ensureDirectory();
    const lockPath = join(this.#directory, ".lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          at: new Date().toISOString(),
        }), { encoding: "utf8", mode: 0o600 });
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/EEXIST/u.test(error.message)) throw error;
        if (await removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) throw new Error(`Decision Worker session registry lock timeout: ${lockPath}`);
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
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Decision Worker session registry is not a real directory");
    await chmod(this.#directory, 0o700);
  }

  #recordPath(taskId: string): string {
    assertTaskId(taskId);
    return join(this.#directory, `${taskId}.json`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function readRecordFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Decision Worker session registry record is not a regular file");
  return readFile(path, "utf8");
}

function normalizeRecord(value: Partial<DecisionSessionRecord>, directory: string, expectedTaskId?: string): DecisionSessionRecord {
  if (expectedTaskId !== undefined && value.taskId !== expectedTaskId) throw new Error("Decision Worker session task id mismatch");
  if (value.version !== 1 || typeof value.taskId !== "string" || !/^[0-9a-f-]{36}$/iu.test(value.taskId)
    || typeof value.task !== "string" || typeof value.cwd !== "string" || typeof value.command !== "string"
    || !Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")
    || typeof value.decisionSessionFile !== "string" || (value.state !== "active" && value.state !== "closed")
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || !validLimit(value.maxTurns, 0) || !validLimit(value.deadlineMs, 0) || !validLimit(value.noOutputTimeoutMs, 0)
    || !validLimit(value.turn, 0) || !validLimit(value.repairRound, 0) || !validLimit(value.recoveryAttempt, 0)
    || (value.recoveryOwnerPid !== undefined && (!Number.isSafeInteger(value.recoveryOwnerPid) || value.recoveryOwnerPid < 1))
    || (value.recoveryOwnerStartTime !== undefined && (typeof value.recoveryOwnerStartTime !== "string" || !/^\d+$/u.test(value.recoveryOwnerStartTime)))
    || (value.recoveryState !== undefined && !isRecoveryState(value.recoveryState))
    || (value.lastFindingSignature !== undefined && (typeof value.lastFindingSignature !== "string" || value.lastFindingSignature.length > 128))
    || (value.workerCostUsd !== undefined && (typeof value.workerCostUsd !== "number" || !Number.isFinite(value.workerCostUsd) || value.workerCostUsd < 0))
    || (value.baseCommit !== undefined && (typeof value.baseCommit !== "string" || !/^[0-9a-f]{40,64}$/iu.test(value.baseCommit)))
    || (value.baseBranch !== undefined && (typeof value.baseBranch !== "string" || !/^[A-Za-z0-9._/-]+$/u.test(value.baseBranch)))
    || (value.remoteBaseline !== undefined && !isRemoteBaseline(value.remoteBaseline))
    || (value.resolvedExecutable !== undefined && (typeof value.resolvedExecutable !== "string" || !isAbsolute(value.resolvedExecutable) || value.resolvedExecutable.length > 4_096))
    || (value.startedAt !== undefined && (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))))
    || (value.recoveryWorker !== undefined && !isRecoveryWorker(value.recoveryWorker))) {
    throw new Error("invalid Decision Worker session record");
  }
  const decisionSessionFile = resolve(value.decisionSessionFile);
  assertSessionPath(decisionSessionFile, directory, value.taskId);
  assertNoCredentialPath(decisionSessionFile);
  assertNoCredentialPath(value.cwd);
  if (value.resolvedExecutable !== undefined) assertResolvedExecutable(value.resolvedExecutable);
  const recoveryWorker = value.recoveryWorker && {
    id: value.recoveryWorker.id,
    ...(value.recoveryWorker.pid !== undefined ? { pid: value.recoveryWorker.pid } : {}),
    startedAt: value.recoveryWorker.startedAt,
  };
  return {
    version: 1,
    taskId: value.taskId,
    task: value.task,
    spec: normalizeTaskSpec(value.spec, value.task),
    cwd: value.cwd,
    command: value.command,
    args: [...value.args],
    approval: value.approval,
    decisionSessionFile,
    maxTurns: value.maxTurns ?? 100,
    deadlineMs: value.deadlineMs ?? 4 * 60 * 60_000,
    noOutputTimeoutMs: value.noOutputTimeoutMs ?? 20 * 60_000,
    startedAt: value.startedAt ?? value.updatedAt,
    ...(typeof value.baseCommit === "string" ? { baseCommit: value.baseCommit } : {}),
    ...(typeof value.baseBranch === "string" ? { baseBranch: value.baseBranch } : {}),
    ...(isRemoteBaseline(value.remoteBaseline) ? { remoteBaseline: { fetch: [...value.remoteBaseline.fetch], push: [...value.remoteBaseline.push] } } : {}),
    ...(typeof value.resolvedExecutable === "string" ? { resolvedExecutable: value.resolvedExecutable } : {}),
    turn: value.turn ?? 0,
    repairRound: value.repairRound ?? 0,
    ...(typeof value.lastFindingSignature === "string" ? { lastFindingSignature: value.lastFindingSignature } : {}),
    ...(typeof value.workerCostUsd === "number" ? { workerCostUsd: value.workerCostUsd } : {}),
    state: value.state,
    recoveryState: value.recoveryState ?? "ready",
    recoveryAttempt: value.recoveryAttempt ?? 0,
    ...(value.recoveryOwnerPid !== undefined ? { recoveryOwnerPid: value.recoveryOwnerPid } : {}),
    ...(typeof value.recoveryOwnerStartTime === "string" ? { recoveryOwnerStartTime: value.recoveryOwnerStartTime } : {}),
    ...(recoveryWorker ? { recoveryWorker } : {}),
    updatedAt: value.updatedAt,
  };
}

function redactRecord<T extends Partial<DecisionSessionRecord>>(value: T): T {
  const safe = redactSensitive(value) as T;
  if (typeof value.cwd === "string") safe.cwd = value.cwd;
  if (typeof value.decisionSessionFile === "string") safe.decisionSessionFile = value.decisionSessionFile;
  return safe;
}

async function assertTaskDirectorySafe(directory: string, taskId: string): Promise<void> {
  try {
    const info = await lstat(resolve(directory, taskId));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Decision Worker task session directory is not a real directory");
  } catch (error) {
    if (error instanceof Error && /ENOENT/u.test(error.message)) throw new Error("Decision Worker task session directory is missing");
    throw error;
  }
}

function assertNoCredentialPath(path: string): void {
  if (!path || String(redactSensitive(path)) !== path) throw new Error("Decision Worker session path contains credential-shaped text");
}

function assertResolvedExecutable(path: string): void {
  if (!isAbsolute(path) || path.length > 4_096 || String(redactSensitive(path)) !== path) {
    throw new Error("Decision Worker resolved executable identity is invalid");
  }
}

function assertTaskId(taskId: string): void {
  if (!/^[0-9a-f-]{36}$/iu.test(taskId) || basename(taskId) !== taskId) throw new Error("invalid task id");
}

function assertSessionPath(sessionFile: string, directory: string, taskId: string): void {
  const taskDirectory = resolve(directory, taskId);
  if (dirname(sessionFile) !== taskDirectory) throw new Error("Decision Worker session file must be a direct child of its task session directory");
}

function isRecoveryState(value: unknown): value is DecisionRecoveryState {
  return value === "ready" || value === "starting" || value === "registered" || value === "recovered_idle" || value === "interrupted";
}

function assertRecoveryState(value: unknown): asserts value is DecisionRecoveryState | undefined {
  if (value !== undefined && !isRecoveryState(value)) throw new Error("invalid Decision Worker recovery state");
}

function isRecoveryWorker(value: unknown): value is DecisionRecoveryWorker {
  if (!value || typeof value !== "object") return false;
  const worker = value as Partial<DecisionRecoveryWorker>;
  return typeof worker.id === "string" && worker.id.length > 0 && worker.id.length <= 256
    && (worker.pid === undefined || (Number.isSafeInteger(worker.pid) && worker.pid > 0))
    && typeof worker.startedAt === "string" && Number.isFinite(Date.parse(worker.startedAt));
}

function assertRecoveryWorker(value: DecisionRecoveryWorker): void {
  if (!isRecoveryWorker(value)) throw new Error("invalid Decision Worker recovery worker identity");
}

function assertRecoveryAttempt(value: unknown): asserts value is number | undefined {
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) throw new Error("invalid Decision Worker recovery attempt");
}

function assertRecoveryOwner(pid: unknown, startTime: unknown): void {
  if (pid !== undefined && (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)) throw new Error("invalid Decision Worker recovery owner pid");
  if (startTime !== undefined && (typeof startTime !== "string" || !/^\d+$/u.test(startTime))) throw new Error("invalid Decision Worker recovery owner start time");
}

function validLimit(value: unknown, minimum: number): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum);
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await lstat(lockPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Decision Worker session registry lock is not a real directory");
    if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
    const ownerPath = join(lockPath, "owner.json");
    try {
      const ownerInfo = await lstat(ownerPath);
      if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink()) throw new Error("Decision Worker session registry lock owner is not a regular file");
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) {
        // An old/incomplete lock is reclaimable after the grace period.
      } else {
        throw error;
      }
    }
    let owner: { pid?: unknown } = {};
    try { owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown }; }
    catch { /* an old/incomplete lock is reclaimable after the grace period */ }
    if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
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

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && /EPERM/u.test(error.message);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
