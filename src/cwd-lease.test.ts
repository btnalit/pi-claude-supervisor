import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CwdLeaseStore, pathsOverlap, removeEmptyChildCgroups, workerIdentity } from "./cwd-lease.ts";
import { currentCgroupPath } from "./worker/process-adapter.ts";

// A hybrid or v1-only host has no delegated v2 hierarchy for these tests.
const cgroupV2Parent = process.platform === "linux" ? await currentCgroupPath().catch(() => undefined) : undefined;

 test("cwd lease stale-lock reclamation is token and inode bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-lock-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  const lockPath = join(leaseDir, ".lock");
  const ownerPath = join(lockPath, "owner.json");
  await mkdir(cwd);
  await mkdir(lockPath, { recursive: true });
  await writeFile(ownerPath, JSON.stringify({ pid: 999999991, startTime: "1", token: "stale-lock-token" }));
  const stale = new Date(Date.now() - 10_000);
  await utimes(ownerPath, stale, stale);
  const store = new CwdLeaseStore(leaseDir);
  const handle = await store.acquire(cwd, "10101010-1010-4010-8010-101010101010", "process-pipe");
  assert.equal((await readdir(leaseDir)).some((name) => name.includes(".reap-")), false);
  await handle.release();
  await rm(root, { recursive: true, force: true });
});

test("cwd leases serialize overlapping acquisition across store instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  await mkdir(join(cwd, "nested"), { recursive: true });
  const first = new CwdLeaseStore(leaseDir);
  const second = new CwdLeaseStore(leaseDir);
  const results = await Promise.allSettled([
    first.acquire(cwd, "11111111-1111-4111-8111-111111111111", "process-pipe"),
    second.acquire(join(cwd, "nested"), "22222222-2222-4222-8222-222222222222", "jsonl"),
  ]);
  const acquired = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<CwdLeaseStore["acquire"]>>> => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(acquired.length, 1);
  assert.equal(rejected.length, 1);
  await acquired[0].value.release();
  const retry = await second.acquire(join(cwd, "nested"), "33333333-3333-4333-8333-333333333333", "jsonl");
  await retry.release();
  await rm(root, { recursive: true, force: true });
});

test("cwd lease worker identity is persisted and release is token-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-"));
  const leaseDir = join(root, "leases");
  const store = new CwdLeaseStore(leaseDir);
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const handle = await store.acquire(cwd, "44444444-4444-4444-8444-444444444444", "tmux");
  await handle.updateWorker({ transport: "tmux", pid: process.pid, startTime: "123", sessionName: "owned-session", ownership: "owned", tmuxTarget: "owned-session", paneStartTime: "pane-start", paneCommand: "claude" });
  const record = JSON.parse(await readFile(join(leaseDir, `${handle.record.leaseId}.json`), "utf8")) as { worker?: { sessionName?: string; ownership?: string } };
  assert.equal(record.worker?.sessionName, "owned-session");
  assert.equal(record.worker?.ownership, "owned");
  const otherStore = new CwdLeaseStore(leaseDir);
  await assert.rejects(() => otherStore.acquire(cwd, "55555555-5555-4555-8555-555555555555", "process-pipe"), /working-directory lease is held/u);
  await handle.release();
  const retry = await otherStore.acquire(cwd, "66666666-6666-4666-8666-666666666666", "process-pipe");
  await retry.release();
  await rm(root, { recursive: true, force: true });
});

