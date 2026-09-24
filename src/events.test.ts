import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
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

test("event log removes an old lock whose pid was reused by another process", { skip: process.platform !== "linux" }, async () => {
  // After a crash and a container restart the new Pi often gets the old pid.
  // The pid is alive, but its start time no longer matches the lock's owner.
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-reused-pid-lock-"));
  const path = join(dir, "events.jsonl");
  const lockPath = `${path}.lock`;
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, startTime: "1", at: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 6_000);
  await utimes(join(lockPath, "owner.json"), old, old);
  await utimes(lockPath, old, old);
  const started = Date.now();
  const entry = await new EventLog(path).append({ type: "after-reused-pid-lock" });
  assert.equal(entry.seq, 1);
  assert.ok(Date.now() - started < 2_000, "the abandoned lock is reclaimed, not waited out");
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
  const entry = await second.append({ type: "second", data: { output: "Bearer top-secret sk-ant-api-value ghp_123456789012345678901234567890123456 github_pat_12345678901234567890 xoxb-12345678901234567890 npm_123456789012345678901234567890123456 AKIA1234567890ABCDEF eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature" } });
  assert.equal(entry.seq, 2);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /secret-value|top-secret|sk-ant-api-value|ghp_123456789012345678901234567890123456|github_pat_12345678901234567890|xoxb-12345678901234567890|npm_123456789012345678901234567890123456|AKIA1234567890ABCDEF|eyJhbGciOiJIUzI1NiJ9/u);
  assert.match(contents, /REDACTED/u);
});

test("append cost does not grow with log size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-bulk-"));
  const path = join(dir, "events.jsonl");
  const lines: string[] = [];
  let size = 0;
  let seq = 0;
  while (size < 5 * 1024 * 1024) {
    seq += 1;
    const line = JSON.stringify({ seq, at: new Date().toISOString(), type: "bulk", data: { pad: "x".repeat(40) } });
    lines.push(line);
    size += line.length + 1;
  }
  await writeFile(path, `${lines.join("\n")}\n`);
  const log = new EventLog(path);
  const firstStart = performance.now();
  const entry = await log.append({ type: "after-bulk" });
  const firstElapsed = performance.now() - firstStart;
  assert.equal(entry.seq, seq + 1);
  assert.ok(firstElapsed < 500, `expected append on a 5 MB log to finish in under 500ms, took ${firstElapsed}ms`);

  // The first append still pays for the one-time full scan on #initialize.
  // A second append on the same (now-initialized) instance must go through
  // the tail-only #refreshSequence path and stay well under that cost,
  // proving the per-append work does not grow with log size.
  const secondStart = performance.now();
  const second = await log.append({ type: "after-bulk-2" });
  const secondElapsed = performance.now() - secondStart;
  assert.equal(second.seq, seq + 2);
  assert.ok(secondElapsed < 100, `expected a tail-path append to finish in under 100ms, took ${secondElapsed}ms`);
});

test("sequence continues across rotation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-rotate-"));
  const path = join(dir, "events.jsonl");
  const log = new EventLog(path, { maxBytes: 2_000 });
  const seqs: number[] = [];
  for (let index = 0; index < 80; index += 1) {
    const entry = await log.append({ type: `event-${index}`, data: { pad: "x".repeat(20) } });
    seqs.push(entry.seq);
  }
  for (let index = 1; index < seqs.length; index += 1) {
    assert.equal(seqs[index], seqs[index - 1] + 1);
  }
  const liveStat = await stat(path);
  assert.ok(liveStat.size > 0);
  const entries = await readdir(dir);
  const rotated = entries.filter((name) => name.startsWith("events.jsonl.") && name !== "events.jsonl.lock");
  assert.ok(rotated.length >= 2, `expected at least 2 rotated files, found ${rotated.length}`);
});

test("rotated files are pruned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-prune-"));
  const path = join(dir, "events.jsonl");
  const log = new EventLog(path, { maxBytes: 2_000, keepRotated: 2 });
  for (let index = 0; index < 160; index += 1) {
    await log.append({ type: `event-${index}`, data: { pad: "x".repeat(20) } });
  }
  const entries = await readdir(dir);
  const rotated = entries.filter((name) => name.startsWith("events.jsonl.") && name !== "events.jsonl.lock");
  assert.ok(rotated.length >= 1, "expected at least one rotation to have happened");
  assert.ok(rotated.length <= 2, `expected at most 2 rotated files, found ${rotated.length}`);
  assert.ok(!entries.includes("events.jsonl.lock"), "lock directory should not remain once operations complete");
});

test("a second instance resumes after rotation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-resume-rotate-"));
  const path = join(dir, "events.jsonl");
  const first = new EventLog(path, { maxBytes: 2_000 });
  let lastSeq = 0;
  for (let index = 0; index < 60; index += 1) {
    const entry = await first.append({ type: `event-${index}`, data: { pad: "x".repeat(20) } });
    lastSeq = entry.seq;
  }
  const entries = await readdir(dir);
  const rotated = entries.filter((name) => name.startsWith("events.jsonl.") && name !== "events.jsonl.lock");
  assert.ok(rotated.length >= 1, "expected at least one rotation to have happened");
  const second = new EventLog(path, { maxBytes: 2_000 });
  const entry = await second.append({ type: "after-rotation" });
  assert.equal(entry.seq, lastSeq + 1);
});

test("tail read repairs a partial last line written after initialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tail-repair-"));
  const path = join(dir, "events.jsonl");
  const log = new EventLog(path);
  const first = await log.append({ type: "first" });
  assert.equal(first.seq, 1);
  await appendFile(path, "not-json-partial-line");
  const second = await log.append({ type: "second" });
  assert.equal(second.seq, 2);
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});
