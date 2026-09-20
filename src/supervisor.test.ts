import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishCommand } from "./policy.ts";
import { promisify } from "node:util";
import type { SupervisorEvent } from "./events.ts";
import type { PiUsageSample, WorkerAdapter, WorkerEvent, WorkerHandle, WorkerOutputChunk, WorkerStartInput, WorkerStatus } from "./types.ts";
import type { DecisionWorkerFactory } from "./decision-worker.ts";
import { Supervisor, extendedDeadlineMs } from "./supervisor.ts";
import { ProcessWorkerAdapter } from "./worker/process-adapter.ts";
import { TmuxWorkerAdapter } from "./worker/tmux-adapter.ts";

const execFileAsync = promisify(execFile);

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

async function initializeGitRepository(cwd: string, branch = "worker/test"): Promise<string> {
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "base.txt"), "base\n");
  await execFileAsync("git", ["add", "base.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd });
  // `git init`'s own default branch name is environment-dependent (e.g. a
  // local `init.defaultBranch=main`); only switch when the repository is not
  // already on the requested branch, so a caller can stay on the initial
  // branch (including `main`) without a spurious "already exists" failure.
  const { stdout: currentBranch } = await execFileAsync("git", ["branch", "--show-current"], { cwd });
  if (currentBranch.trim() !== branch) {
    await execFileAsync("git", ["switch", "-c", branch], { cwd });
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

function automaticSpec() {
  return { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1 } };
}

function automaticReviewer() {
  return { review: async () => ({ verdict: "pass" as const, summary: "unused", findings: [], round: 0, checkedAt: new Date().toISOString() }) };
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

test("automatic supervision requires an independent Reviewer", async () => {
  const supervisor = new Supervisor(new ProcessWorkerAdapter());
  await assert.rejects(() => supervisor.start({
    task: "missing reviewer",
    cwd: "/tmp",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 } },
  }), /independent Reviewer/u);
});

test("automatic supervision rejects the unstructured process-pipe transport", async () => {
  const adapter = new ProcessWorkerAdapter();
  const supervisor = new Supervisor(adapter, undefined, {
    reviewer: { review: async () => ({ verdict: "pass", summary: "unused", findings: [], round: 0, checkedAt: new Date().toISOString() }) },
  });
  await assert.rejects(() => supervisor.start({
    task: "process-pipe is manual",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 } },
  }), /claude-jsonl or automated tmux/u);
});

test("automatic supervision rejects a non-Git cwd before Worker startup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-non-git-start-"));
  try {
    const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
    const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
    await assert.rejects(() => supervisor.start({
      task: "non-Git cwd",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: automaticSpec(),
    }), /verified git baseline/u);
    assert.equal(supervisor.handle, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automatic supervision rejects a detached or bare repository", async () => {
  const detachedCwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-detached-start-"));
  const bareCwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-bare-start-"));
  try {
    const detachedBase = await initializeGitRepository(detachedCwd, "worker/detached");
    await execFileAsync("git", ["checkout", "--detach", detachedBase], { cwd: detachedCwd });
    const detached = new Supervisor(new ProcessWorkerAdapter({ mode: "claude-jsonl" }), undefined, { reviewer: automaticReviewer() });
    await assert.rejects(() => detached.start({ task: "detached", cwd: detachedCwd, command: "claude", automation: true, deadlineMs: 0, noOutputTimeoutMs: 0, spec: automaticSpec() }), /detached, unreadable, or missing git branch/u);

    const bareBase = await initializeGitRepository(bareCwd, "worker/bare");
    await execFileAsync("git", ["config", "core.bare", "true"], { cwd: bareCwd });
    const bare = new Supervisor(new ProcessWorkerAdapter({ mode: "claude-jsonl" }), undefined, { reviewer: automaticReviewer() });
    await assert.rejects(() => bare.start({ task: "bare", cwd: bareCwd, command: "claude", automation: true, baseCommit: bareBase, baseBranch: "worker/bare", deadlineMs: 0, noOutputTimeoutMs: 0, spec: automaticSpec() }), /non-bare git worktree/u);
  } finally {
    await rm(detachedCwd, { recursive: true, force: true });
    await rm(bareCwd, { recursive: true, force: true });
  }
});