test("cwd lease takeover requires an explicit dead-owner and dead-worker proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-takeover-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const store = new CwdLeaseStore(leaseDir);
  const old = await store.acquire(cwd, "77777777-7777-4777-8777-777777777777", "process-pipe");
  await old.updateWorker({ transport: "process-pipe", pid: 999999998, startTime: "1", ownership: "owned", cgroupPath: "/sys/fs/cgroup/pi-claude-supervisor-test-gone" });
  const oldPath = join(leaseDir, `${old.record.leaseId}.json`);
  const oldRecord = JSON.parse(await readFile(oldPath, "utf8")) as Record<string, unknown>;
  oldRecord.ownerPid = 999999999;
  oldRecord.ownerStartTime = "1";
  await writeFile(oldPath, `${JSON.stringify(oldRecord)}\n`);
  await assert.rejects(
    () => store.acquire(cwd, "88888888-8888-4888-8888-888888888888", "process-pipe"),
    /working-directory lease is held/u,
  );
  await assert.rejects(
    () => store.acquire(cwd, "88888888-8888-4888-8888-888888888888", "process-pipe", { takeover: { taskId: old.record.taskId } }),
    /working-directory lease is held/u,
  );
  await old.release();

  const noCgroup = await store.acquire(cwd, "99999999-9999-4999-8999-999999999999", "process-pipe");
  await noCgroup.updateWorker({ transport: "process-pipe", pid: 999999997, startTime: "1", ownership: "owned" });
  const noCgroupPath = join(leaseDir, `${noCgroup.record.leaseId}.json`);
  const noCgroupRecord = JSON.parse(await readFile(noCgroupPath, "utf8")) as Record<string, unknown>;
  noCgroupRecord.ownerPid = 999999996;
  noCgroupRecord.ownerStartTime = "1";
  await writeFile(noCgroupPath, `${JSON.stringify(noCgroupRecord)}\n`);
  // No cgroup was ever used, and the Worker's leader and process group are
  // gone along with its Pi: the adapter's own no-cgroup cleanup evidence.
  // The lease is abandoned, and any start may reclaim it.
  const reclaimed = await store.acquire(cwd, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "process-pipe");
  assert.deepEqual((await store.list()).map((lease) => lease.taskId), ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  await reclaimed.release();
  await noCgroup.release().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

test("an abandoned lease is reclaimed only when nothing of its task can still be running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-abandoned-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const store = new CwdLeaseStore(leaseDir);
  const plant = async (taskId: string, worker: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): Promise<void> => {
    const lease = await store.acquire(cwd, taskId, "process-pipe");
    const path = join(leaseDir, `${lease.record.leaseId}.json`);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    record.ownerPid = 999999990;
    record.ownerStartTime = "1";
    if (worker) record.worker = worker; else delete record.worker;
    await writeFile(path, `${JSON.stringify({ ...record, ...extra })}\n`);
  };
  try {
    // A Pi that died before spawning anything.
    await plant("11111111-1111-4111-8111-111111111111", undefined);
    const afterEmpty = await store.acquire(cwd, "22222222-2222-4222-8222-222222222222", "process-pipe");
    await afterEmpty.release();
    // A Worker whose leader is still alive keeps its lease, and the refusal
    // says what to do about it.
    await plant("33333333-3333-4333-8333-333333333333", { transport: "process-pipe", pid: process.pid, ownership: "owned" });
    await assert.rejects(() => store.acquire(cwd, "44444444-4444-4444-8444-444444444444", "process-pipe"), /its Pi \(pid 999999990\) is gone .*recover --takeover 33333333.*for a manual one, stop or re-adopt its Worker, then delete /u);
    for (const lease of await store.list()) await rm(join(leaseDir, `${lease.leaseId}.json`), { force: true });
    // A tmux session is meant to outlive its Pi: never reclaimed here.
    await plant("55555555-5555-4555-8555-555555555555", { transport: "tmux", pid: 999999991, ownership: "owned", sessionName: "s", tmuxSocket: "/tmp/nonexistent-pi-cs.sock" });
    await assert.rejects(() => store.acquire(cwd, "66666666-6666-4666-8666-666666666666", "process-pipe"), /working-directory lease is held/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic process takeover replaces a lease and then removes its cgroup", async (t) => {
  if (!cgroupV2Parent) {
    t.skip("Linux cgroup v2 is required");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "p-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  let cgroupPath: string | undefined;
  try {
    await mkdir(cwd);
    const parent = cgroupV2Parent!;
    const workerId = randomUUID();
    cgroupPath = join(parent, `pi-claude-supervisor-${workerId}`);
    try {
      await mkdir(cgroupPath);
    } catch {
      t.skip("the current cgroup does not allow test children");
      return;
    }
    const store = new CwdLeaseStore(leaseDir);
    const old = await store.acquire(cwd, "77777777-7777-4777-8777-777777777777", "jsonl");
    await old.updateWorker({ transport: "jsonl", ...(await workerIdentity({ id: workerId, pid: 999999998, cgroupPath })), pid: 999999998, startTime: "1" });
    const oldPath = join(leaseDir, `${old.record.leaseId}.json`);
    const oldRecord = JSON.parse(await readFile(oldPath, "utf8")) as Record<string, unknown>;
    oldRecord.ownerPid = 999999999;
    oldRecord.ownerStartTime = "1";
    await writeFile(oldPath, `${JSON.stringify(oldRecord)}\n`);

    const recovered = await store.acquire(cwd, "88888888-8888-4888-8888-888888888888", "jsonl", { takeover: { taskId: old.record.taskId } });
    assert.equal(recovered.replacedTaskId, old.record.taskId);
    assert.equal(recovered.record.taskId, "88888888-8888-4888-8888-888888888888");
    assert.equal((await readdir(leaseDir)).filter((name) => name.endsWith(".json")).length, 1);
    await assert.rejects(() => access(cgroupPath!), /ENOENT/u);
    await assert.rejects(() => old.release(), /identity changed/u);
    await recovered.release();
  } finally {
    if (cgroupPath) await rmdir(cgroupPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a durable pre-spawn lease can be replaced before cgroup creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-startup-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  try {
    await mkdir(cwd);
    const store = new CwdLeaseStore(leaseDir);
    const old = await store.acquire(cwd, "99999999-9999-4999-8999-999999999999", "jsonl", { startup: true });
    const leasePath = join(leaseDir, `${old.record.leaseId}.json`);
    const record = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
    record.ownerPid = 999999999;
    record.ownerStartTime = "1";
    await writeFile(leasePath, `${JSON.stringify(record)}\n`);

    const recovered = await store.acquire(cwd, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "jsonl", {
      startup: true,
      takeover: { taskId: old.record.taskId },
    });
    assert.equal(recovered.replacedTaskId, old.record.taskId);
    assert.equal(recovered.record.pendingStartup?.transport, "jsonl");
    await recovered.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic provisional lease identity supports takeover before Worker PID registration", async (t) => {
  if (!cgroupV2Parent) {
    t.skip("Linux cgroup v2 is required");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-provisional-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  let cgroupPath: string | undefined;
  try {
    await mkdir(cwd);
    const parent = cgroupV2Parent!;
    const workerId = randomUUID();
    cgroupPath = join(parent, `pi-claude-supervisor-${workerId}`);
    try { await mkdir(cgroupPath); }
    catch { t.skip("the current cgroup does not allow test children"); return; }
    const store = new CwdLeaseStore(leaseDir);
    const old = await store.acquire(cwd, "99999999-9999-4999-8999-999999999999", "jsonl");
    const identity = await workerIdentity({ id: workerId, cgroupPath, retainCgroupUntilLeaseRelease: true });
    await old.updateWorker({ transport: "jsonl", ...identity, retainCgroupUntilLeaseRelease: true });
    const leasePath = join(leaseDir, `${old.record.leaseId}.json`);
    const record = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
    record.ownerPid = 999999999;
    record.ownerStartTime = "1";
    await writeFile(leasePath, `${JSON.stringify(record)}\n`);

    const recovered = await store.acquire(cwd, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "jsonl", { takeover: { taskId: old.record.taskId } });
    assert.equal(recovered.replacedTaskId, old.record.taskId);
    assert.equal(recovered.record.taskId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await assert.rejects(() => access(cgroupPath!), /ENOENT/u);
    await recovered.release();
  } finally {
    if (cgroupPath) await rmdir(cgroupPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("startup takeover reconciles a cgroup created after its provisional plan", async (t) => {
  if (!cgroupV2Parent) {
    t.skip("Linux cgroup v2 is required");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-startup-resource-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  const workerId = randomUUID();
  const cgroupPath = `${cgroupV2Parent!}/pi-claude-supervisor-${workerId}`;
  await mkdir(cwd);
  const store = new CwdLeaseStore(leaseDir);
  const old = await store.acquire(cwd, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "jsonl", { startup: true });
  await old.updateWorker({
    transport: "jsonl",
    workerId,
    cgroupPath,
    ownership: "owned",
    retainCgroupUntilLeaseRelease: true,
  }, { preserveStartup: true });
  try {
    await mkdir(cgroupPath);
  } catch {
    await rm(root, { recursive: true, force: true });
    t.skip("the current cgroup does not allow test children");
    return;
  }
  const oldPath = join(leaseDir, `${old.record.leaseId}.json`);
  const oldRecord = JSON.parse(await readFile(oldPath, "utf8")) as Record<string, unknown>;
  oldRecord.ownerPid = 999999995;
  oldRecord.ownerStartTime = "1";
  await writeFile(oldPath, `${JSON.stringify(oldRecord)}\n`);
  try {
    const recovered = await store.acquire(cwd, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "jsonl", {
      startup: true,
      takeover: { taskId: old.record.taskId },
    });
    assert.equal(recovered.record.pendingStartup?.transport, "jsonl");
    await assert.rejects(() => access(cgroupPath), /ENOENT/u);
    await recovered.release();
  } finally {
    await rmdir(cgroupPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic tmux startup takeover reconciles a planned cgroup before server identity", async (t) => {
  if (!cgroupV2Parent) {
    t.skip("Linux cgroup v2 is required");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-tmux-startup-resource-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  const workerId = randomUUID();
  const cgroupPath = `${cgroupV2Parent!}/pi-claude-supervisor-tmux-${workerId}`;
  const sessionName = `pi-supervisor-${workerId}`;
  const tmuxSocket = `/tmp/pi-cs-${workerId}.sock`;
  await mkdir(cwd);
  const store = new CwdLeaseStore(leaseDir);
  const old = await store.acquire(cwd, "12121212-1212-4121-8121-121212121212", "tmux", { startup: true });
  await old.updateWorker({
    transport: "tmux",
    workerId,
    cgroupPath,
    sessionName,
    tmuxSocket,
    ownership: "owned",
    retainCgroupUntilLeaseRelease: true,
  }, { preserveStartup: true });
  try {
    await mkdir(cgroupPath);
  } catch {
    await rm(root, { recursive: true, force: true });
    t.skip("the current cgroup does not allow test children");
    return;
  }
  const oldPath = join(leaseDir, `${old.record.leaseId}.json`);
  const oldRecord = JSON.parse(await readFile(oldPath, "utf8")) as Record<string, unknown>;
  oldRecord.ownerPid = 999999990;
  oldRecord.ownerStartTime = "1";
  await writeFile(oldPath, `${JSON.stringify(oldRecord)}\n`);
  try {
    const recovered = await store.acquire(cwd, "13131313-1313-4131-8131-131313131313", "tmux", {
      startup: true,
      takeover: { taskId: old.record.taskId },
    });
    assert.equal(recovered.record.pendingStartup?.transport, "tmux");
    await assert.rejects(() => access(cgroupPath), /ENOENT/u);
    await assert.rejects(() => access(tmuxSocket), /ENOENT/u);
    await recovered.release();
  } finally {
    await rmdir(cgroupPath).catch(() => {});
    await rmdir(tmuxSocket).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("tmux handoff refuses an unreconciled pending cleanup transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-handoff-pending-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const store = new CwdLeaseStore(leaseDir);
  const workerId = randomUUID();
  const sessionName = `pi-supervisor-${workerId}`;
  const tmuxSocket = `/tmp/pi-cs-${workerId}.sock`;
  const old = await store.acquire(cwd, "ffffffff-ffff-4fff-8fff-ffffffffffff", "tmux");
  await old.updateWorker({ transport: "tmux", workerId, pid: 999999994, startTime: "1", sessionName, tmuxSocket, ownership: "owned", tmuxTarget: sessionName });
  const oldPath = join(leaseDir, `${old.record.leaseId}.json`);
  const oldRecord = JSON.parse(await readFile(oldPath, "utf8")) as Record<string, unknown>;
  oldRecord.ownerPid = 999999993;
  oldRecord.ownerStartTime = "1";
  oldRecord.pendingCleanup = {
    phase: "prepared",
    transport: "tmux",
    workerId,
    cgroupPath: `/sys/fs/cgroup/pi-claude-supervisor-tmux-${workerId}`,
    cgroupIdentity: { device: "1", inode: "1" },
    sessionName,
    tmuxSocket,
    tmuxServerPid: 999999992,
    tmuxServerStartTime: "1",
  };
  await writeFile(oldPath, `${JSON.stringify(oldRecord)}\n`);
  await mkdir(tmuxSocket);
  try {
    await assert.rejects(
      () => store.acquire(cwd, "abababab-abab-4aba-8aba-abababababab", "tmux", { handoff: { sessionName, tmuxSocket } }),
      /working-directory lease is held/u,
    );
    // A marker whose inode was not durably recorded is never guessed to be
    // owned by the pending transaction.
    await access(tmuxSocket);
  } finally {
    await old.release().catch(() => {});
    await rmdir(tmuxSocket).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("releasing an automatic lease removes its retained empty cgroup", async (t) => {
  if (!cgroupV2Parent) {
    t.skip("Linux cgroup v2 is required");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-retained-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  let cgroupPath: string | undefined;
  try {
    await mkdir(cwd);
    const parent = cgroupV2Parent!;
    const workerId = randomUUID();
    cgroupPath = join(parent, `pi-claude-supervisor-${workerId}`);
    try { await mkdir(cgroupPath); }
    catch { t.skip("the current cgroup does not allow test children"); return; }
    const store = new CwdLeaseStore(leaseDir);
    const lease = await store.acquire(cwd, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "jsonl");
    const identity = await workerIdentity({ id: workerId, cgroupPath, retainCgroupUntilLeaseRelease: true });
    await lease.updateWorker({ transport: "jsonl", ...identity, retainCgroupUntilLeaseRelease: true });
    await lease.release();
    await assert.rejects(() => access(cgroupPath!), /ENOENT/u);
  } finally {
    if (cgroupPath) await rmdir(cgroupPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement-phase pending cleanup retains the replacement lease", async (t) => {
  if (!cgroupV2Parent) {
    t.skip("Linux cgroup v2 is required");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-replacement-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  let cgroupPath: string | undefined;
  try {
    await mkdir(cwd);
    const parent = cgroupV2Parent!;
    const workerId = randomUUID();
    cgroupPath = join(parent, `pi-claude-supervisor-${workerId}`);
    try { await mkdir(cgroupPath); }
    catch { t.skip("the current cgroup does not allow test children"); return; }
    const store = new CwdLeaseStore(leaseDir);
    const old = await store.acquire(cwd, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "jsonl");
    const identity = await workerIdentity({ id: workerId, cgroupPath });
    await old.updateWorker({ transport: "jsonl", ...identity });
    const leasePath = join(leaseDir, `${old.record.leaseId}.json`);
    const record = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, any>;
    record.taskId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    record.pendingCleanup = {
      phase: "replacement",
      transport: "jsonl",
      workerId,
      cgroupPath,
      cgroupIdentity: identity.cgroupIdentity,
    };
    await writeFile(leasePath, `${JSON.stringify(record)}\n`);

    const leases = await store.list();
    assert.equal(leases.length, 1);
    assert.equal(leases[0]!.taskId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    assert.equal(leases[0]!.pendingCleanup, undefined);
    await assert.rejects(() => access(cgroupPath!), /ENOENT/u);
  } finally {
    if (cgroupPath) await rmdir(cgroupPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("pending takeover cleanup is reconciled before lease discovery", async (t) => {
  if (!cgroupV2Parent) {
    t.skip("Linux cgroup v2 is required");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-pending-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  let cgroupPath: string | undefined;
  try {
    await mkdir(cwd);
    const parent = cgroupV2Parent!;
    const workerId = randomUUID();
    cgroupPath = join(parent, `pi-claude-supervisor-${workerId}`);
    try {
      await mkdir(cgroupPath);
    } catch {
      t.skip("the current cgroup does not allow test children");
      return;
    }
    const store = new CwdLeaseStore(leaseDir);
    const old = await store.acquire(cwd, "99999999-9999-4999-8999-999999999999", "jsonl");
    const identity = await workerIdentity({ id: workerId, pid: 999999998, cgroupPath });
    await old.updateWorker({ transport: "jsonl", ...identity, pid: 999999998, startTime: "1" });
    const leasePath = join(leaseDir, `${old.record.leaseId}.json`);
    const record = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
    record.pendingCleanup = {
      phase: "prepared",
      transport: "jsonl",
      workerId,
      cgroupPath,
      cgroupIdentity: identity.cgroupIdentity,
    };
    await writeFile(leasePath, `${JSON.stringify(record)}\n`);

    assert.deepEqual(await store.list(), []);
    await assert.rejects(() => access(cgroupPath!), /ENOENT/u);
  } finally {
    if (cgroupPath) await rmdir(cgroupPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic tmux takeover reclaims a guardian-cleaned lease", async (t) => {
  if (!cgroupV2Parent || spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("Linux cgroup v2 and tmux are required");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "p-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  let cgroupPath: string | undefined;
  try {
    await mkdir(cwd);
    const parent = cgroupV2Parent!;
    const workerId = randomUUID();
    cgroupPath = join(parent, `pi-claude-supervisor-tmux-${workerId}`);
    try {
      await mkdir(cgroupPath);
    } catch {
      t.skip("the current cgroup does not allow test children");
      return;
    }
    const store = new CwdLeaseStore(leaseDir);
    const old = await store.acquire(cwd, "77777777-7777-4777-8777-777777777777", "tmux");
    const identity = await workerIdentity({ id: workerId, pid: 999999998, cgroupPath });
    await old.updateWorker({
      transport: "tmux",
      ...identity,
      pid: 999999998,
      startTime: "1",
      sessionName: `pi-supervisor-${workerId}`,
      tmuxSocket: join(root, `pi-cs-${workerId}.sock`),
      tmuxServerPid: 999999997,
      tmuxServerStartTime: "1",
      ownership: "adopted",
    });
    const oldPath = join(leaseDir, `${old.record.leaseId}.json`);
    const markOwnerDead = async () => {
      const record = JSON.parse(await readFile(oldPath, "utf8")) as Record<string, unknown>;
      record.ownerPid = 999999999;
      record.ownerStartTime = "1";
      await writeFile(oldPath, `${JSON.stringify(record)}\n`);
    };
    await markOwnerDead();

    await assert.rejects(
      () => store.acquire(cwd, "88888888-8888-4888-8888-888888888888", "tmux", { takeover: { taskId: old.record.taskId } }),
      /working-directory lease is held/u,
    );
    await old.updateWorker({
      transport: "tmux",
      ...identity,
      pid: 999999998,
      startTime: "1",
      sessionName: `pi-supervisor-${workerId}`,
      tmuxSocket: join(root, `pi-cs-${workerId}.sock`),
      tmuxServerPid: 999999997,
      tmuxServerStartTime: "1",
      ownership: "owned",
    });
    await markOwnerDead();

    const tamperedRecord = JSON.parse(await readFile(oldPath, "utf8")) as { worker?: { cgroupIdentity?: { inode: string } } };
    tamperedRecord.worker!.cgroupIdentity!.inode = "0";
    await writeFile(oldPath, `${JSON.stringify(tamperedRecord)}\n`);
    await assert.rejects(
      () => store.acquire(cwd, "88888888-8888-4888-8888-888888888888", "tmux", { takeover: { taskId: old.record.taskId } }),
      /working-directory lease is held/u,
    );
    await old.updateWorker({
      transport: "tmux",
      ...identity,
      pid: 999999998,
      startTime: "1",
      sessionName: `pi-supervisor-${workerId}`,
      tmuxSocket: join(root, `pi-cs-${workerId}.sock`),
      tmuxServerPid: 999999997,
      tmuxServerStartTime: "1",
      ownership: "owned",
    });
    await markOwnerDead();

    const replacementDir = join(root, "replacement");
    await mkdir(replacementDir);
    const replacementSocket = join(replacementDir, `pi-cs-${workerId}.sock`);
    assert.equal(spawnSync("tmux", ["-S", replacementSocket, "new-session", "-d", "-s", "replacement", "sleep", "20"], { stdio: "ignore" }).status, 0);
    try {
      await old.updateWorker({
        transport: "tmux",
        ...identity,
        pid: 999999998,
        startTime: "1",
        sessionName: `pi-supervisor-${workerId}`,
        tmuxSocket: replacementSocket,
        tmuxServerPid: 999999997,
        tmuxServerStartTime: "1",
        ownership: "owned",
      });
      await assert.rejects(
        () => store.acquire(cwd, "88888888-8888-4888-8888-888888888888", "tmux", { takeover: { taskId: old.record.taskId } }),
        /working-directory lease is held/u,
      );
    } finally {
      spawnSync("tmux", ["-S", replacementSocket, "kill-server"], { stdio: "ignore" });
    }
    await old.updateWorker({
      transport: "tmux",
      ...identity,
      pid: 999999998,
      startTime: "1",
      sessionName: `pi-supervisor-${workerId}`,
      tmuxSocket: join(root, `pi-cs-${workerId}.sock`),
      tmuxServerPid: 999999997,
      tmuxServerStartTime: "1",
      ownership: "owned",
    });
    await markOwnerDead();

    const recovered = await store.acquire(cwd, "88888888-8888-4888-8888-888888888888", "tmux", {
      takeover: {
        taskId: old.record.taskId,
        beforeReplace: async () => {
          // The reservation must survive the proof-to-replacement window;
          // tmux must not be able to replace it as a stale socket path.
          assert.notEqual(spawnSync("tmux", ["-S", join(root, `pi-cs-${workerId}.sock`), "new-session", "-d", "-s", "replacement", "sleep", "20"], { stdio: "ignore" }).status, 0);
        },
      },
    });
    assert.equal(recovered.replacedTaskId, old.record.taskId);
    await assert.rejects(() => access(cgroupPath!), /ENOENT/u);
    await assert.rejects(() => access(join(root, `pi-cs-${workerId}.sock`)), /ENOENT/u);
    await recovered.release();
  } finally {
    if (cgroupPath) await rmdir(cgroupPath).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("cwd leases canonicalize symlink aliases and support identity-bound tmux handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-"));
  const leaseDir = join(root, "leases");
  const actual = join(root, "actual");
  const alias = join(root, "alias");
  await mkdir(actual);
  await symlink(actual, alias);
  const store = new CwdLeaseStore(leaseDir);
  const old = await store.acquire(actual, "88888888-8888-4888-8888-888888888888", "tmux");
  await old.updateWorker({ transport: "tmux", pid: 999999, startTime: "123", sessionName: "owned", tmuxSocket: "/tmp/sock", ownership: "owned", tmuxTarget: "owned", tmuxPaneId: "%1", paneStartTime: "123", paneCommand: "claude" });
  const handoff = { handoff: { sessionName: "owned", tmuxSocket: "/tmp/sock" } };
  await assert.rejects(() => store.acquire(alias, "99999999-9999-4999-8999-999999999999", "tmux", handoff), /working-directory lease is held/u);
  const oldPath = join(leaseDir, `${old.record.leaseId}.json`);
  const oldRecord = JSON.parse(await readFile(oldPath, "utf8")) as Record<string, unknown>;
  oldRecord.ownerPid = 999999;
  oldRecord.ownerStartTime = "123";
  await writeFile(oldPath, `${JSON.stringify(oldRecord)}\n`);
  await assert.rejects(() => store.acquire(alias, "99999999-9999-4999-8999-999999999999", "process-pipe"), /working-directory lease is held/u);
  const adopted = await store.acquire(alias, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "tmux", handoff);
  assert.equal(adopted.record.taskId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(adopted.replacedTaskId, old.record.taskId);
  assert.equal((await store.list()).length, 1);
  await adopted.release();
  await rm(root, { recursive: true, force: true });
});

test("a lease whose cwd disappeared blocks only that path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-"));
  const leaseDir = join(root, "leases");
  const oldCwd = join(root, "old");
  const newCwd = join(root, "new");
  await mkdir(oldCwd);
  await mkdir(newCwd);
  const store = new CwdLeaseStore(leaseDir);
  const old = await store.acquire(oldCwd, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "process-pipe");
  await rm(oldCwd, { recursive: true, force: true });
  // A vanished lease directory must not throw and block every unrelated cwd.
  const unrelated = await store.acquire(newCwd, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "process-pipe");
  await unrelated.release();
  // The same path is still fail-closed: the raw recorded cwd still matches
  // once the directory exists again for canonicalization.
  await mkdir(oldCwd);
  await assert.rejects(
    () => store.acquire(oldCwd, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "process-pipe"),
    /working-directory lease is held/u,
  );
  await old.release().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

test("cwd lease registry rejects a symlinked registry directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-"));
  const target = join(root, "target");
  const link = join(root, "link");
  await mkdir(target);
  await symlink(target, link);
  await mkdir(join(root, "repo"));
  await assert.rejects(
    () => new CwdLeaseStore(link).acquire(join(root, "repo"), "77777777-7777-4777-8777-777777777777", "process-pipe"),
    /cwd lease registry is not a directory/u,
  );
  await rm(root, { recursive: true, force: true });
});

test("cwd overlap treats parents and descendants as conflicting", () => {
  assert.equal(pathsOverlap("/work/repo", "/work/repo"), true);
  assert.equal(pathsOverlap("/work/repo", "/work/repo/nested"), true);
  assert.equal(pathsOverlap("/work/repo", "/work/repository"), false);
});

test("a corrupt lease record is quarantined and does not block other cwds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-quarantine-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  await mkdir(leaseDir, { recursive: true });
  await mkdir(cwd);
  await writeFile(join(leaseDir, "broken.json"), '{"taskId":');
  const store = new CwdLeaseStore(leaseDir);
  const handle = await store.acquire(cwd, "40000000-0000-4000-8000-000000000001", "process-pipe");
  const quarantined = await store.quarantined();
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0]!, /^broken\.json\./u);
  await assert.rejects(() => access(join(leaseDir, "broken.json")), /ENOENT/u);
  await handle.release();
  await rm(root, { recursive: true, force: true });
});

test("a non-regular lease entry is skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-nonregular-"));
  const leaseDir = join(root, "leases");
  const cwd = join(root, "repo");
  await mkdir(leaseDir, { recursive: true });
  await mkdir(cwd);
  await mkdir(join(leaseDir, "weird.json"));
  const store = new CwdLeaseStore(leaseDir);
  const handle = await store.acquire(cwd, "50000000-0000-4000-8000-000000000001", "process-pipe");
  await access(join(leaseDir, "weird.json"));
  await handle.release();
  await rm(root, { recursive: true, force: true });
});

test("removeEmptyChildCgroups removes nested empty directories bottom-up", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-cgroup-children-"));
  await mkdir(join(root, "a", "b", "c"), { recursive: true });
  await mkdir(join(root, "d"));
  const removed = await removeEmptyChildCgroups(root, async () => false);
  assert.equal(removed, true);
  assert.deepEqual(await readdir(root), []);
  await rm(root, { recursive: true, force: true });

  const root2 = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-cgroup-children-"));
  await mkdir(join(root2, "a", "b", "c"), { recursive: true });
  await mkdir(join(root2, "d"));
  const blocked = join(root2, "a", "b");
  const removed2 = await removeEmptyChildCgroups(root2, async (candidate) => candidate === blocked);
  assert.equal(removed2, false);
  await access(blocked);
  await rm(root2, { recursive: true, force: true });
});
