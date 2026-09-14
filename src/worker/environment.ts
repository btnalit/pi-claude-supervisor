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
 * admits only a direct Claude executable so this boundary cannot be silently
 * omitted by a custom Worker.
 */
export function automaticClaudeArgs(command: string, args: readonly string[] = []): string[] {
  const executable = command.split(/[\\/]/u).at(-1)?.toLowerCase();
  if (executable !== "claude" && executable !== "claude.exe") {
    throw new Error("automatic supervision requires a direct Claude executable with the fail-closed sandbox boundary");
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
