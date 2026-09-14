import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";
import { EventLog, type SupervisorEvent } from "./events.ts";
import { Supervisor } from "./supervisor.ts";
import type { DecisionWorkerFactory } from "./decision-worker.ts";
import type { TaskReviewer } from "./reviewer.ts";
import type {
  PermissionDecision,
  WorkerAdapter,
  WorkerEvent,
  WorkerEventListener,
  WorkerHandle,
  WorkerOutputChunk,
  WorkerStatus,
} from "./types.ts";

class ReplayEventLog extends EventLog {
  readonly records: Array<Omit<SupervisorEvent, "seq" | "at">> = [];

  override async append(event: Omit<SupervisorEvent, "seq" | "at">): Promise<SupervisorEvent> {
    this.records.push(event);
    return { ...event, seq: this.records.length, at: new Date().toISOString() };
  }
}

type ReplayEvent =
  | { type: "permission_request"; request: Extract<WorkerEvent, { type: "permission_request" }>["request"] }
  | { type: "turn_completed"; result: Record<string, unknown>; sequence: number };

class ReplayAdapter implements WorkerAdapter {
  readonly handle: WorkerHandle = { id: "replay-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  listener?: WorkerEventListener;
  running = true;
  activeRequests = 1;
  permissionResponses: Array<{ requestId: string; decision: PermissionDecision }> = [];
  messages: string[] = [];

  capabilities() {
    return { transport: "jsonl" as const, interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true };
  }

  async start(input: { eventListener?: WorkerEventListener }): Promise<WorkerHandle> {
    this.listener = input.eventListener;
    return this.handle;
  }

  async getStatus(): Promise<WorkerStatus> {
    return { handle: this.handle, running: this.running, activeRequests: this.activeRequests, processGroupCleaned: !this.running };
  }

  async readOutput(): Promise<WorkerOutputChunk[]> { return []; }
  async send(_handle: WorkerHandle, message: string): Promise<void> { this.messages.push(message); this.activeRequests = 1; }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async stop(): Promise<void> { this.running = false; this.activeRequests = 0; }
  async killProcessGroup(): Promise<void> { this.running = false; }
  async resumeSession(): Promise<WorkerHandle> { return this.handle; }

  async respondPermission(_handle: WorkerHandle, requestId: string, _toolUseId: string, decision: PermissionDecision): Promise<void> {
    this.permissionResponses.push({ requestId, decision });
  }

  emit(event: ReplayEvent): void {
    if (event.type === "turn_completed") this.activeRequests = 0;
    void this.listener?.({ ...event, handle: this.handle } as WorkerEvent);
  }
}

function replayDecisionWorkerFactory(): DecisionWorkerFactory {
  return (options) => ({
    start: async () => {},
    updateContext: () => {},
    notify: (event) => {
      if (event.type === "permission_request") {
        void options.onAction({ action: event.request.toolName === "AskUserQuestion" ? "deny_permission" : "allow_permission", requestId: event.request.requestId, toolUseId: event.request.toolUseId, reason: "replay fixture" }, event);
      } else if (event.type === "turn_completed") {
        void options.onAction({ action: "verify", reason: "replay result" }, event);
      }
    },
    close: async () => {},
  });
}

const execFileAsync = promisify(execFile);

async function initGit(cwd: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "base.txt"), "base\n");
  await execFileAsync("git", ["add", "base.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd });
  await execFileAsync("git", ["switch", "-c", "worker/replay"], { cwd });
}

const reviewer: TaskReviewer = {
  review: async (input) => ({ verdict: "pass", summary: `replayed round ${input.round}`, findings: [], round: input.round, checkedAt: new Date().toISOString() }),
};

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("automation replay covers permission allow, result, acceptance and independent review", async () => {
  const adapter = new ReplayAdapter();
  const events = new ReplayEventLog();
  const supervisor = new Supervisor(adapter, events, { reviewer });
  await supervisor.start({
    task: "replay a harmless permission task",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 }, acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: replayDecisionWorkerFactory(),
  });

  const permission = { requestId: "request-1", toolUseId: "tool-1", toolName: "Bash", input: { command: "printf OK" }, raw: {} };
  adapter.emit({ type: "permission_request", request: permission });
  adapter.emit({ type: "permission_request", request: permission });
  await waitFor(() => adapter.permissionResponses.length === 1);
  assert.equal(adapter.permissionResponses[0]?.decision.behavior, "allow");

  const result = { type: "turn_completed" as const, result: { type: "result", uuid: "result-1" }, sequence: 1 };
  adapter.emit(result);
  adapter.emit(result);
  await waitFor(() => supervisor.state === "completed");
  assert.equal(supervisor.state, "completed");
  assert.ok(events.records.some((event) => event.type === "acceptance_check_finished"));
  assert.equal(events.records.filter((event) => event.type === "acceptance_result").length, 1);
  assert.equal(events.records.filter((event) => event.type === "review_result").length, 1);
  assert.equal(events.records.filter((event) => event.type === "review_finished").length, 1);
  assert.ok(events.records.some((event) => event.type === "verification_passed"));
});

