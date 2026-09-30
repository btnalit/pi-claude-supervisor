import assert from "node:assert/strict";
import test from "node:test";
import { retryGitRead } from "./git-read.ts";

const failure = (fields: Record<string, unknown>) => Object.assign(new Error("Git read failed"), fields);

test("Git reads retry identified transient failures, but stop after three attempts", async () => {
  for (const error of [failure({ code: "EAGAIN" }), failure({ code: 128, stderr: "fatal: Could not resolve host: example.invalid" }), failure({ code: 128, stderr: "fatal: The requested URL returned error: 503" })]) {
    let attempts = 0;
    assert.equal(await retryGitRead(async () => { if (++attempts < 3) throw error; return "read"; }), "read");
    assert.equal(attempts, 3);
  }
  let attempts = 0;
  const error = failure({ code: "EBUSY" });
  await assert.rejects(retryGitRead(async () => { attempts += 1; throw error; }), (caught) => caught === error);
  assert.equal(attempts, 3);
});

test("Git reads never retry aborts, oversized output, definitive negatives, credentials or unknown failures", async () => {
  for (const error of [
    failure({ name: "AbortError" }),
    failure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM" }),
    failure({ code: 1 }), failure({ code: 2 }),
    failure({ code: 128, stderr: "fatal: Authentication failed" }),
    failure({ code: 128, stderr: "fatal: The requested URL returned error: 403" }),
    failure({ code: 128, stderr: "fatal: not a git repository" }),
    failure({ code: 128, stderr: "fatal: invalid object name" }),
    failure({ code: 128, stderr: "fatal: reference request 503 failed" }),
  ]) {
    let attempts = 0;
    await assert.rejects(retryGitRead(async () => { attempts += 1; throw error; }), (caught) => caught === error);
    assert.equal(attempts, 1);
  }
});

test("an abort interrupts Git retry backoff without another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const reading = retryGitRead(async () => { attempts += 1; controller.abort(); throw failure({ code: "EAGAIN" }); }, controller.signal);
  await assert.rejects(reading);
  assert.equal(attempts, 1);

  const backoff = new AbortController();
  const second = retryGitRead(async () => { attempts += 1; setTimeout(() => backoff.abort(), 10); throw failure({ code: "EAGAIN" }); }, backoff.signal);
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(attempts, 2);
});
