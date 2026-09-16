import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MIN_SUPPORTED_CLAUDE_VERSION,
  assertSupportedClaudeVersion,
  compareClaudeVersions,
  formatClaudeVersion,
  parseClaudeCodeVersion,
  resolveClaudeExecutable,
} from "./claude-version.mjs";

test("Claude version checks accept the compatibility floor and newer releases", () => {
  const floor = parseClaudeCodeVersion("2.1.270 (Claude Code)");
  const newer = parseClaudeCodeVersion("2.1.272 (Claude Code)");
  assert.equal(formatClaudeVersion(floor), MIN_SUPPORTED_CLAUDE_VERSION);
  assert.equal(compareClaudeVersions(newer, floor) > 0, true);
  assert.deepEqual(assertSupportedClaudeVersion("2.1.270 (Claude Code)"), floor);
  assert.deepEqual(assertSupportedClaudeVersion("2.1.272 (Claude Code)"), newer);
  assert.deepEqual(assertSupportedClaudeVersion("3.0.0 (Claude Code)"), { major: 3, minor: 0, patch: 0 });
  assert.throws(() => assertSupportedClaudeVersion("2.1.269 (Claude Code)"), /Claude Code >= 2\.1\.270 is required/u);
  assert.throws(() => parseClaudeCodeVersion("Claude Code"), /could not parse Claude Code version/u);
});

test("Claude executable resolution follows PATH without a versioned directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-version-test-"));
  const executable = join(root, "claude");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    assert.equal(resolveClaudeExecutable(undefined, root), executable);
    assert.equal(resolveClaudeExecutable(executable, "/does/not/exist"), executable);
    assert.throws(() => resolveClaudeExecutable(undefined, "/does/not/exist"), /could not resolve Claude executable from PATH/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
