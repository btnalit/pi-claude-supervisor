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
 * Build a least-privilege worker environment. Credentials and arbitrary host
 * variables are not inherited unless the caller explicitly supplies them.
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
 * Restrict explicit variables supplied to an unattended Worker. This is not a
 * network sandbox, but it removes common remote-repository credentials and
 * disables the Git/package-manager credential helpers before command policy
 * gets a chance to inspect a structured Bash request.
 */
export function automaticWorkerEnvironment(explicit: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(explicit)) {
    if (value !== undefined && isAutomaticAllowedName(name) && (!isRemoteCredentialName(name) || isProviderCredentialName(name))) result[name] = value;
  }
  result.GIT_CONFIG_NOSYSTEM = "1";
  result.GIT_CONFIG_SYSTEM = process.platform === "win32" ? "NUL" : "/dev/null";
  result.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  result.GIT_CONFIG_COUNT = "3";
  result.GIT_CONFIG_KEY_0 = "credential.helper";
  result.GIT_CONFIG_VALUE_0 = "";
  result.GIT_CONFIG_KEY_1 = "http.proxy";
  result.GIT_CONFIG_VALUE_1 = "http://127.0.0.1:9";
  result.GIT_CONFIG_KEY_2 = "https.proxy";
  result.GIT_CONFIG_VALUE_2 = "http://127.0.0.1:9";
  result.GIT_TERMINAL_PROMPT = "0";
  result.GIT_SSH_COMMAND = "false";
  result.GH_CONFIG_DIR = process.platform === "win32" ? "NUL" : "/dev/null";
  result.NPM_CONFIG_USERCONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
  result.npm_config_userconfig = result.NPM_CONFIG_USERCONFIG;
  return result;
}

/**
 * Ask Claude Code to sandbox Bash and its descendants. The API process keeps
 * its provider connection, while Worker-launched commands get no outbound
 * network and cannot silently fall back to an unsandboxed shell. Automatic mode
 * admits only the direct Claude command name. Startup resolves and pins its
 * operator-owned executable path so a custom path or writable replacement
 * cannot silently omit this boundary.
 */
export function automaticClaudeArgs(command: string, args: readonly string[] = []): string[] {
  if (!isDirectClaudeName(command)) {
    throw new Error("automatic supervision requires the direct Claude executable command name; custom executable paths need their own host boundary");
  }
  if (args.some((arg) => arg === "--settings" || arg.startsWith("--settings="))) {
    throw new Error("automatic Claude supervision controls --settings; remove the caller-provided settings override");
  }
  return [
    ...args,
    "--settings",
    JSON.stringify({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: [] },
      },
    }),
  ];
}

/**
 * Resolve and pin the executable used by automatic mode before preflight and
 * spawn. A bare command is resolved from the supervisor's own PATH; explicit
 * paths and writable/untrusted executable locations are rejected. Operators
 * who do not want PATH to be the trust root can set
 * PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE to the expected executable path.
 */
export async function assertTrustedAutomaticClaudeExecutable(command: string): Promise<string> {
  if (!isDirectClaudeName(command)) {
    throw new Error("automatic supervision requires the direct Claude executable command name; custom executable paths need their own host boundary");
  }
  const candidate = await resolveExecutable(command, process.env.PATH);
  if (!candidate) throw new Error("automatic supervision could not resolve the trusted Claude executable from PATH");
  const resolved = await realpath(candidate);
  await assertSecureExecutablePath(resolved);
  const configured = process.env.PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE?.trim();
  if (configured) {
    let expected: string;
    try {
      expected = await realpath(configured);
    } catch {
      throw new Error("PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE is not a readable executable path");
    }
    if (expected !== resolved) {
      throw new Error("resolved Claude executable does not match PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE");
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

const automaticEnvironmentAllowlist = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_SDK_LOAD_CONFIG",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_REGION",
  "CLOUD_ML_REGION",
  "NO_COLOR",
  "CI",
]);

function isAutomaticAllowedName(name: string): boolean {
  return automaticEnvironmentAllowlist.has(name);
}

function isProviderCredentialName(name: string): boolean {
  return name === "ANTHROPIC_API_KEY" || name === "ANTHROPIC_AUTH_TOKEN" || name === "CLAUDE_CODE_OAUTH_TOKEN";
}

export function isRemoteCredentialName(name: string): boolean {
  if (isProviderCredentialName(name)) return false;
  return /^(?:SSH_AUTH_SOCK|GIT_ASKPASS|GIT_SSH_COMMAND|GIT_CREDENTIAL_HELPER|GIT_CONFIG(?:_|$)|GH_CONFIG_DIR|NPM_CONFIG_USERCONFIG|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_ID|AZURE_CLIENT_SECRET|AZURE_TENANT_ID|GOOGLE_APPLICATION_CREDENTIALS|KUBECONFIG)$/iu.test(name)
    || /(?:^|_)(?:GITHUB|GH|GITLAB|BITBUCKET|NPM|NODE_AUTH|CODEARTIFACT|HUGGINGFACE|DOCKER|AWS|AZURE|GOOGLE|CI_JOB)(?:_|$)/iu.test(name)
    || /(?:^|_)(?:TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN|API_KEY|CREDENTIALS?)(?:_|$)/iu.test(name);
}
