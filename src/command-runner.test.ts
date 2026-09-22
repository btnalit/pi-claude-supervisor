import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBoundedCommand } from "./command-runner.ts";

const VERIFICATION_PREFIX = "pi-claude-supervisor-verification-";

async function writableCgroupParent(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const contents = await readFile("/proc/self/cgroup", "utf8");
    const match = contents.match(/^0::([^\n]*)$/mu);
    if (!match) return undefined;
    const parent = `/sys/fs/cgroup${match[1]}`;
    await access(parent, constants.W_OK);
    return parent;
  } catch {
    return undefined;
  }
}

const cgroupParent = await writableCgroupParent();

function commandOptions(overrides: Partial<Parameters<typeof runBoundedCommand>[2]> = {}): Parameters<typeof runBoundedCommand>[2] {
  return {
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    ...overrides,
  };
}

test("failed verification-cgroup preflight removes its newly-created directory", { skip: process.platform !== "linux" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-cs-command-cgroup-preflight-"));
  try {
    const result = await runBoundedCommand(process.execPath, ["-e", "process.exit(0)"], commandOptions({ cgroupParentPath: parent }));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /verification cgroup could not be created/u);
    assert.deepEqual((await readdir(parent)).filter((name) => name.startsWith(VERIFICATION_PREFIX)), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("aborting during verification-cgroup setup does not spawn a command or retain a cgroup", { skip: !cgroupParent }, async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], commandOptions({ signal: controller.signal, cgroupParentPath: cgroupParent }));
  controller.abort();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.ok(Date.now() - started < 2_000, "cancellation must not wait for the command timeout");
  assert.deepEqual((await readdir(cgroupParent!)).filter((name) => name.startsWith(VERIFICATION_PREFIX)), []);
});

test("verification guardian does not pass its internal cgroup capability to the command", { skip: !cgroupParent }, async () => {
  const result = await runBoundedCommand(
    process.execPath,
    ["-e", "process.stdout.write(process.env.PI_CLAUDE_SUPERVISOR_INTERNAL_VERIFICATION_CGROUP ?? 'missing')"],
    commandOptions({ cgroupParentPath: cgroupParent }),
  );
  assert.equal(result.stdout, "missing");
  assert.equal(result.cleanupError, undefined);
});
