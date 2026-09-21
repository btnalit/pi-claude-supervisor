import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * Pi's distributed Linux executable is a Bun-compiled binary. In that mode
 * process.execPath points to `pi`, not to a JavaScript runtime that accepts
 * `-e`. Worker containment helpers are still Node scripts, so resolve a real
 * Node executable before launching them.
 */
export function nodeScriptCommand(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string {
  const configured = env.PI_CLAUDE_SUPERVISOR_NODE?.trim();
  if (configured) {
    const resolved = findExecutable(configured, env.PATH);
    if (!resolved) throw new Error(`configured Node runtime is not executable: ${configured}`);
    assertTrustedExecutable(resolved);
    return resolved;
  }

  if (!process.versions.bun && isNodeExecutable(execPath)) {
    assertTrustedExecutable(execPath);
    return execPath;
  }

  const names = process.platform === "win32" ? ["node.exe", "node.cmd", "node"] : ["node", "nodejs"];
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) {
        assertTrustedExecutable(candidate);
        return candidate;
      }
    }
  }

  throw new Error("Pi is not running on Node and no Node executable was found; put node on PATH or set PI_CLAUDE_SUPERVISOR_NODE");
}

function findExecutable(value: string, pathValue: string | undefined): string | undefined {
  if (isAbsolute(value) || value.includes("/") || value.includes("\\")) return isExecutable(value) ? value : undefined;
  for (const directory of (pathValue ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, value);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assertTrustedExecutable(path: string): void {
  if (process.platform === "win32") return;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const paths = new Set([path, realpathSync(path)]);
  for (const candidate of paths) {
    const executable = statSync(candidate);
    if (!executable.isFile() || executable.nlink !== 1 || (executable.mode & 0o022) !== 0 || (uid !== undefined && executable.uid !== uid && executable.uid !== 0)) {
      throw new Error(`Node runtime is writable by or owned by an untrusted user: ${candidate}`);
    }
    let directory = dirname(candidate);
    while (true) {
      const info = statSync(directory);
      if ((info.mode & 0o022) !== 0 || (uid !== undefined && info.uid !== uid && info.uid !== 0)) {
        throw new Error(`a directory containing the Node runtime is writable by or owned by an untrusted user: ${directory}`);
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
}

function isNodeExecutable(path: string): boolean {
  return /^(?:node|nodejs)(?:\.exe)?$/iu.test(basename(path));
}
