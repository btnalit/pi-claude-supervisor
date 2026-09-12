import { ProcessWorkerAdapter } from "../src/worker/process-adapter.ts";
import { Supervisor } from "../src/supervisor.ts";
import { EventLog } from "../src/events.ts";

const cwd = process.env.SPIKE_AUTOMATION_CWD ?? process.cwd();
const permission = process.env.SPIKE_AUTOMATION_PERMISSION === "1";
const question = process.env.SPIKE_AUTOMATION_QUESTION === "1";
const timeoutMs = Number(process.env.SPIKE_TIMEOUT_MS ?? 120_000);
const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl", terminationGraceMs: 1_000, killGraceMs: 500 });
const human = [];
const eventLogPath = process.env.SPIKE_EVENT_LOG ?? undefined;
const supervisor = new Supervisor(adapter, new EventLog(eventLogPath), {
  onHumanRequired: (notice) => { human.push(notice); console.error('HUMAN_REQUIRED', notice.reason); },
});

await supervisor.start({
  task: question
    ? "Ask one question about which database a local supervisor should use. The task context already prefers SQLite for a local single-user tool; use that answer and then stop. This is an automated question-handling test."
    : permission
      ? "Use Bash exactly to run: printf AUTO_PERMISSION_OK. Then report the output and stop. This is an automation permission test."
      : "Reply with exactly AUTO_SUPERVISOR_SPIKE_OK. Do not use tools. This is an automation integration test.",
  cwd,
  command: process.env.PI_CLAUDE_SUPERVISOR_WORKER_COMMAND ?? "claude",
  args: ["--safe-mode", "--no-session-persistence", "--tools", question ? "AskUserQuestion" : "Bash"],
  automation: true,
  maxTurns: 2,
  deadlineMs: timeoutMs,
  noOutputTimeoutMs: Math.min(timeoutMs, 60_000),
});

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline && !["completed", "failed", "stopped"].includes(supervisor.state)) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (["running", "waiting", "paused"].includes(supervisor.state)) await supervisor.stop("automation spike cleanup");
const summary = {
  mode: "auto",
  permission,
  question,
  state: supervisor.state,
  verified: supervisor.lastVerification?.ok ?? false,
  humanInterventions: human.length,
};
console.log(JSON.stringify(summary, null, 2));
if (supervisor.state !== "completed" || !summary.verified || human.length > 0) process.exitCode = 1;