test("automatic supervision rejects a non-Claude executable after repository validation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-custom-worker-start-"));
  try {
    await initializeGitRepository(cwd, "worker/custom-worker");
    const supervisor = new Supervisor(new ProcessWorkerAdapter({ mode: "claude-jsonl" }), undefined, { reviewer: automaticReviewer() });
    await assert.rejects(() => supervisor.start({
      task: "custom automatic worker",
      cwd,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: automaticSpec(),
    }), /direct Claude executable/u);
    assert.equal(supervisor.handle, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automatic supervision rejects a supplied baseline that is not an existing commit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-missing-baseline-"));
  try {
    await initializeGitRepository(cwd, "worker/missing-baseline");
    const supervisor = new Supervisor(new ProcessWorkerAdapter({ mode: "claude-jsonl" }), undefined, { reviewer: automaticReviewer() });
    await assert.rejects(() => supervisor.start({
      task: "missing baseline",
      cwd,
      command: "claude",
      baseCommit: "0".repeat(40),
      baseBranch: "worker/missing-baseline",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: automaticSpec(),
    }), /not an existing git commit/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automatic supervision rechecks the exact startup HEAD before spawning", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-head-race-"));
  try {
    await initializeGitRepository(cwd, "worker/head-race");
    let closed = false;
    const adapter = new (class extends ProcessWorkerAdapter {
      override async preflight(_input: Pick<WorkerStartInput, "cwd" | "command" | "args" | "env" | "approval" | "automatic">): Promise<void> {}

      override async start(input: WorkerStartInput): Promise<WorkerHandle> {
        await writeFile(join(cwd, "adapter-started.txt"), "changed\n");
        await execFileAsync("git", ["add", "adapter-started.txt"], { cwd });
        await execFileAsync("git", ["commit", "-qm", "unexpected adapter startup change"], { cwd });
        await input.preSpawnCheck?.();
        throw new Error("adapter start should not be reached after the pre-spawn check");
      }
    })({ mode: "claude-jsonl", cgroupMode: "off" });
    const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
    await assert.rejects(() => supervisor.start({
      task: "head race",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: automaticSpec(),
      decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => { closed = true; } }),
    }), /repository HEAD changed/u);
    assert.equal(supervisor.handle, undefined);
    assert.equal(closed, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automatic supervision starts on the initial branch, including main", async () => {
  // The task is anchored to the baseline commit, not to a branch name: Claude
  // Code's own "branch first" guidance is advisory, and a task may legitimately
  // start (or land) on `main`. Only push/merge/PR and a destructive rewrite of
  // a protected branch remain restricted.
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-main-start-"));
  try {
    await initializeGitRepository(cwd, "main");
    const handle: WorkerHandle = { id: "main-start-worker", startedAt: new Date().toISOString(), cwd, ownership: "owned" };
    let running = true;
    const adapter: WorkerAdapter = {
      capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
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
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "start on main",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: automaticSpec(),
      decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
    });
    assert.equal(supervisor.state, "running");
    assert.equal(supervisor.task?.baseBranch, "main");
    // No branch change occurred, so the boundary re-checks must not report one.
    assert.ok(!events.events.some((event) => event.type === "worker_branch_changed"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automatic recovery follows the Worker onto a new branch instead of rejecting it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-branch-follow-"));
  try {
    const baseCommit = await initializeGitRepository(cwd, "main");
    // Claude Code's own advisory guidance is "branch first"; the Worker may
    // branch off main mid-task, including across a Pi restart that recovers
    // the task with its originally recorded starting branch.
    await execFileAsync("git", ["switch", "-c", "feature/x"], { cwd });
    await writeFile(join(cwd, "feature.txt"), "feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "feature work"], { cwd });

    const handle: WorkerHandle = { id: "branch-follow-worker", startedAt: new Date().toISOString(), cwd, ownership: "owned" };
    let running = true;
    const adapter: WorkerAdapter = {
      capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
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
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      taskId: "recovered-branch-follow",
      startedAt: new Date().toISOString(),
      task: "recovery after the Worker branched",
      cwd,
      command: "claude",
      automation: true,
      baseCommit,
      baseBranch: "main",
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: automaticSpec(),
      decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
    });
    assert.equal(supervisor.state, "running");
    // The starting branch recorded in the task context never changes...
    assert.equal(supervisor.task?.baseBranch, "main");
    // ...but the divergence is recorded once as an audited event.
    const changed = events.events.filter((event) => event.type === "worker_branch_changed");
    assert.equal(changed.length, 1);
    assert.deepEqual(changed[0]?.data, { from: "main", to: "feature/x" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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
  await assert.rejects(() => supervisor.verify({ command: "git", args: ["push", "origin", "main"] }), /destructive|unsafe|policy/u);
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
    reviewer: { review: async (input) => ({ verdict: "pass", summary: "not reached", findings: [], round: input.round, checkedAt: new Date().toISOString() }) },
  });
  await supervisor.start({
    task: "non-persistent repair failure",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 }, acceptance: [{ id: "fail", name: "fail", command: process.execPath, args: ["-e", "process.exit(7)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => { decisionClosed += 1; } }),
  });
  running = false;
  await supervisor.poll();
  assert.equal(supervisor.state, "verifying");
  const result = await supervisor.verify();
  assert.equal(result.ok, false);
  assert.equal(supervisor.state, "blocked");
  assert.equal(supervisor.candidateParked, true);
  assert.equal(decisionClosed, 1);
  assert.ok(events.events.some((event) => event.type === "candidate_parked"));
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
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 }, acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
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

test("automatic candidates require and review a local commit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-local-commit-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "base.txt"), "base\\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd });
    await execFileAsync("git", ["switch", "-c", "worker/candidate"], { cwd });

    const handle: WorkerHandle = { id: "local-commit-worker", startedAt: new Date().toISOString(), cwd, ownership: "owned" };
    let running = true;
    let sends = 0;
    let reviewedCommits = "";
    const adapter: WorkerAdapter = {
      capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
      start: async () => handle,
      getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
      readOutput: async () => [],
      send: async () => {
        sends += 1;
        await execFileAsync("git", ["add", "candidate.txt"], { cwd });
        await execFileAsync("git", ["commit", "-qm", "automatic local candidate"], { cwd });
      },
      pause: async () => {},
      resume: async () => {},
      stop: async () => { running = false; },
      killProcessGroup: async () => { running = false; },
      resumeSession: async () => handle,
    };
    const supervisor = new Supervisor(adapter, undefined, {
      reviewer: { review: async (input) => { reviewedCommits = input.evidence.commits ?? ""; return { verdict: "pass", summary: "verified", findings: [], round: input.round, checkedAt: new Date().toISOString() }; } },
    });
    await supervisor.start({
      task: "commit the candidate locally",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: { acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
      decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
    });
    await writeFile(join(cwd, "candidate.txt"), "candidate\\n");
    await supervisor.poll();
    const first = await supervisor.verify();
    assert.equal(first.ok, true);
    assert.equal(supervisor.state, "running");
    assert.equal(sends, 1);

    await supervisor.poll();
    const second = await supervisor.verify();
    assert.equal(second.ok, true);
    assert.equal(supervisor.state, "completed");
    assert.match(reviewedCommits, /automatic local candidate/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 }, acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
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
  assert.equal(supervisor.humanRequired, false);
  assert.equal(supervisor.candidateParked, true);
  assert.equal(supervisor.state, "blocked");
  assert.equal(sends, 1);
});

test("repair-round exhaustion parks the candidate after the final automatic repair", async () => {
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
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { maxRepairRounds: 1, autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 }, acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
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
  assert.equal(supervisor.state, "blocked");
  assert.equal(supervisor.candidateParked, true);
  assert.equal(sends, 1);
  assert.ok(events.events.some((event) => event.type === "repair_round_exhausted"));
  assert.ok(events.events.some((event) => event.type === "candidate_parked"));
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
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 2 }, acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  await supervisor.poll();
  const result = await supervisor.verify();
  assert.equal(result.review?.verdict, "human");
  assert.equal(supervisor.humanRequired, false);
  assert.equal(supervisor.candidateParked, true);
  assert.equal(supervisor.state, "blocked");
  assert.equal(sends, 0);
});

test("Reviewer API failure parks a candidate without human review", async () => {
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
  assert.equal(supervisor.humanRequired, false);
  assert.equal(supervisor.candidateParked, true);
  assert.equal(supervisor.state, "blocked");
});

test("malformed custom Reviewer output parks and cleans up the Worker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-reviewer-malformed-"));
  const supervisor = new Supervisor(new ProcessWorkerAdapter({ cgroupMode: "off" }), undefined, {
    reviewer: { review: async () => ({ verdict: "pass" } as never) },
  });
  try {
    await supervisor.start({ task: "malformed reviewer fixture", cwd, command: process.execPath, args: ["-e", "console.log('worker complete')"] });
    let polled = await supervisor.poll();
    for (let attempt = 0; polled.status.running && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      polled = await supervisor.poll();
    }
    const result = await supervisor.verify({ command: process.execPath, args: ["-e", "process.exit(0)"] });
    assert.equal(result.review?.verdict, "human");
    assert.equal(supervisor.candidateParked, true);
    assert.equal(supervisor.state, "blocked");
    assert.equal((await supervisor.poll()).status.running, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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

test("deferred exited event is retried by the watchdog", async () => {
  const handle: WorkerHandle = { id: "deferred-exit-worker", startedAt: new Date().toISOString(), cwd: "/tmp" };
  let running = true;
  let readOutputCalls = 0;
  let capturedListener: WorkerStartInput["eventListener"];
  const log = new FlakyEventLog("worker_output");
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async (): Promise<WorkerStatus> => ({ handle, running, exitReason: running ? undefined : "completed", processGroupCleaned: !running }),
    readOutput: async () => {
      readOutputCalls += 1;
      return readOutputCalls === 1 ? [{ stream: "stdout" as const, text: "hello", at: new Date().toISOString() }] : [];
    },
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, log as unknown as ConstructorParameters<typeof Supervisor>[1]);
  await supervisor.start({ task: "deferred exit", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 60_000 });
  running = false;
  capturedListener?.({ type: "exited", handle });
  // The first delivery fails inside #pollInternal (worker_output append), so
  // the exit must remain deferred rather than classifying the Worker as failed.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(supervisor.state, "running");
  let attempt = 0;
  while (supervisor.state === "running" && attempt < 60) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    attempt += 1;
  }
  assert.ok(["verifying", "failed"].includes(supervisor.state));
  assert.ok(log.events.some((event) => event.type === "worker_exited"));
  await supervisor.stop("test complete").catch(() => {});
});

test("watchdog classifies a Worker that exited without an event", async () => {
  const handle: WorkerHandle = { id: "unreported-exit-worker", startedAt: new Date().toISOString(), cwd: "/tmp" };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async (): Promise<WorkerStatus> => ({ handle, running, exitReason: running ? undefined : "completed", processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter);
  await supervisor.start({ task: "unreported exit", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 60_000 });
  running = false;
  let attempt = 0;
  while (supervisor.state === "running" && attempt < 60) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    attempt += 1;
  }
  assert.notEqual(supervisor.state, "running");
  await supervisor.stop("test complete").catch(() => {});
});

test("stop with preserveDecisionSession during verifying reports a recoverable close reason", async () => {
  const handle: WorkerHandle = { id: "preserve-session-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let running = true;
  let closure: { cleanupConfirmed: boolean; reason: string } | undefined;
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
  const supervisor = new Supervisor(adapter, undefined, {
    reviewer: { review: async () => new Promise<never>(() => {}) },
  });
  await supervisor.start({
    task: "preserve decision session",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { ...automaticSpec(), acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
    onDecisionSessionClosed: (_taskId, info) => { closure = info; },
  });
  await supervisor.poll();
  const verification = supervisor.verify();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await supervisor.stop("shutdown", { preserveDecisionSession: true });
  await verification;
  assert.equal(supervisor.state, "stopped");
  assert.notEqual(closure?.reason, "human_stop");
  assert.equal(closure?.reason, "recoverable_failure");
});

test("release ignores a late decision", async () => {
  const handle: WorkerHandle = { id: "release-race-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let running = true;
  let released = false;
  let onAction: Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined;
  const events = new FlakyEventLog("never-fail");
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    release: async () => { released = true; running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "release race",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: (options) => { onAction = options.onAction; return { start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }; },
  });
  await supervisor.release();
  assert.equal(released, true);
  await onAction?.({ action: "park", reason: "late" }, { type: "turn_completed", handle, result: {}, sequence: 1 });
  assert.ok(!events.events.some((event) => event.type === "candidate_parked"));
  assert.ok(events.events.some((event) => event.type === "decision_ignored"));
});

test("unexpected exit notifies a failed candidate in automation mode", async () => {
  const handle: WorkerHandle = { id: "unexpected-exit-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let running = true;
  let capturedListener: WorkerStartInput["eventListener"];
  const candidates: Array<{ status: string }> = [];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, exitReason: running ? undefined : "crashed", processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, undefined, {
    reviewer: automaticReviewer(),
    onCandidate: (notice) => { candidates.push(notice); },
  });
  await supervisor.start({
    task: "unexpected exit",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  running = false;
  capturedListener?.({ type: "exited", handle });
  let attempt = 0;
  while (candidates.length === 0 && attempt < 60) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    attempt += 1;
  }
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.status, "failed");
});

test("noop on a completed turn parks the candidate", async () => {
  const handle: WorkerHandle = { id: "noop-turn-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let running = true;
  let onAction: Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
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
  const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "noop turn",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: (options) => { onAction = options.onAction; return { start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }; },
  });
  await onAction?.({ action: "noop", reason: "nothing to do" }, { type: "turn_completed", handle, result: {}, sequence: 1 });
  assert.equal(supervisor.state, "blocked");
  assert.equal(supervisor.candidateParked, true);
});

test("noop on a clean exit proceeds to verification instead of stranding the task", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-noop-exit-"));
  try {
    await initializeGitRepository(cwd, "worker/noop-exit");
    const handle: WorkerHandle = { id: "noop-exit-worker", startedAt: new Date().toISOString(), cwd, ownership: "owned" };
    let running = true;
    let reviews = 0;
    let onAction: Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined;
    let eventListener: WorkerStartInput["eventListener"] | undefined;
    const adapter: WorkerAdapter = {
      capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
      start: async (input) => { eventListener = input.eventListener; return handle; },
      getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running, exitReason: running ? undefined : "completed" }),
      readOutput: async () => [],
      send: async () => {},
      pause: async () => {},
      resume: async () => {},
      stop: async () => { running = false; },
      killProcessGroup: async () => { running = false; },
      resumeSession: async () => handle,
    };
    const supervisor = new Supervisor(adapter, undefined, {
      reviewer: { review: async () => { reviews += 1; return { verdict: "pass" as const, summary: "ok", findings: [], round: 0, checkedAt: new Date().toISOString() }; } },
    });
    await supervisor.start({
      task: "noop exit",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: automaticSpec(),
      decisionWorkerFactory: (options) => { onAction = options.onAction; return { start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }; },
    });
    running = false;
    const exited = { type: "exited" as const, handle, exitCode: 0 };
    eventListener?.(exited);
    await supervisor.poll();
    assert.equal(supervisor.state, "verifying");
    await onAction?.({ action: "noop", reason: "worker finished" }, exited);
    assert.equal(reviews, 1);
    assert.equal(supervisor.state, "completed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a candidate on a protected branch completes and reports where it lives", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-candidate-main-"));
  try {
    await initializeGitRepository(cwd, "main");
    const handle: WorkerHandle = { id: "candidate-main-worker", startedAt: new Date().toISOString(), cwd, ownership: "owned" };
    let running = true;
    let onAction: Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined;
    let eventListener: WorkerStartInput["eventListener"] | undefined;
    const candidates: Array<{ status: string; branch?: string; protectedBranch?: boolean }> = [];
    const adapter: WorkerAdapter = {
      capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
      start: async (input) => { eventListener = input.eventListener; return handle; },
      getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running, exitReason: running ? undefined : "completed" }),
      readOutput: async () => [],
      send: async () => {},
      pause: async () => {},
      resume: async () => {},
      stop: async () => { running = false; },
      killProcessGroup: async () => { running = false; },
      resumeSession: async () => handle,
    };
    const supervisor = new Supervisor(adapter, undefined, {
      reviewer: automaticReviewer(),
      onCandidate: (notice) => { candidates.push(notice); },
    });
    await supervisor.start({
      task: "candidate on main",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: automaticSpec(),
      decisionWorkerFactory: (options) => { onAction = options.onAction; return { start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }; },
    });
    running = false;
    const exited = { type: "exited" as const, handle, exitCode: 0 };
    eventListener?.(exited);
    await supervisor.poll();
    assert.equal(supervisor.state, "verifying");
    await onAction?.({ action: "noop", reason: "worker finished" }, exited);
    assert.equal(supervisor.state, "completed");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.status, "ready");
    assert.equal(candidates[0]?.branch, "main");
    assert.equal(candidates[0]?.protectedBranch, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a recovered task continues its cost budget from the persisted total", async () => {
  const handle: WorkerHandle = { id: "recovered-cost-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let running = true;
  let eventListener: WorkerStartInput["eventListener"] | undefined;
  const progress: number[] = [];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async (input) => { eventListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 1, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "recovered cost",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    initialWorkerCostUsd: 0.5,
    spec: { ...automaticSpec(), autonomy: { ...automaticSpec().autonomy, maxWorkerCostUsd: 0.7 } },
    onDecisionSessionProgress: (info) => { progress.push(info.workerCostUsd); },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  assert.equal(supervisor.usage.workerCostUsd, 0.5);
  eventListener?.({ type: "turn_completed", handle, sequence: 1, result: { total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, num_turns: 1 } });
  await supervisor.poll();
  assert.equal(Number(supervisor.usage.workerCostUsd.toFixed(4)), 0.6);
  assert.ok(progress.includes(0.6), "cumulative cost is persisted through the progress hook");
  assert.notEqual(supervisor.state, "blocked");
  eventListener?.({ type: "turn_completed", handle, sequence: 2, result: { total_cost_usd: 0.3, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, num_turns: 2 } });
  await supervisor.poll();
  assert.equal(Number(supervisor.usage.workerCostUsd.toFixed(4)), 0.8);
  assert.equal(supervisor.state, "blocked");
  assert.equal(supervisor.candidateParked, true);
});

test("stop still transitions when a pending event keeps failing", async () => {
  const handle: WorkerHandle = { id: "pending-flush-worker", startedAt: new Date().toISOString(), cwd: "/tmp" };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async (): Promise<WorkerStatus> => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const log = new SelectiveFailingEventLog(new Set(["worker_waiting"]));
  const supervisor = new Supervisor(adapter, log as unknown as ConstructorParameters<typeof Supervisor>[1]);
  await supervisor.start({ task: "fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  await assert.rejects(() => supervisor.poll(), /persistent event failure/u);
  assert.equal(supervisor.state, "waiting");
  await assert.rejects(() => supervisor.stop("test complete"));
  assert.equal(supervisor.state, "stopped");
});

test("watchdog-classified exit starts verification in automation mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-watchdog-verify-"));
  try {
    await initializeGitRepository(cwd, "worker/watchdog-verify");
    const handle: WorkerHandle = { id: "watchdog-verify-worker", startedAt: new Date().toISOString(), cwd, ownership: "owned" };
    let running = true;
    let reviews = 0;
    const adapter: WorkerAdapter = {
      capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
      start: async () => handle,
      getStatus: async () => ({ handle, running, activeRequests: 0, exitReason: running ? undefined : "completed", processGroupCleaned: !running }),
      readOutput: async () => [],
      send: async () => {},
      pause: async () => {},
      resume: async () => {},
      stop: async () => { running = false; },
      killProcessGroup: async () => { running = false; },
      resumeSession: async () => handle,
    };
    const supervisor = new Supervisor(adapter, undefined, {
      reviewer: { review: async () => { reviews += 1; return { verdict: "pass" as const, summary: "verified", findings: [], round: 0, checkedAt: new Date().toISOString() }; } },
    });
    // No "exited" event is ever delivered by this adapter; only the watchdog's
    // own getStatus poll can notice the Worker died and classify+verify it.
    await supervisor.start({
      task: "watchdog classifies and verifies",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 60_000,
      spec: { ...automaticSpec(), acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
      decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
    });
    running = false;
    let attempt = 0;
    while (reviews === 0 && attempt < 60) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      attempt += 1;
    }
    assert.equal(reviews, 1);
    assert.equal(supervisor.state, "completed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a committed task branch with a dirty worktree requests repair", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-dirty-worktree-"));
  try {
    await initializeGitRepository(cwd, "worker/dirty-worktree");
    const handle: WorkerHandle = { id: "dirty-worktree-worker", startedAt: new Date().toISOString(), cwd, ownership: "owned" };
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
    const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "dirty worktree candidate",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: { autonomy: { unattended: true, requireLocalCommit: true, maxDecisionRetries: 1 }, acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
      decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
    });
    // A commit already exists on the task branch, but the worktree still has
    // an uncommitted change on top of it: the committed candidate and the
    // reviewed worktree diff would disagree.
    await writeFile(join(cwd, "candidate.txt"), "candidate\n");
    await execFileAsync("git", ["add", "candidate.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "candidate commit"], { cwd });
    await writeFile(join(cwd, "dirty.txt"), "dirty\n");
    await supervisor.poll();
    const result = await supervisor.verify();
    assert.equal(result.ok, true);
    const required = events.events.find((event) => event.type === "local_commit_required");
    assert.match(String(required?.data?.reason ?? ""), /uncommitted/u);
    assert.ok(events.events.some((event) => event.type === "repair_requested"));
    assert.equal(sends, 1);
    assert.equal(supervisor.state, "running");
    // An automatic repair round transitions verifying -> running immediately
    // before sending the repair instruction; #sendInternal must not treat that
    // as an ordinary turn boundary and emit a spurious worker_waiting between
    // the repair request and the message actually being sent (F20).
    const repairedIndex = events.events.findIndex((event) => event.type === "repair_requested");
    const sentIndex = events.events.findIndex((event) => event.type === "worker_message_sent");
    assert.ok(repairedIndex >= 0 && sentIndex > repairedIndex);
    assert.ok(!events.events.slice(repairedIndex, sentIndex + 1).some((event) => event.type === "worker_waiting"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rewritten history parks the candidate even on the same branch name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-rewritten-history-"));
  try {
    await initializeGitRepository(cwd, "worker/rewritten");
    const handle: WorkerHandle = { id: "rewritten-worker", startedAt: new Date().toISOString(), cwd, ownership: "owned" };
    let running = true;
    const adapter: WorkerAdapter = {
      capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
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
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "rewritten history",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: automaticSpec(),
      decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
    });
    // The Worker rewrote history under the same branch name (e.g. an orphan
    // commit, or a hard reset to an unrelated commit) instead of building on
    // the recorded baseline: the baseline is no longer an ancestor of HEAD.
    await execFileAsync("git", ["checkout", "-q", "--orphan", "rewritten"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "orphan"], { cwd });
    await supervisor.poll();
    const result = await supervisor.verify();
    assert.equal(result.ok, true);
    assert.equal(supervisor.state, "blocked");
    assert.equal(supervisor.candidateParked, true);
    const parked = events.events.find((event) => event.type === "candidate_parked");
    assert.match(String(parked?.data?.candidateReason ?? ""), /no longer descends from the recorded baseline/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("truncated repository evidence requests a repair before parking", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-truncated-evidence-"));
  try {
    await initializeGitRepository(cwd, "worker/truncated-evidence");
    const handle: WorkerHandle = { id: "truncated-evidence-worker", startedAt: new Date().toISOString(), cwd, ownership: "owned" };
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
    const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "truncated evidence candidate",
      cwd,
      command: "claude",
      automation: true,
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      spec: { ...automaticSpec(), acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
      decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
    });
    // A >1 MiB tracked change makes the collected diff exceed the Reviewer
    // evidence limit; the candidate should get a chance to shrink it before
    // any candidate is parked.
    await writeFile(join(cwd, "base.txt"), "a".repeat(1024 * 1024 + 500_000));
    await supervisor.poll();
    const result = await supervisor.verify();
    assert.equal(result.ok, true);
    const repaired = events.events.find((event) => event.type === "repair_requested");
    assert.match(String(repaired?.data?.reason ?? ""), /review limits/u);
    assert.equal(sends, 1);
    assert.equal(supervisor.state, "running");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a continue decision is ignored, not parked, when the Worker has resumed on its own", async () => {
  const handle: WorkerHandle = { id: "stale-decision-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let activeRequests = 0;
  let stopped = false;
  let capturedListener: WorkerStartInput["eventListener"];
  let onAction: Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined;
  const events = new FlakyEventLog("never-fail");
  const sent: string[] = [];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running: !stopped, activeRequests, processGroupCleaned: stopped }),
    readOutput: async () => [],
    send: async (_handle, message) => { sent.push(message); },
    pause: async () => {},
    resume: async () => {},
    stop: async () => { stopped = true; },
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "stale decision",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: (options) => { onAction = options.onAction; return { start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }; },
  });
  const turnEvent: WorkerEvent = { type: "turn_completed", handle, result: { subtype: "stop", result: "Waiting for 2 background agents" }, sequence: 1 };
  capturedListener?.(turnEvent);
  await supervisor.poll();
  assert.equal(supervisor.state, "waiting");
  // A background agent finished and re-invoked Claude before the decision arrived.
  activeRequests = 1;
  await onAction?.({ action: "continue", message: "keep going", reason: "r" }, turnEvent);
  assert.deepEqual(sent, []);
  assert.equal(stopped, false);
  assert.equal(supervisor.candidateParked, false);
  assert.ok(events.events.some((event) => event.type === "decision_ignored" && /resumed on its own/u.test(String((event.data as { reason?: string } | undefined)?.reason))));
  assert.ok(!events.events.some((event) => event.type === "decision_worker_failed" || event.type === "candidate_parked"));
  // resume-auto after a takeover must not replay into a live turn either.
  await supervisor.takeover();
  await supervisor.resumeAutomation();
  assert.ok(!events.events.some((event) => event.type === "worker_message_sent"));
});

test("a wait decision sends nothing and re-asks the Decision Worker only if the Worker stays idle", async () => {
  const handle: WorkerHandle = { id: "wait-decision-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let capturedListener: WorkerStartInput["eventListener"];
  let onAction: Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined;
  const replays: WorkerEvent[] = [];
  const events = new FlakyEventLog("never-fail");
  const sent: string[] = [];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running: true, activeRequests: 0, processGroupCleaned: false }),
    readOutput: async () => [],
    send: async (_handle, message) => { sent.push(message); },
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "wait decision",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    waitTimeoutMs: 60,
    spec: automaticSpec(),
    decisionWorkerFactory: (options) => {
      onAction = options.onAction;
      return { start: async () => {}, updateContext: () => {}, notify: () => {}, replay: (event) => { replays.push(event); }, close: async () => {} };
    },
  });
  const turnEvent: WorkerEvent = { type: "turn_completed", handle, result: { subtype: "stop", result: "Both reviewer agents are still running; their completion notifications will arrive automatically." }, sequence: 1 };
  capturedListener?.(turnEvent);
  await supervisor.poll();
  await onAction?.({ action: "wait", reason: "worker is waiting for its own agents" }, turnEvent);
  assert.deepEqual(sent, []);
  assert.equal(supervisor.state, "waiting");
  assert.equal(supervisor.candidateParked, false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(replays.length, 1);
  assert.ok(events.events.some((event) => event.type === "wait_expired"));
  // A fresh turn cancels a pending wait: no second replay follows.
  await onAction?.({ action: "wait", reason: "still waiting" }, turnEvent);
  capturedListener?.({ type: "turn_completed", handle, result: { subtype: "stop", result: "done" }, sequence: 2 });
  await supervisor.poll();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(replays.length, 1);
});

test("resume-auto replays the last completed turn", async () => {
  const handle: WorkerHandle = { id: "resume-replay-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  let capturedListener: WorkerStartInput["eventListener"];
  let onAction: Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined;
  const replays: WorkerEvent[] = [];
  const events = new FlakyEventLog("never-fail");
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "resume auto replay",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: (options) => {
      onAction = options.onAction;
      return {
        start: async () => {},
        updateContext: () => {},
        notify: () => {},
        replay: (event) => { replays.push(event); },
        close: async () => {},
      };
    },
  });
  const turnEvent: WorkerEvent = { type: "turn_completed", handle, result: {}, sequence: 1 };
  capturedListener?.(turnEvent);
  // poll() is serialized behind the async event processing #receiveWorkerEvent
  // queued above, so by the time it resolves "waiting" has already landed.
  await supervisor.poll();
  assert.equal(supervisor.state, "waiting");
  await supervisor.takeover();
  assert.equal(supervisor.humanRequired, true);
  await onAction?.({ action: "continue", message: "should not be sent", reason: "r" }, turnEvent);
  assert.ok(events.events.some((event) => event.type === "decision_deferred"));
  assert.ok(!events.events.some((event) => event.type === "worker_message_sent"));
  await supervisor.resumeAutomation();
  assert.equal(replays.length, 1);
  assert.equal(replays[0], turnEvent);
  // The replayed action must not have been deduped by the earlier, deferred
  // delivery: #applyDecision returned before recording its actionKey.
  await onAction?.({ action: "continue", message: "should not be sent", reason: "r" }, turnEvent);
  assert.ok(events.events.some((event) => event.type === "worker_message_sent"));
});

test("failed send does not consume a turn", async () => {
  const handle: WorkerHandle = { id: "failed-send-worker", startedAt: new Date().toISOString(), cwd: "/tmp" };
  let running = true;
  let sendAttempts = 0;
  const events = new FlakyEventLog("never-fail");
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "process-pipe", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error("transient send failure");
    },
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1]);
  await supervisor.start({ task: "failed send fixture", cwd: "/tmp", command: "fixture", deadlineMs: 0, noOutputTimeoutMs: 0 });
  await assert.rejects(() => supervisor.send("first attempt"), /transient send failure/u);
  await supervisor.send("second attempt");
  const sent = events.events.filter((event) => event.type === "worker_message_sent");
  assert.equal(sent.length, 1);
  assert.ok(String(sent[0]?.idempotencyKey).endsWith(":turn:1"));
});

test("deny_permission on a policy-allowed command uses the Decision Worker's reason", async () => {
  const handle: WorkerHandle = { id: "deny-message-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  let onAction: Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined;
  let respondedDecision: { behavior: string; message?: string } | undefined;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
    respondPermission: async (_handle, _requestId, _toolUseId, decision) => { respondedDecision = decision; },
  };
  const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "deny message fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: (options) => { onAction = options.onAction; return { start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }; },
  });
  const permissionEvent: WorkerEvent = {
    type: "permission_request",
    handle,
    request: { requestId: "req-1", toolUseId: "tool-1", toolName: "Read", input: { file_path: "x" }, raw: {} },
  };
  await onAction?.({ action: "deny_permission", requestId: "req-1", toolUseId: "tool-1", reason: "not needed for this task" }, permissionEvent);
  assert.equal(respondedDecision?.behavior, "deny");
  assert.equal(respondedDecision?.message, "denied by supervisor: not needed for this task");
});

