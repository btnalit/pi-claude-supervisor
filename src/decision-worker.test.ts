import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PiDecisionWorker, type DecisionAction, type DecisionWorkerOptions, type PiModel } from "./decision-worker.ts";
import type { PiUsageSample, WorkerEvent, WorkerHandle } from "./types.ts";

/** One model call's token usage, matching a `message_end` record's `usage` field. */
interface ScriptedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { total: number };
}

/** One scripted assistant turn for the fake session below. */
interface ScriptedTurn {
  text?: string;
  stopReason?: "stop" | "error" | "aborted";
  errorMessage?: string;
  /** Do not resolve prompt() until abort() is called; then reply with stopReason "aborted". */
  holdUntilAbort?: boolean;
  usage?: ScriptedUsage;
}

/**
 * A minimal in-memory stand-in for AgentSession. Each call to prompt()
 * consumes the next scripted turn and replays message_start/message_update
 * (text_delta)/message_end to subscribers, exactly like the real Pi session's
 * subscription feed. Matches the background fact that prompt() resolves
 * normally even when the turn ended in "error" or "aborted".
 */
function createFakeSession(turns: ScriptedTurn[], options: { contextTokens?: number | null } = {}) {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: string[] = [];
  const compactCalls: string[] = [];
  let turnIndex = 0;
  let pendingRelease: (() => void) | undefined;
  let contextTokens: number | null = options.contextTokens ?? null;
  const emit = (event: unknown): void => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const runTurn = (turn: ScriptedTurn, stopReasonOverride?: ScriptedTurn["stopReason"]): void => {
    emit({ type: "message_start", message: { role: "assistant" } });
    if (turn.text) emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: turn.text } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: stopReasonOverride ?? turn.stopReason ?? "stop", errorMessage: turn.errorMessage, usage: turn.usage, content: [] } });
  };
  const session = {
    sessionFile: undefined,
    sessionId: "fake-session",
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt(text: string): Promise<void> {
      prompts.push(text);
      const turn = turns[turnIndex] ?? { stopReason: "stop" as const };
      turnIndex += 1;
      if (turn.holdUntilAbort) {
        return new Promise<void>((resolvePrompt) => {
          pendingRelease = () => {
            runTurn(turn, "aborted");
            resolvePrompt();
          };
        });
      }
      return Promise.resolve().then(() => runTurn(turn));
    },
    async abort(): Promise<void> {
      if (pendingRelease) {
        const release = pendingRelease;
        pendingRelease = undefined;
        release();
      }
    },
    getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } {
      return { tokens: contextTokens, contextWindow: 200_000, percent: null };
    },
    async compact(customInstructions?: string): Promise<void> {
      compactCalls.push(customInstructions ?? "");
      // Real compaction leaves context usage unknown until the next model reply.
      contextTokens = null;
    },
    getSessionStats() {
      return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    },
    dispose(): void {},
  };
  return {
    session: session as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
    prompts,
    compactCalls,
    setContextTokens: (tokens: number | null) => { contextTokens = tokens; },
  };
}

function fakeHandle(): WorkerHandle {
  return { id: "worker-1", startedAt: new Date().toISOString(), cwd: "/tmp/task" };
}

function turnCompletedEvent(sequence = 1, result: Record<string, unknown> = {}): WorkerEvent {
  return { type: "turn_completed", handle: fakeHandle(), result, sequence };
}

function permissionRequestEvent(toolName: string, input: Record<string, unknown>): WorkerEvent {
  return { type: "permission_request", handle: fakeHandle(), request: { requestId: "perm-1", toolUseId: "tool-1", toolName, input, raw: {} } };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function baseOptions(overrides: Partial<DecisionWorkerOptions> = {}): DecisionWorkerOptions {
  return {
    context: {
      taskId: "11111111-1111-4111-8111-111111111111",
      task: "fake decision worker test",
      cwd: "/tmp/task",
      state: "starting",
      turn: 0,
      maxTurns: 1,
    },
    onAction: () => {},
    ...overrides,
  };
}

test("Decision Worker refuses a symlinked recovery session file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-decision-worker-session-link-"));
  const cwd = join(root, "cwd");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd);
  await mkdir(sessionDir);
  const outside = join(root, "outside.jsonl");
  const sessionFile = join(sessionDir, "session.jsonl");
  const header = `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd })}\n`;
  await writeFile(outside, header);
  await symlink(outside, sessionFile);
  const worker = new PiDecisionWorker({
    context: {
      taskId: "33333333-3333-4333-8333-333333333333",
      task: "recovery symlink test",
      cwd,
      state: "starting",
      turn: 0,
      maxTurns: 1,
    },
    onAction: () => {},
    sessionFile,
    sessionDir,
  });

  await assert.rejects(() => worker.start(), /ELOOP|secure Decision Worker session-file opening is unavailable/u);
  assert.equal(await readFile(outside, "utf8"), header);
  await rm(root, { recursive: true, force: true });
});