test("automation replay repairs a required-check failure before reacceptance and review", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-automation-replay-"));
  try {
    await initGit(cwd);
    const marker = join(cwd, "repair-fixture.marker");
    const checkScript = [
      "const fs = require('node:fs');",
      `const marker = ${JSON.stringify(marker)};`,
      "if (fs.existsSync(marker)) process.exit(0);",
      "fs.writeFileSync(marker, 'repaired');",
      "process.stderr.write('required check failed');",
      "process.exit(7);",
    ].join(" ");
    const adapter = new ReplayAdapter();
    const events = new ReplayEventLog();
    const supervisor = new Supervisor(adapter, events, { reviewer });
    await supervisor.start({
      task: "replay a repairable required-check failure",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 }, acceptance: [{ id: "repairable", name: "repairable", command: process.execPath, args: ["-e", checkScript], required: true, timeoutMs: 1_000 }] },
      decisionWorkerFactory: replayDecisionWorkerFactory(),
    });

    adapter.emit({ type: "turn_completed", result: { type: "result", uuid: "result-before-repair" }, sequence: 1 });
    await waitFor(() => adapter.messages.length === 1);
    assert.match(adapter.messages[0] ?? "", /Automatic repair round 1/u);
    assert.equal(supervisor.state, "running");

    adapter.emit({ type: "turn_completed", result: { type: "result", uuid: "result-after-repair" }, sequence: 2 });
    await waitFor(() => supervisor.state === "completed");
    assert.equal(supervisor.state, "completed");
    assert.equal(adapter.messages.length, 1);
    const acceptanceResults = events.records.filter((event) => event.type === "acceptance_result");
    assert.equal(acceptanceResults.length, 2);
    assert.equal((acceptanceResults[0]?.data?.checks as Array<{ status: string }>)[0]?.status, "failed");
    assert.equal((acceptanceResults[1]?.data?.checks as Array<{ status: string }>)[0]?.status, "passed");
    assert.equal(events.records.filter((event) => event.type === "repair_requested").length, 1);
    assert.equal(events.records.filter((event) => event.type === "review_result").length, 1);
    assert.ok(events.records.some((event) => event.type === "verification_passed"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automation replay denies AskUserQuestion instead of inventing permission", async () => {
  const adapter = new ReplayAdapter();
  const supervisor = new Supervisor(adapter, new ReplayEventLog(), { reviewer });
  await supervisor.start({
    task: "replay an answerable question",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 }, acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: replayDecisionWorkerFactory(),
  });
  adapter.emit({ type: "permission_request", request: { requestId: "question-1", toolUseId: "tool-question", toolName: "AskUserQuestion", input: { questions: [] }, raw: {} } });
  await waitFor(() => adapter.permissionResponses.length === 1);
  assert.equal(adapter.permissionResponses[0]?.decision.behavior, "deny");
  await supervisor.stop("replay cleanup");
});
