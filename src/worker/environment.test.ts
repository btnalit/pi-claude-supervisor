import assert from "node:assert/strict";
import test from "node:test";
import { automaticClaudeArgs, automaticWorkerEnvironment, workerEnvironment } from "./environment.ts";

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
    GITHUB_TOKEN: "remote-token",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    AWS_ACCESS_KEY_ID: "cloud-key",
  });
  assert.equal(result.ANTHROPIC_API_KEY, "provider-key");
  assert.equal(result.GITHUB_TOKEN, undefined);
  assert.equal(result.SSH_AUTH_SOCK, undefined);
  assert.equal(result.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(result.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(result.GIT_CONFIG_COUNT, "3");
  assert.equal(result.GIT_SSH_COMMAND, "false");
  assert.equal(result.GIT_TERMINAL_PROMPT, "0");
});

test("automatic Claude args require a fail-closed sandbox", () => {
  const args = automaticClaudeArgs("/opt/claude", ["--permission-mode", "acceptEdits"]);
  assert.equal(args[args.length - 2], "--settings");
  const settings = JSON.parse(args.at(-1) ?? "{}") as { sandbox?: { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean; network?: { allowedDomains?: string[] } } };
  assert.deepEqual(settings.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [] },
  });
  assert.throws(() => automaticClaudeArgs("claude", ["--settings", "{}"]), /controls --settings/u);
  assert.deepEqual(automaticClaudeArgs("fixture", ["--settings", "{}"]), ["--settings", "{}"]);
});
