import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventLog, type SupervisorEvent } from "./events.ts";
import { SupervisorStateMachine } from "./state.ts";
import { evaluatePermission } from "./policy.ts";
import { PiDecisionWorker, type DecisionAction } from "./decision-worker.ts";
import { verify, type VerificationCommand } from "./verifier.ts";
import { redactSensitive } from "./redaction.ts";
import type {
  TaskContext,
  VerificationResult,
  WorkerAdapter,
  WorkerHandle,
  WorkerEvent,
  WorkerOutputChunk,
  WorkerPermissionRequest,
  WorkerStartInput,
  WorkerStatus,
} from "./types.ts";

export interface DecisionSessionReadyInfo {
  taskId: string;
  task: string;
  cwd: string;
  sessionFile: string;
  sessionId: string;
  restored: boolean;
  maxTurns: number;
  deadlineMs: number;
  noOutputTimeoutMs: number;
  startedAt: string;
  turn: number;
}

export interface SupervisorStartOptions {
  /** Reuse an existing task id when explicitly recovering after a Pi restart. */
  taskId?: string;
  task: string;
  /** Override the first worker message; recovery uses an empty message to avoid replay. */
  initialInput?: string;
  cwd: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  maxTurns?: number;
  /** Maximum wall-clock runtime; defaults to 4 hours for long development tasks. Set to 0 to disable. */
  deadlineMs?: number;
  /** Maximum time without worker output; defaults to 20 minutes. Set to 0 to disable. */
  noOutputTimeoutMs?: number;
  /** Human approval for a review-level worker command. */
  approval?: { actor: "human"; reason: string };
  /** Adopt an existing tmux session instead of starting a new worker. */
  tmuxSession?: string;
  /** Optional socket path for an existing non-default tmux server. */
  tmuxSocket?: string;
  /** Do not replay the task when adopting an existing interactive session. */
  sendInitialInput?: boolean;
  /** Enable the event-driven Pi Decision Worker. Requires claude-jsonl or tmux. */
  automation?: boolean;
  /** Persistent Pi session location for the Decision Worker. */
  decisionSessionFile?: string;
  decisionSessionDir?: string;
  /** Internal recovery values; elapsed wall time remains cumulative. */
  startedAt?: string;
  initialTurn?: number;
  onDecisionSessionReady?: (info: DecisionSessionReadyInfo) => Promise<void> | void;
  onDecisionSessionProgress?: (info: { taskId: string; turn: number }) => Promise<void> | void;
  onDecisionSessionClosed?: (taskId: string) => Promise<void> | void;
  onHumanRequired?: (notice: HumanInterventionNotice) => Promise<void> | void;
}

export interface HumanInterventionNotice {
  taskId: string;
  workerId?: string;
  cwd: string;
  task: string;
  reason: string;
  question?: string;
  permission?: { requestId: string; toolUseId: string; toolName: string; input: unknown };
}

export class Supervisor {
  readonly #adapter: WorkerAdapter;
  readonly #events: EventLog;
  readonly #machine = new SupervisorStateMachine();
  #task?: TaskContext;
  #handle?: WorkerHandle;
  #lastVerification?: VerificationResult;
  #turn = 0;
  #watchdog?: NodeJS.Timeout;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #pendingEvents: Array<Omit<SupervisorEvent, "seq" | "at">> = [];
  #preemptiveStop?: Promise<void>;
  #deadlineMs = 4 * 60 * 60_000;
  #noOutputTimeoutMs = 20 * 60_000;
  #automation = false;
  #decision?: PiDecisionWorker;
  #onHumanRequired?: (notice: HumanInterventionNotice) => Promise<void> | void;
  #handledEvents = new Set<string>();
  #pendingPermissions = new Map<string, WorkerPermissionRequest>();
  #humanRequired = false;
  #onDecisionSessionProgress?: (info: { taskId: string; turn: number }) => Promise<void> | void;
  #onDecisionSessionClosed?: (taskId: string) => Promise<void> | void;

  constructor(adapter: WorkerAdapter, events = new EventLog(), hooks: { onHumanRequired?: (notice: HumanInterventionNotice) => Promise<void> | void } = {}) {
    this.#adapter = adapter;
    this.#events = events;
    this.#onHumanRequired = hooks.onHumanRequired;
  }