test("a startup provider error rejects start() and calls onStartupFailure", async () => {
  const { session } = createFakeSession([{ stopReason: "error", errorMessage: "rate limited" }]);
  let startupError: unknown;
  const worker = new PiDecisionWorker(baseOptions({
    onStartupFailure: (error) => { startupError = error; },
    sessionFactory: async () => ({ session }),
  }));
  await assert.rejects(() => worker.start());
  assert.ok(startupError instanceof Error);
  assert.equal((startupError as Error).name, "DecisionWorkerApiError");
  assert.match((startupError as Error).message, /rate limited/u);
});

test("a provider error retries within maxDecisionRetries and succeeds", async () => {
  const { session, prompts } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "error", errorMessage: "boom" },
    { stopReason: "stop", text: JSON.stringify({ action: "stop", reason: "done" }) },
  ]);
  const actions: DecisionAction[] = [];
  let failures = 0;
  const worker = new PiDecisionWorker(baseOptions({
    onAction: (action) => { actions.push(action); },
    onFailure: () => { failures += 1; },
    sessionFactory: async () => ({ session }),
    retryBackoffMs: 1,
    context: {
      taskId: "11111111-1111-4111-8111-111111111111",
      task: "retry test",
      cwd: "/tmp/task",
      state: "starting",
      turn: 0,
      maxTurns: 1,
      spec: { goal: "x", scope: [], constraints: [], forbidden: [], acceptance: [], maxRepairRounds: 0, autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, permissionAuthority: "hybrid" } },
    },
  }));
  await worker.start();
  worker.notify(turnCompletedEvent());
  while (actions.length === 0 && failures === 0) await flush();
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.action, "stop");
  assert.equal(failures, 0);
  assert.equal(prompts.length, 3);
  await worker.close();
});

test("exhausting maxDecisionRetries on repeated provider errors calls onFailure, never onAction", async () => {
  const { session } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "error", errorMessage: "boom-1" },
    { stopReason: "error", errorMessage: "boom-2" },
  ]);
  let actionCalls = 0;
  const failures: unknown[] = [];
  const worker = new PiDecisionWorker(baseOptions({
    onAction: () => { actionCalls += 1; },
    onFailure: (_event, error) => { failures.push(error); },
    sessionFactory: async () => ({ session }),
    retryBackoffMs: 1,
    context: {
      taskId: "11111111-1111-4111-8111-111111111111",
      task: "exhausted retries test",
      cwd: "/tmp/task",
      state: "starting",
      turn: 0,
      maxTurns: 1,
      spec: { goal: "x", scope: [], constraints: [], forbidden: [], acceptance: [], maxRepairRounds: 0, autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, permissionAuthority: "hybrid" } },
    },
  }));
  await worker.start();
  worker.notify(turnCompletedEvent());
  while (failures.length === 0 && actionCalls === 0) await flush();
  assert.equal(failures.length, 1);
  assert.equal(actionCalls, 0);
  await worker.close();
});

test("an aborted reply after close() runs mid-prompt triggers neither onAction nor onFailure", async () => {
  const { session, prompts } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { holdUntilAbort: true },
  ]);
  let actionCalls = 0;
  let failureCalls = 0;
  const worker = new PiDecisionWorker(baseOptions({
    onAction: () => { actionCalls += 1; },
    onFailure: () => { failureCalls += 1; },
    sessionFactory: async () => ({ session }),
  }));
  await worker.start();
  worker.notify(turnCompletedEvent());
  while (prompts.length < 2) await flush();
  await worker.close();
  await flush();
  await flush();
  assert.equal(actionCalls, 0);
  assert.equal(failureCalls, 0);
});

