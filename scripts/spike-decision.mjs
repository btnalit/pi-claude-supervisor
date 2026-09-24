// Gated end-to-end spike: a real Pi Decision Worker and Reviewer (any Pi model)
// supervising a scripted Worker that really edits a temporary git repository.
// It exercises the Supervisor's decision, verification, review and repair loop
// against a live model without needing Claude Code or cgroups.
//
// Model credentials never pass through this script: Pi resolves them from its
// own sources (for example GEMINI_API_KEY or ~/.pi/agent/auth.json). Nothing
// here reads, prints or stores a key, and everything printed is redacted.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Supervisor } from "../src/supervisor.ts";
import { EventLog } from "../src/events.ts";
import { PiReadOnlyReviewer } from "../src/reviewer.ts";
import { resolvePiModel } from "../src/pi-model.ts";
import { redactSensitive } from "../src/redaction.ts";

if (process.env.PI_CLAUDE_SUPERVISOR_REAL_DECISION !== "1") {
  console.error("Set PI_CLAUDE_SUPERVISOR_REAL_DECISION=1 to run this spike against a live model.");
  process.exit(2);
}
const modelSpec = process.env.SPIKE_DECISION_MODEL || "google/gemini-3.5-flash-lite";
const scenarios = (process.env.SPIKE_DECISION_SCENARIOS ?? "review,question,stuck").split(",").map((name) => name.trim()).filter(Boolean);
const deadlineMs = Number(process.env.SPIKE_TIMEOUT_MS ?? 600_000);
const keep = process.env.SPIKE_KEEP === "1";

const goal = "Add clamp(value, min, max) to src/clamp.js (ES module) returning value limited to [min, max]. If min > max it must throw a RangeError. Add node:test tests in test/clamp.test.js covering normal clamping and the RangeError case.";
const partial = "export function clamp(value, min, max) {\n  return Math.min(Math.max(value, min), max);\n}\n";
const full = "export function clamp(value, min, max) {\n  if (min > max) throw new RangeError(`min (${min}) must not exceed max (${max})`);\n  return Math.min(Math.max(value, min), max);\n}\n";
const testBase = "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { clamp } from \"../src/clamp.js\";\n\ntest(\"clamps into range\", () => {\n  assert.equal(clamp(5, 0, 3), 3);\n  assert.equal(clamp(-1, 0, 3), 0);\n  assert.equal(clamp(2, 0, 3), 2);\n});\n";
const testFull = `${testBase}\ntest("rejects min > max", () => {\n  assert.throws(() => clamp(1, 3, 0), RangeError);\n});\n`;

/**
 * review:   the first turn misses the RangeError requirement and claims done;
 *           the Decision Worker or Reviewer must catch it and a repair fixes it.
 * question: the Worker asks whether to throw or swap; the answer is in the spec.
 * stuck:    the Worker never fixes the gap but keeps claiming it is done; the
 *           task must end blocked within its repair budget, not loop.
 */
const expected = {
  // The missing RangeError must have been asked for and then made: a
  // Reviewer that waves the incomplete first turn through fails this.
  review: (r) => r.state === "completed" && r.verified && r.fixRequested && r.workerFixed,
  question: (r) => r.state === "completed" && r.verified && r.workerFixed && r.humanRequired.length === 0,
  stuck: (r) => r.state === "blocked" && !r.verified,
};

