import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CLAUDE_HOOK_EVENT_NAMES, HOOK_TIMEOUT_SECONDS, type ClaudeHookEventName } from "./types.ts";

const HOOK_EVENT_NAMES: readonly ClaudeHookEventName[] = CLAUDE_HOOK_EVENT_NAMES;

interface HookCommandEntry {
  type: "command";
  command: string;
  timeout: number;
}

export interface HookSettingsDocument {
  hooks: Record<ClaudeHookEventName, Array<{ hooks: HookCommandEntry[] }>>;
  /**
   * Off for a supervised session: a suggestion is ghost text in the input
   * box, which reads as leftover input and holds every send back.
   */
  promptSuggestionEnabled: false;
}

/** A Claude Code settings document for a supervised session: runs `relayCommand` for every hook event the relay supports. */
export function hookSettingsDocument(relayCommand: string): HookSettingsDocument {
  const hooks = {} as HookSettingsDocument["hooks"];
  for (const name of HOOK_EVENT_NAMES) {
    hooks[name] = [{ hooks: [{ type: "command", command: relayCommand, timeout: HOOK_TIMEOUT_SECONDS }] }];
  }
  return { hooks, promptSuggestionEnabled: false };
}

/** Writes a standalone settings file (e.g. for `--settings <path>` on an owned interactive session). */
export async function writeHookSettingsFile(path: string, relayCommand: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const document = hookSettingsDocument(relayCommand);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
