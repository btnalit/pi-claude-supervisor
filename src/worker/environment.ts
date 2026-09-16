import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

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

/**
 * Build the baseline Worker environment. The small inherited set keeps manual
 * embedding behavior stable; callers may add any explicit variables they need.
 */
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
 * Automatic mode intentionally does not filter credentials, network settings,
 * package-manager configuration or Claude extensions. It inherits the full
 * explicit environment so Claude Code, MCP servers and nested agents retain
 * their normal capabilities. CLAUDECODE is removed because Claude Code uses it
 * to reject a deliberately nested session; process/cgroup cleanup still owns
 * every descendant of the Worker.
 */
export function automaticWorkerEnvironment(
  explicit: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && name !== "CLAUDECODE") result[name] = value;
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (value !== undefined && name !== "CLAUDECODE") result[name] = value;
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
export function automaticClaudeArgs(command: string, args: readonly string[] = []): string[] {
  if (!isDirectClaudeName(command)) {
    throw new Error("automatic supervision requires the direct Claude executable command name; custom executable paths need their own host boundary");
  }
  const result = [...args];
  if (!result.some((value) => value === "--permission-mode" || value.startsWith("--permission-mode="))) {
    result.push("--permission-mode", "default");
  }
  return result;
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
      settings.push({ value: JSON.parse(value), label });
    } catch {
      try {
        settings.push({ value: JSON.parse(await readFile(value, "utf8")), label });
      } catch (error) {
        throw new Error(`automatic supervision could not inspect Claude settings (${label})`, { cause: error });
      }
    }
  }

  const effectiveHome = env.HOME?.trim() ? resolve(env.HOME) : homedir();
  const configDir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(effectiveHome, ".claude");
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
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      settings.push({ value, label: path });
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(error.message)) continue;
      throw new Error(`automatic supervision could not inspect Claude settings (${path})`, { cause: error });
    }
  }
  return settings;
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

/**
 * Resolve and pin the executable used by automatic mode before preflight and
 * spawn. A bare command is resolved from the supervisor's own PATH; explicit
 * paths and writable/untrusted executable locations are rejected. Operators
 * who do not want PATH to be the trust root can set
 * PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE to the expected executable path.
 */
export async function assertTrustedAutomaticClaudeExecutable(command: string, expectedPath?: string): Promise<string> {
  if (!isDirectClaudeName(command)) {
    throw new Error("automatic supervision requires the direct Claude executable command name; custom executable paths need their own host boundary");
  }
  const candidate = await resolveExecutable(command, process.env.PATH);
  if (!candidate) throw new Error("automatic supervision could not resolve the trusted Claude executable from PATH");
  const resolved = await realpath(candidate);
  await assertSecureExecutablePath(resolved);
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
  return resolved;
}

function isDirectClaudeName(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return false;
  const executable = command.toLowerCase();
  return executable === "claude" || executable === "claude.exe";
}

async function resolveExecutable(command: string, pathValue: string | undefined): Promise<string | undefined> {
  for (const directory of (pathValue ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
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
      if ((info.mode & 0o022) !== 0 || (uid !== undefined && info.uid !== uid && info.uid !== 0)) {
        throw new Error("a directory containing the resolved Claude executable is writable by or owned by an untrusted user");
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
}
