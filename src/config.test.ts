import assert from "node:assert/strict";
import test from "node:test";
import { autonomyDefaults, eventLogMaxBytes, reviewTimeoutMs } from "./config.ts";

test("autonomy environment defaults are unattended and bounded", () => {
  assert.deepEqual(autonomyDefaults({}), { unattended: true, requireLocalCommit: true, maxDecisionRetries: 2 });
  assert.deepEqual(autonomyDefaults({
    PI_CLAUDE_SUPERVISOR_UNATTENDED: "0",
    PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT: "false",
    PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES: "4",
  }), { unattended: false, requireLocalCommit: false, maxDecisionRetries: 4 });
  assert.deepEqual(autonomyDefaults({
    PI_CLAUDE_SUPERVISOR_UNATTENDED: "not-a-boolean",
    PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES: "99",
  }), { unattended: true, requireLocalCommit: true, maxDecisionRetries: 2 });
});

test("reviewTimeoutMs defaults and rejects out-of-range overrides", () => {
  assert.equal(reviewTimeoutMs({}), 600_000);
  assert.equal(reviewTimeoutMs({ PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS: "120000" }), 120_000);
  assert.equal(reviewTimeoutMs({ PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS: "1000" }), 600_000);
  assert.equal(reviewTimeoutMs({ PI_CLAUDE_SUPERVISOR_REVIEW_TIMEOUT_MS: "9999999" }), 600_000);
});

test("eventLogMaxBytes defaults and rejects out-of-range overrides", () => {
  assert.equal(eventLogMaxBytes({}), 64 * 1024 * 1024);
  assert.equal(eventLogMaxBytes({ PI_CLAUDE_SUPERVISOR_EVENT_LOG_MAX_BYTES: String(2 * 1024 * 1024) }), 2 * 1024 * 1024);
  assert.equal(eventLogMaxBytes({ PI_CLAUDE_SUPERVISOR_EVENT_LOG_MAX_BYTES: "100" }), 64 * 1024 * 1024);
});
