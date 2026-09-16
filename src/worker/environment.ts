import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

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
export function automaticWorkerEnvironment(explicit: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(explicit)) {
    if (value !== undefined && name !== "CLAUDECODE") result[name] = value;
  }
  return result;
}

/**
 * Validate the executable identity used by automatic mode. Claude's normal
 * command-line arguments are otherwise left untouched: tool extensions,
 * agents, background tasks, MCP configuration and network access belong to
 * Claude Code's full development surface. Stream-json transport flags are
 * added by the adapter, while the supervisor policy still blocks known remote
 * push/main integration and destructive operations.
 */
export function automaticClaudeArgs(command: string, args: readonly string[] = []): string[] {
  if (!isDirectClaudeName(command)) {
    throw new Error("automatic supervision requires the direct Claude executable command name; custom executable paths need their own host boundary");
  }
  return [...args];
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