test("hybrid permission authority answers routine requests from policy", async () => {
  const handle: WorkerHandle = { id: "hybrid-permission-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  let capturedListener: WorkerStartInput["eventListener"];
  const responded: Array<{ requestId: string; behavior: string; message?: string }> = [];
  const notified: WorkerEvent[] = [];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
    respondPermission: async (_handle, requestId, _toolUseId, decision) => { responded.push({ requestId, ...decision }); },
  };
  const events = new FlakyEventLog("never-fail");
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "hybrid permission fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: (event) => { notified.push(event); }, close: async () => {} }),
  });
  const routineEvent: WorkerEvent = {
    type: "permission_request",
    handle,
    request: { requestId: "req-routine", toolUseId: "tool-routine", toolName: "Bash", input: { command: "ls -la" }, raw: {} },
  };
  capturedListener?.(routineEvent);
  await supervisor.poll();
  assert.equal(responded.length, 1);
  assert.equal(responded[0]?.behavior, "allow");
  assert.equal(notified.length, 0);
  const decision = events.events.find((event) => event.type === "permission_decision");
  assert.equal(decision?.data?.actor, "policy");

  const nonRoutineEvent: WorkerEvent = {
    type: "permission_request",
    handle,
    request: { requestId: "req-curl", toolUseId: "tool-curl", toolName: "Bash", input: { command: "curl https://x" }, raw: {} },
  };
  capturedListener?.(nonRoutineEvent);
  await supervisor.poll();
  assert.equal(responded.length, 1);
  assert.equal(notified.length, 1);
  assert.equal(notified[0], nonRoutineEvent);
});

