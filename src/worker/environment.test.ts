import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assertAutomaticClaudePermissionConfiguration, assertTrustedAutomaticClaudeExecutable, automaticClaudeArgs, automaticWorkerEnvironment, workerEnvironment } from "./environment.ts";

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

test("automatic Worker environment preserves credentials, helpers and custom settings", () => {
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
    CLAUDECODE: "1",
  }, {
    PATH: "/bin",
    BASE_ONLY_SETTING: "inherited",
    CLAUDECODE: "parent",
  });
  assert.equal(result.ANTHROPIC_API_KEY, "provider-key");
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, "oauth-token");
  assert.equal(result.GITHUB_TOKEN, "remote-token");
  assert.equal(result.SSH_AUTH_SOCK, "/tmp/agent.sock");
  assert.equal(result.AWS_ACCESS_KEY_ID, "cloud-key");
  assert.equal(result.GH_ENTERPRISE_TOKEN, "enterprise-token");
  assert.equal(result.GITHUB_ENTERPRISE_TOKEN, "github-enterprise-token");
  assert.equal(result.CODEARTIFACT_AUTH_TOKEN, "registry-token");
  assert.equal(result.HUGGINGFACE_TOKEN, "hub-token");
  assert.equal(result.GIT_CONFIG_PARAMETERS, "credential.helper=store");
  assert.equal(result.RANDOM_LOCAL_SETTING, "not-allowlisted");
  assert.equal(result.PATH, "/bin");
  assert.equal(result.BASE_ONLY_SETTING, "inherited");
  assert.equal(result.CLAUDECODE, undefined);
  assert.equal(result.GIT_CONFIG_NOSYSTEM, undefined);
  assert.equal(result.GIT_SSH_COMMAND, undefined);
  assert.equal(result.GIT_TERMINAL_PROMPT, undefined);
});

test("automatic Claude args preserve the full Claude Code argument surface", () => {
  const original = ["--permission-mode", "acceptEdits", "--settings", "{}", "--tools", "default", "--agent", "test", "--plugin-dir", "/tmp/plugin", "--resume", "session-id"];
  assert.deepEqual(automaticClaudeArgs("claude", original), original);
  assert.deepEqual(automaticClaudeArgs("claude", ["--settings", "{}"]).slice(-2), ["--permission-mode", "default"]);

  assert.deepEqual(automaticClaudeArgs("claude", ["--allowedTools", "Task", "MCP"]), ["--allowedTools", "Task", "MCP", "--permission-mode", "default"]);
  assert.throws(() => automaticClaudeArgs("/tmp/attacker/claude"), /direct Claude executable/u);
  assert.throws(() => automaticClaudeArgs("fixture", ["--settings", "{}"]), /direct Claude executable/u);
});

test("automatic Claude permission configuration rejects Bash preauthorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-permission-config-"));
  const configDir = join(root, "config");
  const cwd = join(root, "repo");
  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(join(cwd, ".claude"), { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: configDir };
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, ["--allowedTools", "Bash"], env),
      /Bash preauthorization/u,
    );
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, ["--allowedTools=Bash(git status)"], env),
      /Bash preauthorization/u,
    );
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, ["--settings", JSON.stringify({ permissions: { allow: ["Bash(git status)"] } })], env),
      /Bash permission events/u,
    );
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, ["--permission-mode", "auto"], env),
      /permission mode auto/u,
    );
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, ["--permission-mode", "default", "--permission-mode=bypassPermissions"], env),
      /duplicate --permission-mode/u,
    );
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, ["--permission-mode", "default", "--permission-mode", "auto"], env),
      /duplicate --permission-mode/u,
    );
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, ["--permission-mode"], env),
      /missing --permission-mode/u,
    );
    await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "auto" } }));
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, [], env),
      /Bash permission events/u,
    );
    await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, ["--permission-mode", "default"], env),
      /Bash permission events/u,
    );
    await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Edit"] } }));
    await assert.doesNotReject(() => assertAutomaticClaudePermissionConfiguration(cwd, ["--permission-mode", "default"], env));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic permission checks use the effective HOME settings root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-permission-home-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  try {
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }));
    await assert.rejects(
      () => assertAutomaticClaudePermissionConfiguration(cwd, [], { HOME: home }),
      /Bash permission events/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic mode rejects an explicit executable path before resolution", async () => {
  await assert.rejects(() => assertTrustedAutomaticClaudeExecutable("/tmp/attacker/claude"), /direct Claude executable/u);
});

test("automatic mode rejects a recovery executable identity mismatch", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".pi-claude-supervisor-expected-"));
  const expectedPath = join(directory, "expected-claude");
  try {
    await writeFile(expectedPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await assert.rejects(() => assertTrustedAutomaticClaudeExecutable("claude", expectedPath), /expected pinned identity/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
