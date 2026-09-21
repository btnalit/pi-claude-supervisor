import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { nodeScriptCommand } from "./runtime.ts";

test("node script helper keeps the real Node executable on a Node host", () => {
  assert.equal(nodeScriptCommand({ PATH: "" }, process.execPath), process.execPath);
});

test("node script helper resolves Node when Pi runs as a compiled non-Node binary", async () => {
  const root = await mkdtemp(join(process.cwd(), ".pi-claude-supervisor-runtime-test-"));
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nodePath = join(root, nodeName);
  try {
    await copyFile(process.execPath, nodePath);
    await chmod(nodePath, 0o700);
    assert.equal(nodeScriptCommand({ PATH: root }, "/opt/pi/pi"), nodePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node script helper honors an explicitly configured runtime", async () => {
  const root = await mkdtemp(join(process.cwd(), ".pi-claude-supervisor-runtime-configured-test-"));
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nodePath = join(root, nodeName);
  try {
    await copyFile(process.execPath, nodePath);
    await chmod(nodePath, 0o700);
    assert.equal(nodeScriptCommand({ PATH: root, PI_CLAUDE_SUPERVISOR_NODE: basename(nodePath) }, "/opt/pi/pi"), nodePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node script helper fails clearly when a compiled Pi has no Node runtime", () => {
  assert.throws(
    () => nodeScriptCommand({ PATH: "/path/that/does/not/exist" }, "/opt/pi/pi"),
    /no Node executable was found.*PI_CLAUDE_SUPERVISOR_NODE/u,
  );
});