async function runScenario(scenario, model) {
  // The repository under review holds only the task: the event log lives
  // beside it, or the Reviewer would judge the Supervisor's own log as work.
  const root = await mkdtemp(join(tmpdir(), `pi-claude-supervisor-spike-decision-${scenario}-`));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  // Isolated from the user's git config: no signing prompts, no hooks.
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "pipe" }).toString();
  const writeImpl = async (done) => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await mkdir(join(cwd, "test"), { recursive: true });
    await writeFile(join(cwd, "src/clamp.js"), done ? full : partial);
    await writeFile(join(cwd, "test/clamp.test.js"), done ? testFull : testBase);
  };

  const handle = { id: `spike-decision-${scenario}`, startedAt: new Date().toISOString(), cwd, ownership: "owned" };
  let running = true;
  let listener;
  let sequence = 0;
  let fixed = false;
  let fixRequested = false;
  const transcript = [];
  const reply = (text) => setTimeout(() => {
    sequence += 1;
    transcript.push(`WORKER> ${text}`);
    listener?.({ type: "turn_completed", handle, sequence, result: { subtype: "success", result: text, session_id: `spike-${scenario}`, num_turns: sequence } });
  }, 300);
  const adapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true, repairableSession: true }),
    start: async (input) => {
      listener = input.eventListener;
      if (scenario === "question") reply("Before I write the code: when min > max, should clamp throw a RangeError, or silently swap the bounds? Please confirm and I will continue.");
      else {
        await writeImpl(false);
        reply("Implemented clamp(value, min, max) in src/clamp.js with tests in test/clamp.test.js. All tests pass. The task is complete.");
      }
      return handle;
    },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async (_handle, message) => {
      transcript.push(`SUPERVISOR> ${message.slice(0, 400)}`);
      // The fix follows only a message that asks for it.
      if (/RangeError|min\s*>\s*max/iu.test(message)) fixRequested = true;
      if (scenario !== "stuck" && fixRequested && !fixed) {
        fixed = true;
        await writeImpl(true);
        reply("Done. clamp now throws RangeError when min > max, with a test for it; all tests pass.");
      } else reply("All requirements are implemented and the tests pass; nothing else to change.");
    },
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };

  const logPath = join(root, "events.jsonl");
  const human = [];
  const supervisor = new Supervisor(adapter, new EventLog(logPath), {
    reviewer: new PiReadOnlyReviewer({ model, timeoutMs: Math.min(deadlineMs, 300_000) }),
    decisionModel: model,
    onHumanRequired: (notice) => { human.push(notice.reason); },
  });
  const started = Date.now();
  let error;
  try {
    git("init", "-q", "-b", "task/clamp");
    git("config", "user.email", "spike@example.invalid");
    git("config", "user.name", "spike");
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "clamp-spike", type: "module", private: true }, null, 2)}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    await supervisor.start({
      task: goal,
      cwd,
      command: "claude",
      automation: true,
      deadlineMs,
      noOutputTimeoutMs: 0,
      spec: {
        goal,
        acceptance: [{ id: "tests", name: "node --test", command: process.execPath, args: ["--test"], required: true, timeoutMs: 60_000 }],
        maxRepairRounds: 2,
        autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 3 },
      },
    });
    while (Date.now() - started < deadlineMs + 60_000 && !["completed", "failed", "stopped", "blocked"].includes(supervisor.state) && human.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await supervisor.poll().catch(() => {});
    }
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  } finally {
    if (["running", "waiting", "paused", "verifying"].includes(supervisor.state)) await supervisor.stop("spike cleanup").catch(() => {});
  }
  // Let a pending scripted reply fire before the directory goes away.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const events = (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const count = (type) => events.filter((event) => event.type === type).length;
  const result = {
    scenario,
    model: modelSpec,
    seconds: Math.round((Date.now() - started) / 1000),
    state: supervisor.state,
    verified: supervisor.lastVerification?.ok ?? false,
    repairRound: supervisor.repairRound,
    fixRequested,
    workerFixed: fixed,
    humanRequired: human,
    decisions: events.filter((event) => event.type === "decision_made").map((event) => `${event.data?.action}: ${String(event.data?.reason ?? "").slice(0, 160)}`),
    overrides: count("decision_overridden"),
    reviews: events.filter((event) => event.type === "review_result").map((event) => `${event.data?.verdict}: ${String(event.data?.summary ?? "").slice(0, 160)}`),
    reviewFormatFailures: events.filter((event) => event.type === "review_result" && String(event.data?.summary ?? "").startsWith("invalid Reviewer output")).length,
    ...(error ? { error: error.slice(0, 400) } : {}),
    transcript: transcript.map((line) => line.slice(0, 200)),
  };
  result.ok = !error && expected[scenario](result);
  if (keep) result.keptAt = root;
  else await rm(root, { recursive: true, force: true });
  return result;
}

const unknown = scenarios.filter((scenario) => !expected[scenario]);
if (unknown.length > 0 || scenarios.length === 0 || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
  console.error(`Scenarios must be some of ${Object.keys(expected).join(", ")}${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}, and SPIKE_TIMEOUT_MS a positive number of milliseconds.`);
  process.exit(2);
}
let model;
try {
  model = await resolvePiModel(modelSpec);
} catch (caught) {
  console.error(String(redactSensitive(caught instanceof Error ? caught.message : String(caught))));
  process.exit(2);
}
const results = [];
for (const scenario of scenarios) {
  const result = await runScenario(scenario, model);
  results.push(result);
  console.log(JSON.stringify(redactSensitive(result), null, 2));
}
const failed = results.filter((result) => !result.ok).map((result) => result.scenario);
console.log(JSON.stringify({ model: modelSpec, passed: results.length - failed.length, failed }));
if (failed.length > 0) process.exitCode = 1;
