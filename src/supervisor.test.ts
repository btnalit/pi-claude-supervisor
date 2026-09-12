import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SupervisorEvent } from "./events.ts";
import type { WorkerAdapter, WorkerHandle, WorkerOutputChunk, WorkerStatus } from "./types.ts";
import { Supervisor } from "./supervisor.ts";
import { ProcessWorkerAdapter } from "./worker/process-adapter.ts";

class FlakyEventLog {
  readonly events: Array<Omit<SupervisorEvent, "seq" | "at">> = [];
  #failed = false;
  readonly failType: string;

  constructor(failType: string) {
    this.failType = failType;
  }

  async append(event: Omit<SupervisorEvent, "seq" | "at">): Promise<SupervisorEvent> {
    if (!this.#failed && event.type === this.failType) {
      this.#failed = true;
      throw new Error("injected event failure");
    }
    this.events.push(event);
    return { ...event, seq: this.events.length, at: new Date().toISOString() };
  }
}

class SelectiveFailingEventLog {
  readonly events: Array<Omit<SupervisorEvent, "seq" | "at">> = [];
  readonly failTypes: ReadonlySet<string>;

  constructor(failTypes: ReadonlySet<string>) {
    this.failTypes = failTypes;
  }

  async append(event: Omit<SupervisorEvent, "seq" | "at">): Promise<SupervisorEvent> {
    if (this.failTypes.has(event.type)) throw new Error("persistent event failure");
    this.events.push(event);
    return { ...event, seq: this.events.length, at: new Date().toISOString() };
  }
}

test("supervisor rejects spawn failure before reporting a worker start", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-spawn-error-"));
  const supervisor = new Supervisor(new ProcessWorkerAdapter());
  await assert.rejects(() => supervisor.start({
    task: "spawn error",
    cwd,
    command: join(cwd, "does-not-exist"),
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
  }), /spawn|ENOENT/u);
  assert.equal(supervisor.state, "failed");
  assert.equal(supervisor.handle, undefined);
});

test("startup failure events preserve pending lifecycle order", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-start-order-"));
  const log = new FlakyEventLog("task_started");
  const supervisor = new Supervisor(new ProcessWorkerAdapter(), log as unknown as ConstructorParameters<typeof Supervisor>[1]);

  await assert.rejects(() => supervisor.start({
    task: "fixture",
    cwd,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
  }), /injected event failure/u);
  assert.deepEqual(log.events.map((event) => event.type), ["task_started", "worker_start_failed"]);
});

test("watchdog stops a worker that produces no output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-watchdog-"));
  const supervisor = new Supervisor(new ProcessWorkerAdapter());
  await supervisor.start({
    task: "fixture",
    cwd,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    deadlineMs: 0,
    noOutputTimeoutMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(supervisor.state, "stopped");
});

test("watchdog stops the worker even when timeout events cannot be persisted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-watchdog-log-failure-"));
  const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 25, killGraceMs: 25 });
  const log = new SelectiveFailingEventLog(new Set(["worker_watchdog_timeout", "worker_stopped"]));
  const supervisor = new Supervisor(adapter, log as unknown as ConstructorParameters<typeof Supervisor>[1]);
  const handle = await supervisor.start({
    task: "fixture",
    cwd,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 10000)"],
    deadlineMs: 0,
    noOutputTimeoutMs: 10,
  });

  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(supervisor.state, "stopped");
  assert.equal((await adapter.getStatus(handle)).running, false);
});

test("watchdog stops despite an already-pending failed lifecycle event", async () => {
  const handle: WorkerHandle = { id: "pending-watchdog-worker", startedAt: new Date().toISOString(), cwd: "/tmp" };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async (): Promise<WorkerStatus> => ({ handle, running, activeRequests: 0, processGroupCleaned: true }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const log = new SelectiveFailingEventLog(new Set(["worker_waiting", "worker_watchdog_timeout", "worker_stopped"]));
  const supervisor = new Supervisor(adapter, log as unknown as ConstructorParameters<typeof Supervisor>[1]);

  await supervisor.start({ task: "fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 10 });
  await assert.rejects(() => supervisor.poll(), /persistent event failure/u);
  assert.equal(supervisor.state, "waiting");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(supervisor.state, "stopped");
  assert.equal(running, false);
});

test("supervisor serializes JSONL turns and enters waiting after result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-jsonl-state-"));
  const supervisor = new Supervisor(new ProcessWorkerAdapter({ mode: "claude-jsonl" }));
  await supervisor.start({
    task: "first",
    cwd,
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', () => setTimeout(() => process.stdout.write(JSON.stringify({type:'result'}) + '\\n'), 15))", "--"],
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
  });
  await assert.rejects(() => supervisor.send("must wait"), /active JSONL request/u);
  let result = await supervisor.poll();
  for (let attempt = 0; supervisor.state !== "waiting" && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = await supervisor.poll();
  }
  assert.equal(result.status.activeRequests, 0);
  assert.equal(supervisor.state, "waiting");
  await supervisor.send("second");
  await supervisor.stop("test complete");
});

