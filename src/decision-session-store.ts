import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { redactSensitive } from "./redaction.ts";
import { normalizeTaskSpec } from "./acceptance.ts";
import type { TaskSpec } from "./types.ts";

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
  turn: number;
  repairRound?: number;
  lastFindingSignature?: string;
  state: "active" | "closed";
  updatedAt: string;
}

/**
 * Small crash-tolerant registry for Decision Worker sessions.
 * The Pi session JSONL remains the source of conversation history; this file
 * only maps a supervisor task to that history and the restart parameters.
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

  async save(record: Omit<DecisionSessionRecord, "version" | "updatedAt"> & Partial<Pick<DecisionSessionRecord, "updatedAt">>): Promise<void> {
    assertTaskId(record.taskId);
    const decisionSessionFile = resolve(record.decisionSessionFile);
    await assertTaskDirectorySafe(this.#directory, record.taskId);
    assertSessionPath(decisionSessionFile, this.#directory, record.taskId);
    assertNoCredentialPath(decisionSessionFile);
    assertNoCredentialPath(record.cwd);
    const safeRecord = redactRecord(record);
    const normalized: DecisionSessionRecord = {
      ...safeRecord,
      version: 1,
      updatedAt: safeRecord.updatedAt ?? new Date().toISOString(),
      args: [...safeRecord.args],
      decisionSessionFile,
    };
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const target = this.#recordPath(record.taskId);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeJson(temporary, normalized);
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  async close(taskId: string): Promise<void> {
    const record = await this.load(taskId);
    if (!record) return;
    await this.save({ ...record, state: "closed", updatedAt: new Date().toISOString() });
  }

  async update(taskId: string, patch: Partial<Pick<DecisionSessionRecord, "turn" | "repairRound" | "lastFindingSignature" | "updatedAt">>): Promise<void> {
    const record = await this.load(taskId);
    if (!record || record.state !== "active") return;
    await this.save({ ...record, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() });
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
    try {
      const value = JSON.parse(await readFile(this.#recordPath(taskId), "utf8")) as Partial<DecisionSessionRecord>;
      assertNoCredentialPath(typeof value.decisionSessionFile === "string" ? resolve(value.decisionSessionFile) : "");
      return normalizeRecord(redactRecord(value), this.#directory);
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) return undefined;
      throw error;
    }
  }

  async list(options: { activeOnly?: boolean } = {}): Promise<DecisionSessionRecord[]> {
    try {
      const names = await readdir(this.#directory);
      const records: DecisionSessionRecord[] = [];
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        try {
          const value = JSON.parse(await readFile(join(this.#directory, name), "utf8")) as Partial<DecisionSessionRecord>;
          assertNoCredentialPath(typeof value.decisionSessionFile === "string" ? resolve(value.decisionSessionFile) : "");
          const record = normalizeRecord(redactRecord(value), this.#directory);
          if (!options.activeOnly || record.state === "active") records.push(record);
        } catch {
          // A torn or manually edited registry record is not recoverable.
        }
      }
      return records.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) return [];
      throw error;
    }
  }

  #recordPath(taskId: string): string {
    assertTaskId(taskId);
    return join(this.#directory, `${taskId}.json`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function normalizeRecord(value: Partial<DecisionSessionRecord>, directory: string): DecisionSessionRecord {
  if (value.version !== 1 || typeof value.taskId !== "string" || !/^[0-9a-f-]{36}$/iu.test(value.taskId)
    || typeof value.task !== "string" || typeof value.cwd !== "string" || typeof value.command !== "string"
    || !Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")
    || typeof value.decisionSessionFile !== "string" || (value.state !== "active" && value.state !== "closed")
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || !validLimit(value.maxTurns, 0) || !validLimit(value.deadlineMs, 0) || !validLimit(value.noOutputTimeoutMs, 0)
    || !validLimit(value.turn, 0) || !validLimit(value.repairRound, 0)
    || (value.lastFindingSignature !== undefined && (typeof value.lastFindingSignature !== "string" || value.lastFindingSignature.length > 128))
    || (value.startedAt !== undefined && (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))))) {
    throw new Error("invalid Decision Worker session record");
  }
  const decisionSessionFile = resolve(value.decisionSessionFile);
  assertSessionPath(decisionSessionFile, directory, value.taskId);
  assertNoCredentialPath(decisionSessionFile);
  assertNoCredentialPath(value.cwd);
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
    turn: value.turn ?? 0,
    repairRound: value.repairRound ?? 0,
    ...(typeof value.lastFindingSignature === "string" ? { lastFindingSignature: value.lastFindingSignature } : {}),
    state: value.state,
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

function assertTaskId(taskId: string): void {
  if (!/^[0-9a-f-]{36}$/iu.test(taskId) || basename(taskId) !== taskId) throw new Error("invalid task id");
}

function assertSessionPath(sessionFile: string, directory: string, taskId: string): void {
  const taskDirectory = resolve(directory, taskId);
  if (dirname(sessionFile) !== taskDirectory) throw new Error("Decision Worker session file must be a direct child of its task session directory");
}

function validLimit(value: unknown, minimum: number): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum);
}
