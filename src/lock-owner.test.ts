import assert from "node:assert/strict";
import test from "node:test";
import { currentLockOwner, lockOwnerAlive } from "./lock-owner.ts";

test("a lock owner is alive only while its pid still names the same process", { skip: process.platform !== "linux" }, async () => {
  const self = await currentLockOwner();
  assert.equal(self.pid, process.pid);
  assert.match(self.startTime ?? "", /^\d+$/u);
  assert.equal(await lockOwnerAlive(self), true);
  // A pid reused after a restart: alive, but a different process.
  assert.equal(await lockOwnerAlive({ ...self, startTime: "1" }), false);
  // A record written before start times were recorded still falls back to the pid.
  assert.equal(await lockOwnerAlive({ pid: process.pid }), true);
  assert.equal(await lockOwnerAlive({ pid: 999_999_999 }), false);
  for (const malformed of [undefined, null, "pid", {}, { pid: -1 }, { pid: 1.5 }]) assert.equal(await lockOwnerAlive(malformed), false);
});