test("policy permission authority never consults the Decision Worker", async () => {
  const handle: WorkerHandle = { id: "policy-only-permission-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  let capturedListener: WorkerStartInput["eventListener"];
  const responded: Array<{ requestId: string; behavior: string; message?: string }> = [];
  const notified: WorkerEvent[] = [];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
    respondPermission: async (_handle, requestId, _toolUseId, decision) => { responded.push({ requestId, ...decision }); },
  };
  const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "policy-only permission fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, permissionAuthority: "policy" } },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: (event) => { notified.push(event); }, close: async () => {} }),
  });
  capturedListener?.({
    type: "permission_request",
    handle,
    request: { requestId: "req-curl", toolUseId: "tool-curl", toolName: "Bash", input: { command: "curl https://x" }, raw: {} },
  });
  await supervisor.poll();
  assert.equal(responded[0]?.behavior, "allow");
  assert.equal(notified.length, 0);

  capturedListener?.({
    type: "permission_request",
    handle,
    request: { requestId: "req-push", toolUseId: "tool-push", toolName: "Bash", input: { command: "git push origin main" }, raw: {} },
  });
  await supervisor.poll();
  assert.equal(responded[1]?.behavior, "deny");
  assert.match(String(responded[1]?.message ?? ""), /denied by supervisor policy/u);
  assert.equal(notified.length, 0);
});

test("decision-worker permission authority forwards everything", async () => {
  const handle: WorkerHandle = { id: "decision-worker-only-permission-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  let capturedListener: WorkerStartInput["eventListener"];
  const responded: Array<{ requestId: string; behavior: string; message?: string }> = [];
  const notified: WorkerEvent[] = [];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
    respondPermission: async (_handle, requestId, _toolUseId, decision) => { responded.push({ requestId, ...decision }); },
  };
  const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "decision-worker-only permission fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, permissionAuthority: "decision-worker" } },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: (event) => { notified.push(event); }, close: async () => {} }),
  });
  capturedListener?.({
    type: "permission_request",
    handle,
    request: { requestId: "req-ls", toolUseId: "tool-ls", toolName: "Bash", input: { command: "ls" }, raw: {} },
  });
  await supervisor.poll();
  assert.equal(responded.length, 0);
  assert.equal(notified.length, 1);
});

test("worker usage is recorded and the cost budget parks the candidate", async () => {
  const handle: WorkerHandle = { id: "usage-budget-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let running = true;
  let capturedListener: WorkerStartInput["eventListener"];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const events = new FlakyEventLog("never-fail");
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "usage budget fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, maxWorkerCostUsd: 1 } },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  capturedListener?.({
    type: "turn_completed",
    handle,
    result: { total_cost_usd: 0.4, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, num_turns: 3 },
    sequence: 1,
  });
  await supervisor.poll();
  assert.ok(events.events.some((event) => event.type === "worker_usage"));
  assert.equal(supervisor.usage.workerCostUsd, 0.4);

  capturedListener?.({
    type: "turn_completed",
    handle,
    result: { total_cost_usd: 1.2, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, num_turns: 4 },
    sequence: 2,
  });
  await supervisor.poll();
  const parked = events.events.find((event) => event.type === "candidate_parked");
  assert.ok(parked);
  assert.match(String(parked?.data?.reason ?? ""), /budget/u);
  assert.equal(supervisor.state, "blocked");
});

test("Claude's own budget stop parks with a clear reason", async () => {
  const handle: WorkerHandle = { id: "claude-budget-stop-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let running = true;
  let capturedListener: WorkerStartInput["eventListener"];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { running = false; },
    killProcessGroup: async () => { running = false; },
    resumeSession: async () => handle,
  };
  const events = new FlakyEventLog("never-fail");
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "claude budget stop fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  capturedListener?.({
    type: "turn_completed",
    handle,
    result: { subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 5 },
    sequence: 1,
  });
  await supervisor.poll();
  const parked = events.events.find((event) => event.type === "candidate_parked");
  assert.ok(parked);
  assert.match(String(parked?.data?.reason ?? ""), /max-budget-usd/u);
});

test("Pi usage samples accumulate", async () => {
  const handle: WorkerHandle = { id: "pi-usage-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
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
  const events = new FlakyEventLog("never-fail");
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  let capturedOnUsage: ((sample: PiUsageSample) => void) | undefined;
  await supervisor.start({
    task: "pi usage fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: (options) => { capturedOnUsage = options.onUsage; return { start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }; },
  });
  capturedOnUsage?.({ role: "decision", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, costUsd: 0.01 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(supervisor.usage.decision.calls, 1);
  assert.ok(events.events.some((event) => event.type === "pi_usage"));
});

test("a Reviewer report's usage is recorded when it never called onUsage", async () => {
  const handle: WorkerHandle = { id: "review-usage-fallback-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let running = true;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "jsonl", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: true, persistentSession: true }),
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
  const supervisor = new Supervisor(adapter, undefined, {
    reviewer: {
      // This fake never calls ReviewInput.onUsage; the Supervisor must fall
      // back to the raw (pre-normalization) report's own `usage` field.
      review: async () => ({
        verdict: "pass" as const,
        summary: "verified",
        findings: [],
        round: 0,
        checkedAt: new Date().toISOString(),
        usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600, costUsd: 0.02 },
      }),
    },
  });
  await supervisor.start({
    task: "reviewer usage fallback fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1 }, acceptance: [{ id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.exit(0)"], required: true, timeoutMs: 1_000 }] },
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} }),
  });
  await supervisor.poll();
  const result = await supervisor.verify();
  assert.equal(result.ok, true);
  assert.equal(supervisor.usage.reviewer.calls, 1);
  assert.equal(supervisor.usage.reviewer.input, 500);
});

test("interactive pre-phase permission: policy deny is answered without the Decision Worker", async () => {
  const handle: WorkerHandle = { id: "pre-deny-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  const responded: Array<{ requestId: string; behavior: string; message?: string; defer?: boolean }> = [];
  const notified: WorkerEvent[] = [];
  let capturedListener: WorkerStartInput["eventListener"];
  let capturedInput: WorkerStartInput | undefined;
  const fakeHookSource: import("./hooks/types.ts").HookEventSource = { subscribe: async () => async () => {} };
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; capturedInput = input; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    release: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
    respondPermission: async (_handle, requestId, _toolUseId, decision) => { responded.push({ requestId, ...decision }); },
  };
  const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "interactive pre-deny fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    interactive: true,
    hookSource: fakeHookSource,
    hookSettingsPath: "/tmp/pi-cs-fixture-settings.json",
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: (event) => { notified.push(event); }, close: async () => {} }),
  });
  assert.equal(capturedInput?.interactive, true);
  assert.equal(capturedInput?.hookSource, fakeHookSource);
  assert.equal(capturedInput?.hookSettingsPath, "/tmp/pi-cs-fixture-settings.json");
  capturedListener?.({
    type: "permission_request",
    handle,
    request: { requestId: "req-push", toolUseId: "tool-push", toolName: "Bash", input: { command: "git push origin main" }, raw: {}, phase: "pre" },
  });
  await supervisor.poll();
  assert.equal(responded.length, 1);
  assert.equal(responded[0]?.behavior, "deny");
  assert.match(String(responded[0]?.message ?? ""), /denied by supervisor policy/u);
  assert.equal(notified.length, 0);
});

test("interactive pre-phase permission: a routine tool call defers to Claude's own permission mode", async () => {
  const handle: WorkerHandle = { id: "pre-defer-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  const responded: Array<{ requestId: string; behavior: string; message?: string; defer?: boolean }> = [];
  const notified: WorkerEvent[] = [];
  let capturedListener: WorkerStartInput["eventListener"];
  const events = new FlakyEventLog("never-fail");
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    release: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
    respondPermission: async (_handle, requestId, _toolUseId, decision) => { responded.push({ requestId, ...decision }); },
  };
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "interactive pre-defer fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    interactive: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: (event) => { notified.push(event); }, close: async () => {} }),
  });
  capturedListener?.({
    type: "permission_request",
    handle,
    request: { requestId: "req-ls", toolUseId: "tool-ls", toolName: "Bash", input: { command: "ls -la" }, raw: {}, phase: "pre" },
  });
  await supervisor.poll();
  assert.equal(responded.length, 1);
  assert.equal(responded[0]?.behavior, "allow");
  assert.equal(responded[0]?.defer, true);
  assert.equal(notified.length, 0);
  assert.ok(!events.events.some((event) => event.type === "permission_decision"));
});

test("interactive pre-phase AskUserQuestion is forwarded to the Decision Worker and answered as a permission deny", async () => {
  const handle: WorkerHandle = { id: "pre-askuserquestion-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  const responded: Array<{ requestId: string; behavior: string; message?: string; defer?: boolean }> = [];
  const notified: WorkerEvent[] = [];
  let capturedListener: WorkerStartInput["eventListener"];
  let onAction: Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    release: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
    respondPermission: async (_handle, requestId, _toolUseId, decision) => { responded.push({ requestId, ...decision }); },
  };
  const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "interactive AskUserQuestion fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    interactive: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: (options) => {
      onAction = options.onAction;
      return { start: async () => {}, updateContext: () => {}, notify: (event) => { notified.push(event); }, close: async () => {} };
    },
  });
  const questionEvent: WorkerEvent = {
    type: "permission_request",
    handle,
    request: { requestId: "req-ask", toolUseId: "tool-ask", toolName: "AskUserQuestion", input: { question: "Which option?" }, raw: {}, phase: "pre" },
  };
  capturedListener?.(questionEvent);
  await supervisor.poll();
  assert.equal(notified.length, 1);
  assert.equal(notified[0], questionEvent);
  assert.equal(responded.length, 0);
  await onAction?.({ action: "deny_permission", requestId: "req-ask", toolUseId: "tool-ask", reason: "Option B because it matches the existing pattern" }, questionEvent);
  assert.equal(responded.length, 1);
  assert.equal(responded[0]?.behavior, "deny");
  assert.match(String(responded[0]?.message ?? ""), /^Supervisor answer: Option B because/u);
});

