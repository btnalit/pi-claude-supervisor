import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
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
  "StopFailure",
  "Notification",
];

/** Substring that marks a hook command entry as ours, regardless of which stateDir produced it. */
const RELAY_MARKER = "/hooks/relay.js";
/** Only an entry that is exactly `<quoted node> <quoted .../hooks/relay.js>` is ours; a personal script that merely contains the substring is not. */
const RELAY_COMMAND_PATTERN = /^(?:'[^']*'|"[^"]*"|\S+) (?:'([^']*\/hooks\/relay\.js)'|"([^"]*\/hooks\/relay\.js)"|(\S*\/hooks\/relay\.js))$/u;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

function isRelayEntry(command: unknown, expectedRelayPath: string): command is string {
  if (typeof command !== "string" || !command.includes(RELAY_MARKER)) return false;
  const trimmed = command.trim();
  if (!RELAY_COMMAND_PATTERN.test(trimmed)) return false;
  const executableMatch = /^(?:'([^']*)'|"([^"]*)"|(\S+)) /u.exec(trimmed);
  const relayMatch = / (?:'([^']*\/hooks\/relay\.js)'|"([^"]*\/hooks\/relay\.js)"|(\S*\/hooks\/relay\.js))$/u.exec(trimmed);
  const executable = executableMatch?.[1] ?? executableMatch?.[2] ?? executableMatch?.[3];
  const relayPath = relayMatch?.[1] ?? relayMatch?.[2] ?? relayMatch?.[3];
  return Boolean(executable && relayPath && /^(?:node|nodejs)(?:\.exe|\.cmd)?$/iu.test(basename(executable)) && isAbsolute(relayPath) && relayPath === expectedRelayPath);
}

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
  const changed = await mutateSettings(settingsPath, (document) => addRelayHooks(document, relayCommand, relayPath));
  return { changed, settingsPath, relayPath };
}

/** Removes only our relay entries from the user's Claude Code settings; every other hook is left untouched. */
export async function uninstallUserHooks(options: InstallHookOptions): Promise<InstallHookResult> {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const relayPath = join(hookSocketDirectory(options.stateDir), "relay.js");
  const changed = await mutateSettings(settingsPath, (document) => removeRelayHooks(document, relayPath));
  return { changed, settingsPath, relayPath };
}

function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

async function writeRelayScript(relayPath: string): Promise<void> {
  const directory = dirname(relayPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error(`hook relay directory is not a real directory: ${directory}`);
  if (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid()) throw new Error(`hook relay directory is owned by another user: ${directory}`);
  if (await realpath(directory) !== directory) throw new Error(`hook relay directory contains a symlink: ${directory}`);
  await chmod(directory, 0o700);
  try {
    const existing = await lstat(relayPath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`hook relay target is not a regular file: ${relayPath}`);
    if (typeof process.getuid === "function" && existing.uid !== process.getuid()) throw new Error(`hook relay target is owned by another user: ${relayPath}`);
    if (existing.nlink > 1) throw new Error(`hook relay target is a hard-link alias: ${relayPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("secure hook relay writing is unavailable");
  const temporary = `${relayPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(HOOK_RELAY_SCRIPT, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    await rename(temporary, relayPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function addRelayHooks(document: SettingsDocument, relayCommand: string, relayPath: string): boolean {
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
        if (!isRelayEntry(entry.command, relayPath)) continue;
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

function removeRelayHooks(document: SettingsDocument, relayPath: string): boolean {
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
      const nextEntries = group.hooks.filter((entry) => !isRelayEntry(entry.command, relayPath));
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
  const requested = resolve(settingsPath);
  let target = requested;
  let document: SettingsDocument = {};
  try {
    target = await realpath(requested);
    const raw = await readSettingsFile(target);
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    target = requested;
  }

  const changed = mutate(document);
  if (!changed) return false;

  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = dirname(target);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`hook settings parent is not a real directory: ${parent}`);
  if (typeof process.getuid === "function" && parentInfo.uid !== process.getuid()) throw new Error(`hook settings parent is owned by another user: ${parent}`);
  if ((parentInfo.mode & 0o077) !== 0) throw new Error(`hook settings parent is not private: ${parent}`);
  if (await realpath(parent) !== parent) throw new Error(`hook settings parent contains a symlink: ${parent}`);
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw new Error(`hook settings target is not a regular file: ${target}`);
    if (typeof process.getuid === "function" && targetInfo.uid !== process.getuid()) throw new Error(`hook settings target is owned by another user: ${target}`);
    if (targetInfo.nlink > 1) throw new Error(`hook settings target is a hard-link alias: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readSettingsFile(path: string): Promise<string> {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("secure hook settings reading is unavailable");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`hook settings file is not a regular file: ${path}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`hook settings file is owned by another user: ${path}`);
    if (info.nlink > 1) throw new Error(`hook settings file is a hard-link alias: ${path}`);
    if (info.size > MAX_SETTINGS_BYTES) throw new Error(`hook settings file exceeds the safe size limit: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
  } finally {
    await handle.close().catch(() => {});
  }
}
