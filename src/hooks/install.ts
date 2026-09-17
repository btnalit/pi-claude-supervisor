import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HOOK_TIMEOUT_SECONDS, type ClaudeHookEventName } from "./types.ts";
import { HOOK_RELAY_SCRIPT, hookRelayCommand } from "./relay.ts";
import { hookSocketDirectory } from "./server.ts";

const HOOK_EVENT_NAMES: readonly ClaudeHookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "Stop",
  "Notification",
];

/** Substring that marks a hook command entry as ours, regardless of which stateDir produced it. */
const RELAY_MARKER = "/hooks/relay.js";

interface HookEntry {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  hooks?: HookEntry[];
  [key: string]: unknown;
}

interface SettingsDocument {
  hooks?: Partial<Record<string, HookGroup[]>>;
  [key: string]: unknown;
}

export interface InstallHookOptions {
  /** Defaults to ~/.claude/settings.json (the user scope). */
  settingsPath?: string;
  stateDir: string;
}

export interface InstallHookResult {
  changed: boolean;
  settingsPath: string;
  relayPath: string;
}

/** Writes the relay script and registers it for all seven hook events in the user's Claude Code settings. */
export async function installUserHooks(options: InstallHookOptions): Promise<InstallHookResult> {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const relayPath = join(hookSocketDirectory(options.stateDir), "relay.js");
  await writeRelayScript(relayPath);
  const relayCommand = hookRelayCommand(relayPath);
  const changed = await mutateSettings(settingsPath, (document) => addRelayHooks(document, relayCommand));
  return { changed, settingsPath, relayPath };
}

/** Removes only our relay entries from the user's Claude Code settings; every other hook is left untouched. */
export async function uninstallUserHooks(options: InstallHookOptions): Promise<InstallHookResult> {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const relayPath = join(hookSocketDirectory(options.stateDir), "relay.js");
  const changed = await mutateSettings(settingsPath, (document) => removeRelayHooks(document));
  return { changed, settingsPath, relayPath };
}

function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

async function writeRelayScript(relayPath: string): Promise<void> {
  await mkdir(dirname(relayPath), { recursive: true, mode: 0o700 });
  const temporary = `${relayPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, HOOK_RELAY_SCRIPT, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, relayPath);
  await chmod(relayPath, 0o600);
}

function addRelayHooks(document: SettingsDocument, relayCommand: string): boolean {
  const hooks = isPlainRecord(document.hooks) ? document.hooks : {};
  document.hooks = hooks;
  let changed = false;
  for (const name of HOOK_EVENT_NAMES) {
    const groups = Array.isArray(hooks[name]) ? hooks[name]! : [];
    hooks[name] = groups;
    let matched = false;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      for (const entry of group.hooks) {
        if (typeof entry.command !== "string" || !entry.command.includes(RELAY_MARKER)) continue;
        matched = true;
        if (entry.type !== "command" || entry.command !== relayCommand || entry.timeout !== HOOK_TIMEOUT_SECONDS) {
          entry.type = "command";
          entry.command = relayCommand;
          entry.timeout = HOOK_TIMEOUT_SECONDS;
          changed = true;
        }
      }
    }
    if (!matched) {
      groups.push({ hooks: [{ type: "command", command: relayCommand, timeout: HOOK_TIMEOUT_SECONDS }] });
      changed = true;
    }
  }
  return changed;
}

function removeRelayHooks(document: SettingsDocument): boolean {
  if (!isPlainRecord(document.hooks)) return false;
  const hooks = document.hooks;
  let changed = false;
  for (const name of HOOK_EVENT_NAMES) {
    const groups = hooks[name];
    if (!Array.isArray(groups)) continue;
    const nextGroups: HookGroup[] = [];
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) {
        nextGroups.push(group);
        continue;
      }
      const nextEntries = group.hooks.filter((entry) => !(typeof entry.command === "string" && entry.command.includes(RELAY_MARKER)));
      if (nextEntries.length !== group.hooks.length) changed = true;
      if (nextEntries.length > 0) nextGroups.push({ ...group, hooks: nextEntries });
    }
    if (nextGroups.length !== groups.length) changed = true;
    if (nextGroups.length > 0) hooks[name] = nextGroups;
    else delete hooks[name];
  }
  return changed;
}

function isPlainRecord(value: unknown): value is Record<string, HookGroup[]> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads, mutates, and atomically rewrites the settings file. A missing file
 * starts from `{}`; invalid JSON (or a non-object document) is never
 * overwritten — it throws instead so the caller can surface the problem.
 */
async function mutateSettings(settingsPath: string, mutate: (document: SettingsDocument) => boolean): Promise<boolean> {
  let document: SettingsDocument = {};
  let mode = 0o600;
  try {
    const raw = await readFile(settingsPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`hook settings file is not valid JSON, refusing to modify it: ${settingsPath}`);
    }
    if (!isPlainRecord(parsed)) {
      throw new Error(`hook settings file does not contain a JSON object, refusing to modify it: ${settingsPath}`);
    }
    document = parsed as SettingsDocument;
    mode = (await stat(settingsPath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") document = {};
    else throw error;
  }

  const changed = mutate(document);
  if (!changed) return false;

  // A dotfile-managed settings file is often a symlink; rename onto the
  // symlink path itself would replace it with a plain file and silently
  // detach it from its managed source. Write through to the real target.
  const target = await realpath(settingsPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return settingsPath;
    throw error;
  });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode, flag: "wx" });
  await rename(temporary, target);
  await chmod(target, mode);
  return true;
}
