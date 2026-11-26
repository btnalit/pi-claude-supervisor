import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { analyzeFiles, expandLogPaths, formatReport, parseSinceArg } from "./report.mjs";

const execFileAsync = promisify(execFile);

test("report aggregates rotated and live event logs into accurate outcome, park, override, permission, cost, and reviewer stats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-report-"));
  try {
    const rotated = join(dir, "events.jsonl.2026-11-24T00-00-00-000Z-a1b2c3d4");
    const live = join(dir, "events.jsonl");

    const rotatedEvents = [
      // Task 1: starts, 1 repair round, review revise -> pass, completes in 10s
      { seq: 1, at: "2026-11-24T10:00:00.000Z", type: "task_started", taskId: "task-1" },
      { seq: 2, at: "2026-11-24T10:00:02.000Z", type: "permission_decision", taskId: "task-1", data: { actor: "policy", behavior: "allow", phase: "pre", toolName: "Bash" } },
      { seq: 3, at: "2026-11-24T10:00:03.000Z", type: "permission_decision", taskId: "task-1", data: { actor: "policy", behavior: "deny", phase: "pre", toolName: "Bash" } },
      { seq: 4, at: "2026-11-24T10:00:04.000Z", type: "worker_usage", taskId: "task-1", data: { costUsd: 0.25 } },
      { seq: 5, at: "2026-11-24T10:00:05.000Z", type: "pi_usage", taskId: "task-1", data: { role: "decision", input: 1000, output: 100, cacheRead: 200, cacheWrite: 50, totalTokens: 1350, costUsd: 0.01 } },
      { seq: 6, at: "2026-11-24T10:00:06.000Z", type: "review_started", taskId: "task-1" },
      { seq: 7, at: "2026-11-24T10:00:07.000Z", type: "review_result", taskId: "task-1", data: { verdict: "revise" } },
      { seq: 8, at: "2026-11-24T10:00:07.500Z", type: "repair_requested", taskId: "task-1" },
      { seq: 9, at: "2026-11-24T10:00:08.000Z", type: "decision_overridden", taskId: "task-1", data: { action: "continue", override: "verify", reason: "turn budget of 100 is exhausted" } },
      // Malformed line in rotated log should be counted and skipped cleanly.
    ];

    const liveEvents = [
      // Task 1 finishes in live log
      { seq: 10, at: "2026-11-24T10:00:09.000Z", type: "review_started", taskId: "task-1" },
      { seq: 11, at: "2026-11-24T10:00:09.500Z", type: "review_result", taskId: "task-1", data: { verdict: "pass", summary: "ok", findings: [] } },
      { seq: 12, at: "2026-11-24T10:00:09.600Z", type: "pi_usage", taskId: "task-1", data: { role: "reviewer", input: 2000, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 2300, costUsd: 0.03 } },
      { seq: 13, at: "2026-11-24T10:00:10.000Z", type: "verification_passed", taskId: "task-1" },
      // Task 2: decision_worker_failed fallback deny, real REVIEW-OUTPUT failure, then worker_stopped BEFORE candidate_parked (#parkCandidate order)
      { seq: 14, at: "2026-11-24T11:00:00.000Z", type: "task_started", taskId: "task-2" },
      { seq: 15, at: "2026-11-24T11:00:10.000Z", type: "decision_worker_failed", taskId: "task-2", data: { eventType: "permission_request", fallback: "deny_permission" } },
      { seq: 16, at: "2026-11-24T11:00:10.100Z", type: "permission_decision", taskId: "task-2", data: { actor: "supervisor", behavior: "deny", policy: "decision_error_fallback", toolName: "AskUserQuestion" } },
      { seq: 17, at: "2026-11-24T11:00:20.000Z", type: "review_started", taskId: "task-2" },
      { seq: 18, at: "2026-11-24T11:00:25.000Z", type: "review_result", taskId: "task-2", data: { verdict: "human", summary: "invalid Reviewer output: unsupported verdict", findings: [{ id: "REVIEW-OUTPUT", severity: "P0", message: "invalid Reviewer output: unsupported verdict" }] } },
      { seq: 19, at: "2026-11-24T11:00:29.000Z", type: "worker_stopped", taskId: "task-2", data: { reason: "park candidate: Reviewer blocked" } },
      { seq: 20, at: "2026-11-24T11:00:30.000Z", type: "candidate_parked", taskId: "task-2", data: { reasonLabel: "Reviewer blocked", reason: "invalid Reviewer output: unsupported verdict" } },
      { seq: 21, at: "2026-11-24T11:00:31.000Z", type: "worker_usage", taskId: "task-2", data: { costUsd: 0.75 } },
      // Task 3: operator stopped
      { seq: 22, at: "2026-11-24T12:00:00.000Z", type: "task_started", taskId: "task-3" },
      { seq: 23, at: "2026-11-24T12:05:00.000Z", type: "worker_stopped", taskId: "task-3", data: { reason: "operator stop" } },
      // Task 4: watchdog failure (worker_stopped BEFORE candidate_failed) + Reviewer API failure shape
      { seq: 24, at: "2026-11-24T13:00:00.000Z", type: "task_started", taskId: "task-4" },
      { seq: 25, at: "2026-11-24T13:01:00.000Z", type: "review_started", taskId: "task-4" },
      { seq: 26, at: "2026-11-24T13:01:05.000Z", type: "review_result", taskId: "task-4", data: { verdict: "human", summary: "independent Reviewer failed: 429 rate limited", findings: [{ id: "REVIEW-ERROR", severity: "P0", message: "429 rate limited" }] } },
      { seq: 27, at: "2026-11-24T13:02:00.000Z", type: "worker_stopped", taskId: "task-4", data: { reason: "watchdog timeout" } },
      { seq: 28, at: "2026-11-24T13:02:01.000Z", type: "candidate_failed", taskId: "task-4", data: { reason: "watchdog timeout" } },
      // Task 5: truncated repository evidence REVIEW-OUTPUT must NOT inflate format/API failure rate
      { seq: 29, at: "2026-11-24T14:00:00.000Z", type: "task_started", taskId: "task-5" },
      { seq: 30, at: "2026-11-24T14:00:10.000Z", type: "review_started", taskId: "task-5" },
      { seq: 31, at: "2026-11-24T14:00:15.000Z", type: "review_result", taskId: "task-5", data: { verdict: "human", summary: "evidence truncated", findings: [{ id: "REVIEW-OUTPUT", severity: "P1", message: "repository evidence is incomplete or truncated" }] } },
      { seq: 32, at: "2026-11-24T14:00:16.000Z", type: "candidate_blocked", taskId: "task-5", data: { reason: "repair budget exhausted" } },
    ];

    await writeFile(rotated, `${rotatedEvents.map((e) => JSON.stringify(e)).join("\n")}\n{broken json line\n`);
    await writeFile(live, `${liveEvents.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const paths = await expandLogPaths([live], { includeRotated: true });
    assert.deepEqual(paths, [rotated, live]);

    const report = await analyzeFiles(paths);
    assert.equal(report.files.length, 2);
    assert.equal(report.totalEvents, 32);
    assert.equal(report.malformedLines, 1);
    assert.equal(report.tasks.total, 5);
    assert.deepEqual(report.tasks.outcomes, { completed: 1, failed: 1, in_progress: 1, parked: 1, stopped: 1 });
    assert.deepEqual(report.tasks.parkReasons, { "Reviewer blocked": 1 });
    assert.deepEqual(report.tasks.blockReasons, { "repair budget exhausted": 1 });
    assert.equal(report.tasks.repairRounds.total, 1);
    assert.deepEqual(report.tasks.repairRounds.distribution, { "0": 4, "1": 1, "2": 0, "3+": 0 });
    assert.equal(report.tasks.firstCandidateDurationMs.samples, 2);
    assert.equal(report.tasks.firstCandidateDurationMs.min, 10_000);
    assert.equal(report.tasks.firstCandidateDurationMs.max, 30_000);
    assert.equal(report.decisions.overridden, 1);
    assert.deepEqual(report.decisions.overrideReasons, { "continue -> verify (turn budget of <N> is exhausted)": 1 });
    assert.equal(report.decisions.workerFailed, 1);
    assert.equal(report.decisions.workerFailedFallbackDeny, 1);
    assert.deepEqual(report.permissions.byActor, { policy: 2, supervisor: 1 });
    assert.deepEqual(report.permissions.deniedTools, { AskUserQuestion: 1, Bash: 1 });
    assert.equal(report.costAndUsage.workerCostUsd.total, 1);
    assert.equal(report.costAndUsage.pi.decision.totalTokens, 1350);
    assert.equal(report.costAndUsage.pi.reviewer.totalTokens, 2300);
    // 5 completed reviews: revise, pass, REVIEW-OUTPUT format failure, independent Reviewer failed API failure, truncated evidence (excluded).
    assert.equal(report.reviewer.started, 5);
    assert.equal(report.reviewer.completed, 5);
    assert.equal(report.reviewer.formatOrApiFailures, 2);
    assert.equal(report.reviewer.failureRate, 0.4);

    const text = formatReport(report);
    assert.match(text, /Tasks \(5 total\)/u);
    assert.match(text, /Reviewer blocked: 1/u);
    assert.match(text, /Worker cost: total=\$1\.0000/u);

    // CLI invocation with --json and --since filters accurately.
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/report.mjs",
      "--json",
      "--include-rotated",
      "--since",
      "2026-11-24T11:30:00.000Z",
      live,
    ]);
    const filtered = JSON.parse(stdout);
    assert.equal(filtered.tasks.total, 3);
    assert.deepEqual(filtered.tasks.outcomes, { failed: 1, in_progress: 1, stopped: 1 });

    // --include-rotated still finds rotated logs if the live file is momentarily absent.
    await rm(live);
    const rotatedOnly = await expandLogPaths([live], { includeRotated: true });
    assert.deepEqual(rotatedOnly, [rotated, live]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseSinceArg parses durations and ISO timestamps and rejects invalid input", () => {
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  assert.equal(parseSinceArg("2h", now), now - 7_200_000);
  assert.equal(parseSinceArg("7d", now), now - 7 * 86_400_000);
  assert.equal(parseSinceArg("2026-11-20T00:00:00.000Z", now), Date.parse("2026-11-20T00:00:00.000Z"));
  assert.throws(() => parseSinceArg("yesterday", now), /Invalid --since/u);
});
