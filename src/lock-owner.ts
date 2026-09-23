import { readFile } from "node:fs/promises";

/**
 * Identity written into a short-lived lock directory's `owner.json`. The pid
 * alone is not an identity: after a crash and a container or VM restart the
 * next Pi often gets the same pid, and a lock judged only by `kill(pid, 0)`
 * then looks held forever. The pid's start time (Linux) makes it one.
 */
export interface LockOwner {
  pid: number;
  startTime?: string;
  at: string;
}

let ownStartTime: Promise<string | undefined> | undefined;

/** The owner record for a lock taken by this process. */
export async function currentLockOwner(): Promise<LockOwner> {
  ownStartTime ??= processStartTime(process.pid);
  const startTime = await ownStartTime;
  return { pid: process.pid, ...(startTime ? { startTime } : {}), at: new Date().toISOString() };
}

/**
 * Whether the process that wrote `owner` still exists. A missing or malformed
 * record, a dead pid, or a live pid with a different start time (a reused
 * pid) all mean the lock is abandoned; only a live pid whose start time still
 * matches (or cannot be compared) keeps it.
 */
export async function lockOwnerAlive(owner: unknown): Promise<boolean> {
  if (!owner || typeof owner !== "object") return false;
  const { pid, startTime } = owner as { pid?: unknown; startTime?: unknown };
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!(error instanceof Error && /EPERM/u.test(error.message))) return false;
  }
  if (typeof startTime !== "string") return true;
  const current = await processStartTime(pid);
  return current === undefined || current === startTime;
}

/** Linux process start time in clock ticks since boot (field 22 of /proc/<pid>/stat). */
export async function processStartTime(pid: number): Promise<string | undefined> {
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
