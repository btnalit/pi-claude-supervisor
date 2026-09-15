import assert from "node:assert/strict";
import test from "node:test";
import { isClaudeLauncherProcess, isClaudeProcess, sameProcessIdentity, unexpectedClaudeProcess, unexpectedReviewerProcess } from "./process-tree.ts";

test("process scope rejects a non-Claude Reviewer executable", () => {
  const reviewer = {
    pid: 42,
    ppid: 7,
    startTime: "1",
    command: "node",
    executable: "/usr/bin/node",
    argv0: "/tmp/worker-reviewer.mjs",
    commandLine: "/tmp/worker-reviewer.mjs --read-only",
  };
  assert.equal(unexpectedReviewerProcess([reviewer]), reviewer);
  const ordinaryNodeReviewer = { ...reviewer, argv0: "/usr/bin/node", commandLine: "/usr/bin/node /tmp/review.js --read-only" };
  assert.equal(unexpectedReviewerProcess([ordinaryNodeReviewer]), ordinaryNodeReviewer);
  const shellWithPathMention = { ...reviewer, command: "bash", executable: "/usr/bin/bash", argv0: "/usr/bin/bash", commandLine: "/usr/bin/bash -c export PATH=/opt/codex/bin:$PATH; echo ok" };
  assert.equal(unexpectedReviewerProcess([shellWithPathMention]), undefined);
});

test("process scope recognizes a Node-launched Claude by the pinned command path", () => {
  const command = "/tmp/claude-wrapper/claude";
  const direct = {
    pid: 42,
    ppid: 7,
    startTime: "1",
    command: "node-MainThread",
    executable: "/usr/bin/node",
    argv0: "/usr/bin/node",
    commandLine: `/usr/bin/node ${command} --input-format stream-json`,
  };
  assert.equal(isClaudeProcess(direct, command), true);
  assert.equal(isClaudeProcess(direct, "claude"), true);
  assert.equal(isClaudeProcess({ ...direct, executable: command, command: "claude", argv0: "rg", commandLine: "rg --files --hidden /tmp" }), false);
  assert.equal(isClaudeProcess({ ...direct, executable: "/usr/bin/rg", command: "rg", argv0: "/usr/bin/rg", commandLine: `/usr/bin/rg ${command}`, argv: ["/usr/bin/rg", command] }, command), false);
  assert.equal(isClaudeLauncherProcess(direct), true);
  assert.equal(isClaudeLauncherProcess({ ...direct, commandLine: "/usr/bin/node -e console.log('claude')" }), false);
  assert.equal(isClaudeLauncherProcess({ ...direct, command: "sh", executable: "/bin/sh", argv0: "/bin/sh", commandLine: "/bin/sh -c /tmp/claude" }), true);
  assert.equal(isClaudeLauncherProcess({ ...direct, command: "env", executable: "/usr/bin/env", argv0: "/usr/bin/env", commandLine: "/usr/bin/env CLAUDE_MODE=1 claude" }), true);
  assert.equal(isClaudeLauncherProcess({ ...direct, command: "env", executable: "/usr/bin/env", argv0: "/usr/bin/env", commandLine: "/usr/bin/env -u NAME /tmp/claude", argv: ["/usr/bin/env", "-u", "NAME", "/tmp/claude"] }), true);
  assert.equal(isClaudeLauncherProcess({ ...direct, command: "bash", executable: "/bin/bash", argv0: "/bin/bash", commandLine: "/bin/bash --noprofile -c /tmp/claude", argv: ["/bin/bash", "--noprofile", "-c", "/tmp/claude"] }), true);
  assert.equal(isClaudeProcess({ ...direct, command: "node", executable: "/usr/bin/node", argv0: "/usr/bin/node", commandLine: "/usr/bin/node --no-warnings /tmp/claude", argv: ["/usr/bin/node", "--no-warnings", "/tmp/claude"] }, "claude"), true);
  assert.equal(isClaudeProcess({ ...direct, command: "node", executable: "/usr/bin/node", argv0: "/usr/bin/node", commandLine: "/usr/bin/node --experimental-loader loader.mjs /tmp/claude", argv: ["/usr/bin/node", "--experimental-loader", "loader.mjs", "/tmp/claude"] }, "claude"), true);
  assert.equal(isClaudeLauncherProcess({ ...direct, command: "ksh", executable: "/bin/ksh", argv0: "/bin/ksh", commandLine: "/bin/ksh -c /tmp/claude", argv: ["/bin/ksh", "-c", "/tmp/claude"] }), true);
  assert.equal(unexpectedClaudeProcess([direct], new Map([[direct.pid, direct]]), command), undefined);
  const nested = { ...direct, pid: 43, ppid: 42, commandLine: `/usr/bin/node ${command} --nested` };
  assert.equal(unexpectedClaudeProcess([direct, nested], new Map([[direct.pid, direct]]), command), nested);
});

test("process scope does not trust a PID after identity reuse", () => {
  const trusted = {
    pid: 42,
    ppid: 7,
    startTime: "1",
    command: "claude",
    executable: "/opt/claude",
    argv0: "claude",
    commandLine: "claude -p",
  };
  const reused = { ...trusted, startTime: "2", commandLine: "claude /tmp/review.js" };
  assert.equal(sameProcessIdentity(trusted, reused), false);
  assert.equal(unexpectedClaudeProcess([reused], new Map([[trusted.pid, trusted]])), reused);
  assert.equal(unexpectedReviewerProcess([reused]), reused);
});