test("interactive prompt-phase permission keeps today's hybrid policy/decision-worker behavior", async () => {
  const handle: WorkerHandle = { id: "prompt-phase-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  let capturedListener: WorkerStartInput["eventListener"];
  const responded: Array<{ requestId: string; behavior: string; message?: string }> = [];
  const notified: WorkerEvent[] = [];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    release: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
    respondPermission: async (_handle, requestId, _toolUseId, decision) => { responded.push({ requestId, ...decision }); },
  };
  const supervisor = new Supervisor(adapter, undefined, { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "interactive prompt-phase fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    interactive: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: () => ({ start: async () => {}, updateContext: () => {}, notify: (event) => { notified.push(event); }, close: async () => {} }),
  });
  capturedListener?.({
    type: "permission_request",
    handle,
    request: { requestId: "req-routine", toolUseId: "tool-routine", toolName: "Bash", input: { command: "ls -la" }, raw: {}, phase: "prompt" },
  });
  await supervisor.poll();
  assert.equal(responded[0]?.behavior, "allow");
  assert.equal(notified.length, 0);

  capturedListener?.({
    type: "permission_request",
    handle,
    request: { requestId: "req-curl", toolUseId: "tool-curl", toolName: "Bash", input: { command: "curl https://x" }, raw: {}, phase: "prompt" },
  });
  await supervisor.poll();
  assert.equal(responded.length, 1);
  assert.equal(notified.length, 1);
});

test("human_input pauses automation, is withheld from the Decision Worker's next turn, and replays after resume-auto", async () => {
  const handle: WorkerHandle = { id: "human-input-worker", startedAt: new Date().toISOString(), cwd: process.cwd(), ownership: "owned" };
  const running = true;
  let capturedListener: WorkerStartInput["eventListener"];
  const notified: WorkerEvent[] = [];
  const replays: WorkerEvent[] = [];
  const events = new FlakyEventLog("never-fail");
  const humanNotices: Array<{ reason: string; source?: string }> = [];
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true }),
    start: async (input) => { capturedListener = input.eventListener; return handle; },
    getStatus: async () => ({ handle, running, activeRequests: 0, processGroupCleaned: !running }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
    release: async () => {},
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
    respondPermission: async (_handle, requestId, _toolUseId, decision) => { permissionReplies.push({ requestId, decision }); },
  };
  const permissionReplies: Array<{ requestId: string; decision: { behavior: string; defer?: boolean } }> = [];
  const supervisor = new Supervisor(adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
    reviewer: automaticReviewer(),
    onHumanRequired: (notice) => { humanNotices.push(notice); },
  });
  await supervisor.start({
    task: "human input fixture",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    interactive: true,
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    spec: automaticSpec(),
    decisionWorkerFactory: () => ({
      start: async () => {},
      updateContext: () => {},
      notify: (event) => { notified.push(event); },
      replay: (event) => { replays.push(event); },
      close: async () => {},
    }),
  });
  capturedListener?.({ type: "human_input", handle, text: "hello from a human" });
  await supervisor.poll();
  assert.equal(supervisor.humanRequired, true);
  assert.ok(events.events.some((event) => event.type === "human_takeover" && (event.data as { source?: string } | undefined)?.source === "worker_prompt"));
  assert.ok(events.events.some((event) => event.type === "human_input"));
  assert.equal(humanNotices.length, 1);

  // While the human drives, Claude's own permission prompt is theirs to answer:
  // a prompt-phase request is deferred immediately instead of pending for
  // /supervise approve and freezing the TUI.
  capturedListener?.({ type: "permission_request", handle, request: { requestId: "p1", toolUseId: "t1", toolName: "Bash", input: { command: "npm test" }, raw: {}, phase: "prompt" } });
  await supervisor.poll();
  assert.deepEqual(permissionReplies.at(-1), { requestId: "p1", decision: { behavior: "allow", defer: true } });
  assert.equal(notified.length, 0);
  // Likewise a question: the human at the keyboard answers it in the TUI.
  capturedListener?.({ type: "permission_request", handle, request: { requestId: "q1", toolUseId: "t2", toolName: "AskUserQuestion", input: { questions: [] }, raw: {}, phase: "pre" } });
  await supervisor.poll();
  assert.deepEqual(permissionReplies.at(-1), { requestId: "q1", decision: { behavior: "allow", defer: true } });
  assert.equal(notified.length, 0);
  assert.equal(humanNotices[0]?.source, "worker_prompt");

  const turnEvent: WorkerEvent = { type: "turn_completed", handle, result: {}, sequence: 1 };
  capturedListener?.(turnEvent);
  await supervisor.poll();
  assert.equal(notified.length, 0);

  await supervisor.resumeAutomation();
  assert.equal(replays.length, 1);
  assert.equal(replays[0], turnEvent);
});

test("a completed interactive task with keepWorkerOnCompletion releases instead of stopping the Worker", async () => {
  const handle: WorkerHandle = { id: "keep-open-worker", startedAt: new Date().toISOString(), cwd: "/tmp", ownership: "owned" };
  let stopCalls = 0;
  let releaseCalls = 0;
  let killProcessGroupCalls = 0;
  let released = false;
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true, repairableSession: true }),
    start: async () => handle,
    getStatus: async () => ({ handle, running: !released, activeRequests: 0, processGroupCleaned: released }),
    readOutput: async () => [],
    send: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => { stopCalls += 1; },
    release: async () => { releaseCalls += 1; released = true; },
    killProcessGroup: async () => { killProcessGroupCalls += 1; },
    resumeSession: async () => handle,
  };
  let candidateNotice: { reason: string } | undefined;
  const supervisor = new Supervisor(adapter, undefined, { onCandidate: (notice) => { candidateNotice = notice; } });
  await supervisor.start({
    task: "keep open fixture",
    cwd: "/tmp",
    command: "fixture",
    deadlineMs: 0,
    noOutputTimeoutMs: 0,
    interactive: true,
    keepWorkerOnCompletion: true,
  });
  await supervisor.poll();
  const result = await supervisor.verify({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(result.ok, true);
  assert.equal(supervisor.state, "completed");
  assert.equal(releaseCalls, 1);
  assert.equal(stopCalls, 0);
  assert.equal(supervisor.released, true);
  assert.match(candidateNotice?.reason ?? "", /interactive session stays open/u);

  // An explicit stop on the kept-open session must actually close it: the
  // adapter's own stop() would just re-release an already-released record
  // (see #stopInternal's "completed" branch), so this goes through
  // killProcessGroup instead.
  await supervisor.stop("operator requested close");
  assert.equal(killProcessGroupCalls, 1);
  assert.equal(stopCalls, 0);
});

/**
 * A persistent, adopted-style Worker whose stop is a release: the process
 * keeps running after the Supervisor lets go, exactly like an adopted
 * interactive tmux session. `activeRequests` models whether Claude is mid-turn.
 */