  get state() { return this.#machine.state; }
  get task() { return this.#task; }
  get handle() { return this.#handle; }
  get lastVerification() { return this.#lastVerification; }
  get humanRequired() { return this.#humanRequired; }

  async start(options: SupervisorStartOptions): Promise<WorkerHandle> {
    return this.#exclusive(() => this.#startInternal(options));
  }

  async #startInternal(options: SupervisorStartOptions): Promise<WorkerHandle> {
    await this.#flushPendingEvents();
    if (this.#machine.state === "completed" || this.#machine.state === "failed" || this.#machine.state === "stopped") this.#machine.reset();
    if (this.#machine.state !== "idle") throw new Error(`cannot start from ${this.#machine.state}`);
    const taskId = options.taskId ?? randomUUID();
    this.#handle = undefined;
    this.#lastVerification = undefined;
    this.#preemptiveStop = undefined;
    this.#automation = options.automation ?? false;
    this.#onDecisionSessionProgress = options.onDecisionSessionProgress;
    this.#onDecisionSessionClosed = options.onDecisionSessionClosed;
    this.#handledEvents.clear();
    this.#pendingPermissions.clear();
    this.#humanRequired = false;
    this.#task = { taskId, task: options.task, cwd: options.cwd, maxTurns: options.maxTurns ?? 100, startedAt: options.startedAt ?? new Date().toISOString() };
    this.#turn = options.initialTurn ?? 0;
    this.#deadlineMs = options.deadlineMs ?? 4 * 60 * 60_000;
    this.#noOutputTimeoutMs = options.noOutputTimeoutMs ?? 20 * 60_000;
    this.#clearWatchdog();
    this.#machine.transition("starting");
    try {
      await this.#appendEvent({
        type: "task_started",
        taskId,
        data: {
          cwd: options.cwd,
          command: options.command,
          ...(options.approval ? { approval: options.approval } : {}),
        },
      });
      if (this.#automation && !["jsonl", "tmux"].includes(this.#adapter.capabilities().transport)) {
        throw new Error("automatic supervision requires claude-jsonl or tmux transport");
      }
      if (this.#automation) {
        this.#decision = new PiDecisionWorker({
          context: { taskId, task: options.task, cwd: options.cwd, state: this.#machine.state, turn: this.#turn, maxTurns: this.#task.maxTurns },
          sessionFile: options.decisionSessionFile,
          sessionDir: options.decisionSessionDir ? join(options.decisionSessionDir, taskId) : undefined,
          onSessionReady: (info) => options.onDecisionSessionReady?.({
            taskId,
            task: options.task,
            cwd: options.cwd,
            ...info,
            maxTurns: this.#task!.maxTurns,
            deadlineMs: this.#deadlineMs,
            noOutputTimeoutMs: this.#noOutputTimeoutMs,
            startedAt: this.#task!.startedAt,
            turn: this.#turn,
          }),
          onAction: (action, event) => this.#applyDecision(action, event),
          onFailure: (event, error) => this.#decisionFailure(event, error),
          onStartupFailure: (error) => this.#decisionStartupFailure(error),
        });
        await this.#decision.start();
      }
      const input: WorkerStartInput = {
        task: options.initialInput ?? options.task,
        cwd: options.cwd,
        command: options.command,
        args: options.args,
        env: options.env,
        approval: options.approval,
        tmuxSession: options.tmuxSession,
        tmuxSocket: options.tmuxSocket,
        sendInitialInput: options.sendInitialInput,
        eventListener: (event) => this.#receiveWorkerEvent(event),
      };
      this.#handle = await this.#adapter.start(input);
      this.#machine.transition("running");
      await this.#appendEvent({ type: "worker_started", taskId, workerId: this.#handle.id, data: { pid: this.#handle.pid } });
      this.#armWatchdog();
      return this.#handle;
    } catch (error) {
      const startFailure = error as { workerHandle?: WorkerHandle; workerCleanupRequired?: boolean };
      const startFailureHandle = startFailure.workerHandle;
      if (!this.#handle && startFailureHandle && (startFailure.workerCleanupRequired || startFailureHandle.ownership || startFailureHandle.sessionName)) this.#handle = startFailureHandle;
      const handle = this.#handle;
      if (handle) {
        try {
          await this.#adapter.stop(handle, "startup failed");
        } catch {
          try { await this.#adapter.killProcessGroup(handle, "startup cleanup"); } catch { /* preserve startup error */ }
        }
      }
      if (["starting", "running"].includes(this.#machine.state)) this.#machine.transition("failed");
      try {
        await this.#appendEvent({ type: "worker_start_failed", taskId, data: { error: safeMessage(error) } });
      } catch { /* logging failure must not hide the startup failure */ }
      await this.#decision?.close().catch(() => {});
      this.#decision = undefined;
      await Promise.resolve(this.#onDecisionSessionClosed?.(taskId)).catch(() => {});
      throw error;
    }
  }

  async poll(): Promise<{ status: WorkerStatus; output: WorkerOutputChunk[] }> {
    return this.#exclusive(() => this.#pollInternal());
  }

  async #pollInternal(intentionalVerification = false): Promise<{ status: WorkerStatus; output: WorkerOutputChunk[] }> {
    await this.#flushPendingEvents();
    const taskId = this.#task?.taskId;
    const handle = this.#handle;
    if (!taskId || !handle) throw new Error("no active task");
    const output = await this.#adapter.readOutput(handle);
    const status = await this.#adapter.getStatus(handle);
    if (output.length) {
      try {
        await this.#events.append({ type: "worker_output", taskId, workerId: handle.id, data: { chunks: output } });
      } catch (error) {
        if (this.#adapter.restoreOutput) {
          try { await this.#adapter.restoreOutput(handle, output); } catch { /* preserve append failure */ }
        }
        throw error;
      }
    }
    if (status.running && status.activeRequests === 0 && this.#machine.state === "running") {
      this.#machine.transition("waiting");
      await this.#appendEvent({ type: "worker_waiting", taskId, workerId: handle.id });
    }
    if (!status.running && ["running", "waiting", "paused"].includes(this.#machine.state)) {
      this.#clearWatchdog();
      const cleanupSafe = !status.cleanupError && status.processGroupCleaned === true;
      if ((status.exitReason === "completed" || intentionalVerification) && cleanupSafe) this.#machine.transition("verifying");
      else this.#machine.transition("failed");
      await this.#appendEvent({ type: "worker_exited", taskId, workerId: handle.id, data: { exitCode: status.exitCode, signal: status.signal, reason: status.exitReason, cleanupSafe, cleanupError: status.cleanupError } });
      if (this.#machine.state === "failed") {
        await this.#decision?.close().catch(() => {});
        this.#decision = undefined;
        await Promise.resolve(this.#onDecisionSessionClosed?.(taskId)).catch(() => {});
      }
    }
    return { status, output };
  }

  #receiveWorkerEvent(event: WorkerEvent): void {
    if (event.type === "output" || event.type === "jsonl") return;
    void this.#exclusive(() => this.#processWorkerEvent(event)).catch((error) => {
      void this.#appendEvent({ type: "worker_event_error", taskId: this.#task?.taskId, workerId: event.handle.id, data: { error: safeMessage(error), eventType: event.type } }).catch(() => {});
    });
  }

  async #processWorkerEvent(event: WorkerEvent): Promise<void> {
    const taskId = this.#task?.taskId;
    const handle = this.#handle;
    if (!taskId || !handle || event.handle.id !== handle.id) return;
    const key = workerEventKey(event);
    if (this.#handledEvents.has(key)) return;
    this.#handledEvents.add(key);
    if (event.type === "turn_completed" || event.type === "exited") await this.#pollInternal();
    if (event.type === "permission_request") {
      this.#pendingPermissions.set(event.request.requestId, event.request);
      await this.#appendEvent({
        type: "permission_requested",
        taskId,
        workerId: handle.id,
        data: { requestId: event.request.requestId, toolUseId: event.request.toolUseId, toolName: event.request.toolName, input: event.request.input },
      });
    }
    if (this.#decision && (event.type === "permission_request" || event.type === "turn_completed" || event.type === "exited")) {
      this.#decision.updateContext({ state: this.#machine.state, turn: this.#turn });
      this.#decision.notify(event);
    }
  }

  async #decisionStartupFailure(error: unknown): Promise<void> {
    const task = this.#task;
    if (!task) return;
    const reason = `Decision Worker API failed during initialization: ${safeMessage(error)}`;
    try {
      await this.#appendEvent({ type: "decision_worker_failed", taskId: task.taskId, data: { eventType: "startup", error: safeMessage(error) } });
    } catch (auditError) {
      console.error(`pi-claude-supervisor decision startup audit failed: ${safeMessage(auditError)}`);
    }
    const notice: HumanInterventionNotice = { taskId: task.taskId, cwd: task.cwd, task: task.task, reason };
    try {
      await this.#appendEvent({ type: "human_intervention_required", taskId: task.taskId, data: notice as unknown as Record<string, unknown> });
    } catch (auditError) {
      console.error(`pi-claude-supervisor human intervention audit failed: ${safeMessage(auditError)}`);
    }
    try {
      if (this.#onHumanRequired) await this.#onHumanRequired(notice);
      else console.error(`pi-claude-supervisor human intervention required: ${safeMessage(reason)}`);
    } catch (notifyError) {
      console.error(`pi-claude-supervisor human intervention notification failed: ${safeMessage(notifyError)}`);
    }
  }

  async #decisionFailure(event: WorkerEvent, error: unknown): Promise<void> {
    return this.#exclusive(async () => {
      let auditError: unknown;
      try {
        await this.#appendEvent({
          type: "decision_worker_failed",
          taskId: this.#task?.taskId,
          workerId: event.handle.id,
          data: { eventType: event.type, error: safeMessage(error) },
        });
      } catch (failure) {
        auditError = failure;
      }
      let noticeError: unknown;
      try {
        await this.#requestHuman(`Decision Worker API failed: ${safeMessage(error)}`, event);
      } catch (failure) {
        noticeError = failure;
      }
      if (auditError || noticeError) throw new AggregateError([auditError, noticeError].filter(Boolean), "Decision Worker failure handling failed");
    });
  }

