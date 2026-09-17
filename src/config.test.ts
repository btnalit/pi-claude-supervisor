import assert from "node:assert/strict";
import test from "node:test";
import {
  autonomyDefaults,
  decisionCompactionTokens,
  decisionModel,
  decisionSessionRetentionDays,
  evidenceMaxBytes,
  evidenceMaxUntrackedFiles,
  eventLogMaxBytes,
  progressHeartbeatMs,
  reviewerModel,
  reviewTimeoutMs,
  workerAutocompactTokens,
  workerMcpConfigPath,
  workerModel,
} from "./config.ts";

test("autonomy environment defaults are unattended and bounded", () => {
  assert.deepEqual(autonomyDefaults({}), { unattended: true, requireLocalCommit: true, maxDecisionRetries: 2, permissionAuthority: "hybrid" });
  assert.deepEqual(autonomyDefaults({
    PI_CLAUDE_SUPERVISOR_UNATTENDED: "0",
    PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT: "false",
    PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES: "4",
  }), { unattended: false, requireLocalCommit: false, maxDecisionRetries: 4, permissionAuthority: "hybrid" });
  assert.deepEqual(autonomyDefaults({
    PI_CLAUDE_SUPERVISOR_UNATTENDED: "not-a-boolean",
    PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES: "99",
  }), { unattended: true, requireLocalCommit: true, maxDecisionRetries: 2, permissionAuthority: "hybrid" });
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

test("workerModel, workerMcpConfigPath, decisionModel and reviewerModel trim or omit", () => {
  assert.equal(workerModel({}), undefined);
  assert.equal(workerModel({ PI_CLAUDE_SUPERVISOR_WORKER_MODEL: "  claude-sonnet-4-5  " }), "claude-sonnet-4-5");
  assert.equal(workerModel({ PI_CLAUDE_SUPERVISOR_WORKER_MODEL: "   " }), undefined);
  assert.equal(workerMcpConfigPath({}), undefined);
  assert.equal(workerMcpConfigPath({ PI_CLAUDE_SUPERVISOR_WORKER_MCP_CONFIG: " /etc/mcp.json " }), "/etc/mcp.json");
  assert.equal(decisionModel({}), undefined);
  assert.equal(decisionModel({ PI_CLAUDE_SUPERVISOR_DECISION_MODEL: " anthropic/claude-opus-4 " }), "anthropic/claude-opus-4");
  assert.equal(reviewerModel({}), undefined);
  assert.equal(reviewerModel({ PI_CLAUDE_SUPERVISOR_REVIEWER_MODEL: " anthropic/claude-haiku-4 " }), "anthropic/claude-haiku-4");
});

test("workerAutocompactTokens defaults, honors an explicit 0 opt-out and rejects out-of-range overrides", () => {
  assert.equal(workerAutocompactTokens({}), 200_000);
  assert.equal(workerAutocompactTokens({ PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS: "300000" }), 300_000);
  assert.equal(workerAutocompactTokens({ PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS: "0" }), 0);
  assert.equal(workerAutocompactTokens({ PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS: "50000" }), 200_000);
  assert.equal(workerAutocompactTokens({ PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS: "2000000" }), 200_000);
  assert.equal(workerAutocompactTokens({ PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS: "" }), 200_000);
  assert.equal(workerAutocompactTokens({ PI_CLAUDE_SUPERVISOR_WORKER_AUTOCOMPACT_TOKENS: "0e5" }), 200_000);
});

test("decisionCompactionTokens defaults, honors an explicit 0 opt-out and rejects out-of-range overrides", () => {
  assert.equal(decisionCompactionTokens({}), 60_000);
  assert.equal(decisionCompactionTokens({ PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS: "100000" }), 100_000);
  assert.equal(decisionCompactionTokens({ PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS: "0" }), 0);
  assert.equal(decisionCompactionTokens({ PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS: "5000" }), 60_000);
  assert.equal(decisionCompactionTokens({ PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS: "9999999" }), 60_000);
  assert.equal(decisionCompactionTokens({ PI_CLAUDE_SUPERVISOR_DECISION_COMPACT_TOKENS: "" }), 60_000);
});

test("progressHeartbeatMs defaults and rejects out-of-range overrides", () => {
  assert.equal(progressHeartbeatMs({}), 60_000);
  assert.equal(progressHeartbeatMs({ PI_CLAUDE_SUPERVISOR_PROGRESS_HEARTBEAT_MS: "10000" }), 10_000);
  assert.equal(progressHeartbeatMs({ PI_CLAUDE_SUPERVISOR_PROGRESS_HEARTBEAT_MS: "1000" }), 60_000);
  assert.equal(progressHeartbeatMs({ PI_CLAUDE_SUPERVISOR_PROGRESS_HEARTBEAT_MS: "9999999" }), 60_000);
});

test("decisionSessionRetentionDays defaults, allows 0 within range and rejects out-of-range overrides", () => {
  assert.equal(decisionSessionRetentionDays({}), 30);
  assert.equal(decisionSessionRetentionDays({ PI_CLAUDE_SUPERVISOR_DECISION_SESSION_RETENTION_DAYS: "0" }), 0);
  assert.equal(decisionSessionRetentionDays({ PI_CLAUDE_SUPERVISOR_DECISION_SESSION_RETENTION_DAYS: "7" }), 7);
  assert.equal(decisionSessionRetentionDays({ PI_CLAUDE_SUPERVISOR_DECISION_SESSION_RETENTION_DAYS: "-1" }), 30);
  assert.equal(decisionSessionRetentionDays({ PI_CLAUDE_SUPERVISOR_DECISION_SESSION_RETENTION_DAYS: "99999" }), 30);
});

test("evidenceMaxBytes and evidenceMaxUntrackedFiles default and reject out-of-range overrides", () => {
  assert.equal(evidenceMaxBytes({}), 1024 * 1024);
  assert.equal(evidenceMaxBytes({ PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_BYTES: String(2 * 1024 * 1024) }), 2 * 1024 * 1024);
  assert.equal(evidenceMaxBytes({ PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_BYTES: "100" }), 1024 * 1024);
  assert.equal(evidenceMaxUntrackedFiles({}), 512);
  assert.equal(evidenceMaxUntrackedFiles({ PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_UNTRACKED_FILES: "100" }), 100);
  assert.equal(evidenceMaxUntrackedFiles({ PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_UNTRACKED_FILES: "1" }), 512);
  assert.equal(evidenceMaxUntrackedFiles({ PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_UNTRACKED_FILES: "99999" }), 512);
});
