import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("stop preempts a startup blocked before a worker handle exists", async () => {
  const handle: WorkerHandle = { id: "never-started", startedAt: new Date().toISOString(), cwd: "/tmp" };
  let aborts = 0;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async (input) => new Promise<WorkerHandle>((_resolve, reject) => {
      input.abortSignal?.addEventListener("abort", () => { aborts += 1; reject(new Error("startup aborted")); }, { once: true });
    }),
    abortStart: async () => {},
    getStatus: async (): Promise<WorkerStatus> => ({ handle, running: false, processGroupCleaned: true }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  const start = supervisor.start({ task: "blocked startup", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const startedAt = Date.now();
  await supervisor.stop("operator preempted startup");
  assert.ok(Date.now() - startedAt < 1_000);
  await assert.rejects(start, /startup aborted/u);
  assert.equal(aborts, 1);
  assert.equal(supervisor.state, "stopped");
});

test("startup cancellation fails closed when adapter cleanup reports an error", async () => {
  const handle: WorkerHandle = { id: "unclean-start", startedAt: new Date().toISOString(), cwd: "/tmp" };
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async (input) => new Promise<WorkerHandle>((_resolve, reject) => {
      input.abortSignal?.addEventListener("abort", () => reject(new Error("startup aborted")), { once: true });
    }),
    abortStart: async () => { throw new Error("startup cleanup failed"); },
    getStatus: async (): Promise<WorkerStatus> => ({ handle, running: true }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { throw new Error("startup cleanup failed"); },
    killProcessGroup: async () => { throw new Error("startup cleanup failed"); },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  const start = supervisor.start({ task: "unclean startup", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  const startFailure = assert.rejects(start, /startup aborted/u);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(supervisor.stop("operator cancellation"), /startup cleanup failed/u);
  await startFailure;
  assert.equal(supervisor.state, "failed");
});

test("supervisor closure hook reports cleanup evidence and human-stop intent", async () => {
  const handle: WorkerHandle = { id: "closure-hook-worker", startedAt: new Date().toISOString(), cwd: "/tmp" };
  let running = true;
  let closure: { cleanupConfirmed: boolean; reason: string } | undefined;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async (): Promise<WorkerStatus> => ({ handle, running, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  await supervisor.start({
    task: "closure hook",
    cwd: "/tmp",
    command: "fixture",
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    onDecisionSessionClosed: (_taskId, info) => { closure = info; },
  });
  await supervisor.stop("operator stop");
  assert.deepEqual(closure, { cleanupConfirmed: true, reason: "human_stop" });
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

test("watchdog starts the no-output clock at the worker start", async () => {
  const handle: WorkerHandle = {
    id: "worker-start-baseline",
    startedAt: new Date().toISOString(),
    cwd: "/tmp",
  };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async (): Promise<WorkerStatus> => ({ handle, running, activeRequests: 1, processGroupCleaned: true }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);

  await supervisor.start({
    task: "recovered fixture",
    cwd: "/tmp",
    command: "fixture",
    // The cumulative task deadline may already be old during recovery, but
    // the worker itself has only just started.
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    deadlineMs: 0,
    noOutputTimeoutMs: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(supervisor.state, "running");
  await supervisor.stop("test complete");
});

test("paused workers do not consume the no-output watchdog budget", async () => {
  const handle: WorkerHandle = { id: "paused-watchdog-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  await supervisor.start({ task: "pause watchdog", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 25 });
  await supervisor.pause();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(supervisor.state, "paused");
  await supervisor.resume();
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
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
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

test("verification stops an owned persistent worker before completion", async () => {
  const handle: WorkerHandle = { id: "persistent-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let stopped = false;
  let stopCalls = 0;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running: !stopped, activeRequests: 0, processGroupCleaned: stopped }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { stopCalls += 1; stopped = true; },
    release: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  await supervisor.start({ task: "fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  await supervisor.poll();
  const result = await supervisor.verify({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(result.ok, true);
  assert.equal(stopCalls, 1);
  assert.equal(supervisor.state, "completed");
});

test("adopted verification treats intentional release as confirmed cleanup", async () => {
  const handle: WorkerHandle = { id: "adopted-verification", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "adopted" };
  let released = false;
  let closure: { cleanupConfirmed: boolean; reason: string } | undefined;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true, repairableSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running: true, activeRequests: 0, processGroupCleaned: released }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { released = true; },
    release: async () => { released = true; },
    killProcessGroup: async () => { throw new Error("adopted session cannot be killed"); },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  await supervisor.start({ task: "adopted fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0, onDecisionSessionClosed: (_taskId, info) => { closure = info; } });
  await supervisor.poll();
  const result = await supervisor.verify({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(result.ok, true);
  assert.equal(supervisor.state, "completed");
  assert.deepEqual(closure, { cleanupConfirmed: true, reason: "completed" });
});

test("verification rejects cgroup cleanup errors instead of completing", async () => {
  const handle: WorkerHandle = { id: "persistent-cgroup-error", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let stopped = false;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running: !stopped, activeRequests: 0, processGroupCleaned: stopped, ...(stopped ? { cgroupError: "injected cgroup cleanup boundary failure" } : {}) }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { stopped = true; },
    release: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  await supervisor.start({ task: "fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  await supervisor.poll();
  await assert.rejects(() => supervisor.verify({ command: process.execPath, args: ["-e", "process.exit(0)"] }), /cgroup cleanup/u);
  assert.equal(supervisor.state, "failed");
});

test("verification policy rejection stops a persistent worker", async () => {
  const handle: WorkerHandle = { id: "persistent-verification-rejection", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let stopped = false;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running: !stopped, activeRequests: 0, processGroupCleaned: stopped }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { stopped = true; },
    release: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  await supervisor.start({ task: "fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  await supervisor.poll();
  await assert.rejects(() => supervisor.verify({ command: "rm", args: ["-rf", "/tmp/should-not-run"] }), /destructive|unsafe|policy/u);
  assert.equal(stopped, true);
  assert.equal(supervisor.state, "failed");
});

test("verification accepts confirmed process-group fallback in auto cgroup mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-auto-cgroup-"));
  const cgroupParentDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-fake-cgroup-"));
  const cgroupParentPath = join(cgroupParentDir, "not-a-cgroup-directory");
  await writeFile(cgroupParentPath, "not a cgroup\n");
  const supervisor = new Supervisor(new ProcessWorkerAdapter({ cgroupMode: "auto", cgroupParentPath }));
  await supervisor.start({ task: "fixture", cwd, command: process.execPath, args: ["-e", "console.log('worker complete')"] });
  let polled = await supervisor.poll();
  for (let attempt = 0; polled.status.running && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    polled = await supervisor.poll();
  }
  assert.equal(polled.status.running, false);
  assert.equal(supervisor.state, "verifying");
  assert.equal(polled.status.cgroupRequired, false);
  assert.match(polled.status.cgroupError ?? "", /cgroup|ENOTDIR|ENOENT/u);
  assert.equal(polled.status.processGroupCleaned, true);
  const result = await supervisor.verify({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(result.ok, true);
  assert.equal(supervisor.state, "completed");
  await rm(cgroupParentDir, { recursive: true, force: true });
});

test("non-persistent verification failure finalizes once and closes the decision session", async () => {
  const handle: WorkerHandle = { id: "non-persistent-repair-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let running = true;
  let decisionClosed = 0;
  const events = new FlakyEventLog("never-fail");
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, exitReason: running ? undefined : "completed", processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
    onHumanRequired: () => {},
  });
  await supervisor.start({
    task: "non-persistent repair failure",
    cwd: "/tmp",
    command: "fixture",
    automation: true,
    spec: { acceptance: [{ id: "fail", name: "fail", command: process.execPath, args: ["-e", "process.exit(7)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => { decisionClosed += 1; } }),
  });
  running = false;
  await supervisor.poll();
  assert.equal(supervisor.state, "verifying");
  const result = await supervisor.verify();
  assert.equal(result.ok, false);
  assert.equal(supervisor.state, "failed");
  assert.equal(decisionClosed, 1);
  assert.ok(events.events.some((event) => event.type === "verification_failed"));
});

test("stop from verifying performs cleanup and reaches stopped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-stop-verifying-"));
  try {
    const supervisor = new Supervisor(new ProcessWorkerAdapter({ cgroupMode: "off" }));
    await supervisor.start({ task: "stop verifying", cwd, command: process.execPath, args: ["-e", "console.log('done')"], deadlineMs: 0, noOutputTimeoutMs: 0 });
    let report = await supervisor.poll();
    for (let attempt = 0; report.status.running && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      report = await supervisor.poll();
    }
    assert.equal(supervisor.state, "verifying");
    await supervisor.stop("operator stop while verifying");
    assert.equal(supervisor.state, "stopped");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop aborts an in-flight acceptance command and wins verification", async () => {
  const handle: WorkerHandle = { id: "cancel-verification-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, repairableSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  await supervisor.start({
    task: "cancel verification",
    cwd: "/tmp",
    command: "fixture",
    spec: { acceptance: [{ id: "slow", name: "slow", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], required: true, timeoutMs: 30_000 }] },
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
  });
  await supervisor.poll();
  const verification = supervisor.verify();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stopping = supervisor.stop("operator cancelled verification");
  const result = await verification;
  await stopping;
  assert.equal(result.checks[0]?.status, "cancelled");
  assert.equal(supervisor.state, "stopped");
});

test("stop aborts a hanging custom Reviewer without waiting for its promise", async () => {
  const handle: WorkerHandle = { id: "hanging-reviewer-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, repairableSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, undefined, { onHumanRequired: () => {}, reviewer: { review: async () => new Promise<never>(() => {}) } });
  await supervisor.start({
    task: "hanging reviewer",
    cwd: "/tmp",
    command: "fixture",
    spec: { acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
  });
  await supervisor.poll();
  const verification = supervisor.verify();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await supervisor.stop("operator cancelled hanging Reviewer");
  await verification;
  assert.equal(supervisor.state, "stopped");
});

test("automatic acceptance review requests a bounded repair before completing", async () => {
  const handle: WorkerHandle = { id: "review-repair-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let running = true;
  let sends: string[] = [];
  let reviews = 0;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async (_handle, message) => { sends.push(message); },
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, undefined, {
    reviewer: {
      review: async () => {
        reviews += 1;
        return reviews === 1
          ? { verdict: "revise", summary: "add the missing case", findings: [{ id: "F001", severity: "P2", message: "missing case", requiredFix: "add the case" }], round: reviews - 1, checkedAt: new Date().toISOString() }
          : { verdict: "pass", summary: "verified", findings: [], round: reviews - 1, checkedAt: new Date().toISOString() };
      },
    },
  });
  await supervisor.start({
    task: "reviewed fixture",
    cwd: "/tmp",
    command: "fixture",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  await supervisor.poll();
  const first = await supervisor.verify();
  assert.equal(first.ok, false);
  assert.equal(supervisor.state, "running");
  assert.equal(reviews, 1);
  assert.match(sends[0] ?? "", /Automatic repair round 1/u);

  await supervisor.poll();
  const second = await supervisor.verify();
  assert.equal(second.ok, true);
  assert.equal(second.review?.verdict, "pass");
  assert.equal(reviews, 2);
  assert.equal(supervisor.state, "completed");
});

test("repeated Reviewer findings escalate instead of looping forever", async () => {
  const handle: WorkerHandle = { id: "duplicate-finding-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let running = true;
  let sends = 0;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => { sends += 1; },
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  let reviews = 0;
  const supervisor = new Supervisor(adapter, undefined, {
    reviewer: { review: async () => ({ verdict: "revise", summary: "still missing", findings: [{ id: "F001", severity: "P2", message: "same issue", requiredFix: "fix it" }], round: reviews++, checkedAt: new Date().toISOString() }) },
  });
  await supervisor.start({
    task: "duplicate finding fixture",
    cwd: "/tmp",
    command: "fixture",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  await supervisor.poll();
  const first = await supervisor.verify();
  assert.equal(first.review?.verdict, "revise");
  assert.equal(supervisor.state, "running");
  assert.equal(sends, 1);
  await supervisor.poll();
  const second = await supervisor.verify();
  assert.equal(second.review?.verdict, "human");
  assert.equal(supervisor.humanRequired, true);
  assert.equal(sends, 1);
});

test("repair-round exhaustion fails closed after the final automatic repair", async () => {
  const handle: WorkerHandle = { id: "exhausted-repair-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let running = true;
  let sends = 0;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => { sends += 1; },
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const events = new FlakyEventLog("never-fail");
  let reviews = 0;
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
    reviewer: {
      review: async () => {
        const round = reviews++;
        return {
          verdict: "revise" as const,
          summary: "still missing",
          findings: [{ id: "F001", severity: "P2" as const, message: `issue in round ${round}`, requiredFix: "fix it" }],
          round,
          checkedAt: new Date().toISOString(),
        };
      },
    },
  });
  await supervisor.start({
    task: "exhaust automatic repairs",
    cwd: "/tmp",
    command: "fixture",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { maxRepairRounds: 1, acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  await supervisor.poll();
  const first = await supervisor.verify();
  assert.equal(first.review?.verdict, "revise");
  assert.equal(supervisor.state, "running");
  assert.equal(sends, 1);

  await supervisor.poll();
  const second = await supervisor.verify();
  assert.equal(second.ok, false);
  assert.equal(second.review?.verdict, "revise");
  assert.equal(supervisor.state, "failed");
  assert.equal(sends, 1);
  assert.ok(events.events.some((event) => event.type === "repair_round_exhausted"));
  assert.ok(events.events.some((event) => event.type === "verification_failed"));
});

test("P0 and P1 Reviewer findings never enter automatic repair", async () => {
  const handle: WorkerHandle = { id: "blocking-finding-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let running = true;
  let sends = 0;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => { sends += 1; },
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, undefined, {
    reviewer: { review: async () => ({ verdict: "revise", summary: "unsafe", findings: [{ id: "F001", severity: "P1", message: "unsafe behavior", requiredFix: "human decision" }], round: 0, checkedAt: new Date().toISOString() }) },
  });
  await supervisor.start({
    task: "blocking finding fixture",
    cwd: "/tmp",
    command: "fixture",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  await supervisor.poll();
  const result = await supervisor.verify();
  assert.equal(result.review?.verdict, "human");
  assert.equal(supervisor.humanRequired, true);
  assert.equal(sends, 0);
});

test("Reviewer API failure is fail-closed and recorded as human review", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-reviewer-error-"));
  const supervisor = new Supervisor(new ProcessWorkerAdapter({ cgroupMode: "off" }), undefined, {
    onHumanRequired: () => {},
    reviewer: { review: async () => { throw new Error("review service unavailable"); } },
  });
  await supervisor.start({ task: "reviewer failure fixture", cwd, command: process.execPath, args: ["-e", "console.log('worker complete')"] });
  let polled = await supervisor.poll();
  for (let attempt = 0; polled.status.running && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    polled = await supervisor.poll();
  }
  const result = await supervisor.verify({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(result.review?.verdict, "human");
  assert.equal(supervisor.humanRequired, true);
  assert.equal(supervisor.state, "failed");
});

test("supervisor requires independent verification after worker exit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-"));
  const supervisor = new Supervisor(new ProcessWorkerAdapter({ cgroupMode: "off" }));
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
