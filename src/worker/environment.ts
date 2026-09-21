import { constants as fsConstants, existsSync, statSync } from "node:fs";
import { access, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const MAX_CLAUDE_SETTINGS_BYTES = 4 * 1024 * 1024;

const inheritedNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
] as const;

// These variables can replace Git's command, repository, or transport
// boundary without appearing in argv. Automatic Workers start with a clean
// copy, and the granted publish command clears the same names again in case a
// Worker exported one during an earlier turn.
const unsafeGitEnvironment = /^(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|NAMESPACE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_GLOBAL|_SYSTEM|_NOSYSTEM|_COUNT|_KEY_\d+|_VALUE_\d+|_PARAMETERS)?|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|EXEC_PATH|TEMPLATE_DIR|SSH(?:_COMMAND|_VARIANT)?|ASKPASS|PROXY_COMMAND|EDITOR|SEQUENCE_EDITOR|EXTERNAL_DIFF|DIFF_OPTS|TRACE(?:2)?(?:_EVENTS)?|TRACE_PERFORMANCE|TRACE_SETUP|TRACE_PACKET|TRACE_PACK_ACCESS|TRACE_CURL(?:_NO_DATA)?|PUSH_OPTION(?:_\d+)?|PUSH_OPTION_COUNT)|GIT_SSH|SSH_ASKPASS)$/u;

/**
 * Build the baseline Worker environment. The small inherited set keeps manual
 * embedding behavior stable; callers may add any explicit variables they need.
 */
/**
 * Claude's configuration directory: `CLAUDE_CONFIG_DIR` when set, else
 * `~/.claude` under the effective home. One derivation for every place that
 * reasons about Claude's files, so a relocated config directory is honored
 * everywhere or nowhere.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const effectiveHome = env.HOME?.trim() ? resolve(env.HOME) : homedir();
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(effectiveHome, ".claude");
}

export function workerEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  explicit: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    if (inherited[name] !== undefined) result[name] = inherited[name];
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/**
 * Automatic mode preserves the operator's provider/network/package-manager
 * environment, but Supervisor-owned variables are never passed to Claude.
 * Those names include state directories, webhook URLs/secrets, authority and
 * control-plane settings; exposing them would let a Worker read or spoof the
 * Supervisor's own control plane. CLAUDECODE is also removed because Claude
 * Code uses it to reject a deliberately nested session.
 */
export function automaticWorkerEnvironment(
  explicit: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const allowed = (name: string): boolean => name !== "CLAUDECODE"
    && !name.startsWith("PI_CLAUDE_SUPERVISOR_")
    && !unsafeGitEnvironment.test(name);
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && allowed(name)) result[name] = value;
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (value !== undefined && allowed(name)) result[name] = value;
  }
  return result;
}

/**
 * Validate the executable identity used by automatic mode. Claude's normal
 * command-line arguments are otherwise left untouched: tool extensions,
 * agents, background tasks, MCP configuration and network access belong to
 * Claude Code's full development surface. A safe permission mode is added only
 * when the caller did not choose one; stream-json transport flags are added by
 * the adapter. The supervisor policy still blocks known remote push/main
 * integration and destructive operations.
 */
export interface AutomaticClaudeArgOptions {
  /** `--model` for the Worker; a user-supplied --model in args wins. */
  model?: string;
  /** `--autocompact <tokens>`; 0/undefined keeps Claude's default. */
  autocompactTokens?: number;
  /** `--max-budget-usd`; Claude stops the session itself once exceeded. */
  maxBudgetUsd?: number;
  /** `--strict-mcp-config --mcp-config <path>`; restricts the Worker to the listed MCP servers. */
  mcpConfigPath?: string;
}