function closeOutFixture(cwd: string) {
  const handle: WorkerHandle = { id: "close-out-worker", startedAt: new Date().toISOString(), cwd, ownership: "adopted" };
  const state = { activeRequests: 0, released: false, stopReasons: [] as string[], sent: [] as string[], replays: [] as WorkerEvent[], contexts: [] as Array<Record<string, unknown>>, listener: undefined as WorkerStartInput["eventListener"], onAction: undefined as Parameters<DecisionWorkerFactory>[0]["onAction"] | undefined };
  const adapter: WorkerAdapter = {
    capabilities: () => ({ transport: "tmux", interactiveInput: true, pause: true, resumeSession: false, processGroupControl: false, persistentSession: true, repairableSession: true }),
    start: async (input) => { state.listener = input.eventListener; return handle; },
    // Like the tmux adapter's release of an adopted session: the Worker keeps
    // running, and the Supervisor's own cleanup obligations are what "cleaned" reports.
    getStatus: async () => ({ handle, running: true, activeRequests: state.activeRequests, processGroupCleaned: state.released }),
    readOutput: async () => [],
    send: async (_handle, message) => { state.sent.push(message); },
    pause: async () => {},
    resume: async () => {},
    stop: async (_handle, reason) => { state.released = true; state.stopReasons.push(reason); },
    release: async (_handle, reason) => { state.released = true; state.stopReasons.push(`release: ${reason}`); },
    killProcessGroup: async () => {},
    resumeSession: async () => handle,
  };
  const decisionWorkerFactory: DecisionWorkerFactory = (options) => {
    state.onAction = options.onAction;
    return {
      start: async () => {},
      updateContext: (patch) => { state.contexts.push(patch as Record<string, unknown>); },
      notify: () => {},
      replay: (event) => { state.replays.push(event); },
      close: async () => {},
    };
  };
  const turn = (sequence: number): WorkerEvent => ({ type: "turn_completed", handle, result: { subtype: "stop", result: "background agents still running" }, sequence });
  return { handle, adapter, state, decisionWorkerFactory, turn };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("the deadline opens a close-out that verifies an idle Worker instead of stopping it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-close-out-idle-"));
  try {
    await initializeGitRepository(cwd, "worker/close-out-idle");
    const fixture = closeOutFixture(cwd);
    const events = new FlakyEventLog("never-fail");
    const candidates: string[] = [];
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
      reviewer: automaticReviewer(),
      onCandidate: (notice) => { candidates.push(notice.status); },
    });
    await supervisor.start({
      task: "close out at the deadline",
      cwd,
      command: "claude",
      automation: true,
      spec: automaticSpec(),
      // The deadline lands a couple of seconds from now; the close-out window is wide open.
      startedAt: new Date(Date.now() - 500).toISOString(),
      deadlineMs: 3_000,
      deadlineGraceMs: 60_000,
      deadlineWarningMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    assert.equal(supervisor.deadline?.closeOut, false);
    assert.ok((supervisor.deadline?.remainingMs ?? 0) > 0);
    const turn = fixture.turn(1);
    fixture.state.listener?.(turn);
    await supervisor.poll();
    assert.equal(supervisor.state, "waiting");
    // Decided before the deadline: an ordinary wait, nothing is sent.
    await fixture.state.onAction?.({ action: "wait", reason: "agents are still running" }, turn);
    assert.equal(supervisor.state, "waiting");
    await waitFor(() => supervisor.state === "completed");
    assert.equal(supervisor.deadline?.closeOut, true);
    assert.equal(supervisor.deadline?.remainingMs, 0);
    const types = events.events.map((event) => event.type);
    assert.ok(types.includes("worker_deadline_reached"));
    assert.ok(types.includes("deadline_close_out"));
    assert.ok(types.includes("verification_passed"));
    assert.ok(!types.includes("worker_watchdog_timeout"), "the close-out must not be reported as a watchdog stop");
    assert.ok(!types.includes("candidate_failed"));
    assert.deepEqual(candidates, ["ready"]);
    const reached = events.events.find((event) => event.type === "worker_deadline_reached");
    assert.equal(reached?.data?.deadlineMs, 3_000);
    assert.equal(reached?.data?.graceMs, 60_000);
    assert.equal(fixture.state.stopReasons.at(-1), "verification passed");
    assert.ok(fixture.state.contexts.some((patch) => (patch.deadline as { closeOut?: boolean } | undefined)?.closeOut === true), "the Decision Worker sees the close-out");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a wait decision during close-out is overridden into verification, and never underneath an in-flight decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-close-out-wait-"));
  try {
    await initializeGitRepository(cwd, "worker/close-out-wait");
    const fixture = closeOutFixture(cwd);
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "close out overrides wait",
      cwd,
      command: "claude",
      automation: true,
      spec: automaticSpec(),
      startedAt: new Date(Date.now() - 3_000).toISOString(),
      deadlineMs: 2_000,
      deadlineGraceMs: 60_000,
      deadlineWarningMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    const turn = fixture.turn(1);
    fixture.state.listener?.(turn);
    await supervisor.poll();
    assert.equal(supervisor.state, "waiting");
    // The decision for this turn is still in flight: the watchdog records the
    // deadline but leaves the next step to that decision.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(supervisor.state, "waiting");
    assert.ok(events.events.some((event) => event.type === "worker_deadline_reached"));
    assert.ok(!events.events.some((event) => event.type === "deadline_close_out"));
    await fixture.state.onAction?.({ action: "wait", reason: "still waiting on agents" }, turn);
    assert.equal(supervisor.state, "completed");
    const overridden = events.events.find((event) => event.type === "decision_overridden");
    assert.equal(overridden?.data?.action, "wait");
    assert.equal(overridden?.data?.override, "verify");
    assert.ok(events.events.some((event) => event.type === "verification_passed"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a busy Worker keeps its turn at the deadline and its completed turn is decided under close-out", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-close-out-busy-"));
  try {
    await initializeGitRepository(cwd, "worker/close-out-busy");
    const fixture = closeOutFixture(cwd);
    fixture.state.activeRequests = 1;
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "close out waits for the turn",
      cwd,
      command: "claude",
      automation: true,
      spec: automaticSpec(),
      startedAt: new Date(Date.now() - 3_000).toISOString(),
      deadlineMs: 2_000,
      deadlineGraceMs: 60_000,
      deadlineWarningMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    await waitFor(() => events.events.some((event) => event.type === "worker_deadline_reached"));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(supervisor.state, "running", "a Worker mid-turn is neither verified nor stopped inside the grace window");
    assert.ok(!events.events.some((event) => event.type === "deadline_close_out"));
    assert.deepEqual(fixture.state.sent, []);
    // The turn ends: the Decision Worker is asked with closeOut in its context.
    fixture.state.activeRequests = 0;
    const turn = fixture.turn(1);
    fixture.state.listener?.(turn);
    await supervisor.poll();
    assert.equal(supervisor.state, "waiting");
    const latest = fixture.state.contexts.at(-1)?.deadline as { closeOut?: boolean; closeOutRemainingMs?: number } | undefined;
    assert.equal(latest?.closeOut, true);
    assert.ok((latest?.closeOutRemainingMs ?? 0) > 0);
    await fixture.state.onAction?.({ action: "verify", reason: "the Worker reported completion" }, turn);
    assert.equal(supervisor.state, "completed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a manual task is stopped at its deadline whatever the grace: the close-out belongs to automation", async () => {
  for (const graceMs of [60_000, 0]) {
    const fixture = closeOutFixture("/tmp");
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1]);
    await supervisor.start({
      task: "manual hard stop",
      cwd: "/tmp",
      command: "fixture",
      startedAt: new Date(Date.now() - 1_500).toISOString(),
      deadlineMs: 1_000,
      deadlineGraceMs: graceMs,
      deadlineWarningMs: 0,
      noOutputTimeoutMs: 0,
    });
    assert.equal(supervisor.deadline?.graceMs, 0, `grace=${graceMs}: a manual task reports no close-out window`);
    await waitFor(() => supervisor.state === "stopped");
    const timeout = events.events.find((event) => event.type === "worker_watchdog_timeout");
    assert.equal(timeout?.data?.reason, "worker deadline exceeded", `grace=${graceMs}`);
    assert.ok(!events.events.some((event) => event.type === "worker_deadline_reached"), `grace=${graceMs}: no close-out is announced for a manual task`);
  }
});

test("an automatic Worker is stopped outright once the close-out window has also elapsed, with the deadline notice first", async () => {
  const fixture = closeOutFixture(process.cwd());
  fixture.state.activeRequests = 1;
  const events = new FlakyEventLog("never-fail");
  const candidates: string[] = [];
  const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer(), onCandidate: (notice) => { candidates.push(notice.status); } });
  await supervisor.start({
    task: "hard stop after grace",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    spec: automaticSpec(),
    startedAt: new Date(Date.now() - 2_500).toISOString(),
    deadlineMs: 1_000,
    deadlineGraceMs: 1_000,
    deadlineWarningMs: 0,
    noOutputTimeoutMs: 0,
    decisionWorkerFactory: fixture.decisionWorkerFactory,
  });
  await waitFor(() => supervisor.state === "stopped");
  const types = events.events.map((event) => event.type);
  assert.ok(types.indexOf("worker_deadline_reached") >= 0 && types.indexOf("worker_deadline_reached") < types.indexOf("worker_watchdog_timeout"), "the deadline notice precedes the outright stop");
  assert.equal(events.events.find((event) => event.type === "worker_watchdog_timeout")?.data?.reason, "worker deadline exceeded");
  assert.deepEqual(candidates, ["failed"]);
});

test("with no grace window a wait right after the deadline is not turned into a close-out; the stop follows", async () => {
  const fixture = closeOutFixture(process.cwd());
  const events = new FlakyEventLog("never-fail");
  const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "no grace, no close-out",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    spec: automaticSpec(),
    startedAt: new Date(Date.now() - 1_200).toISOString(),
    deadlineMs: 1_000,
    deadlineGraceMs: 0,
    deadlineWarningMs: 0,
    noOutputTimeoutMs: 0,
    decisionWorkerFactory: fixture.decisionWorkerFactory,
  });
  assert.equal(supervisor.deadline?.closeOut, false, "no grace window means no close-out state, even past the deadline");
  const turn = fixture.turn(1);
  fixture.state.listener?.(turn);
  await supervisor.poll();
  await fixture.state.onAction?.({ action: "wait", reason: "agents still running" }, turn);
  assert.ok(!events.events.some((event) => event.type === "decision_overridden"));
  assert.ok(!events.events.some((event) => event.type === "worker_deadline_reached"));
  await waitFor(() => supervisor.state === "stopped");
  assert.ok(!events.events.some((event) => event.type === "acceptance_started"));
});

test("a repair round that cannot finish inside the close-out window blocks the candidate instead", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-close-out-repair-"));
  try {
    await initializeGitRepository(cwd, "worker/close-out-repair");
    const fixture = closeOutFixture(cwd);
    const events = new FlakyEventLog("never-fail");
    const candidates: string[] = [];
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer(), onCandidate: (notice) => { candidates.push(notice.status); } });
    await supervisor.start({
      task: "close out with a failing check",
      cwd,
      command: "claude",
      automation: true,
      spec: {
        ...automaticSpec(),
        maxRepairRounds: 3,
        acceptance: [{ id: "always-fails", name: "always fails", command: process.execPath, args: ["-e", "process.exit(1)"], required: true, timeoutMs: 30_000 }],
      },
      // Deadline passed 1.5s ago with a 30s window: under a minute left, so no repair can fit.
      startedAt: new Date(Date.now() - 2_500).toISOString(),
      deadlineMs: 1_000,
      deadlineGraceMs: 30_000,
      deadlineWarningMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    await waitFor(() => supervisor.state === "blocked");
    const blocked = events.events.find((event) => event.type === "candidate_blocked");
    assert.match(String(blocked?.data?.reason), /close-out window is exhausted/u);
    assert.ok(!events.events.some((event) => event.type === "repair_requested"));
    assert.deepEqual(fixture.state.sent, []);
    assert.deepEqual(candidates, ["blocked"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a Decision Worker without replay support never leaves a decision pending, so the close-out still verifies", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-close-out-noreplay-"));
  try {
    await initializeGitRepository(cwd, "worker/close-out-noreplay");
    const fixture = closeOutFixture(cwd);
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "no replay",
      cwd,
      command: "claude",
      automation: true,
      spec: automaticSpec(),
      startedAt: new Date(Date.now() - 500).toISOString(),
      deadlineMs: 3_000,
      deadlineGraceMs: 60_000,
      deadlineWarningMs: 0,
      noOutputTimeoutMs: 0,
      waitTimeoutMs: 60,
      decisionWorkerFactory: (options) => {
        fixture.state.onAction = options.onAction;
        return { start: async () => {}, updateContext: () => {}, notify: () => {}, close: async () => {} };
      },
    });
    const turn = fixture.turn(1);
    fixture.state.listener?.(turn);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "wait", reason: "agents still running" }, turn);
    // The wait timer fires and finds nothing to replay to; that must not mark a decision pending.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await waitFor(() => supervisor.state === "completed");
    assert.ok(events.events.some((event) => event.type === "deadline_close_out"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a warning that fires while a decision is in flight is re-asked when that decision turns out to be a wait", async () => {
  const fixture = closeOutFixture(process.cwd());
  const events = new FlakyEventLog("never-fail");
  const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "owed warning",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    spec: automaticSpec(),
    startedAt: new Date(Date.now() - 1_500).toISOString(),
    deadlineMs: 60_000,
    deadlineGraceMs: 60_000,
    deadlineWarningMs: 59_000,
    noOutputTimeoutMs: 0,
    waitTimeoutMs: 0,
    decisionWorkerFactory: fixture.decisionWorkerFactory,
  });
  const turn = fixture.turn(1);
  fixture.state.listener?.(turn);
  await supervisor.poll();
  // The decision for this turn is in flight when the warning fires: no replay yet.
  await waitFor(() => events.events.some((event) => event.type === "worker_deadline_approaching"));
  assert.equal(fixture.state.replays.length, 0);
  // Its answer was made from a pre-warning clock: a wait is re-asked once with the current one.
  await fixture.state.onAction?.({ action: "wait", reason: "made without the clock" }, turn);
  assert.equal(fixture.state.replays.length, 1);
  assert.equal(supervisor.state, "waiting");
  // The re-asked wait is honored as an ordinary wait.
  await fixture.state.onAction?.({ action: "wait", reason: "still waiting, knowingly" }, turn);
  assert.equal(fixture.state.replays.length, 1);
  await supervisor.stop("test complete");
});

test("the deadline warning re-asks the Decision Worker while the Worker idles under a wait, and a repeated wait re-arms", async () => {
  const fixture = closeOutFixture(process.cwd());
  const events = new FlakyEventLog("never-fail");
  const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
  await supervisor.start({
    task: "deadline warning",
    cwd: process.cwd(),
    command: "claude",
    automation: true,
    spec: automaticSpec(),
    startedAt: new Date(Date.now() - 1_500).toISOString(),
    deadlineMs: 60_000,
    deadlineGraceMs: 60_000,
    deadlineWarningMs: 59_000,
    noOutputTimeoutMs: 0,
    waitTimeoutMs: 0,
    decisionWorkerFactory: fixture.decisionWorkerFactory,
  });
  const turn = fixture.turn(1);
  fixture.state.listener?.(turn);
  await supervisor.poll();
  await fixture.state.onAction?.({ action: "wait", reason: "agents still running" }, turn);
  await waitFor(() => fixture.state.replays.length === 1);
  const warning = events.events.find((event) => event.type === "worker_deadline_approaching");
  assert.ok(warning);
  assert.ok((warning?.data?.remainingMs as number) > 0 && (warning?.data?.remainingMs as number) <= 59_000);
  const latest = fixture.state.contexts.at(-1)?.deadline as { closeOut?: boolean; remainingMs?: number } | undefined;
  assert.equal(latest?.closeOut, false);
  assert.ok((latest?.remainingMs ?? 0) > 0);
  assert.equal(supervisor.state, "waiting", "a warning never verifies or stops anything by itself");
  // The re-asked decision may still be `wait`: it is applied again, not
  // silently deduped, so the wait timer is re-armed each time.
  await fixture.state.onAction?.({ action: "wait", reason: "still waiting" }, turn);
  assert.equal(events.events.filter((event) => event.type === "decision_made" && event.data?.action === "wait").length, 2);
  // The warning is emitted once per task.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(events.events.filter((event) => event.type === "worker_deadline_approaching").length, 1);
  assert.equal(fixture.state.replays.length, 1);
  await supervisor.stop("test complete");
});

