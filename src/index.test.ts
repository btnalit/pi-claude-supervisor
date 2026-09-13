import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CwdLeaseStore, type CwdLeaseHandle } from "./cwd-lease.ts";
import extension from "./index.ts";

test("index rejects an unknown worker transport instead of falling back", () => {
  const previous = process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
  process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "not-a-transport";
  try {
    assert.throws(() => extension({} as never), /Unsupported PI_CLAUDE_SUPERVISOR_TRANSPORT/u);
  } finally {
    if (previous === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
    else process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = previous;
  }
});

test("index rejects required cgroup mode with tmux instead of ignoring it", () => {
  const previousTransport = process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
  const previousCgroupMode = process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
  process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "tmux";
  process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = "required";
  try {
    assert.throws(() => extension({} as never), /required is unsupported with tmux/u);
  } finally {
    if (previousTransport === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
    else process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = previousTransport;
    if (previousCgroupMode === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
    else process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = previousCgroupMode;
  }
});

test("index releases a confirmed-clean failed worker cwd reservation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-index-"));
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-state-"));
  const leaseDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-leases-"));
  const previousWorker = process.env.PI_CLAUDE_SUPERVISOR_WORKER;
  const previousStateDir = process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR;
  const previousLeaseDir = process.env.PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR;
  const previousTransport = process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
  const previousCgroupMode = process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
  const previousMode = process.env.PI_CLAUDE_SUPERVISOR_MODE;
  const previousAutomation = process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION;
  process.env.PI_CLAUDE_SUPERVISOR_WORKER = `${process.execPath} -e "const { existsSync } = require('node:fs'); const timer = setInterval(() => { if (existsSync('.worker-failed')) { clearInterval(timer); process.exit(1); } }, 10)"`;
  process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR = stateDir;
  process.env.PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR = leaseDir;
  process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "process-pipe";
  process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = "off";
  process.env.PI_CLAUDE_SUPERVISOR_MODE = "manual";
  process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION = "0";

  const registrations: { commands: Array<{ name: string; definition: { handler: (args: string, ctx: TestContext) => Promise<void> } }>; events: Array<{ name: string; handler: () => Promise<void> }> } = { commands: [], events: [] };
  const messages: string[] = [];
  const context: TestContext = {
    cwd,
    hasUI: true,
    ui: { confirm: async () => false, notify: (message) => messages.push(message) },
  };
  let shutdownHandler: (() => Promise<void>) | undefined;
  const fakePi = {
    registerCommand(name: string, definition: { handler: (args: string, ctx: TestContext) => Promise<void> }) {
      registrations.commands.push({ name, definition });
    },
    on(name: string, handler: () => Promise<void>) {
      registrations.events.push({ name, handler });
    },
  };

  try {
    extension(fakePi as never);
    const command = registrations.commands.find(({ name }) => name === "supervise")?.definition;
    const shutdown = registrations.events.find(({ name }) => name === "session_shutdown")?.handler;
    assert.ok(command);
    assert.ok(shutdown);
    shutdownHandler = shutdown;

    await command.handler("start failing worker", context);
    assert.match(messages.at(-1) ?? "", /^Worker started:/u);

    await command.handler("start overlapping worker", context);
    assert.match(messages.at(-1) ?? "", /overlapping cwd/u);

    await writeFile(join(cwd, ".worker-failed"), "fail\n");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await command.handler("poll", context);
      if ((messages.at(-1) ?? "").includes("running=false")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(messages.at(-1) ?? "", /running=false/u);

    const originalAcquire = CwdLeaseStore.prototype.acquire;
    CwdLeaseStore.prototype.acquire = async function(this: CwdLeaseStore, ...args: Parameters<CwdLeaseStore["acquire"]>) {
      const handle = await originalAcquire.apply(this, args);
      handle.updateWorker = async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error("injected lease registration failure");
      };
      return handle;
    };
    try {
      const pidFile = join(cwd, ".registration-failure-pid");
      process.env.PI_CLAUDE_SUPERVISOR_WORKER = `${process.execPath} -e "require('node:fs').writeFileSync('.registration-failure-pid', String(process.pid)); setInterval(() => {}, 10000)"`;
      await command.handler("start registration failure worker", context);
      assert.match(messages.at(-1) ?? "", /injected lease registration failure/u);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const pid = Number(await readFile(pidFile, "utf8"));
          assert.ok(pid);
          assert.throws(() => process.kill(pid, 0), /ESRCH/u);
          break;
        } catch (error) {
          if (attempt === 199) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    } finally {
      CwdLeaseStore.prototype.acquire = originalAcquire;
    }

    const originalAcquireForReleaseFailure = CwdLeaseStore.prototype.acquire;
    let underlyingRelease: (() => Promise<void>) | undefined;
    let failedLeaseHandle: CwdLeaseHandle | undefined;
    CwdLeaseStore.prototype.acquire = async function(this: CwdLeaseStore, ...args: Parameters<CwdLeaseStore["acquire"]>) {
      const handle = await originalAcquireForReleaseFailure.apply(this, args);
      underlyingRelease = handle.release.bind(handle);
      failedLeaseHandle = handle;
      handle.release = async () => {
        throw new Error("injected lease release failure");
      };
      return handle;
    };
    try {
      process.env.PI_CLAUDE_SUPERVISOR_WORKER = join(cwd, "missing-worker");
      await command.handler("start release failure worker", context);
      await command.handler("start while lease release fails", context);
      assert.match(messages.at(-1) ?? "", /overlapping cwd|working-directory lease is held/u);
    } finally {
      CwdLeaseStore.prototype.acquire = originalAcquireForReleaseFailure;
      if (failedLeaseHandle && underlyingRelease) {
        failedLeaseHandle.release = underlyingRelease;
        await underlyingRelease();
      }
    }

    process.env.PI_CLAUDE_SUPERVISOR_WORKER = `${process.execPath} -e "setInterval(() => {}, 10000)"`;
    await command.handler("start reusable worker", context);
    const startedMessage = messages.at(-1) ?? "";
    assert.match(startedMessage, /^Worker started:/u);
    const pid = Number(startedMessage.match(/pid (\d+)/u)?.[1]);
    assert.ok(pid);
    await shutdown();
    assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  } finally {
    if (shutdownHandler) {
      try {
        await shutdownHandler();
      } catch (error) {
        console.error(`index test cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (previousWorker === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_WORKER;
    else process.env.PI_CLAUDE_SUPERVISOR_WORKER = previousWorker;
    if (previousStateDir === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR;
    else process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR = previousStateDir;
    if (previousLeaseDir === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR;
    else process.env.PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR = previousLeaseDir;
    if (previousTransport === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
    else process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = previousTransport;
    if (previousCgroupMode === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
    else process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = previousCgroupMode;
    if (previousMode === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_MODE;
    else process.env.PI_CLAUDE_SUPERVISOR_MODE = previousMode;
    if (previousAutomation === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION;
    else process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION = previousAutomation;
    await rm(cwd, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(leaseDir, { recursive: true, force: true });
  }
});

type TestContext = {
  cwd: string;
  hasUI: boolean;
  ui: { confirm: () => Promise<boolean>; notify: (message: string) => void };
};
