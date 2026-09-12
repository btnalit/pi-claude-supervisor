import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export interface DecisionSessionRecord {
  version: 1;
  taskId: string;
  task: string;
  cwd: string;
  command: string;
  args: string[];
  approval?: { actor: "human"; reason: string };
  decisionSessionFile: string;
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
    assertSessionPath(decisionSessionFile, this.#directory, record.taskId);
    const normalized: DecisionSessionRecord = {
      ...record,
      version: 1,
      updatedAt: record.updatedAt ?? new Date().toISOString(),
      args: [...record.args],
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

  async load(taskId: string): Promise<DecisionSessionRecord | undefined> {
    assertTaskId(taskId);
    try {
      const value = JSON.parse(await readFile(this.#recordPath(taskId), "utf8")) as Partial<DecisionSessionRecord>;
      return normalizeRecord(value, this.#directory);
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
          const record = normalizeRecord(value, this.#directory);
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
    || typeof value.updatedAt !== "string") {
    throw new Error("invalid Decision Worker session record");
  }
  const decisionSessionFile = resolve(value.decisionSessionFile);
  assertSessionPath(decisionSessionFile, directory, value.taskId);
  return {
    version: 1,
    taskId: value.taskId,
    task: value.task,
    cwd: value.cwd,
    command: value.command,
    args: [...value.args],
    approval: value.approval,
    decisionSessionFile,
    state: value.state,
    updatedAt: value.updatedAt,
  };
}

function assertTaskId(taskId: string): void {
  if (!/^[0-9a-f-]{36}$/iu.test(taskId) || basename(taskId) !== taskId) throw new Error("invalid task id");
}

function assertSessionPath(sessionFile: string, directory: string, taskId: string): void {
  const allowedPrefix = `${resolve(directory)}/${taskId}/`;
  if (!sessionFile.startsWith(allowedPrefix)) throw new Error("Decision Worker session file is outside the task session directory");
}
