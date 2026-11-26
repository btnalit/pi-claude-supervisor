#!/usr/bin/env node
/**
 * Read-only quality & autonomy report over Supervisor event logs (`events.jsonl`
 * and rotated `events.jsonl.<stamp>` siblings). Zero runtime side effects.
 *
 * Usage:
 *   npm run report -- [--json] [--include-rotated] [--since <ISO|duration>] [events.jsonl ...]
 *
 * Task outcome derivation rule (applied in chronological order per taskId):
 *   - `verification_passed` -> `completed` (terminal, never overwritten)
 *   - `candidate_parked` -> `parked` (overrides `stopped`, because `#parkCandidate` writes `worker_stopped` before `candidate_parked`)
 *   - `candidate_failed` -> `failed` (overrides `stopped`, because watchdog/failure paths write `worker_stopped` before `candidate_failed`)
 *   - `verification_failed` | `worker_start_failed` -> `failed` (unless already `completed`, `stopped`, or `parked`)
 *   - `worker_stopped` -> `stopped` (unless `completed`; overrides `verification_failed` when operator stops during verification)
 *   - No terminal event observed -> `in_progress`
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROTATED_SUFFIX_RE = /^\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8})$/u;

export function parseSinceArg(value, nowMs = Date.now()) {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/iu);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const mult = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return nowMs - amount * mult;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Invalid --since value (expected ISO timestamp or duration like 24h, 7d): ${value}`);
}

export async function expandLogPaths(inputs, { includeRotated = false } = {}) {
  const expanded = [];
  const seen = new Set();
  const add = (filePath) => {
    const resolved = resolve(filePath);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      expanded.push(resolved);
    }
  };

  for (const input of inputs) {
    const resolved = resolve(input);
    let info = null;
    try {
      info = await stat(resolved);
    } catch {
      // File may be absent (e.g., momentarily right after rotation); still
      // scan rotated siblings when --include-rotated is requested.
    }
    if (info?.isDirectory()) {
      const entries = await readdir(resolved);
      const rotated = entries
        .filter((name) => name.startsWith("events.jsonl.") && ROTATED_SUFFIX_RE.test(name.slice("events.jsonl".length)))
        .sort();
      for (const name of rotated) add(join(resolved, name));
      if (entries.includes("events.jsonl")) add(join(resolved, "events.jsonl"));
      continue;
    }
    if (includeRotated) {
      const dir = dirname(resolved);
      const base = basename(resolved);
      const entries = await readdir(dir).catch(() => []);
      const rotated = entries
        .filter((name) => name.startsWith(`${base}.`) && ROTATED_SUFFIX_RE.test(name.slice(base.length)))
        .sort();
      for (const name of rotated) add(join(dir, name));
    }
    add(resolved);
  }
  return expanded;
}

export function categorizeOverrideReason(data) {
  const override = typeof data?.override === "string" ? data.override : "";
  const action = typeof data?.action === "string" ? data.action : "";
  const rawReason = typeof data?.reason === "string" ? data.reason : "";
  const reason = rawReason.replace(/\b\d+\b/gu, "<N>");
  if (action && override) return `${action} -> ${override}${reason ? ` (${truncateLabel(reason, 60)})` : ""}`;
  if (reason) return truncateLabel(reason, 80);
  return "unspecified";
}

function isReviewerFormatOrApiFailure(data) {
  if (!data || typeof data !== "object" || data.verdict !== "human") return false;
  if (typeof data.summary === "string" && /^independent Reviewer failed:/iu.test(data.summary.trim())) {
    return true;
  }
  if (Array.isArray(data.findings)) {
    return data.findings.some((finding) =>
      finding
      && typeof finding === "object"
      && finding.id === "REVIEW-OUTPUT"
      && !/repository evidence is incomplete or truncated/iu.test(String(finding.message ?? "")),
    );
  }
  return false;
}

function truncateLabel(value, maxLen = 80) {
  const singleLine = String(value).replace(/\s+/gu, " ").trim();
  if (!singleLine) return "(empty)";
  return singleLine.length > maxLen ? `${singleLine.slice(0, maxLen - 1)}…` : singleLine;
}

function increment(map, key, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function sortedEntries(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function percentile(sortedNumbers, p) {
  if (sortedNumbers.length === 0) return null;
  const index = Math.min(sortedNumbers.length - 1, Math.max(0, Math.ceil((p / 100) * sortedNumbers.length) - 1));
  return sortedNumbers[index];
}

export function createAggregator({ sinceMs } = {}) {
  const tasks = new Map();
  const parkReasons = new Map();
  const blockReasons = new Map();
  const overrideReasons = new Map();
  const permissionByActor = new Map();
  const permissionByBehavior = new Map();
  const permissionByPhase = new Map();
  const deniedTools = new Map();
  const reviewVerdicts = new Map();
  const piUsage = {
    decision: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
    reviewer: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
  };
  let totalEvents = 0;
  let skippedBeforeSince = 0;
  let malformedLines = 0;
  let earliestAt = null;
  let latestAt = null;
  let decisionOverrides = 0;
  let decisionWorkerFailed = 0;
  let decisionWorkerFallbackDeny = 0;
  let decisionActionFailed = 0;
  let decisionRetries = 0;
  let decisionIgnored = 0;
  let reviewsStarted = 0;
  let reviewsCompleted = 0;
  let reviewerFormatOrApiFailures = 0;

  const ensureTask = (taskId) => {
    let entry = tasks.get(taskId);
    if (!entry) {
      entry = {
        taskId,
        startedAtMs: null,
        firstCandidateAtMs: null,
        outcome: "in_progress",
        repairRounds: 0,
        workerCostUsd: 0,
        workerTurns: 0,
      };
      tasks.set(taskId, entry);
    }
    return entry;
  };

  const ingest = (event) => {
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      malformedLines += 1;
      return;
    }
    const atMs = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
    if (sinceMs !== undefined && Number.isFinite(atMs) && atMs < sinceMs) {
      skippedBeforeSince += 1;
      return;
    }
    totalEvents += 1;
    if (typeof event.at === "string") {
      if (earliestAt === null || event.at < earliestAt) earliestAt = event.at;
      if (latestAt === null || event.at > latestAt) latestAt = event.at;
    }

    const data = event.data && typeof event.data === "object" ? event.data : {};
    const task = typeof event.taskId === "string" && event.taskId ? ensureTask(event.taskId) : null;

    if (task && Number.isFinite(atMs) && task.startedAtMs === null && (event.type === "task_started" || event.type === "worker_started")) {
      task.startedAtMs = atMs;
    }

    switch (event.type) {
      case "verification_passed":
        if (task) {
          task.outcome = "completed";
          if (Number.isFinite(atMs) && task.firstCandidateAtMs === null) task.firstCandidateAtMs = atMs;
        }
        break;
      case "candidate_parked": {
        if (task) {
          // `#parkCandidate` writes `worker_stopped` before `candidate_parked`,
          // so `candidate_parked` must override `stopped`.
          if (task.outcome !== "completed") task.outcome = "parked";
          if (Number.isFinite(atMs) && task.firstCandidateAtMs === null) task.firstCandidateAtMs = atMs;
        }
        const rawLabel = typeof data.reasonLabel === "string" && data.reasonLabel.trim()
          ? data.reasonLabel
          : typeof data.candidateReason === "string" && data.candidateReason.trim()
            ? data.candidateReason
            : typeof data.reason === "string" && data.reason.trim()
              ? data.reason
              : "(unspecified)";
        increment(parkReasons, truncateLabel(rawLabel, 80));
        break;
      }
      case "candidate_blocked": {
        const rawBlock = typeof data.reason === "string" && data.reason.trim()
          ? data.reason
          : "(unspecified)";
        increment(blockReasons, truncateLabel(rawBlock, 80));
        break;
      }
      case "candidate_failed":
        if (task && task.outcome !== "completed") {
          // Watchdog/failure paths write `worker_stopped` before `candidate_failed`.
          task.outcome = "failed";
        }
        break;
      case "verification_failed":
      case "worker_start_failed":
        if (task) {
          if (task.outcome !== "completed" && task.outcome !== "stopped" && task.outcome !== "parked") task.outcome = "failed";
          if (event.type === "verification_failed" && Number.isFinite(atMs) && task.firstCandidateAtMs === null) {
            task.firstCandidateAtMs = atMs;
          }
        }
        break;
      case "worker_stopped":
        if (task && task.outcome !== "completed") {
          task.outcome = "stopped";
        }
        break;
      case "repair_requested":
        if (task) task.repairRounds += 1;
        break;
      case "decision_overridden":
        decisionOverrides += 1;
        increment(overrideReasons, categorizeOverrideReason(data));
        break;
      case "decision_worker_failed":
        decisionWorkerFailed += 1;
        if (data.fallback === "deny_permission") decisionWorkerFallbackDeny += 1;
        break;
      case "decision_action_failed":
        decisionActionFailed += 1;
        break;
      case "decision_retry":
        decisionRetries += 1;
        break;
      case "decision_ignored":
        decisionIgnored += 1;
        break;
      case "permission_decision": {
        const actor = typeof data.actor === "string" ? data.actor : "unknown";
        const behavior = typeof data.behavior === "string" ? data.behavior : "unknown";
        const phase = typeof data.phase === "string" ? data.phase : "unspecified";
        increment(permissionByActor, actor);
        increment(permissionByBehavior, behavior);
        increment(permissionByPhase, phase);
        if (behavior === "deny") {
          const toolName = typeof data.toolName === "string" ? data.toolName : "unknown";
          increment(deniedTools, toolName);
        }
        break;
      }
      case "worker_usage": {
        const cost = typeof data.costUsd === "number" && Number.isFinite(data.costUsd) ? data.costUsd : 0;
        if (task) {
          task.workerCostUsd += cost;
          task.workerTurns += 1;
        }
        break;
      }
      case "pi_usage": {
        const role = data.role === "reviewer" ? "reviewer" : data.role === "decision" ? "decision" : null;
        if (role) {
          const bucket = piUsage[role];
          bucket.calls += 1;
          if (typeof data.input === "number" && Number.isFinite(data.input)) bucket.input += data.input;
          if (typeof data.output === "number" && Number.isFinite(data.output)) bucket.output += data.output;
          if (typeof data.cacheRead === "number" && Number.isFinite(data.cacheRead)) bucket.cacheRead += data.cacheRead;
          if (typeof data.cacheWrite === "number" && Number.isFinite(data.cacheWrite)) bucket.cacheWrite += data.cacheWrite;
          if (typeof data.totalTokens === "number" && Number.isFinite(data.totalTokens)) bucket.totalTokens += data.totalTokens;
          if (typeof data.costUsd === "number" && Number.isFinite(data.costUsd)) bucket.costUsd += data.costUsd;
        }
        break;
      }
      case "review_started":
        reviewsStarted += 1;
        break;
      case "review_result": {
        reviewsCompleted += 1;
        const verdict = typeof data.verdict === "string" ? data.verdict : "unknown";
        increment(reviewVerdicts, verdict);
        if (isReviewerFormatOrApiFailure(data)) reviewerFormatOrApiFailures += 1;
        break;
      }
      default:
        break;
    }
  };

  const finalize = (files = []) => {
    const outcomes = new Map();
    const repairDistribution = new Map();
    const candidateDurationsMs = [];
    let totalWorkerCostUsd = 0;
    let maxWorkerCostUsd = 0;
    let totalRepairRounds = 0;

    for (const task of tasks.values()) {
      increment(outcomes, task.outcome);
      const bucket = task.repairRounds >= 3 ? "3+" : String(task.repairRounds);
      increment(repairDistribution, bucket);
      totalRepairRounds += task.repairRounds;
      totalWorkerCostUsd += task.workerCostUsd;
      if (task.workerCostUsd > maxWorkerCostUsd) maxWorkerCostUsd = task.workerCostUsd;
      if (task.startedAtMs !== null && task.firstCandidateAtMs !== null && task.firstCandidateAtMs >= task.startedAtMs) {
        candidateDurationsMs.push(task.firstCandidateAtMs - task.startedAtMs);
      }
    }
    candidateDurationsMs.sort((a, b) => a - b);
    const taskCount = tasks.size;
    const reviewerFailureRate = reviewsCompleted > 0 ? reviewerFormatOrApiFailures / reviewsCompleted : 0;

    return {
      files,
      totalEvents,
      skippedBeforeSince,
      malformedLines,
      timeRange: { earliestAt, latestAt },
      tasks: {
        total: taskCount,
        outcomes: sortedEntries(outcomes),
        parkReasons: sortedEntries(parkReasons),
        blockReasons: sortedEntries(blockReasons),
        repairRounds: {
          total: totalRepairRounds,
          averagePerTask: taskCount > 0 ? Number((totalRepairRounds / taskCount).toFixed(2)) : 0,
          distribution: Object.fromEntries(["0", "1", "2", "3+"].map((k) => [k, repairDistribution.get(k) ?? 0])),
        },
        firstCandidateDurationMs: {
          samples: candidateDurationsMs.length,
          min: candidateDurationsMs[0] ?? null,
          p50: percentile(candidateDurationsMs, 50),
          p90: percentile(candidateDurationsMs, 90),
          max: candidateDurationsMs.at(-1) ?? null,
        },
      },
      decisions: {
        overridden: decisionOverrides,
        overrideReasons: sortedEntries(overrideReasons),
        workerFailed: decisionWorkerFailed,
        workerFailedFallbackDeny: decisionWorkerFallbackDeny,
        actionFailed: decisionActionFailed,
        retries: decisionRetries,
        ignored: decisionIgnored,
      },
      permissions: {
        byActor: sortedEntries(permissionByActor),
        byBehavior: sortedEntries(permissionByBehavior),
        byPhase: sortedEntries(permissionByPhase),
        deniedTools: sortedEntries(deniedTools),
      },
      costAndUsage: {
        workerCostUsd: {
          total: Number(totalWorkerCostUsd.toFixed(4)),
          averagePerTask: taskCount > 0 ? Number((totalWorkerCostUsd / taskCount).toFixed(4)) : 0,
          maxTask: Number(maxWorkerCostUsd.toFixed(4)),
        },
        pi: {
          decision: { ...piUsage.decision, costUsd: Number(piUsage.decision.costUsd.toFixed(4)) },
          reviewer: { ...piUsage.reviewer, costUsd: Number(piUsage.reviewer.costUsd.toFixed(4)) },
        },
      },
      reviewer: {
        started: reviewsStarted,
        completed: reviewsCompleted,
        verdicts: sortedEntries(reviewVerdicts),
        formatOrApiFailures: reviewerFormatOrApiFailures,
        failureRate: Number(reviewerFailureRate.toFixed(4)),
      },
    };
  };

  return { ingest, finalize, recordMalformed: () => { malformedLines += 1; } };
}

export async function analyzeFiles(filePaths, options = {}) {
  const agg = createAggregator(options);
  const existingFiles = [];
  for (const filePath of filePaths) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    existingFiles.push(filePath);
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        agg.ingest(JSON.parse(trimmed));
      } catch {
        agg.recordMalformed();
      }
    }
  }
  return agg.finalize(existingFiles);
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return "n/a";
  if (ms < 1_000) return `${ms}ms`;
  const sec = ms / 1_000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)}m`;
  return `${(min / 60).toFixed(2)}h`;
}

function formatHistogram(record, indent = "  ") {
  const entries = Object.entries(record);
  if (entries.length === 0) return `${indent}(none)`;
  return entries.map(([key, count]) => `${indent}${key}: ${count}`).join("\n");
}

export function formatReport(report) {
  const lines = [];
  lines.push("pi-claude-supervisor Event Log Report");
  lines.push("=====================================");
  lines.push(`Files scanned: ${report.files.length}${report.files.length > 0 ? ` (${report.files.map((f) => basename(f)).join(", ")})` : ""}`);
  lines.push(`Events: ${report.totalEvents}${report.malformedLines > 0 ? ` (malformed lines skipped: ${report.malformedLines})` : ""}${report.skippedBeforeSince > 0 ? ` (before --since: ${report.skippedBeforeSince})` : ""}`);
  if (report.timeRange.earliestAt && report.timeRange.latestAt) {
    lines.push(`Window: ${report.timeRange.earliestAt} .. ${report.timeRange.latestAt}`);
  }
  lines.push("");
  lines.push(`Tasks (${report.tasks.total} total) — outcomes:`);
  lines.push(formatHistogram(report.tasks.outcomes));
  lines.push("");
  lines.push("Park reasons:");
  lines.push(formatHistogram(report.tasks.parkReasons));
  if (Object.keys(report.tasks.blockReasons ?? {}).length > 0) {
    lines.push("Candidate block reasons:");
    lines.push(formatHistogram(report.tasks.blockReasons));
  }
  lines.push("");
  const rr = report.tasks.repairRounds;
  lines.push(`Repair rounds: total=${rr.total}, avg/task=${rr.averagePerTask}, dist=[0:${rr.distribution["0"]}, 1:${rr.distribution["1"]}, 2:${rr.distribution["2"]}, 3+:${rr.distribution["3+"]}]`);
  const dur = report.tasks.firstCandidateDurationMs;
  lines.push(`Time to first candidate (n=${dur.samples}): min=${formatMs(dur.min)} p50=${formatMs(dur.p50)} p90=${formatMs(dur.p90)} max=${formatMs(dur.max)}`);
  lines.push("");
  const dec = report.decisions;
  lines.push(`Decisions: overridden=${dec.overridden}, worker_failed=${dec.workerFailed} (deny_fallback=${dec.workerFailedFallbackDeny}), action_failed=${dec.actionFailed}, retries=${dec.retries}, ignored=${dec.ignored}`);
  if (Object.keys(dec.overrideReasons).length > 0) {
    lines.push("Override reasons:");
    lines.push(formatHistogram(dec.overrideReasons));
  }
  lines.push("");
  lines.push("Permissions (by actor / behavior / denied tools):");
  lines.push(`  actors: ${Object.entries(report.permissions.byActor).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
  lines.push(`  behaviors: ${Object.entries(report.permissions.byBehavior).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
  if (Object.keys(report.permissions.deniedTools).length > 0) {
    lines.push(`  denied tools: ${Object.entries(report.permissions.deniedTools).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  lines.push("");
  const wCost = report.costAndUsage.workerCostUsd;
  const dPi = report.costAndUsage.pi.decision;
  const rPi = report.costAndUsage.pi.reviewer;
  lines.push(`Worker cost: total=$${wCost.total.toFixed(4)}, avg/task=$${wCost.averagePerTask.toFixed(4)}, max=$${wCost.maxTask.toFixed(4)}`);
  lines.push(`Pi Decision usage: calls=${dPi.calls}, tokens=${dPi.totalTokens} (in=${dPi.input}, out=${dPi.output}, cacheR=${dPi.cacheRead}, cacheW=${dPi.cacheWrite}), cost=$${dPi.costUsd.toFixed(4)}`);
  lines.push(`Pi Reviewer usage: calls=${rPi.calls}, tokens=${rPi.totalTokens} (in=${rPi.input}, out=${rPi.output}, cacheR=${rPi.cacheRead}, cacheW=${rPi.cacheWrite}), cost=$${rPi.costUsd.toFixed(4)}`);
  lines.push("");
  const rev = report.reviewer;
  lines.push(`Reviewer: started=${rev.started}, completed=${rev.completed}, format/api failures=${rev.formatOrApiFailures} (${(rev.failureRate * 100).toFixed(1)}%), verdicts=${Object.entries(rev.verdicts).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
  return lines.join("\n");
}

function defaultEventLogPath() {
  const stateDir = process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR?.trim()
    ? resolve(process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR)
    : join(homedir(), ".pi", "agent", "claude-supervisor");
  return join(stateDir, "events.jsonl");
}

async function main(argv) {
  let jsonOutput = false;
  let includeRotated = false;
  let sinceMs;
  const inputs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--include-rotated" || arg === "--rotated") {
      includeRotated = true;
    } else if (arg === "--since") {
      const next = argv[i + 1];
      if (!next) throw new Error("--since requires a value (ISO timestamp or duration like 24h, 7d)");
      sinceMs = parseSinceArg(next);
      i += 1;
    } else if (arg.startsWith("--since=")) {
      sinceMs = parseSinceArg(arg.slice("--since=".length));
    } else if (arg === "-h" || arg === "--help") {
      console.log("Usage: npm run report -- [--json] [--include-rotated] [--since <ISO|duration>] [events.jsonl ...]");
      return;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }

  const rawPaths = inputs.length > 0 ? inputs : [defaultEventLogPath()];
  const filePaths = await expandLogPaths(rawPaths, { includeRotated });
  const report = await analyzeFiles(filePaths, { sinceMs });
  if (inputs.length > 0 && report.files.length === 0) {
    console.error(`Warning: no readable event log files matched: ${inputs.join(", ")}`);
  }
  console.log(jsonOutput ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
