import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const allowed = new Set([
  "PI_CLAUDE_SUPERVISOR_MODE",
  "PI_CLAUDE_SUPERVISOR_AUTOMATION",
  "PI_CLAUDE_SUPERVISOR_TRANSPORT",
  "PI_CLAUDE_SUPERVISOR_WORKER",
  "PI_CLAUDE_SUPERVISOR_STATE_DIR",
  "PI_CLAUDE_SUPERVISOR_WORKER_ENV",
  "PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL",
  "PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT",
  "PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_SECRET",
]);

export function loadSupervisorEnvironment(): string | undefined {
  const path = process.env.PI_CLAUDE_SUPERVISOR_ENV_FILE ?? join(homedir(), ".config", "pi-claude-supervisor", "env");
  if (!existsSync(path)) return undefined;
  try {
    const contents = readFileSync(path, "utf8");
    // Best effort: the file is local configuration, never a repository asset.
    try { chmodSync(path, 0o600); } catch { /* read-only filesystems may reject chmod */ }
    for (const line of contents.split(/\r?\n/u)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
      if (!match || !allowed.has(match[1]) || process.env[match[1]] !== undefined) continue;
      const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
      process.env[match[1]] = value;
    }
    return path;
  } catch (error) {
    console.error(`pi-claude-supervisor could not read env file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
