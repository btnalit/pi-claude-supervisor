import assert from "node:assert/strict";
import test from "node:test";
import { assertTrustedAutomaticClaudeExecutable, automaticClaudeArgs, automaticWorkerEnvironment, workerEnvironment } from "./environment.ts";

test("worker environment keeps essentials and excludes unrelated credentials", () => {
  const result = workerEnvironment(
    { PATH: "/bin", HOME: "/home/test", ANTHROPIC_API_KEY: "secret", RANDOM_TOKEN: "hidden" },
    { ANTHROPIC_API_KEY: "explicit" },
  );
  assert.equal(result.PATH, "/bin");
  assert.equal(result.HOME, "/home/test");
  assert.equal(result.ANTHROPIC_API_KEY, "explicit");
  assert.equal(result.RANDOM_TOKEN, undefined);
});

test("automatic Worker environment strips remote credentials and credential helpers", () => {
  const result = automaticWorkerEnvironment({
    ANTHROPIC_API_KEY: "provider-key",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    GITHUB_TOKEN: "remote-token",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    AWS_ACCESS_KEY_ID: "cloud-key",
    GH_ENTERPRISE_TOKEN: "enterprise-token",
    GITHUB_ENTERPRISE_TOKEN: "github-enterprise-token",
    CODEARTIFACT_AUTH_TOKEN: "registry-token",
    HUGGINGFACE_TOKEN: "hub-token",
    GIT_CONFIG_PARAMETERS: "credential.helper=store",
    RANDOM_LOCAL_SETTING: "not-allowlisted",
  });
  assert.equal(result.ANTHROPIC_API_KEY, "provider-key");
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, "oauth-token");
  assert.equal(result.GITHUB_TOKEN, undefined);
  assert.equal(result.SSH_AUTH_SOCK, undefined);
  assert.equal(result.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(result.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(result.GITHUB_ENTERPRISE_TOKEN, undefined);
  assert.equal(result.CODEARTIFACT_AUTH_TOKEN, undefined);
  assert.equal(result.HUGGINGFACE_TOKEN, undefined);
  assert.equal(result.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(result.RANDOM_LOCAL_SETTING, undefined);
  assert.equal(result.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(result.GIT_CONFIG_COUNT, "3");
  assert.equal(result.GIT_SSH_COMMAND, "false");
  assert.equal(result.GIT_TERMINAL_PROMPT, "0");
});

test("automatic Claude args require a fail-closed sandbox", () => {
  const args = automaticClaudeArgs("claude", ["--permission-mode", "acceptEdits"]);
  assert.equal(args[args.length - 2], "--settings");
  const settings = JSON.parse(args.at(-1) ?? "{}") as { sandbox?: { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean; network?: { allowedDomains?: string[] } } };
  assert.deepEqual(settings.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [] },
  });
  assert.throws(() => automaticClaudeArgs("claude", ["--settings", "{}"]), /controls --settings/u);
  assert.throws(() => automaticClaudeArgs("/tmp/attacker/claude"), /direct Claude executable/u);
  assert.throws(() => automaticClaudeArgs("fixture", ["--settings", "{}"]), /direct Claude executable/u);
});

test("automatic mode rejects an explicit executable path before resolution", async () => {
  await assert.rejects(() => assertTrustedAutomaticClaudeExecutable("/tmp/attacker/claude"), /direct Claude executable/u);
});

test("automatic mode rejects a recovery executable identity mismatch", async () => {
  await assert.rejects(() => assertTrustedAutomaticClaudeExecutable("claude", process.execPath), /expected pinned identity/u);
});
