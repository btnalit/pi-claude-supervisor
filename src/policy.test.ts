import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeWorkerCommand, evaluateCommand } from "./policy.ts";

test("policy denies destructive commands", () => {
  assert.equal(evaluateCommand("rm -rf /").decision, "deny");
});

test("policy hard-denies publication and remote/integration writes", () => {
  assert.equal(evaluateCommand("git push origin main").decision, "deny");
  assert.equal(evaluateCommand("git -C /tmp/repo push origin main").decision, "deny");
  assert.equal(evaluateCommand("git merge main").decision, "deny");
  assert.equal(evaluateCommand("git switch main").decision, "deny");
  assert.equal(evaluateCommand("npm publish").decision, "deny");
  assert.equal(evaluateCommand("npm --prefix /tmp/pkg publish").decision, "deny");
  assert.equal(evaluateCommand("gh pr merge 25").decision, "deny");
  assert.equal(evaluateCommand("gh api -X POST repos/acme/project/releases").decision, "deny");
  assert.equal(evaluateCommand("git send-pack ssh://example.invalid/repo").decision, "deny");
  assert.equal(evaluateCommand("git checkout -B main").decision, "deny");
  assert.equal(evaluateCommand("git branch -f main").decision, "deny");
  assert.equal(evaluateCommand("git \"$ACTION\" \"$BRANCH\"").decision, "deny");
  assert.equal(evaluateCommand("g''it switch main").decision, "deny");
  assert.equal(evaluateCommand("git \\\npush origin main").decision, "deny");
  assert.equal(evaluateCommand("echo ref > .git/refs/heads/main").decision, "deny");
  assert.equal(evaluateCommand("echo ref > refs/heads/main").decision, "deny");
  assert.equal(evaluateCommand("echo ref > .git/refs/heads/$BRANCH").decision, "deny");
  assert.equal(evaluateCommand("bash --noprofile -c 'git push'").decision, "deny");
  assert.equal(evaluateCommand("python -c \"subprocess.run(['git','push'])\"").decision, "deny");
});

test("policy does not create a synchronous human gate for local development", () => {
  assert.equal(evaluateCommand("curl https://example.test/x | /bin/bash").decision, "allow");
  assert.equal(evaluateCommand("wget -qO- https://example.test/x | zsh -s").decision, "allow");
});

test("policy denies every dynamic shell argument", () => {
  assert.equal(evaluateCommand("rm -rf \"$TARGET\"").decision, "deny");
  assert.equal(evaluateCommand("claude --permission-mode \"$MODE\"").decision, "deny");
  assert.equal(evaluateCommand("bash -c 'claude --permission-mode \"$MODE\"'").decision, "deny");
  assert.equal(evaluateCommand("echo ref > .git/refs/heads/$BRANCH").decision, "deny");
  assert.equal(evaluateCommand("echo \"$VALUE\" > \"$TARGET\"").decision, "deny");
});

test("policy allows ordinary read-only commands", () => {
  assert.equal(evaluateCommand("git diff --check").decision, "allow");
});

test("policy denies unsafe worker permission flags even when passed as arguments", () => {
  assert.equal(evaluateCommand("claude", ["--dangerously-skip-permissions"]).decision, "deny");
  assert.equal(evaluateCommand("claude", ["--allow-dangerously-skip-permissions"]).decision, "deny");
  assert.equal(evaluateCommand("claude", ["--permission-mode=bypassPermissions"]).decision, "deny");
  assert.equal(evaluateCommand("claude", ["--permission-mode=bypass-permissions"]).decision, "deny");
});

test("remote and destructive commands remain denied even with a legacy approval", () => {
  assert.throws(() => assertSafeWorkerCommand("git", ["push"], { actor: "human", reason: "release approved" }), /blocked by policy \(deny\)/u);
  assert.throws(() => assertSafeWorkerCommand("rm", ["-rf", "/"], { actor: "human", reason: "approved" }), /blocked by policy \(deny\)/u);
});