test("an idle adopted Worker that never completed a turn is still classified and verified at the deadline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-close-out-unpolled-"));
  try {
    await initializeGitRepository(cwd, "worker/close-out-unpolled");
    const fixture = closeOutFixture(cwd);
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "close out an unpolled Worker",
      cwd,
      command: "claude",
      automation: true,
      spec: automaticSpec(),
      startedAt: new Date(Date.now() - 3_000).toISOString(),
      deadlineMs: 2_000,
      deadlineGraceMs: 60_000,
      deadlineWarningMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    // No turn, no poll: the Supervisor still believes the Worker is running.
    assert.equal(supervisor.state, "running");
    await waitFor(() => supervisor.state === "completed");
    const types = events.events.map((event) => event.type);
    assert.ok(types.includes("worker_waiting"));
    assert.ok(types.includes("deadline_close_out"));
    assert.ok(types.includes("verification_passed"));
    assert.ok(!types.includes("worker_watchdog_timeout"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("extendedDeadlineMs grants the extension from now for an expired task and from the deadline otherwise", () => {
  const hour = 60 * 60_000;
  // Expired 5 hours in: 30 more minutes means 30 minutes from now.
  assert.equal(extendedDeadlineMs(4 * hour, 5 * hour, 30 * 60_000), 5 * hour + 30 * 60_000);
  // Extending by 0 puts the deadline at the present, i.e. the close-out opens at once.
  assert.equal(extendedDeadlineMs(4 * hour, 5 * hour, 0), 5 * hour);
  // Not yet expired: the extension is added to the remaining budget.
  assert.equal(extendedDeadlineMs(4 * hour, 1 * hour, 30 * 60_000), 4 * hour + 30 * 60_000);
  assert.equal(extendedDeadlineMs(4 * hour, 1 * hour, -5), 4 * hour);
});

/**
 * A repository with a real `origin` the test controls, so the publish phase can
 * be confirmed the way the Supervisor confirms it: by reading the remote.
 */
async function repositoryWithRemote(prefix: string, branch: string): Promise<{ cwd: string; remote: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const remote = await mkdtemp(join(tmpdir(), `${prefix}remote-`));
  await execFileAsync("git", ["init", "--bare", "-q"], { cwd: remote });
  await initializeGitRepository(cwd, branch);
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd });
  return { cwd, remote, cleanup: async () => { await rm(cwd, { recursive: true, force: true }); await rm(remote, { recursive: true, force: true }); } };
}

test("with push authority the verified candidate is handed back to publish, and completion confirms the remote", async () => {
  const branch = "worker/publish-ok";
  const repo = await repositoryWithRemote("pi-claude-supervisor-publish-", branch);
  try {
    const fixture = closeOutFixture(repo.cwd);
    const events = new FlakyEventLog("never-fail");
    const candidates: Array<{ status: string; reason: string }> = [];
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
      reviewer: automaticReviewer(),
      onCandidate: (notice) => { candidates.push({ status: notice.status, reason: notice.reason }); },
    });
    // The Worker "publishes" when the Supervisor asks: the instruction arriving
    // is what triggers the real push here, in the one shape the grant admits.
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo.cwd })).stdout.trim();
    fixture.adapter.send = async (_handle, message) => {
      fixture.state.sent.push(message);
      if (message.includes("Publish it")) await execFileAsync("git", ["-C", repo.cwd, "-c", "core.hooksPath=/dev/null", "push", "origin", `${head}:refs/heads/${branch}`], { cwd: repo.cwd });
    };
    await supervisor.start({
      task: "publish the verified candidate",
      cwd: repo.cwd,
      command: "claude",
      automation: true,
      spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, remoteAuthority: "push" } },
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });

    const first = fixture.turn(1);
    fixture.state.listener?.(first);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "work is done" }, first);

    // Verification passed, so the task is not finished: the Worker was asked to publish.
    const requested = events.events.find((event) => event.type === "publish_requested");
    assert.ok(requested, "the verified candidate is handed back to publish");
    assert.equal(requested?.data?.branch, branch);
    assert.equal(supervisor.state, "running");
    const expected = publishCommand({ authority: "push", remoteName: "origin", branch, head, cwd: repo.cwd });
    assert.ok(fixture.state.sent.some((message) => message.includes(`\`${expected}\``)),
      "the instruction spells out the one shape the grant admits: an absolute -C, the hooks path pinned, and the verified commit as the refspec source");
    assert.match(expected, /^git -C \S+ -c core\.hooksPath=\/dev\/null push origin '[0-9a-f]{40}:refs\/heads\/worker\/publish-ok'$/u);
    assert.equal(candidates.length, 0, "no candidate is announced until the publish settles");

    // The publish turn comes back; acceptance is not re-run on the unchanged tree.
    const acceptanceRuns = events.events.filter((event) => event.type === "acceptance_started").length;
    const second = fixture.turn(2);
    fixture.state.listener?.(second);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "pushed" }, second);
    assert.equal(events.events.filter((event) => event.type === "acceptance_started").length, acceptanceRuns, "the unchanged tree is not re-verified");

    assert.equal(supervisor.state, "completed");
    assert.ok(events.events.some((event) => event.type === "publish_confirmed"));
    assert.deepEqual(candidates.map((candidate) => candidate.status), ["ready"]);
    // The remote really carries the verified commit.
    const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", "origin", branch], { cwd: repo.cwd });
    assert.match(stdout, new RegExp(`^${head}\\s+refs/heads/${branch}`, "u"));
  } finally {
    await repo.cleanup();
  }
});

test("a commit made during the publish turn cannot ride the grant: the verified commit is published and the notice says which tree is where", async () => {
  const branch = "worker/publish-then-commit";
  const repo = await repositoryWithRemote("pi-claude-supervisor-publish-drift-", branch);
  try {
    const fixture = closeOutFixture(repo.cwd);
    const events = new FlakyEventLog("never-fail");
    const candidates: Array<{ status: string; reason: string; prUrl?: string }> = [];
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
      reviewer: automaticReviewer(),
      onCandidate: (notice) => { candidates.push({ status: notice.status, reason: notice.reason, ...(notice.prUrl ? { prUrl: notice.prUrl } : {}) }); },
    });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo.cwd })).stdout.trim();
    // The Worker pushes the granted commit, then — against the instruction —
    // commits again. The refspec names the commit, so the second one stays local.
    fixture.adapter.send = async (_handle, message) => {
      fixture.state.sent.push(message);
      if (!message.includes("Publish it")) return;
      await execFileAsync("git", ["-C", repo.cwd, "-c", "core.hooksPath=/dev/null", "push", "origin", `${head}:refs/heads/${branch}`], { cwd: repo.cwd });
      await writeFile(join(repo.cwd, "after-publish.txt"), "unverified\n");
      await execFileAsync("git", ["add", "after-publish.txt"], { cwd: repo.cwd });
      await execFileAsync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "after publish"], { cwd: repo.cwd });
    };
    await supervisor.start({
      task: "publish, then keep committing",
      cwd: repo.cwd,
      command: "claude",
      automation: true,
      spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, remoteAuthority: "push" } },
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    const first = fixture.turn(1);
    fixture.state.listener?.(first);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "done" }, first);
    assert.ok(events.events.some((event) => event.type === "publish_requested"));
    const acceptanceRuns = events.events.filter((event) => event.type === "acceptance_started").length;

    const second = fixture.turn(2);
    fixture.state.listener?.(second);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "pushed and tidied up" }, second);

    // The changed tree earned its own verification and the grant was not reissued.
    assert.equal(events.events.filter((event) => event.type === "acceptance_started").length, acceptanceRuns + 1, "the changed tree is re-verified");
    assert.equal(events.events.filter((event) => event.type === "publish_requested").length, 1, "the grant is one-shot");
    const abandoned = events.events.find((event) => event.type === "publish_abandoned");
    assert.equal(abandoned?.data?.published, true, "the confirmation found the verified commit on the remote");
    assert.equal(supervisor.state, "completed");
    assert.match(String(candidates.at(-1)?.reason), /was published to origin\/worker\/publish-then-commit/u);
    assert.match(String(candidates.at(-1)?.reason), /new tree is not published/u);
    assert.equal(candidates.at(-1)?.prUrl, undefined, "the notice's pull request field means this candidate, not the one that left");
    // The remote holds exactly the verified commit, not the later one.
    const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", "origin", branch], { cwd: repo.cwd });
    assert.match(stdout, new RegExp(`^${head}\\s+refs/heads/${branch}`, "u"));
    const local = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo.cwd })).stdout.trim();
    assert.notEqual(local, head);
  } finally {
    await repo.cleanup();
  }
});

test("an edit left uncommitted during the publish turn is a changed candidate, not an unchanged one", async () => {
  const branch = "worker/publish-then-edit";
  const repo = await repositoryWithRemote("pi-claude-supervisor-publish-edit-", branch);
  try {
    const fixture = closeOutFixture(repo.cwd);
    const events = new FlakyEventLog("never-fail");
    const candidates: Array<{ status: string; reason: string }> = [];
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
      reviewer: automaticReviewer(),
      onCandidate: (notice) => { candidates.push({ status: notice.status, reason: notice.reason }); },
    });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo.cwd })).stdout.trim();
    fixture.adapter.send = async (_handle, message) => {
      fixture.state.sent.push(message);
      if (!message.includes("Publish it")) return;
      await execFileAsync("git", ["-C", repo.cwd, "-c", "core.hooksPath=/dev/null", "push", "origin", `${head}:refs/heads/${branch}`], { cwd: repo.cwd });
      // HEAD stays put, but the tree no longer matches the pushed commit.
      await writeFile(join(repo.cwd, "after-publish.txt"), "uncommitted\n");
    };
    await supervisor.start({
      task: "publish, then edit without committing",
      cwd: repo.cwd,
      command: "claude",
      automation: true,
      spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, remoteAuthority: "push" } },
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    const first = fixture.turn(1);
    fixture.state.listener?.(first);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "done" }, first);
    const acceptanceRuns = events.events.filter((event) => event.type === "acceptance_started").length;
    const second = fixture.turn(2);
    fixture.state.listener?.(second);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "pushed" }, second);

    assert.equal(events.events.filter((event) => event.type === "acceptance_started").length, acceptanceRuns + 1, "the changed tree is re-verified, HEAD unchanged or not");
    const abandoned = events.events.find((event) => event.type === "publish_abandoned");
    assert.equal(abandoned?.data?.published, true);
    assert.match(String(abandoned?.data?.reason), /left with uncommitted changes/u);
    assert.equal(supervisor.state, "completed");
    assert.match(String(candidates.at(-1)?.reason), /not published: .*left with uncommitted changes.*new tree is not published/u);
  } finally {
    await repo.cleanup();
  }
});

