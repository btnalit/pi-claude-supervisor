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
    if (value !== undefined && !isRemoteCredentialName(name)) result[name] = value;
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
 * network and cannot silently fall back to an unsandboxed shell. A caller may
 * still use a non-Claude test executable; built-in Claude workers are required
 * to use this boundary in automatic mode.
 */
export function automaticClaudeArgs(command: string, args: readonly string[] = []): string[] {
  const executable = command.split(/[\\/]/u).at(-1)?.toLowerCase();
  if (executable !== "claude" && executable !== "claude.exe") return [...args];
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

export function isRemoteCredentialName(name: string): boolean {
  return /^(?:GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|BITBUCKET_TOKEN|CI_JOB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|SSH_AUTH_SOCK|GIT_ASKPASS|GIT_SSH_COMMAND|GIT_CREDENTIAL_HELPER|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_ID|AZURE_CLIENT_SECRET|AZURE_TENANT_ID|GOOGLE_APPLICATION_CREDENTIALS|KUBECONFIG)$/iu.test(name)
    || /(?:^|_)(?:GITHUB|GITLAB|BITBUCKET|NPM|AWS|AZURE|GOOGLE|CI_JOB)(?:_|$)/iu.test(name);
}