test("supervisor marks an externally SIGTERM-terminated worker as failed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-sigterm-"));
  const supervisor = new Supervisor(new ProcessWorkerAdapter());
  const handle = await supervisor.start({
    task: "signal fixture",
    cwd,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
  });
  assert.ok(handle.pid);
  process.kill(handle.pid, "SIGTERM");
  let report = await supervisor.poll();
  for (let attempt = 0; report.status.running && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    report = await supervisor.poll();
  }
  assert.equal(report.status.signal, "SIGTERM");
  assert.equal(supervisor.state, "failed");
});

test("concurrent supervisor stops are idempotent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-stop-race-"));
  const supervisor = new Supervisor(new ProcessWorkerAdapter());
  await supervisor.start({
    task: "stop race",
    cwd,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
  });
  await Promise.all([supervisor.stop("first stop"), supervisor.stop("second stop")]);
  assert.equal(supervisor.state, "stopped");
});

test("supervisor retries a failed lifecycle event before continuing", async () => {
  const handle: WorkerHandle = { id: "event-retry-worker", startedAt: new Date().toISOString(), cwd: "/tmp" };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async (): Promise<WorkerStatus> => ({ handle, running, activeRequests: 0, processGroupCleaned: true }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const log = new FlakyEventLog("worker_waiting");
  const supervisor = new Supervisor(adapter, log as unknown as ConstructorParameters<typeof Supervisor>[1]);

  await supervisor.start({ task: "fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  await assert.rejects(() => supervisor.poll(), /injected event failure/u);
  assert.equal(supervisor.state, "waiting");
  assert.equal(log.events.filter((event) => event.type === "worker_waiting").length, 0);

  await supervisor.poll();
  assert.equal(log.events.filter((event) => event.type === "worker_waiting").length, 1);

  await supervisor.stop("test complete");
});

test("supervisor restores output when output event persistence fails", async () => {
  const handle: WorkerHandle = { id: "output-retry-worker", startedAt: new Date().toISOString(), cwd: "/tmp" };
  const chunk = { stream: "stdout" as const, text: "important output", at: new Date().toISOString() };
  let pending: WorkerOutputChunk[] = [chunk];
  let restoreCalls = 0;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running: true, activeRequests: 1, processGroupCleaned: true }),
    readOutput: async () => { const result = pending; pending = []; return result; },
    restoreOutput: async (_handle, chunks) => { restoreCalls += 1; pending = [...chunks, ...pending]; },
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const log = new FlakyEventLog("worker_output");
  const supervisor = new Supervisor(adapter, log as unknown as ConstructorParameters<typeof Supervisor>[1]);

  await supervisor.start({ task: "fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  await assert.rejects(() => supervisor.poll(), /injected event failure/u);
  assert.equal(restoreCalls, 1);
  const retry = await supervisor.poll();
  assert.deepEqual(retry.output, [chunk]);

  await supervisor.stop("test complete");
});

test("supervisor retries a failed stop event on a later idempotent stop", async () => {
  const handle: WorkerHandle = { id: "stop-event-retry-worker", startedAt: new Date().toISOString(), cwd: "/tmp" };
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running: true, processGroupCleaned: true }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const log = new FlakyEventLog("worker_stopped");
  const supervisor = new Supervisor(adapter, log as unknown as ConstructorParameters<typeof Supervisor>[1]);

  await supervisor.start({ task: "fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  await assert.rejects(() => supervisor.stop("first stop"), /injected event failure/u);
  assert.equal(supervisor.state, "stopped");
  await supervisor.stop("retry stop");
  assert.equal(log.events.filter((event) => event.type === "worker_stopped").length, 1);
});

test("supervisor requires independent verification after worker exit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-"));
  const supervisor = new Supervisor(new ProcessWorkerAdapter());
  await supervisor.start({ task: "fixture", cwd, command: process.execPath, args: ["-e", "console.log('worker complete')"] });
  let polled = await supervisor.poll();
  for (let attempt = 0; polled.status.running && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    polled = await supervisor.poll();
  }
  assert.equal(polled.status.running, false);
  assert.equal(supervisor.state, "verifying");
  const result = await supervisor.verify({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(result.ok, true);
  assert.equal(supervisor.state, "completed");
});