test("a publish the Worker never performed blocks the candidate instead of completing it", async () => {
  const branch = "worker/publish-missing";
  const repo = await repositoryWithRemote("pi-claude-supervisor-publish-miss-", branch);
  try {
    const fixture = closeOutFixture(repo.cwd);
    const events = new FlakyEventLog("never-fail");
    const candidates: Array<{ status: string; reason: string; deliverable: boolean }> = [];
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
      reviewer: automaticReviewer(),
      onCandidate: (notice) => { candidates.push({ status: notice.status, reason: notice.reason, deliverable: notice.deliverable }); },
    });
    await supervisor.start({
      task: "publish is requested but not done",
      cwd: repo.cwd,
      command: "claude",
      automation: true,
      spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, remoteAuthority: "push" } },
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    const first = fixture.turn(1);
    fixture.state.listener?.(first);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "done" }, first);
    assert.ok(events.events.some((event) => event.type === "publish_requested"));

    // The Worker reports back without having pushed anything.
    const second = fixture.turn(2);
    fixture.state.listener?.(second);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "claims to have pushed" }, second);

    assert.equal(supervisor.state, "blocked");
    assert.ok(events.events.some((event) => event.type === "publish_unconfirmed"));
    assert.equal(candidates.at(-1)?.status, "blocked");
    assert.match(String(candidates.at(-1)?.reason), /does not point at/u);
    // `status` is the task outcome; `deliverable` is the candidate: it passed
    // acceptance and review and is intact on its branch, so the operator can
    // publish it by hand — which is exactly what the notice is for.
    assert.equal(candidates.at(-1)?.deliverable, true);
  } finally {
    await repo.cleanup();
  }
});

test("a verified tree with uncommitted changes is never granted: the Worker is asked to commit, and the task ends unpublished only when no repair round is left", async () => {
  const branch = "worker/publish-dirty";
  const repo = await repositoryWithRemote("pi-claude-supervisor-publish-dirty-", branch);
  try {
    const fixture = closeOutFixture(repo.cwd);
    const events = new FlakyEventLog("never-fail");
    const candidates: Array<{ status: string; reason: string; deliverable: boolean }> = [];
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
      reviewer: automaticReviewer(),
      onCandidate: (notice) => { candidates.push({ status: notice.status, reason: notice.reason, deliverable: notice.deliverable }); },
    });
    await supervisor.start({
      task: "leave an uncommitted fix behind",
      cwd: repo.cwd,
      command: "claude",
      automation: true,
      // requireLocalCommit off is the one way a dirty tree reaches the publish
      // step at all; the grant must still refuse it.
      spec: { maxRepairRounds: 1, autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, remoteAuthority: "push" } },
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    await writeFile(join(repo.cwd, "uncommitted-fix.txt"), "the Reviewer saw this in the diff; HEAD does not have it\n");
    const first = fixture.turn(1);
    fixture.state.listener?.(first);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "done" }, first);

    // Not a dead end: the Worker is asked to commit what belongs to the candidate.
    assert.ok(!events.events.some((event) => event.type === "publish_requested"), "no grant for a tree HEAD does not represent");
    assert.equal(fixture.state.sent.length, 1);
    assert.match(fixture.state.sent[0]!, /uncommitted or untracked changes.*commit everything that belongs to the candidate/u);
    assert.equal(supervisor.state, "running");

    // The Worker comes back without committing; the one repair round is spent.
    const second = fixture.turn(2);
    fixture.state.listener?.(second);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "done again" }, second);
    assert.ok(!events.events.some((event) => event.type === "publish_requested"));
    const skipped = events.events.find((event) => event.type === "publish_skipped");
    assert.match(String(skipped?.data?.reason), /uncommitted or untracked changes.*no repair round was available/u);
    assert.equal(supervisor.state, "completed");
    assert.match(String(candidates.at(-1)?.reason), /not published: .*uncommitted or untracked/u);
    assert.equal(fixture.state.sent.length, 1, "no publish instruction was ever sent");
    const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", "origin", branch], { cwd: repo.cwd });
    assert.equal(stdout.trim(), "", "nothing reached the remote");
  } finally {
    await repo.cleanup();
  }
});

test("a remote that cannot be reached leaves the publish unconfirmed, not falsely refuted", async () => {
  const branch = "worker/publish-unreachable";
  const repo = await repositoryWithRemote("pi-claude-supervisor-publish-unreachable-", branch);
  try {
    const fixture = closeOutFixture(repo.cwd);
    const events = new FlakyEventLog("never-fail");
    const candidates: Array<{ status: string; reason: string; deliverable: boolean }> = [];
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
      reviewer: automaticReviewer(),
      onCandidate: (notice) => { candidates.push({ status: notice.status, reason: notice.reason, deliverable: notice.deliverable }); },
    });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo.cwd })).stdout.trim();
    fixture.adapter.send = async (_handle, message) => {
      fixture.state.sent.push(message);
      if (!message.includes("Publish it")) return;
      await execFileAsync("git", ["-C", repo.cwd, "-c", "core.hooksPath=/dev/null", "push", "origin", `${head}:refs/heads/${branch}`], { cwd: repo.cwd });
      // The push landed; then the remote drops off the network (here: is deleted).
      await rm(repo.remote, { recursive: true, force: true });
    };
    await supervisor.start({
      task: "publish, then lose the remote",
      cwd: repo.cwd,
      command: "claude",
      automation: true,
      spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, remoteAuthority: "push" } },
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    const first = fixture.turn(1);
    fixture.state.listener?.(first);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "done" }, first);
    assert.ok(events.events.some((event) => event.type === "publish_requested"));
    const second = fixture.turn(2);
    fixture.state.listener?.(second);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "pushed" }, second);

    assert.equal(supervisor.state, "blocked");
    const unconfirmed = events.events.find((event) => event.type === "publish_unconfirmed");
    assert.ok(unconfirmed, "the publish is unconfirmed, not refuted");
    assert.ok(typeof unconfirmed?.data?.unreachable === "string", "the event records that the remote could not be asked");
    assert.notEqual(unconfirmed?.data?.remoteChanged, true, "a remote that cannot be read was not 'repointed'");
    assert.match(String(candidates.at(-1)?.reason), /could not be reached to confirm the publish/u);
    assert.doesNotMatch(String(candidates.at(-1)?.reason), /does not point at|no longer points/u);
    assert.equal(candidates.at(-1)?.deliverable, true);
  } finally {
    await repo.cleanup();
  }
});

test("without remote authority the task still completes at the verified candidate", async () => {
  const branch = "worker/no-authority";
  const repo = await repositoryWithRemote("pi-claude-supervisor-publish-none-", branch);
  try {
    const fixture = closeOutFixture(repo.cwd);
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "no remote authority",
      cwd: repo.cwd,
      command: "claude",
      automation: true,
      spec: automaticSpec(),
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    const turn = fixture.turn(1);
    fixture.state.listener?.(turn);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "done" }, turn);
    assert.equal(supervisor.state, "completed");
    assert.ok(!events.events.some((event) => event.type === "publish_requested"));
    assert.deepEqual(fixture.state.sent, []);
  } finally {
    await repo.cleanup();
  }
});

test("the publish grant dies with its turn, so a later unverified push is refused", async () => {
  const branch = "worker/publish-oneshot";
  const repo = await repositoryWithRemote("pi-claude-supervisor-publish-oneshot-", branch);
  try {
    const fixture = closeOutFixture(repo.cwd);
    const events = new FlakyEventLog("never-fail");
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], { reviewer: automaticReviewer() });
    await supervisor.start({
      task: "the grant is one-shot",
      cwd: repo.cwd,
      command: "claude",
      automation: true,
      spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, remoteAuthority: "push" } },
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    const responded: Array<{ requestId: string; behavior: string; message?: string }> = [];
    fixture.adapter.respondPermission = async (_handle, requestId, _toolUseId, response) => { responded.push({ requestId, behavior: response.behavior, ...(response.message ? { message: response.message } : {}) }); };
    const first = fixture.turn(1);
    fixture.state.listener?.(first);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "done" }, first);
    assert.ok(events.events.some((event) => event.type === "publish_requested"));

    // The granted push, requested under the default hybrid authority, is the
    // Supervisor's own decision: answered by the policy, never escalated to a
    // Decision Worker whose standing rule is to refuse a push.
    const head = String(events.events.find((event) => event.type === "publish_requested")?.data?.head);
    const granted = { requestId: "req-granted-push", toolUseId: "tool-granted-push", toolName: "Bash", input: { command: publishCommand({ authority: "push", remoteName: "origin", branch, head, cwd: repo.cwd }) }, raw: {} };
    fixture.state.listener?.({ type: "permission_request", handle: fixture.handle, request: granted });
    await supervisor.poll();
    assert.deepEqual(responded.map((entry) => [entry.requestId, entry.behavior]), [["req-granted-push", "allow"]]);
    const decision = events.events.find((event) => event.type === "permission_decision" && event.data?.requestId === "req-granted-push");
    assert.equal(decision?.data?.actor, "policy");
    assert.equal(decision?.data?.behavior, "allow");
    // The same grant does not stretch to a differently shaped push.
    fixture.state.listener?.({ type: "permission_request", handle: fixture.handle, request: { ...granted, requestId: "req-branch-push", input: { command: `git -C ${repo.cwd} -c core.hooksPath=/dev/null push origin ${branch}` } } });
    await supervisor.poll();
    assert.equal(responded.at(-1)?.behavior, "deny");
    assert.match(String(responded.at(-1)?.message), /publish grant is live but only admits/u);

    // The publish turn ends. Whatever the Decision Worker decides next, the
    // authority is already gone — it does not wait for a `verify`.
    fixture.state.listener?.(fixture.turn(2));
    await supervisor.poll();
    assert.ok(events.events.some((event) => event.type === "publish_grant_revoked"));
    assert.equal(supervisor.deadline, undefined);
    // The very command the grant admitted a moment ago is refused now, through
    // the same permission path, not by asking the policy without a grant.
    fixture.state.listener?.({ type: "permission_request", handle: fixture.handle, request: { ...granted, requestId: "req-late-push" } });
    await supervisor.poll();
    assert.equal(responded.at(-1)?.requestId, "req-late-push");
    assert.equal(responded.at(-1)?.behavior, "deny");
    assert.match(String(responded.at(-1)?.message), /no remote repository/u);
    assert.match(String(responded.at(-1)?.message), /one-shot publish grant expired/u, "the denial says the grant is gone rather than that no authority ever existed");
  } finally {
    await repo.cleanup();
  }
});

test("a task granted remote authority never reports ready without saying the publish did not happen", async () => {
  const branch = "main";
  const repo = await repositoryWithRemote("pi-claude-supervisor-publish-skip-", branch);
  try {
    const fixture = closeOutFixture(repo.cwd);
    const events = new FlakyEventLog("never-fail");
    const candidates: Array<{ status: string; reason: string }> = [];
    const supervisor = new Supervisor(fixture.adapter, events as unknown as ConstructorParameters<typeof Supervisor>[1], {
      reviewer: automaticReviewer(),
      onCandidate: (notice) => { candidates.push({ status: notice.status, reason: notice.reason }); },
    });
    await supervisor.start({
      task: "the candidate sits on a protected branch",
      cwd: repo.cwd,
      command: "claude",
      automation: true,
      // The candidate is on `main`, which is never publishable.
      spec: { autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, remoteAuthority: "push" } },
      deadlineMs: 0,
      noOutputTimeoutMs: 0,
      decisionWorkerFactory: fixture.decisionWorkerFactory,
    });
    const turn = fixture.turn(1);
    fixture.state.listener?.(turn);
    await supervisor.poll();
    await fixture.state.onAction?.({ action: "verify", reason: "done" }, turn);

    assert.equal(supervisor.state, "completed");
    assert.ok(events.events.some((event) => event.type === "publish_skipped"));
    // Completing silently would tell the operator a PR exists when none does.
    assert.match(String(candidates.at(-1)?.reason), /not published: .*protected branch/u);
  } finally {
    await repo.cleanup();
  }
});