test("a fenced JSON reply is parsed as a valid action", async () => {
  const { session } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "stop", text: "```json\n" + JSON.stringify({ action: "stop", reason: "x" }) + "\n```" },
  ]);
  const actions: DecisionAction[] = [];
  const worker = new PiDecisionWorker(baseOptions({
    onAction: (action) => { actions.push(action); },
    sessionFactory: async () => ({ session }),
  }));
  await worker.start();
  worker.notify(turnCompletedEvent());
  while (actions.length === 0) await flush();
  assert.equal(actions[0]?.action, "stop");
  await worker.close();
});

test("a prose-wrapped JSON reply is parsed as a valid action", async () => {
  const { session } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "stop", text: `Sure. ${JSON.stringify({ action: "stop", reason: "x" })} ` },
  ]);
  const actions: DecisionAction[] = [];
  const worker = new PiDecisionWorker(baseOptions({
    onAction: (action) => { actions.push(action); },
    sessionFactory: async () => ({ session }),
  }));
  await worker.start();
  worker.notify(turnCompletedEvent());
  while (actions.length === 0) await flush();
  assert.equal(actions[0]?.action, "stop");
  await worker.close();
});

test("a reply with no JSON gets exactly one bounded re-prompt before an action is accepted", async () => {
  const { session, prompts } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "stop", text: "I cannot decide" },
    { stopReason: "stop", text: JSON.stringify({ action: "stop", reason: "x" }) },
  ]);
  const actions: DecisionAction[] = [];
  const worker = new PiDecisionWorker(baseOptions({
    onAction: (action) => { actions.push(action); },
    sessionFactory: async () => ({ session }),
  }));
  await worker.start();
  const promptsAfterStart = prompts.length;
  worker.notify(turnCompletedEvent());
  while (actions.length === 0) await flush();
  assert.equal(actions[0]?.action, "stop");
  assert.equal(prompts.length - promptsAfterStart, 2);
  await worker.close();
});

test("event prompts are compact even when the underlying event payload is large", async () => {
  const largeContent = "x".repeat(100 * 1024);
  const { session, prompts } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "stop", text: JSON.stringify({ action: "deny_permission", reason: "x" }) },
  ]);
  const worker = new PiDecisionWorker(baseOptions({
    onAction: () => {},
    sessionFactory: async () => ({ session }),
  }));
  await worker.start();
  const promptsAfterStart = prompts.length;
  worker.notify(permissionRequestEvent("Write", { file_path: "/tmp/x.txt", content: largeContent }));
  while (prompts.length === promptsAfterStart) await flush();
  const prompt = prompts[promptsAfterStart]!;
  assert.ok(Buffer.byteLength(prompt, "utf8") < 12 * 1024, `expected a compact prompt, got ${Buffer.byteLength(prompt, "utf8")} bytes`);
  assert.match(prompt, /"bytes":/u);
  assert.match(prompt, /"preview"/u);
  await worker.close();
});

test("a large turn_completed result is bounded to a compact tail", async () => {
  const largeResult = "y".repeat(50 * 1024);
  const { session, prompts } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "stop", text: JSON.stringify({ action: "verify", reason: "x" }) },
  ]);
  const worker = new PiDecisionWorker(baseOptions({
    onAction: () => {},
    sessionFactory: async () => ({ session }),
  }));
  await worker.start();
  const promptsAfterStart = prompts.length;
  worker.notify(turnCompletedEvent(1, { result: largeResult, subtype: "success" }));
  while (prompts.length === promptsAfterStart) await flush();
  const prompt = prompts[promptsAfterStart]!;
  assert.ok(Buffer.byteLength(prompt, "utf8") < 12 * 1024, `expected a compact prompt, got ${Buffer.byteLength(prompt, "utf8")} bytes`);
  await worker.close();
});

