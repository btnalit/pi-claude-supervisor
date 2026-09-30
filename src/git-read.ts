import { setTimeout as delay } from "node:timers/promises";

/** Only for idempotent, read-only Git inspections, never acceptance commands. */
export async function retryGitRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      if (signal?.aborted || attempt >= 2 || !transientGitRead(error)) throw error;
      await delay(100 * (attempt + 1), undefined, { signal });
    }
  }
}

function transientGitRead(error: unknown): boolean {
  const failure = (error ?? {}) as { name?: string; code?: number | string; killed?: boolean; signal?: string; stderr?: string };
  if (failure.name === "AbortError" || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || failure.code === 1 || failure.code === 2) return false;
  const stderr = String(failure.stderr ?? "");
  if (/authentication failed|permission denied|access denied|repository not found|could not read username|returned error:\s*(?:401|403|404)\b/iu.test(stderr)) return false;
  if (["EAGAIN", "EBUSY", "EMFILE", "ENFILE", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(String(failure.code))) return true;
  if (failure.killed && failure.signal === "SIGTERM") return true;
  return /could not resolve (?:host|hostname)|failed to connect|connection (?:reset|timed out|refused)|temporary failure|resource temporarily unavailable|too many open files|unable to create [^\n]*\.lock[^\n]*file exists|requested URL returned error:\s*(?:408|429|500|502|503|504)\b/iu.test(stderr);
}
