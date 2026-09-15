import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CwdLeaseStore, type CwdLeaseHandle, workerIdentity } from "./cwd-lease.ts";
import { DecisionSessionStore } from "./decision-session-store.ts";
import { TmuxWorkerAdapter } from "./worker/tmux-adapter.ts";
import extension from "./index.ts";
import { preflightCgroupContainment } from "./worker/process-adapter.ts";

const requiredCgroupTestAvailable = process.platform === "linux" && await canUseRequiredCgroup();

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

test("index rejects explicit process-pipe in automatic mode", () => {
  const previousTransport = process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
  const previousMode = process.env.PI_CLAUDE_SUPERVISOR_MODE;
  process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "process-pipe";
  process.env.PI_CLAUDE_SUPERVISOR_MODE = "auto";
  try {
    assert.throws(() => extension({} as never), /automatic supervision requires/u);
  } finally {
    if (previousTransport === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
    else process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = previousTransport;
    if (previousMode === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_MODE;
    else process.env.PI_CLAUDE_SUPERVISOR_MODE = previousMode;
  }
});

test("index rejects required cgroup mode for manual tmux instead of ignoring it", () => {
  const previousTransport = process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
  const previousCgroupMode = process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
  process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "tmux";
  process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = "required";
  try {
    assert.throws(() => extension({} as never), /unsupported with manual tmux/u);
  } finally {
    if (previousTransport === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
    else process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = previousTransport;
    if (previousCgroupMode === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
    else process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = previousCgroupMode;
  }
});

test("index recovers an idle Decision Worker without replaying the original task", { skip: !requiredCgroupTestAvailable, concurrency: false }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-recover-index-"));
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-recover-state-"));
  const leaseDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-recover-leases-"));
  const fakeBin = await mkdtemp(join(process.cwd(), ".pi-claude-supervisor-recover-bin-"));
  const taskId = "22222222-2222-4222-8222-222222222222";
  const fakeClaude = join(fakeBin, "claude");
  await copyFile(process.execPath, fakeClaude);
  await chmod(fakeClaude, 0o700);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd, stdio: "ignore" }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd, stdio: "ignore" }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.name", "Test"], { cwd, stdio: "ignore" }).status, 0);
  await writeFile(join(cwd, "base.txt"), "base\n");
  assert.equal(spawnSync("git", ["add", "base.txt"], { cwd, stdio: "ignore" }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-qm", "base"], { cwd, stdio: "ignore" }).status, 0);
  assert.equal(spawnSync("git", ["switch", "-c", "worker/recovery"], { cwd, stdio: "ignore" }).status, 0);
  const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
  const marker = join(stateDir, "received-input.jsonl");
  const decisionStore = new DecisionSessionStore(join(stateDir, "decision-sessions"));
  const decisionSessionDirectory = decisionStore.sessionDirectory(taskId);
  await mkdir(decisionSessionDirectory, { recursive: true });
  const decisionSessionFile = join(decisionSessionDirectory, "session.jsonl");
  await writeFile(decisionSessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd })}\n`);
  const fakeWorker = "const fs=require('node:fs'); process.stdin.on('data', data => fs.appendFileSync(process.argv[1], data)); setInterval(() => {}, 10000);";
  await decisionStore.save({
    taskId,
    task: "original task must not be replayed",
    cwd,
    command: "claude",
    args: ["-e", fakeWorker, marker],
    resolvedExecutable: fakeClaude,
    decisionSessionFile,
    maxTurns: 2,
    deadlineMs: 60_000,
    noOutputTimeoutMs: 60_000,
    startedAt: new Date().toISOString(),
    baseCommit,
    baseBranch: "worker/recovery",
    turn: 0,
    state: "active",
  });
  const keys = ["PI_CLAUDE_SUPERVISOR_STATE_DIR", "PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR", "PI_CLAUDE_SUPERVISOR_TRANSPORT", "PI_CLAUDE_SUPERVISOR_CGROUP_MODE", "PI_CLAUDE_SUPERVISOR_MODE", "PI_CLAUDE_SUPERVISOR_AUTOMATION", "PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<typeof keys[number], string | undefined>;
  const previousPath = process.env.PATH;
  for (const key of keys) delete process.env[key];
  process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR = stateDir;
  process.env.PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR = leaseDir;
  process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "jsonl";
  process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = "required";
  process.env.PI_CLAUDE_SUPERVISOR_MODE = "auto";
  process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION = "1";
  process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
  delete process.env.PI_CLAUDE_SUPERVISOR_TRUSTED_CLAUDE;
  const registrations: { commands: Array<{ name: string; definition: { handler: (args: string, ctx: TestContext) => Promise<void> } }>; events: Array<{ name: string; handler: () => Promise<void> }> } = { commands: [], events: [] };
  const messages: string[] = [];
  const context: TestContext = { cwd, hasUI: true, ui: { confirm: async () => false, notify: (message) => messages.push(message) } };
  let shutdownHandler: (() => Promise<void>) | undefined;
  try {
    const fakePi = {
      registerCommand(name: string, definition: { handler: (args: string, ctx: TestContext) => Promise<void> }) { registrations.commands.push({ name, definition }); },
      on(name: string, handler: () => Promise<void>) { registrations.events.push({ name, handler }); },
    };
    extension(fakePi as never);
    const command = registrations.commands.find(({ name }) => name === "supervise")?.definition;
    shutdownHandler = registrations.events.find(({ name }) => name === "session_shutdown")?.handler;
    assert.ok(command);
    assert.ok(shutdownHandler);

    await command.handler(`recover ${taskId}`, context);
    assert.match(messages.at(-1) ?? "", new RegExp(`Worker recovered idle: task=${taskId} worker=[^;]+; original task was not replayed`, "u"));
    const recovered = await decisionStore.load(taskId);
    assert.equal(recovered?.state, "active");
    assert.equal(recovered?.recoveryState, "recovered_idle");
    assert.equal(recovered?.baseCommit, baseCommit);
    assert.equal(recovered?.baseBranch, "worker/recovery");
    assert.equal(recovered?.resolvedExecutable, fakeClaude);
    assert.ok(recovered?.recoveryWorker?.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(() => readFile(marker, "utf8"), /ENOENT/u);

    await command.handler(`send ${taskId} explicit continuation`, context);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const received = await readFile(marker, "utf8");
        assert.match(received, /explicit continuation/u);
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await command.handler(`stop ${taskId}`, context);
    assert.equal((await decisionStore.load(taskId))?.state, "closed");
  } finally {
    if (shutdownHandler) await shutdownHandler().catch(() => {});
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(fakeBin, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(leaseDir, { recursive: true, force: true });
  }
});

test("adopted tmux detach retains a live lease and reaps it after the session dies", { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0, concurrency: false }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-adopted-index-"));
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-adopted-state-"));
  const leaseDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-adopted-leases-"));
  const fakeClaude = join(stateDir, "claude");
  await copyFile(process.execPath, fakeClaude);
  await chmod(fakeClaude, 0o700);
  const fixture = "process.stdout.write('>\\n--------------------\\n'); process.stdin.resume(); setInterval(() => {}, 10000);";
  const seededAdapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
  const seeded = await seededAdapter.start({ task: "seeded session", cwd, command: fakeClaude, args: ["-e", fixture], sendInitialInput: false });
  const seedStore = new CwdLeaseStore(leaseDir);
  const seedLease = await seedStore.acquire(cwd, "11111111-1111-4111-8111-111111111111", "tmux");
  await seedLease.updateWorker({
    transport: "tmux",
    ...(await workerIdentity(seeded)),
    sessionName: seeded.sessionName,
    tmuxSocket: seeded.tmuxSocket,
    tmuxTarget: seeded.tmuxTarget,
    tmuxPaneId: seeded.tmuxPaneId,
    paneStartTime: seeded.paneStartTime,
    paneCommand: seeded.paneCommand,
    ownership: "owned",
  });
  const leasePath = join(leaseDir, `${seedLease.record.leaseId}.json`);
  const seededRecord = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
  seededRecord.ownerPid = 999999999;
  seededRecord.ownerStartTime = "1";
  await writeFile(leasePath, `${JSON.stringify(seededRecord)}\n`);
  await seededAdapter.release(seeded, "seed handoff");

  const previous = {
    worker: process.env.PI_CLAUDE_SUPERVISOR_WORKER,
    stateDir: process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR,
    leaseDir: process.env.PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR,
    transport: process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT,
    cgroupMode: process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE,
    mode: process.env.PI_CLAUDE_SUPERVISOR_MODE,
    automation: process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION,
    tmuxSocket: process.env.PI_CLAUDE_SUPERVISOR_TMUX_SOCKET,
  };
  process.env.PI_CLAUDE_SUPERVISOR_WORKER = `${fakeClaude} -e ${JSON.stringify(fixture)}`;
  process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR = stateDir;
  process.env.PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR = leaseDir;
  process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "tmux";
  process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = "auto";
  process.env.PI_CLAUDE_SUPERVISOR_MODE = "auto";
  process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION = "1";
  process.env.PI_CLAUDE_SUPERVISOR_TMUX_SOCKET = seeded.tmuxSocket!;
  const registrations: { commands: Array<{ name: string; definition: { handler: (args: string, ctx: TestContext) => Promise<void> } }>; events: Array<{ name: string; handler: () => Promise<void> }> } = { commands: [], events: [] };
  const messages: string[] = [];
  const context: TestContext = { cwd, hasUI: true, ui: { confirm: async () => false, notify: (message) => messages.push(message) } };
  let shutdownHandler: (() => Promise<void>) | undefined;
  try {
    const fakePi = {
      registerCommand(name: string, definition: { handler: (args: string, ctx: TestContext) => Promise<void> }) { registrations.commands.push({ name, definition }); },
      on(name: string, handler: () => Promise<void>) { registrations.events.push({ name, handler }); },
    };
    extension(fakePi as never);
    const command = registrations.commands.find(({ name }) => name === "supervise")?.definition;
    shutdownHandler = registrations.events.find(({ name }) => name === "session_shutdown")?.handler;
    assert.ok(command);
    assert.ok(shutdownHandler);

    await command.handler(`adopt-tmux ${seeded.sessionName} observe existing session`, context);
    assert.match(messages.at(-1) ?? "", /^Tmux worker adopted:/u);
    const taskId = messages.at(-1)?.match(/task=([0-9a-f-]{36})/u)?.[1];
    assert.ok(taskId);
    await command.handler(`stop ${taskId}`, context);
    assert.match(messages.at(-1) ?? "", /Worker stopped/u);
    assert.equal((await seedStore.list()).length, 1);
    assert.equal(spawnSync("tmux", ["-S", seeded.tmuxSocket!, "has-session", "-t", seeded.sessionName!], { stdio: "ignore" }).status, 0);

    const replacement = spawnSync("tmux", ["-S", seeded.tmuxSocket!, "respawn-pane", "-k", "-t", seeded.tmuxPaneId!, "--", fakeClaude, "-e", fixture], { encoding: "utf8" });
    assert.equal(replacement.status, 0, replacement.stderr);
    await command.handler("poll", context);
    assert.equal((await seedStore.list()).length, 1);

    spawnSync("tmux", ["-S", seeded.tmuxSocket!, "kill-session", "-t", seeded.sessionName!], { stdio: "ignore" });
    for (let attempt = 0; attempt < 30 && (await seedStore.list()).length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await seedStore.list(), []);
  } finally {
    if (shutdownHandler) await shutdownHandler().catch(() => {});
    spawnSync("tmux", ["-S", seeded.tmuxSocket!, "kill-session", "-t", seeded.sessionName!], { stdio: "ignore" });
    const envKeys = {
      worker: "PI_CLAUDE_SUPERVISOR_WORKER",
      stateDir: "PI_CLAUDE_SUPERVISOR_STATE_DIR",
      leaseDir: "PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR",
      transport: "PI_CLAUDE_SUPERVISOR_TRANSPORT",
      cgroupMode: "PI_CLAUDE_SUPERVISOR_CGROUP_MODE",
      mode: "PI_CLAUDE_SUPERVISOR_MODE",
      automation: "PI_CLAUDE_SUPERVISOR_AUTOMATION",
      tmuxSocket: "PI_CLAUDE_SUPERVISOR_TMUX_SOCKET",
    } as const;
    for (const [key, value] of Object.entries(previous) as Array<[keyof typeof envKeys, string | undefined]>) {
      const envKey = envKeys[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
    await rm(cwd, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    await rm(leaseDir, { recursive: true, force: true });
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

async function canUseRequiredCgroup(): Promise<boolean> {
  try {
    await preflightCgroupContainment();
    return true;
  } catch {
    return false;
  }
}

type TestContext = {
  cwd: string;
  hasUI: boolean;
  ui: { confirm: () => Promise<boolean>; notify: (message: string) => void };
};
