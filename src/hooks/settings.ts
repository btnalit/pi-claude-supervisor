import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, lstat, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HOOK_TIMEOUT_SECONDS, type ClaudeHookEventName } from "./types.ts";

const HOOK_EVENT_NAMES: readonly ClaudeHookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "Notification",
];

interface HookCommandEntry {
  type: "command";
  command: string;
  timeout: number;
}

export interface HookSettingsDocument {
  hooks: Record<ClaudeHookEventName, Array<{ hooks: HookCommandEntry[] }>>;
}

/** A Claude Code settings document that runs `relayCommand` for every hook event the relay supports. */
export function hookSettingsDocument(relayCommand: string): HookSettingsDocument {
  const hooks = {} as HookSettingsDocument["hooks"];
  for (const name of HOOK_EVENT_NAMES) {
    hooks[name] = [{ hooks: [{ type: "command", command: relayCommand, timeout: HOOK_TIMEOUT_SECONDS }] }];
  }
  return { hooks };
}

/** Writes a standalone settings file (e.g. for `--settings <path>` on an owned interactive session). */
export async function writeHookSettingsFile(path: string, relayCommand: string): Promise<void> {
  const target = resolve(path);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (typeof process.getuid === "function" && parentInfo.uid !== process.getuid()) || (parentInfo.mode & 0o077) !== 0) {
    throw new Error("hook settings parent is not a private directory");
  }
  if (await realpath(parent) !== parent) throw new Error("hook settings parent contains a symlink");

  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("hook settings target is not a regular file");
    if (typeof process.getuid === "function" && existing.uid !== process.getuid()) throw new Error("hook settings target is owned by another user");
    if (existing.nlink > 1) throw new Error("hook settings target is a hard-link alias");
  } catch (error) {
    if (!(error instanceof Error) || !/ENOENT/u.test(error.message)) throw error;
  }

  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("secure hook settings writing is unavailable");
  const document = hookSettingsDocument(relayCommand);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
