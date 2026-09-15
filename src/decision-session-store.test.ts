import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DecisionSessionStore } from "./decision-session-store.ts";

const taskId = "11111111-1111-4111-8111-111111111111";

test("Decision Worker session registry survives a fresh store instance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-decision-store-"));
  const store = new DecisionSessionStore(directory);
  const sessionFile = join(store.sessionDirectory(taskId), "session.jsonl");
  await mkdir(store.sessionDirectory(taskId), { recursive: true });
  await store.save({
    taskId,
    task: "recover the fixture",
    cwd: "/tmp/fixture",
    command: "claude",
    args: ["--print"],
    resolvedExecutable: "/usr/bin/claude",
    approval: { actor: "human", reason: "test approval" },
    decisionSessionFile: sessionFile,
    maxTurns: 100,
    deadlineMs: 4 * 60 * 60_000,
    noOutputTimeoutMs: 20 * 60_000,
    startedAt: new Date().toISOString(),
    turn: 0,
    repairRound: 0,
    state: "active",
  });

  const restored = await new DecisionSessionStore(directory).load(taskId);
  assert.equal(restored?.taskId, taskId);
  assert.equal(restored?.state, "active");
  assert.equal(restored?.recoveryState, "ready");
  assert.equal(restored?.recoveryAttempt, 0);
  assert.equal(restored?.decisionSessionFile, sessionFile);
  assert.equal(restored?.resolvedExecutable, "/usr/bin/claude");
  assert.deepEqual(restored?.args, ["--print"]);
  assert.equal((await stat(join(directory, `${taskId}.json`))).mode & 0o777, 0o600);
  assert.equal(await store.sessionFileExists(taskId), false);
  await mkdir(store.sessionDirectory(taskId), { recursive: true });
  await writeFile(sessionFile, "{\"session\":true}\n");
  assert.equal(await store.sessionFileExists(taskId), true);
  await store.update(taskId, { turn: 3, repairRound: 1, lastFindingSignature: "abc123" });
  assert.equal((await store.load(taskId))?.turn, 3);
  assert.equal((await store.load(taskId))?.repairRound, 1);
  assert.equal((await store.load(taskId))?.lastFindingSignature, "abc123");

  await store.close(taskId);
  assert.equal((await store.load(taskId))?.state, "closed");
  assert.match(await readFile(join(directory, `${taskId}.json`), "utf8"), /closed/u);
});

test("Decision Worker recovery rejects a record whose task id differs from its filename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-decision-store-mismatch-"));
  const otherTaskId = "22222222-2222-4222-8222-222222222222";
  await writeFile(join(directory, `${taskId}.json`), JSON.stringify({ taskId: otherTaskId, decisionSessionFile: "/tmp/session.jsonl" }));
  await assert.rejects(() => new DecisionSessionStore(directory).load(taskId), /task id mismatch/u);
});

test("Decision Worker recovery claims are durable and only one attempt can start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-decision-store-recovery-"));
  const store = new DecisionSessionStore(directory);
  const sessionDirectory = store.sessionDirectory(taskId);
  await mkdir(sessionDirectory, { recursive: true });
  const sessionFile = join(sessionDirectory, "session.jsonl");
  await writeFile(sessionFile, "{}\n");
  await store.save({
    taskId,
    task: "recover once",
    cwd: "/tmp/fixture",
    command: "claude",
    args: [],
    decisionSessionFile: sessionFile,
    maxTurns: 10,
    deadlineMs: 60_000,
    noOutputTimeoutMs: 60_000,
    startedAt: new Date().toISOString(),
    turn: 2,
    state: "active",
  });

  const [first, second] = await Promise.allSettled([store.beginRecovery(taskId), new DecisionSessionStore(directory).beginRecovery(taskId)]);
  assert.equal([first, second].filter((result) => result.status === "fulfilled").length, 1);
  assert.equal([first, second].filter((result) => result.status === "rejected").length, 1);
  const claimed = first.status === "fulfilled" ? first.value : second.status === "fulfilled" ? second.value : undefined;
  assert.equal(claimed?.recoveryState, "starting");
  assert.equal(claimed?.recoveryAttempt, 1);
  await store.recordRecoveryWorker(taskId, { id: "worker-1", pid: 12345, startedAt: new Date().toISOString() });
  assert.equal((await store.load(taskId))?.recoveryState, "registered");
  await store.markRecoveryIdle(taskId);
  assert.equal((await store.load(taskId))?.recoveryState, "recovered_idle");
  await store.markRecoveryInterrupted(taskId);
  assert.equal((await store.load(taskId))?.recoveryState, "interrupted");
  const retry = await store.beginRecovery(taskId);
  assert.equal(retry.recoveryAttempt, 2);
  await store.resetRecovery(taskId);
  assert.equal((await store.load(taskId))?.recoveryState, "ready");
  const stale = await store.load(taskId);
  assert.ok(stale);
  await store.save({ ...stale, recoveryState: "starting", recoveryOwnerPid: 999999999, recoveryOwnerStartTime: "1" });
  await store.reconcileStaleRecovery(taskId);
  assert.equal((await store.load(taskId))?.recoveryState, "interrupted");

  const runningOwner = await store.load(taskId);
  assert.ok(runningOwner);
  await store.save({ ...runningOwner, recoveryState: "starting", recoveryOwnerPid: process.pid, recoveryOwnerStartTime: "0" });
  await store.reconcileStaleRecovery(taskId);
  assert.equal((await store.load(taskId))?.recoveryState, "interrupted");

  const missingIdentity = await store.load(taskId);
  assert.ok(missingIdentity);
  await store.save({ ...missingIdentity, recoveryState: "starting", recoveryOwnerPid: process.pid, recoveryOwnerStartTime: undefined });
  await assert.rejects(() => store.reconcileStaleRecovery(taskId), /identity is unavailable/u);
});

test("Decision Worker session registry ignores corrupt and misnamed records during discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-decision-store-corrupt-"));
  const store = new DecisionSessionStore(directory);
  await mkdir(store.sessionDirectory(taskId), { recursive: true });
  await store.save({
    taskId,
    task: "valid",
    cwd: "/tmp/fixture",
    command: "claude",
    args: [],
    decisionSessionFile: join(store.sessionDirectory(taskId), "session.jsonl"),
    maxTurns: 100,
    deadlineMs: 4 * 60 * 60_000,
    noOutputTimeoutMs: 20 * 60_000,
    startedAt: new Date().toISOString(),
    turn: 0,
    repairRound: 0,
    state: "active",
  });
  await writeFile(join(directory, "corrupt.json"), "not-json\n");
  await writeFile(join(directory, "not-a-task.json"), JSON.stringify({ taskId, state: "active" }));
  const records = await store.list({ activeOnly: true });
  assert.deepEqual(records.map((record) => record.taskId), [taskId]);
});
