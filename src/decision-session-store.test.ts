import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DecisionSessionStore } from "./decision-session-store.ts";

const taskId = "11111111-1111-4111-8111-111111111111";

test("Decision Worker session registry survives a fresh store instance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-decision-store-"));
  const store = new DecisionSessionStore(directory);
  const sessionFile = join(store.sessionDirectory(taskId), "session.jsonl");
  await store.save({
    taskId,
    task: "recover the fixture",
    cwd: "/tmp/fixture",
    command: "claude",
    args: ["--print"],
    approval: { actor: "human", reason: "test approval" },
    decisionSessionFile: sessionFile,
    state: "active",
  });

  const restored = await new DecisionSessionStore(directory).load(taskId);
  assert.equal(restored?.taskId, taskId);
  assert.equal(restored?.state, "active");
  assert.equal(restored?.decisionSessionFile, sessionFile);
  assert.deepEqual(restored?.args, ["--print"]);
  assert.equal((await stat(join(directory, `${taskId}.json`))).mode & 0o777, 0o600);

  await store.close(taskId);
  assert.equal((await store.load(taskId))?.state, "closed");
  assert.match(await readFile(join(directory, `${taskId}.json`), "utf8"), /closed/u);
});

test("Decision Worker session registry ignores corrupt records during discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-decision-store-corrupt-"));
  const store = new DecisionSessionStore(directory);
  await store.save({
    taskId,
    task: "valid",
    cwd: "/tmp/fixture",
    command: "claude",
    args: [],
    decisionSessionFile: join(store.sessionDirectory(taskId), "session.jsonl"),
    state: "active",
  });
  await writeFile(join(directory, "corrupt.json"), "not-json\n");
  const records = await store.list({ activeOnly: true });
  assert.deepEqual(records.map((record) => record.taskId), [taskId]);
});
