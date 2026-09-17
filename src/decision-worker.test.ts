import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PiDecisionWorker, type DecisionAction, type DecisionWorkerOptions } from "./decision-worker.ts";
import type { WorkerEvent, WorkerHandle } from "./types.ts";

/** One scripted assistant turn for the fake session below. */
interface ScriptedTurn {
  text?: string;
  stopReason?: "stop" | "error" | "aborted";
  errorMessage?: string;
  /** Do not resolve prompt() until abort() is called; then reply with stopReason "aborted". */
  holdUntilAbort?: boolean;
}

/**
 * A minimal in-memory stand-in for AgentSession. Each call to prompt()
 * consumes the next scripted turn and replays message_start/message_update
 * (text_delta)/message_end to subscribers, exactly like the real Pi session's
 * subscription feed. Matches the background fact that prompt() resolves
 * normally even when the turn ended in "error" or "aborted".
 */
function createFakeSession(turns: ScriptedTurn[]) {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: string[] = [];
  let turnIndex = 0;
  let pendingRelease: (() => void) | undefined;
  const emit = (event: unknown): void => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const runTurn = (turn: ScriptedTurn, stopReasonOverride?: ScriptedTurn["stopReason"]): void => {
    emit({ type: "message_start", message: { role: "assistant" } });
    if (turn.text) emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: turn.text } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: stopReasonOverride ?? turn.stopReason ?? "stop", errorMessage: turn.errorMessage, content: [] } });
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
    dispose(): void {},
  };
  return { session: session as unknown as import("@earendil-works/pi-coding-agent").AgentSession, prompts };
}

function fakeHandle(): WorkerHandle {
  return { id: "worker-1", startedAt: new Date().toISOString(), cwd: "/tmp/task" };
}

function turnCompletedEvent(sequence = 1): WorkerEvent {
  return { type: "turn_completed", handle: fakeHandle(), result: {}, sequence };
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
