import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventLog } from "./events.ts";

test("event log appends ordered JSONL records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-"));
  const log = new EventLog(join(dir, "events.jsonl"));
  await log.append({ type: "one" });
  await log.append({ type: "two", data: { ok: true } });
  const records = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number; data?: { ok?: boolean } });
  assert.deepEqual(records.map((record) => record.seq), [1, 2]);
  const second = records[1];
  assert.ok(second?.data);
  assert.equal(second.data.ok, true);
});

test("event log coordinates concurrent writers across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lock-"));
  const path = join(dir, "events.jsonl");
  const writers = Array.from({ length: 4 }, (_, index) => new EventLog(path).append({ type: `writer-${index}` }));
  const entries = await Promise.all(writers);
  assert.deepEqual(entries.map((entry) => entry.seq).sort((a, b) => a - b), [1, 2, 3, 4]);
  const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number });
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3, 4]);
});

test("event log removes an old lock owned by a dead process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-stale-lock-"));
  const path = join(dir, "events.jsonl");
  const lockPath = `${path}.lock`;
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
  const old = new Date(Date.now() - 6_000);
  await utimes(join(lockPath, "owner.json"), old, old);
  await utimes(lockPath, old, old);
  const entry = await new EventLog(path).append({ type: "after-stale-lock" });
  assert.equal(entry.seq, 1);
});

test("event log repairs a corrupt tail and resumes from the maximum sequence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-corrupt-tail-"));
  const path = join(dir, "events.jsonl");
  await writeFile(path, `${JSON.stringify({ seq: 4, type: "old" })}\nnot-json\n`);
  const entry = await new EventLog(path).append({ type: "recovered" });
  assert.equal(entry.seq, 5);
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.doesNotThrow(() => JSON.parse(lines[1]));
});

test("event log resumes sequence and redacts credential-shaped values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-resume-"));
  const path = join(dir, "events.jsonl");
  const first = new EventLog(path);
  await first.append({ type: "first", data: { token: "secret-value" } });
  const second = new EventLog(path);
  const entry = await second.append({ type: "second", data: { output: "Bearer top-secret sk-ant-api-value" } });
  assert.equal(entry.seq, 2);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /secret-value|top-secret|sk-ant-api-value/u);
  assert.match(contents, /REDACTED/u);
});
