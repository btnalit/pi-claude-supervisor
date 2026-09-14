import assert from "node:assert/strict";
import test from "node:test";
import { autonomyDefaults } from "./config.ts";

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