export function automaticClaudeArgs(command: string, args: readonly string[] = [], options: AutomaticClaudeArgOptions = {}): string[] {
  if (!isDirectClaudeName(command)) {
    throw new Error("automatic supervision requires the direct Claude executable command name; custom executable paths need their own host boundary");
  }
  const result = [...args];
  if (!result.some((value) => value === "--permission-mode" || value.startsWith("--permission-mode="))) {
    result.push("--permission-mode", "default");
  }
  if (options.model && !hasFlag(result, "--model")) {
    result.push("--model", options.model);
  }
  if (options.autocompactTokens !== undefined && options.autocompactTokens !== 0) {
    if (!Number.isSafeInteger(options.autocompactTokens) || options.autocompactTokens < 100_000 || options.autocompactTokens > 1_000_000) {
      throw new Error("automatic supervision requires --autocompact between 100000 and 1000000 tokens");
    }
    if (!hasFlag(result, "--autocompact")) result.push("--autocompact", String(options.autocompactTokens));
  }
  if (options.maxBudgetUsd !== undefined && Number.isFinite(options.maxBudgetUsd) && options.maxBudgetUsd > 0 && !hasFlag(result, "--max-budget-usd")) {
    result.push("--max-budget-usd", String(options.maxBudgetUsd));
  }
  if (options.mcpConfigPath) {
    const resolvedPath = resolve(options.mcpConfigPath);
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
      throw new Error(`automatic supervision requires an existing --mcp-config file: ${resolvedPath}`);
    }
    if (!hasFlag(result, "--mcp-config")) {
      if (!result.includes("--strict-mcp-config")) result.push("--strict-mcp-config");
      result.push("--mcp-config", resolvedPath);
    }
  }
  return result;
}

/** True when args already sets `name` as `--flag value` or `--flag=value`. */
function hasFlag(args: readonly string[], name: string): boolean {
  const equalsPrefix = `${name}=`;
  return args.some((value) => value === name || value.startsWith(equalsPrefix));
}

/**
 * Claude can pre-authorize tools through CLI arguments or settings files. That
 * would prevent the Supervisor from seeing a Bash permission request before a
 * command runs, so automatic mode refuses Bash preauthorization while keeping
 * the Bash tool itself available through the normal host permission path.
 */
export async function assertAutomaticClaudePermissionConfiguration(
  cwd: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertNoCliBashPreauthorization(args);
  const cliPermissionMode = explicitPermissionMode(args);
  assertNoUnsafePermissionMode(args);
  for (const setting of await automaticClaudeSettings(cwd, args, env)) {
    if (hasBashPreauthorization(setting.value) || (cliPermissionMode === undefined && hasUnsafeSettingsPermissionMode(setting.value))) {
      throw new Error(`automatic supervision refuses Claude settings that bypass Supervisor Bash permission events (${setting.label})`);
    }
  }
}

function assertNoCliBashPreauthorization(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    const equalPrefix = value.match(/^--allowed(?:tools|[-_]tools?)=(.*)$/iu)?.[1];
    if (equalPrefix !== undefined && isBashToolRule(equalPrefix)) {
      throw new Error("automatic supervision refuses --allowedTools Bash preauthorization; Bash must remain visible to the Supervisor permission policy");
    }
    if (!/^--allowed(?:tools|[-_]tools?)$/iu.test(value)) continue;
    for (let next = index + 1; next < args.length && !args[next]!.startsWith("-"); next += 1) {
      if (isBashToolRule(args[next]!)) {
        throw new Error("automatic supervision refuses --allowedTools Bash preauthorization; Bash must remain visible to the Supervisor permission policy");
      }
    }
  }
}

function explicitPermissionMode(args: readonly string[]): string | undefined {
  let mode: string | undefined;
  let seen = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    const inline = value.match(/^--permission-mode=(.*)$/iu)?.[1];
    if (inline !== undefined) {
      if (seen) throw new Error("automatic supervision refuses duplicate --permission-mode arguments");
      if (!inline.trim()) throw new Error("automatic supervision refuses an empty --permission-mode value");
      seen = true;
      mode = inline;
      continue;
    }
    if (/^--permission-mode$/iu.test(value)) {
      if (seen) throw new Error("automatic supervision refuses duplicate --permission-mode arguments");
      const next = args[index + 1];
      if (next === undefined || next.startsWith("-")) throw new Error("automatic supervision refuses a missing --permission-mode value");
      seen = true;
      mode = next;
      index += 1;
    }
  }
  return mode;
}

function assertNoUnsafePermissionMode(args: readonly string[]): void {
  const mode = explicitPermissionMode(args);
  if (mode && isUnsafePermissionMode(mode)) {
    throw new Error(`automatic supervision refuses Claude permission mode ${mode}; the Supervisor must retain the host permission boundary`);
  }
}