  async #applyDecision(action: DecisionAction, event: WorkerEvent): Promise<void> {
    return this.#exclusive(async () => {
      const task = this.#task;
      const handle = this.#handle;
      if (!task || !handle || !this.#automation || this.#humanRequired) return;
      const actionKey = `${workerEventKey(event)}:${action.action}`;
      if (this.#handledEvents.has(actionKey)) return;
      this.#handledEvents.add(actionKey);
      await this.#appendEvent({ type: "decision_made", taskId: task.taskId, workerId: handle.id, data: { action: action.action, reason: action.reason, confidence: action.confidence } });
      if (action.action === "allow_permission" || action.action === "deny_permission") {
        if (event.type !== "permission_request" || !this.#adapter.respondPermission) {
          await this.#requestHuman(`Permission response is unavailable for ${event.type}`, event);
          return;
        }
        const policy = evaluatePermission(event.request.toolName, event.request.input);
        if (policy.decision === "review" && !(event.request.toolName === "AskUserQuestion" && action.action === "deny_permission")) {
          await this.#requestHuman(policy.reason, event);
          return;
        }
        const behavior = policy.decision === "deny" ? "deny" : action.action === "allow_permission" ? "allow" : "deny";
        await this.#adapter.respondPermission(handle, event.request.requestId, event.request.toolUseId, {
          behavior,
          message: behavior === "deny" ? `${policy.reason}; denied by supervisor` : undefined,
        }, behavior === "allow" ? event.request.input : undefined);
        await this.#appendEvent({ type: "permission_decision", taskId: task.taskId, workerId: handle.id, data: { requestId: event.request.requestId, toolName: event.request.toolName, behavior, policy: policy.decision } });
        return;
      }
      if (action.action === "continue" || action.action === "redirect" || action.action === "answer") {
        await this.#sendInternal(action.message);
        return;
      }
      if (action.action === "verify") {
        if (this.#machine.state === "waiting" && this.#adapter.capabilities().persistentSession) {
          this.#machine.transition("verifying");
          await this.#verifyInternal();
          return;
        }
        if (this.#machine.state === "waiting") {
          await this.#adapter.stop(handle, "Decision Worker requested verification");
          await this.#pollInternal(true);
        }
        if (this.#machine.state === "verifying") await this.#verifyInternal();
        else await this.#requestHuman(`Decision Worker requested verification from state ${this.#machine.state}`, event);
        return;
      }
      if (action.action === "ask_human") {
        await this.#requestHuman(action.reason, event, action.question);
        return;
      }
      if (action.action === "stop") {
        await this.#stopInternal(`Decision Worker: ${action.reason}`);
        return;
      }
      if (action.action === "retry") {
        await this.#requestHuman(`Retry requires a concrete corrective instruction: ${action.reason}`, event);
      }
    });
  }

  async #requestHuman(reason: string, event: WorkerEvent, question?: string): Promise<void> {
    const task = this.#task;
    const handle = this.#handle;
    if (!task) return;
    const permission = event.type === "permission_request" ? {
      requestId: event.request.requestId,
      toolUseId: event.request.toolUseId,
      toolName: event.request.toolName,
      input: event.request.input,
    } : undefined;
    this.#humanRequired = true;
    const notice: HumanInterventionNotice = { taskId: task.taskId, workerId: handle?.id, cwd: task.cwd, task: task.task, reason, question, permission };
    let logError: unknown;
    try {
      await this.#appendEvent({ type: "human_intervention_required", taskId: task.taskId, workerId: handle?.id, data: notice as unknown as Record<string, unknown> });
    } catch (error) {
      logError = error;
    }
    // Alert delivery is independent from event-log persistence: a broken audit
    // path must not suppress the operator notification.
    if (this.#onHumanRequired) await this.#onHumanRequired(notice);
    else console.error(`pi-claude-supervisor human intervention required: ${safeMessage(reason)}`);
    if (logError) throw logError;
  }

  async approvePermission(behavior: "allow" | "deny", requestId?: string): Promise<void> {
    return this.#exclusive(async () => {
      const task = this.#task;
      const handle = this.#handle;
      if (!task || !handle || !this.#adapter.respondPermission) throw new Error("permission responses are unavailable");
      const request = requestId ? this.#pendingPermissions.get(requestId) : [...this.#pendingPermissions.values()].at(-1);
      if (!request) throw new Error("no pending permission request");
      const policy = evaluatePermission(request.toolName, request.input);
      if (policy.decision === "deny" && behavior === "allow") throw new Error(`permission denied by policy: ${policy.reason}`);
      await this.#adapter.respondPermission(handle, request.requestId, request.toolUseId, { behavior: policy.decision === "deny" ? "deny" : behavior }, behavior === "allow" ? request.input : undefined);
      this.#pendingPermissions.delete(request.requestId);
      this.#humanRequired = false;
      await this.#appendEvent({ type: "permission_decision", taskId: task.taskId, workerId: handle.id, data: { requestId: request.requestId, toolName: request.toolName, behavior: policy.decision === "deny" ? "deny" : behavior, actor: "human", policy: policy.decision } });
    });
  }

  async takeover(): Promise<void> {
    return this.#exclusive(async () => {
      this.#humanRequired = true;
      await this.#appendEvent({ type: "human_takeover", taskId: this.#task?.taskId, workerId: this.#handle?.id });
    });
  }

  async resumeAutomation(): Promise<void> {
    return this.#exclusive(async () => {
      if (!this.#automation) throw new Error("automatic mode is not enabled");
      this.#humanRequired = false;
      await this.#appendEvent({ type: "automation_resumed", taskId: this.#task?.taskId, workerId: this.#handle?.id });
    });
  }

  async send(message: string): Promise<void> {
    return this.#exclusive(() => this.#sendInternal(message));
  }

  async #sendInternal(message: string): Promise<void> {
    await this.#flushPendingEvents();
    const taskId = this.#task?.taskId;
    const handle = this.#handle;
    if (!taskId || !handle) throw new Error("no active task");
    if (!["running", "waiting"].includes(this.#machine.state)) throw new Error(`cannot send from ${this.#machine.state}`);
    const status = await this.#adapter.getStatus(handle);
    if (status.activeRequests !== undefined && status.activeRequests > 0) {
      throw new Error(this.#adapter.capabilities().transport === "jsonl"
        ? "worker has an active JSONL request; poll until its result before sending the next turn"
        : "worker has an active turn; wait until its interactive prompt or structured result is ready before sending another turn");
    }
    if (status.activeRequests === 0 && this.#machine.state === "running") {
      this.#machine.transition("waiting");
      await this.#appendEvent({ type: "worker_waiting", taskId, workerId: handle.id });
    }
    if (++this.#turn > (this.#task?.maxTurns ?? 100)) throw new Error("supervisor turn budget exhausted");
    await this.#adapter.send(handle, message, `${taskId}:turn:${this.#turn}`);
    if (this.#machine.state === "waiting") this.#machine.transition("running");
    await this.#appendEvent({ type: "worker_message_sent", taskId, workerId: handle.id, idempotencyKey: `${taskId}:turn:${this.#turn}`, data: { message } });
    await Promise.resolve(this.#onDecisionSessionProgress?.({ taskId, turn: this.#turn })).catch(() => {});
  }

  async pause(): Promise<void> {
    return this.#exclusive(() => this.#pauseInternal());
  }

  async #pauseInternal(): Promise<void> {
    await this.#flushPendingEvents();
    if (!this.#handle || this.#machine.state !== "running") throw new Error("worker is not running");
    await this.#adapter.pause(this.#handle);
    this.#machine.transition("paused");
    await this.#appendEvent({ type: "worker_paused", taskId: this.#task?.taskId, workerId: this.#handle.id });
  }

  async resume(): Promise<void> {
    return this.#exclusive(() => this.#resumeInternal());
  }

  async #resumeInternal(): Promise<void> {
    await this.#flushPendingEvents();
    if (!this.#handle || this.#machine.state !== "paused") throw new Error("worker is not paused");
    await this.#adapter.resume(this.#handle);
    this.#machine.transition("running");
    await this.#appendEvent({ type: "worker_resumed", taskId: this.#task?.taskId, workerId: this.#handle.id });
  }

  async abortStart(reason = "startup aborted"): Promise<void> {
    // This path intentionally bypasses #exclusive(): start() may be blocked in
    // a Decision Worker model call and shutdown must still dispose that session.
    let cleanupError: unknown;
    const abort = this.#adapter.abortStart?.(reason);
    if (abort) {
      try { await abort; }
      catch (error) { cleanupError = error; }
    }
    await this.#decision?.close().catch(() => {});
    this.#decision = undefined;
    if (this.#handle) {
      try { await this.#adapter.stop(this.#handle, reason); }
      catch (error) { cleanupError ??= error; }
    }
    if (cleanupError) throw cleanupError;
  }

  async release(reason = "Pi session disconnected"): Promise<void> {
    const handle = this.#handle;
    const preemptiveRelease = handle
      ? this.#adapter.release
        ? this.#adapter.release(handle, reason)
        : this.#adapter.stop(handle, reason)
      : this.#adapter.abortStart?.(reason) ?? Promise.resolve();
    await this.#decision?.close().catch(() => {});
    this.#decision = undefined;
    await withTimeout(this.#exclusive(async () => {
      this.#clearWatchdog();
      await preemptiveRelease;
      if (handle) await this.#appendEvent({ type: "worker_released", taskId: this.#task?.taskId, workerId: handle.id, data: { reason } });
    }), 15_000, "persistent worker release");
  }

  async stop(reason = "human requested stop"): Promise<void> {
    // Start the adapter stop immediately so a queued/hung send cannot delay
    // process termination. State/event changes still remain serialized below.
    if (!this.#preemptiveStop && this.#handle && ["starting", "running", "waiting", "paused"].includes(this.#machine.state)) {
      this.#preemptiveStop = this.#adapter.stop(this.#handle, reason);
      void this.#preemptiveStop.catch(() => { /* consumed by serialized stop */ });
    }
    return this.#exclusive(() => this.#stopInternal(reason));
  }

  async #stopInternal(reason: string, flushPendingEvents = true): Promise<void> {
    if (flushPendingEvents) await this.#flushPendingEvents();
    if (!this.#handle) throw new Error("no active task");
    if (this.#machine.state === "stopped") return;
    if (this.#machine.state === "failed") {
      // A failed startup or cleanup attempt may still retain a live handle.
      // Retry group termination during shutdown instead of treating the state
      // as fully reclaimed.
      if (this.#handle) await this.#adapter.stop(this.#handle, reason);
      await this.#decision?.close().catch(() => {});
      this.#decision = undefined;
      await Promise.resolve(this.#onDecisionSessionClosed?.(this.#task?.taskId ?? "")).catch(() => {});
      return;
    }
    if (this.#machine.state === "completed") {
      if (this.#handle) {
        await this.#adapter.stop(this.#handle, reason);
        await this.#drainOutputAfterStop(this.#handle);
      }
      return;
    }
    if (!["running", "waiting", "paused", "starting"].includes(this.#machine.state)) return;
    this.#clearWatchdog();
    const preemptiveStop = this.#preemptiveStop;
    this.#preemptiveStop = undefined;
    if (preemptiveStop) await preemptiveStop;
    else await this.#adapter.stop(this.#handle, reason);
    let outputError: unknown;
    try {
      await this.#drainOutputAfterStop(this.#handle);
    } catch (error) {
      outputError = error;
    }
    this.#machine.transition("stopped");
    await this.#appendEvent({ type: "worker_stopped", taskId: this.#task?.taskId, workerId: this.#handle.id, data: { reason } });
    if (outputError) throw outputError;
    await this.#decision?.close().catch(() => {});
    this.#decision = undefined;
    await Promise.resolve(this.#onDecisionSessionClosed?.(this.#task?.taskId ?? "")).catch(() => {});
  }

  async #drainOutputAfterStop(handle: WorkerHandle): Promise<void> {
    const output = await this.#adapter.readOutput(handle);
    if (!output.length) return;
    try {
      await this.#appendEvent({ type: "worker_output", taskId: this.#task?.taskId, workerId: handle.id, data: { chunks: output } });
    } catch (error) {
      if (this.#adapter.restoreOutput) await this.#adapter.restoreOutput(handle, output).catch(() => {});
      throw error;
    }
  }

  async verify(command?: VerificationCommand): Promise<VerificationResult> {
    return this.#exclusive(() => this.#verifyInternal(command));
  }

  async #verifyInternal(command?: VerificationCommand): Promise<VerificationResult> {
    await this.#flushPendingEvents();
    if (!this.#task) throw new Error("no active task");
    if (this.#machine.state === "waiting" && this.#adapter.capabilities().persistentSession) this.#machine.transition("verifying");
    if (this.#machine.state !== "verifying") throw new Error(`cannot verify from ${this.#machine.state}`);
    let result: VerificationResult;
    try {
      result = await verify(this.#task.cwd, command);
    } catch (error) {
      await this.#failVerification(error);
      throw error;
    }
    this.#clearWatchdog();
    let cleanupError: unknown;
    if (this.#handle) {
      try {
        await this.#adapter.stop(this.#handle, result.ok ? "verification passed" : "verification failed");
        await this.#drainOutputAfterStop(this.#handle);
        const cleanup = await this.#adapter.getStatus(this.#handle);
        if (cleanup.cleanupError) throw new Error(`worker cleanup failed after verification: ${cleanup.cleanupError}`);
        if (this.#handle.ownership === "owned" && (cleanup.running || cleanup.processGroupCleaned !== true)) {
          throw new Error("owned worker cleanup was not confirmed after verification");
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    this.#lastVerification = result;
    const verificationSucceeded = result.ok && !cleanupError;
    this.#machine.transition(verificationSucceeded ? "completed" : "failed");
    await this.#appendEvent({ type: verificationSucceeded ? "verification_passed" : "verification_failed", taskId: this.#task.taskId, workerId: this.#handle?.id, data: { ...result, ...(cleanupError ? { cleanupError: safeMessage(cleanupError) } : {}) } });
    await this.#decision?.close().catch(() => {});
    this.#decision = undefined;
    await Promise.resolve(this.#onDecisionSessionClosed?.(this.#task.taskId)).catch(() => {});
    if (cleanupError) throw cleanupError;
    return result;
  }

  async #failVerification(error: unknown): Promise<void> {
    this.#clearWatchdog();
    let cleanupError: unknown;
    if (this.#handle) {
      try {
        await this.#adapter.stop(this.#handle, "verification failed");
        await this.#drainOutputAfterStop(this.#handle);
      } catch (stopError) {
        cleanupError = stopError;
      }
    }
    if (this.#machine.state === "verifying") this.#machine.transition("failed");
    if (this.#task) {
      try {
        await this.#appendEvent({
          type: "verification_failed",
          taskId: this.#task.taskId,
          workerId: this.#handle?.id,
          data: { error: safeMessage(error), ...(cleanupError ? { cleanupError: safeMessage(cleanupError) } : {}) },
        });
      } catch {
        // Preserve the verifier error; the event remains a pending lifecycle record.
      }
      await this.#decision?.close().catch(() => {});
      this.#decision = undefined;
      await Promise.resolve(this.#onDecisionSessionClosed?.(this.#task.taskId)).catch(() => {});
    }
  }

  #armWatchdog(): void {
    if (this.#deadlineMs <= 0 && this.#noOutputTimeoutMs <= 0) return;
    this.#watchdog = setInterval(() => { void this.#checkWatchdog().catch(() => { /* lifecycle state is retained for the next explicit operation */ }); }, 1_000);
    this.#watchdog.unref();
  }

  #clearWatchdog(): void {
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = undefined;
  }

  async #checkWatchdog(): Promise<void> {
    return this.#exclusive(() => this.#checkWatchdogInternal());
  }

  async #checkWatchdogInternal(): Promise<void> {
    if (!this.#task || !this.#handle || !["running", "waiting", "paused"].includes(this.#machine.state)) return;
    const status = await this.#adapter.getStatus(this.#handle);
    if (!status.running) return;
    const now = Date.now();
    const taskStartedAt = Date.parse(this.#task.startedAt);
    // The deadline is cumulative across recovery, but the no-output timer
    // starts when this worker process starts. Otherwise a slow Decision Worker
    // startup or a recovered task can be stopped on its first watchdog tick
    // before this worker has had a chance to produce output.
    const workerStartedAt = Date.parse(this.#handle.startedAt);
    const lastOutputAt = status.lastOutputAt ? Date.parse(status.lastOutputAt) : workerStartedAt;
    const reason = this.#deadlineMs > 0 && now - taskStartedAt >= this.#deadlineMs
      ? "worker deadline exceeded"
      : this.#noOutputTimeoutMs > 0 && now - lastOutputAt >= this.#noOutputTimeoutMs
        ? "worker produced no output before timeout"
        : undefined;
    if (!reason) return;
    let timeoutEventError: unknown;
    try {
      await this.#appendEvent({ type: "worker_watchdog_timeout", taskId: this.#task.taskId, workerId: this.#handle.id, data: { reason } });
    } catch (error) {
      timeoutEventError = error;
    }
    // Termination must not wait for a persistently failing event log. The
    // timeout event remains queued and is retried after the adapter stop.
    await this.#stopInternal(reason, false);
    if (timeoutEventError) throw timeoutEventError;
  }

  async #appendEvent(event: Omit<SupervisorEvent, "seq" | "at">): Promise<void> {
    try {
      await this.#flushPendingEvents();
      await this.#events.append(event);
    } catch (error) {
      this.#pendingEvents.push(event);
      throw error;
    }
  }

  async #flushPendingEvents(): Promise<void> {
    while (this.#pendingEvents.length > 0) {
      const event = this.#pendingEvents[0];
      await this.#events.append(event);
      this.#pendingEvents.shift();
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#lifecycleTail = previous.then(() => gate);
    return previous.then(async () => {
      try {
        return await operation();
      } finally {
        release();
      }
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function workerEventKey(event: WorkerEvent): string {
  if (event.type === "permission_request") return `${event.handle.id}:permission:${event.request.requestId}`;
  if (event.type === "turn_completed") return `${event.handle.id}:result:${event.sequence}`;
  if (event.type === "exited") return `${event.handle.id}:exit`;
  if (event.type === "jsonl") return `${event.handle.id}:jsonl:${String(event.record.uuid ?? event.record.request_id ?? JSON.stringify(event.record))}`;
  return `${event.handle.id}:output:${event.chunk.at}:${event.chunk.text.slice(0, 80)}`;
}

function safeMessage(error: unknown): string {
  return String(redactSensitive(error instanceof Error ? error.message : String(error)));
}