test("the current-context payload omits the task spec", async () => {
  const { session, prompts } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "stop", text: JSON.stringify({ action: "stop", reason: "x" }) },
  ]);
  const worker = new PiDecisionWorker(baseOptions({
    onAction: () => {},
    sessionFactory: async () => ({ session }),
    context: {
      taskId: "11111111-1111-4111-8111-111111111111",
      task: "fake decision worker test",
      cwd: "/tmp/task",
      state: "starting",
      turn: 0,
      maxTurns: 1,
      repairRound: 2,
      spec: {
        goal: "UNIQUE_SPEC_GOAL_TEXT_NOT_IN_EVENT_PROMPTS",
        scope: [],
        constraints: [],
        forbidden: [],
        acceptance: [],
        maxRepairRounds: 0,
        autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, permissionAuthority: "hybrid" },
      },
    },
  }));
  await worker.start();
  const promptsAfterStart = prompts.length;
  worker.notify(turnCompletedEvent());
  while (prompts.length === promptsAfterStart) await flush();
  const prompt = prompts[promptsAfterStart]!;
  assert.match(prompt, /"repairRound"/u);
  assert.doesNotMatch(prompt, /UNIQUE_SPEC_GOAL_TEXT_NOT_IN_EVENT_PROMPTS/u);
  await worker.close();
});

test("usage samples are reported for each Decision Worker prompt", async () => {
  const startupUsage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 };
  const decisionUsage = { input: 111, output: 22, cacheRead: 3, cacheWrite: 4, totalTokens: 140, cost: { total: 0.01 } };
  const { session } = createFakeSession([
    { stopReason: "stop", text: "ack", usage: startupUsage },
    { stopReason: "stop", text: JSON.stringify({ action: "stop", reason: "x" }), usage: decisionUsage },
  ]);
  const samples: PiUsageSample[] = [];
  const worker = new PiDecisionWorker(baseOptions({
    onAction: () => {},
    sessionFactory: async () => ({ session }),
    onUsage: (sample) => { samples.push(sample); },
  }));
  await worker.start();
  worker.notify(turnCompletedEvent());
  while (samples.length < 2) await flush();
  const decisionSample = samples[1]!;
  assert.equal(decisionSample.role, "decision");
  assert.equal(decisionSample.input, decisionUsage.input);
  assert.equal(decisionSample.output, decisionUsage.output);
  assert.equal(decisionSample.cacheRead, decisionUsage.cacheRead);
  assert.equal(decisionSample.cacheWrite, decisionUsage.cacheWrite);
  assert.equal(decisionSample.totalTokens, decisionUsage.totalTokens);
  assert.equal(decisionSample.costUsd, 0.01);
  await worker.close();
});

test("compaction runs above the threshold and instructions are re-sent once", async () => {
  const { session, prompts, compactCalls } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "stop", text: JSON.stringify({ action: "continue", message: "go", reason: "x" }) },
    { stopReason: "stop", text: JSON.stringify({ action: "continue", message: "go", reason: "x" }) },
    { stopReason: "stop", text: JSON.stringify({ action: "stop", reason: "done" }) },
  ], { contextTokens: 70_000 });
  const actions: DecisionAction[] = [];
  const worker = new PiDecisionWorker(baseOptions({
    onAction: (action) => { actions.push(action); },
    sessionFactory: async () => ({ session }),
    compactionTokens: 60_000,
  }));
  await worker.start();
  const promptsAfterStart = prompts.length;

  worker.notify(turnCompletedEvent(1));
  while (actions.length < 1) await flush();
  assert.equal(compactCalls.length, 1);

  worker.notify(turnCompletedEvent(2));
  while (actions.length < 2) await flush();
  const secondPrompt = prompts[promptsAfterStart + 1]!;
  assert.match(secondPrompt, /^SUPERVISOR INSTRUCTIONS \(re-sent after compaction\):/u);
  assert.equal(compactCalls.length, 1);

  worker.notify(turnCompletedEvent(3));
  while (actions.length < 3) await flush();
  const thirdPrompt = prompts[promptsAfterStart + 2]!;
  assert.doesNotMatch(thirdPrompt, /^SUPERVISOR INSTRUCTIONS/u);

  await worker.close();
});