async function automaticClaudeSettings(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Array<{ value: unknown; label: string }>> {
  const settings: Array<{ value: unknown; label: string }> = [];
  for (const { value, label } of explicitSettings(args, cwd)) {
    if (value !== null && typeof value === "object") {
      settings.push({ value, label });
      continue;
    }
    if (typeof value !== "string") throw new Error(`automatic supervision could not inspect Claude settings (${label})`);
    try {
      settings.push({ value: JSON.parse(await readClaudeSettingsFile(value)), label });
    } catch (error) {
      throw new Error(`automatic supervision could not inspect Claude settings (${label})`, { cause: error });
    }
  }

  const configDir = claudeConfigDir(env);
  const paths = new Set<string>([
    join(configDir, "settings.json"),
    "/etc/claude-code/managed-settings.json",
  ]);
  let directory = resolve(cwd);
  while (true) {
    paths.add(join(directory, ".claude", "settings.json"));
    paths.add(join(directory, ".claude", "settings.local.json"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const path of paths) {
    try {
      const value = JSON.parse(await readClaudeSettingsFile(path)) as unknown;
      settings.push({ value, label: path });
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) continue;
      throw new Error(`automatic supervision could not inspect Claude settings (${path})`, { cause: error });
    }
  }
  return settings;
}

async function readClaudeSettingsFile(path: string): Promise<string> {
  const resolved = await realpath(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Claude settings is not a regular file");
    if (typeof process.getuid === "function" && info.uid !== process.getuid() && info.uid !== 0) throw new Error("Claude settings is owned by an untrusted user");
    if ((info.mode & 0o022) !== 0) throw new Error("Claude settings is writable by an untrusted user");
    if (info.nlink > 1) throw new Error("Claude settings is a hard-link alias");
    if (info.size > MAX_CLAUDE_SETTINGS_BYTES) throw new Error("Claude settings exceeds the safe size limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
  } finally {
    await handle?.close().catch(() => {});
  }
}

function explicitSettings(args: readonly string[], cwd: string): Array<{ value: unknown; label: string }> {
  const values: Array<{ value: unknown; label: string }> = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const inline = argument.match(/^--settings=(.*)$/u)?.[1];
    const value = inline ?? (argument === "--settings" ? args[index + 1] : undefined);
    if (value === undefined) continue;
    if (inline === undefined) index += 1;
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) values.push({ value: JSON.parse(trimmed), label: "--settings JSON" });
    else values.push({ value: resolve(cwd, trimmed), label: `--settings ${trimmed}` });
  }
  return values;
}

function hasBashPreauthorization(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  if (isBashToolRule(settings.allowedTools)) return true;
  if (isBashToolRule(settings.permissions && typeof settings.permissions === "object"
    ? (settings.permissions as Record<string, unknown>).allow
    : undefined)) return true;
  return false;
}

function hasUnsafeSettingsPermissionMode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  const permissions = settings.permissions && typeof settings.permissions === "object"
    ? settings.permissions as Record<string, unknown>
    : undefined;
  return [settings.permissionMode, permissions?.defaultMode]
    .some((mode) => typeof mode === "string" && isUnsafePermissionMode(mode));
}

function isBashToolRule(value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => typeof item === "string"
    && item.split(/[\s,]+/u).some((rule) => /^Bash(?:$|\()/iu.test(rule)));
}

function isUnsafePermissionMode(value: string): boolean {
  const normalized = value.replace(/[-_]/gu, "").toLowerCase();
  return normalized === "auto" || normalized === "bypasspermissions" || normalized === "dontask";
}

/** The launch spelling and immutable identity of the Claude executable. */
export interface TrustedAutomaticClaudeExecutable {
  /** The PATH entry to execute. Keep a mise/asdf/npm shim's argv[0] intact. */
  launchCommand: string;
  /** The real file identity persisted across recovery. */
  resolvedPath: string;
}

/**
 * Resolve and pin the executable used by automatic mode before preflight and
 * spawn. A bare command is resolved from the supervisor's own PATH; explicit
 * paths and writable/untrusted executable locations are rejected. The launch
 * spelling is deliberately retained: realpath'ing a mise/asdf/npm shim before
 * spawn changes argv[0] and can make the version manager select a different
 * runtime or fail to locate Claude's resources. The realpath is the identity
 * that is persisted and compared on recovery.
 */
