import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CwdLeaseStore, pathsOverlap } from "./cwd-lease.ts";

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
  await assert.rejects(
    () => store.acquire(cwd, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "process-pipe", { takeover: { taskId: noCgroup.record.taskId } }),
    /working-directory lease is held/u,
  );
  await noCgroup.release();
  await rm(root, { recursive: true, force: true });
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

test("cwd lease registry fails closed when a leased cwd disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lease-"));
  const leaseDir = join(root, "leases");
  const oldCwd = join(root, "old");
  const newCwd = join(root, "new");
  await mkdir(oldCwd);
  await mkdir(newCwd);
  const store = new CwdLeaseStore(leaseDir);
  const old = await store.acquire(oldCwd, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "process-pipe");
  await rm(oldCwd, { recursive: true, force: true });
  await assert.rejects(() => store.acquire(newCwd, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "process-pipe"), /ENOENT/u);
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
