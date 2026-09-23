import assert from "node:assert/strict";
import test from "node:test";
import {
  autonomyDefaults,
  deadlineGraceMs,
  deadlineMs,
  deadlineWarningMs,
  decisionCompactionTokens,
  decisionModel,
  decisionSessionRetentionDays,
  evidenceMaxBytes,
  evidenceMaxUntrackedFiles,
  eventLogMaxBytes,
  formatDurationMs,
  noOutputTimeoutMs,
  parseDurationMs,
  progressHeartbeatMs,
  reviewerModel,
  reviewTimeoutMs,
  workerAutocompactTokens,
  workerMcpConfigPath,
  workerModel,
} from "./config.ts";

test("autonomy environment defaults are unattended and bounded", () => {
  assert.deepEqual(autonomyDefaults({}), { unattended: true, requireLocalCommit: true, maxDecisionRetries: 4, permissionAuthority: "hybrid", remoteAuthority: "none", remoteName: "origin" });
  assert.deepEqual(autonomyDefaults({
    PI_CLAUDE_SUPERVISOR_UNATTENDED: "0",
    PI_CLAUDE_SUPERVISOR_REQUIRE_LOCAL_COMMIT: "false",
    PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES: "1",
  }), { unattended: false, requireLocalCommit: false, maxDecisionRetries: 1, permissionAuthority: "hybrid", remoteAuthority: "none", remoteName: "origin" });
  assert.deepEqual(autonomyDefaults({
    PI_CLAUDE_SUPERVISOR_UNATTENDED: "not-a-boolean",
    PI_CLAUDE_SUPERVISOR_MAX_DECISION_RETRIES: "99",
  }), { unattended: true, requireLocalCommit: true, maxDecisionRetries: 4, permissionAuthority: "hybrid", remoteAuthority: "none", remoteName: "origin" });
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

test("parseDurationMs accepts unit suffixes, compounds and plain milliseconds", () => {
  assert.equal(parseDurationMs("8h"), 8 * 60 * 60_000);
  assert.equal(parseDurationMs("90m"), 90 * 60_000);
  assert.equal(parseDurationMs("2h30m"), 150 * 60_000);
  assert.equal(parseDurationMs("45s"), 45_000);
  assert.equal(parseDurationMs("1.5h"), 90 * 60_000);
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs(" 1d "), 24 * 60 * 60_000);
  assert.equal(parseDurationMs("14400000"), 14_400_000);
  assert.equal(parseDurationMs("0"), 0);
  assert.equal(parseDurationMs(""), undefined);
  assert.equal(parseDurationMs(undefined), undefined);
  assert.equal(parseDurationMs("-5m"), undefined);
  assert.equal(parseDurationMs("5 m"), undefined);
  assert.equal(parseDurationMs("five"), undefined);
  assert.equal(parseDurationMs("1h30"), undefined);
});

test("formatDurationMs renders compact durations", () => {
  assert.equal(formatDurationMs(0), "0s");
  assert.equal(formatDurationMs(45_000), "45s");
  assert.equal(formatDurationMs(6 * 60_000 + 30_000), "6m30s");
  assert.equal(formatDurationMs(24 * 60_000 + 30_000), "24m");
  assert.equal(formatDurationMs(2 * 60 * 60_000 + 13 * 60_000), "2h13m");
  assert.equal(formatDurationMs(4 * 60 * 60_000), "4h");
  assert.equal(formatDurationMs(-1), "0s");
});

test("deadline budgets default, accept durations and honor the zero opt-out", () => {
  assert.equal(deadlineMs({}), 4 * 60 * 60_000);
  assert.equal(deadlineMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_MS: "8h" }), 8 * 60 * 60_000);
  assert.equal(deadlineMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_MS: "28800000" }), 8 * 60 * 60_000);
  assert.equal(deadlineMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_MS: "0" }), 0);
  assert.equal(deadlineMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_MS: "0h" }), 0, "any zero duration is the opt-out");
  assert.equal(deadlineGraceMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_GRACE_MS: "0m" }), 0);
  assert.equal(deadlineMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_MS: "1m" }), 4 * 60 * 60_000, "below the 5-minute floor keeps the default");
  assert.equal(deadlineMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_MS: "8d" }), 4 * 60 * 60_000, "above the 7-day ceiling keeps the default");
  assert.equal(deadlineMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_MS: "soon" }), 4 * 60 * 60_000);

  assert.equal(deadlineGraceMs({}), 30 * 60_000);
  assert.equal(deadlineGraceMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_GRACE_MS: "1h" }), 60 * 60_000);
  assert.equal(deadlineGraceMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_GRACE_MS: "0" }), 0);
  assert.equal(deadlineGraceMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_GRACE_MS: "2d" }), 30 * 60_000);

  assert.equal(deadlineWarningMs({}), 15 * 60_000);
  assert.equal(deadlineWarningMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_WARNING_MS: "30m" }), 30 * 60_000);
  assert.equal(deadlineWarningMs({ PI_CLAUDE_SUPERVISOR_DEADLINE_WARNING_MS: "0" }), 0);

  assert.equal(noOutputTimeoutMs({}), 20 * 60_000);
  assert.equal(noOutputTimeoutMs({ PI_CLAUDE_SUPERVISOR_NO_OUTPUT_TIMEOUT_MS: "45m" }), 45 * 60_000);
  assert.equal(noOutputTimeoutMs({ PI_CLAUDE_SUPERVISOR_NO_OUTPUT_TIMEOUT_MS: "0" }), 0);
  assert.equal(noOutputTimeoutMs({ PI_CLAUDE_SUPERVISOR_NO_OUTPUT_TIMEOUT_MS: "10s" }), 20 * 60_000, "below the 1-minute floor keeps the default");
});

test("remote authority never defaults on and only accepts the two grants", () => {
  assert.equal(autonomyDefaults({}).remoteAuthority, "none");
  assert.equal(autonomyDefaults({}).remoteName, "origin");
  assert.equal(autonomyDefaults({ PI_CLAUDE_SUPERVISOR_REMOTE_AUTHORITY: "push" }).remoteAuthority, "push");
  assert.equal(autonomyDefaults({ PI_CLAUDE_SUPERVISOR_REMOTE_AUTHORITY: "PR" }).remoteAuthority, "pr");
  assert.equal(autonomyDefaults({ PI_CLAUDE_SUPERVISOR_REMOTE_AUTHORITY: "none" }).remoteAuthority, "none");
  assert.equal(autonomyDefaults({ PI_CLAUDE_SUPERVISOR_REMOTE_AUTHORITY: "  " }).remoteAuthority, "none");
  // Anything unrecognised throws, like a malformed remote name: a typo must
  // not silently switch the publish phase off behind a bare "candidate is ready".
  assert.throws(() => autonomyDefaults({ PI_CLAUDE_SUPERVISOR_REMOTE_AUTHORITY: "merge" }), /must be none, push or pr: merge/u);
  assert.throws(() => autonomyDefaults({ PI_CLAUDE_SUPERVISOR_REMOTE_AUTHORITY: "pull-request" }), /must be none, push or pr/u);
  assert.equal(autonomyDefaults({ PI_CLAUDE_SUPERVISOR_REMOTE_NAME: "upstream" }).remoteName, "upstream");
  assert.throws(() => autonomyDefaults({ PI_CLAUDE_SUPERVISOR_REMOTE_NAME: "bad name;rm" }), /must be a plain remote name/u);
});