test("model option reaches the session factory", async () => {
  const { session } = createFakeSession([{ stopReason: "stop", text: "ack" }]);
  const fakeModel = { provider: "anthropic", id: "claude-fake-test-model" } as unknown as PiModel;
  let capturedModel: PiModel | undefined;
  const worker = new PiDecisionWorker(baseOptions({
    onAction: () => {},
    model: fakeModel,
    sessionFactory: async (factoryOptions) => {
      capturedModel = factoryOptions?.model;
      return { session };
    },
  }));
  await worker.start();
  assert.equal(capturedModel, fakeModel);
  await worker.close();
});

test("the deadline reaches the startup instructions and every event prompt in minutes", async () => {
  const { session, prompts } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "stop", text: JSON.stringify({ action: "wait", reason: "x" }) },
    { stopReason: "stop", text: JSON.stringify({ action: "verify", reason: "y" }) },
  ]);
  const worker = new PiDecisionWorker(baseOptions({
    onAction: () => {},
    sessionFactory: async () => ({ session }),
    context: {
      ...baseOptions().context,
      deadline: { totalMs: 4 * 60 * 60_000, graceMs: 30 * 60_000, remainingMs: 6.4 * 60_000, closeOut: false },
    },
  }));
  await worker.start();
  const instructions = prompts[0]!;
  assert.match(instructions, /Wall-clock budget: 4 hours for the whole task, then a 30 minutes close-out window/u);
  assert.match(instructions, /wait is no longer available during close-out/u);
  const promptsAfterStart = prompts.length;
  worker.notify(turnCompletedEvent(1));
  while (prompts.length === promptsAfterStart) await flush();
  const beforeDeadline = prompts[promptsAfterStart]!;
  assert.match(beforeDeadline, /"deadlineRemainingMinutes": 6\b/u);
  assert.match(beforeDeadline, /"closeOut": false/u);
  assert.doesNotMatch(beforeDeadline, /closeOutRemainingMinutes/u);
  // The Supervisor refreshes the clock before each notification; close-out adds the remaining grace.
  worker.updateContext({ deadline: { totalMs: 4 * 60 * 60_000, graceMs: 30 * 60_000, remainingMs: 0, closeOut: true, closeOutRemainingMs: 24 * 60_000 } });
  worker.notify(turnCompletedEvent(2));
  while (prompts.length === promptsAfterStart + 1) await flush();
  const duringCloseOut = prompts[promptsAfterStart + 1]!;
  assert.match(duringCloseOut, /"deadlineRemainingMinutes": 0\b/u);
  assert.match(duringCloseOut, /"closeOut": true/u);
  assert.match(duringCloseOut, /"closeOutRemainingMinutes": 24\b/u);
  await worker.close();
});

test("without a deadline the prompts carry no time budget at all", async () => {
  const { session, prompts } = createFakeSession([
    { stopReason: "stop", text: "ack" },
    { stopReason: "stop", text: JSON.stringify({ action: "verify", reason: "y" }) },
  ]);
  const worker = new PiDecisionWorker(baseOptions({ onAction: () => {}, sessionFactory: async () => ({ session }) }));
  await worker.start();
  assert.doesNotMatch(prompts[0]!, /Wall-clock budget|Time budget/u);
  const promptsAfterStart = prompts.length;
  worker.notify(turnCompletedEvent(1));
  while (prompts.length === promptsAfterStart) await flush();
  assert.doesNotMatch(prompts[promptsAfterStart]!, /deadlineRemainingMinutes|closeOut/u);
  await worker.close();
});

test("with no close-out window the instructions say the Worker is stopped at the deadline", async () => {
  const { session, prompts } = createFakeSession([{ stopReason: "stop", text: "ack" }]);
  const worker = new PiDecisionWorker(baseOptions({
    onAction: () => {},
    sessionFactory: async () => ({ session }),
    context: { ...baseOptions().context, deadline: { totalMs: 2 * 60 * 60_000, graceMs: 0, remainingMs: 60 * 60_000, closeOut: false } },
  }));
  await worker.start();
  assert.match(prompts[0]!, /Wall-clock budget: 2 hours for the whole task, with no close-out window: the Supervisor stops the Worker at the deadline/u);
  assert.match(prompts[0]!, /There is no close-out window/u);
  assert.doesNotMatch(prompts[0]!, /Once closeOut is true/u);
  await worker.close();
});
