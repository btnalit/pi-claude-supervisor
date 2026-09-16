import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";

export const MIN_SUPPORTED_CLAUDE_VERSION = "2.1.270";

/**
 * Resolve the current Claude executable from PATH unless an explicit test
 * override is supplied. This intentionally follows an installer-managed
 * `latest` link instead of naming a versioned installation directory.
 */
export function resolveClaudeExecutable(explicitPath = process.env.PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_PATH, pathValue = process.env.PATH) {
  const configured = explicitPath?.trim();
  if (configured) return configured;
  const names = process.platform === "win32" ? ["claude.exe", "claude"] : ["claude"];
  for (const directory of (pathValue ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH until the current Claude installation is found.
      }
    }
  }
  throw new Error("could not resolve Claude executable from PATH; set PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_PATH to override");
}

export function parseClaudeCodeVersion(output) {
  const match = String(output).match(/(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:\b|$)/u);
  if (!match) throw new Error(`could not parse Claude Code version from --version output: ${String(output).trim()}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareClaudeVersions(left, right) {
  for (const component of ["major", "minor", "patch"]) {
    if (left[component] !== right[component]) return left[component] - right[component];
  }
  return 0;
}

/** Accept the compatibility floor and all newer Claude Code releases. */
export function assertSupportedClaudeVersion(output, minimum = MIN_SUPPORTED_CLAUDE_VERSION) {
  const actual = parseClaudeCodeVersion(output);
  const floor = parseClaudeCodeVersion(minimum);
  if (compareClaudeVersions(actual, floor) < 0) {
    throw new Error(`Claude Code >= ${minimum} is required; detected ${formatClaudeVersion(actual)}`);
  }
  return actual;
}

export function formatClaudeVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}