export async function trustedAutomaticClaudeExecutable(command: string, expectedPath?: string): Promise<TrustedAutomaticClaudeExecutable> {
  if (!isDirectClaudeName(command)) {
    throw new Error("automatic supervision requires the direct Claude executable command name; custom executable paths need their own host boundary");
  }
  const candidate = await resolveExecutable(command, process.env.PATH);
  if (!candidate) throw new Error("automatic supervision could not resolve the trusted Claude executable from PATH");
  const resolved = await realpath(candidate);
  // Check both spellings. stat follows a symlink, while the directory walk on
  // the launch spelling also protects the PATH shim directory from replacement.
  await assertSecureExecutablePath(candidate);
  if (candidate !== resolved) await assertSecureExecutablePath(resolved);
  const configured = expectedPath?.trim() || process.env.PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE?.trim();
  if (configured) {
    let expected: string;
    try {
      expected = await realpath(configured);
      await assertSecureExecutablePath(expected);
    } catch (error) {
      if (error instanceof Error && /writable|owned|regular file/u.test(error.message)) throw error;
      throw new Error("the expected Claude executable path is not a readable executable");
    }
    if (expected !== resolved) {
      throw new Error("resolved Claude executable does not match the expected pinned identity");
    }
  }
  return { launchCommand: candidate, resolvedPath: resolved };
}

/** Backwards-compatible identity-only assertion used by callers that do not spawn. */
export async function assertTrustedAutomaticClaudeExecutable(command: string, expectedPath?: string): Promise<string> {
  return (await trustedAutomaticClaudeExecutable(command, expectedPath)).resolvedPath;
}

/**
 * Resolve another Supervisor-owned helper without retaining a Worker-controlled
 * PATH spelling. Publish commands use this for `env`, `git` and (when needed)
 * `gh`; the resolved file and every containing directory must have the same
 * ownership/mode guarantees as the automatic Claude executable.
 */
export async function trustedExecutablePath(command: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/u.test(command)) throw new Error("Supervisor helper executable must be a bare command name");
  const candidate = await resolveExecutable(command, process.env.PATH);
  if (!candidate) throw new Error(`Supervisor helper executable could not be resolved from PATH: ${command}`);
  return trustedExecutableCandidate(candidate);
}

/** Verify an explicitly configured absolute helper, such as a test harness's tmux wrapper. */
export async function trustedAbsoluteExecutablePath(command: string): Promise<string> {
  if (!isAbsolute(command) || command.includes("\0")) throw new Error("Supervisor helper executable path must be absolute");
  return trustedExecutableCandidate(command);
}

async function trustedExecutableCandidate(candidate: string): Promise<string> {
  const resolved = await realpath(candidate);
  await assertSecureExecutablePath(candidate);
  if (candidate !== resolved) await assertSecureExecutablePath(resolved);
  return resolved;
}

function isDirectClaudeName(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return false;
  const executable = command.toLowerCase();
  return executable === "claude" || executable === "claude.exe";
}

async function resolveExecutable(command: string, pathValue: string | undefined): Promise<string | undefined> {
  for (const directory of (pathValue ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(resolve(directory), command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return undefined;
}

async function assertSecureExecutablePath(path: string): Promise<void> {
  await access(path, fsConstants.X_OK);
  const executable = await stat(path);
  if (!executable.isFile()) throw new Error("resolved Claude executable is not a regular file");
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if ((executable.mode & 0o022) !== 0 || (uid !== undefined && executable.uid !== uid && executable.uid !== 0)) {
      throw new Error("resolved Claude executable is writable by or owned by an untrusted user");
    }
    let directory = dirname(path);
    while (true) {
      const info = await stat(directory);
      const stickySharedDirectory = (info.mode & 0o1000) !== 0 && (info.mode & 0o002) !== 0 && info.uid === 0;
      if (((info.mode & 0o022) !== 0 && !stickySharedDirectory) || (uid !== undefined && info.uid !== uid && info.uid !== 0)) {
        throw new Error("a directory containing the resolved Claude executable is writable by or owned by an untrusted user");
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
}
