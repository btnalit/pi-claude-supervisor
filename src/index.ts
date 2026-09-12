import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { EventLog } from "./events.ts";
import { ProcessWorkerAdapter } from "./worker/process-adapter.ts";
import { Supervisor } from "./supervisor.ts";
import { evaluateCommand } from "./policy.ts";
import { HumanWebhookNotifier } from "./notifications.ts";
import { loadSupervisorEnvironment } from "./config.ts";
import { DecisionSessionStore, type DecisionSessionRecord } from "./decision-session-store.ts";

/**
 * Pi Claude Supervisor.
 *
 * Each task gets an independent Supervisor and Worker process. Multiple task
 * sessions may run concurrently, but active sessions must use different
 * working directories so workers cannot silently overwrite one another.
 */
export default function piClaudeSupervisor(pi: ExtensionAPI): void {
  loadSupervisorEnvironment();
  const automation = process.env.PI_CLAUDE_SUPERVISOR_MODE === "auto" || process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION === "1";
  const adapter = new ProcessWorkerAdapter({
    // Automatic decisions require Claude's structured event stream. The pipe
    // transport remains available for manual/compatibility sessions.
    mode: automation || process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT === "jsonl" ? "claude-jsonl" : "process-pipe",
  });
  const humanWebhook = new HumanWebhookNotifier({
    url: process.env.PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL,
    format: process.env.PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_FORMAT === "wecom" ? "wecom" : "generic",
    secret: process.env.PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_SECRET,
  });
  const stateDir = process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR ?? join(homedir(), ".pi", "agent", "claude-supervisor");
  const events = new EventLog(join(stateDir, "events.jsonl"));
  const decisionStore = new DecisionSessionStore(join(stateDir, "decision-sessions"));
  const sessions = new Map<string, Supervisor>();
  const reservedCwds = new Map<string, string>();
  const pendingCwds = new Set<string>();
  const pendingStarts = new Set<Promise<void>>();
  const pendingStartSessions = new Set<Supervisor>();
  let activeTaskId: string | undefined;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  };
  const activeSessions = () => [...sessions.entries()].filter(([, session]) =>
    ["starting", "running", "waiting", "paused"].includes(session.state));
  const releaseSettledReservations = async (): Promise<void> => {
    for (const [taskId, session] of sessions) {
      if (!["completed", "stopped", "failed"].includes(session.state)) continue;
      if (!session.handle) {
        reservedCwds.delete(taskId);
        continue;
      }
      try {
        const status = await adapter.getStatus(session.handle);
        if (!status.running && status.processGroupCleaned === true && !status.cleanupError) reservedCwds.delete(taskId);
      } catch {
        // Keep the reservation when cleanup status cannot be confirmed.
      }
    }
  };
  const stopSession = async (session: Supervisor, reason: string): Promise<void> => {
    let lifecycleError: unknown;
    try {
      await session.stop(reason);
    } catch (error) {
      lifecycleError = error;
    }

    const handle = session.handle;
    if (!handle) {
      if (lifecycleError) throw lifecycleError;
      return;
    }

    const deadline = Date.now() + 5_000;
    let cleanupError: unknown;
    while (Date.now() <= deadline) {
      try {
        const status = await adapter.getStatus(handle);
        if (!status.running && status.processGroupCleaned === true) {
          if (lifecycleError) throw lifecycleError;
          return;
        }
      } catch (error) {
        cleanupError = error;
      }
      try {
        await adapter.killProcessGroup(handle, "shutdown cleanup retry");
      } catch (error) {
        cleanupError = error;
      }
      await delay(25);
    }

    if (lifecycleError) throw lifecycleError;
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error(`worker cleanup did not complete before shutdown deadline: ${handle.id}`);
  }

  pi.registerCommand("supervise", {
    description: "Manage policy-gated Claude workers and concurrent task sessions",
    handler: async (args, ctx) => {
      try {
        const tokens = args.trim() ? args.trim().split(/\s+/u) : [];
        const [operation = "status", ...rest] = tokens;
        let message = "";
        if (operation === "start") {
          const task = rest.join(" ").trim();
          if (!task) throw new Error("Usage: /supervise start <task>");
          const [command, ...workerArgs] = parseCommand(process.env.PI_CLAUDE_SUPERVISOR_WORKER ?? "claude");
          if (!command) throw new Error("PI_CLAUDE_SUPERVISOR_WORKER must contain an executable");
          const policy = evaluateCommand(command, workerArgs);
          let approval: { actor: "human"; reason: string } | undefined;
          if (policy.decision === "deny") throw new Error(`Worker command denied: ${policy.reason}`);
          if (policy.decision === "review") {
            if (!ctx.hasUI) throw new Error(`Worker command requires interactive approval: ${policy.reason}`);
            const approved = await ctx.ui.confirm(
              "Approve Claude worker command?",
              `${redactText([command, ...workerArgs].join(" "))}\n\nReason: ${redactText(policy.reason)}`,
            );
            if (!approved) throw new Error("Worker command not approved");
            approval = { actor: "human", reason: policy.reason };
          }
          if (shuttingDown) throw new Error("Pi session is shutting down");
          const cwdKey = await canonicalCwd(ctx.cwd);
          await releaseSettledReservations();
          if (shuttingDown) throw new Error("Pi session is shutting down");
          const reservedPaths = [...pendingCwds, ...reservedCwds.values()];
          if (reservedPaths.some((reserved) => pathsOverlap(reserved, cwdKey))) {
            throw new Error("An active, starting, or unreaped worker uses an overlapping cwd; use a separate worktree for concurrent sessions");
          }
          pendingCwds.add(cwdKey);
          const session = new Supervisor(adapter, events, {
            onHumanRequired: async (notice) => {
              if (ctx.hasUI) ctx.ui.notify(`Claude Worker needs human intervention: ${notice.reason}`, "warning");
              if (humanWebhook.enabled) {
                try {
                  await humanWebhook.notify(notice);
                } catch (error) {
                  console.error(`pi-claude-supervisor human webhook failed: ${error instanceof Error ? error.message : String(error)}`);
                }
              } else {
                console.error(`pi-claude-supervisor human intervention required: ${notice.reason}`);
              }
            },
          });
          pendingStartSessions.add(session);
          const startOperation = (async () => {
            try {
              const handle = await session.start({
                task,
                cwd: ctx.cwd,
                command,
                args: workerArgs,
                env: selectedWorkerEnvironment(),
                approval,
                automation,
                decisionSessionDir: decisionStore.directory,
                onDecisionSessionReady: (info) => decisionStore.save({
                  taskId: info.taskId,
                  task: info.task,
                  cwd: info.cwd,
                  command,
                  args: workerArgs,
                  approval,
                  decisionSessionFile: info.sessionFile,
                  maxTurns: info.maxTurns,
                  deadlineMs: info.deadlineMs,
                  noOutputTimeoutMs: info.noOutputTimeoutMs,
                  startedAt: info.startedAt,
                  turn: info.turn,
                  state: "active",
                }),
                onDecisionSessionProgress: (info) => decisionStore.update(info.taskId, { turn: info.turn }),
                onDecisionSessionClosed: (taskId) => decisionStore.close(taskId),
              });
              const taskId = session.task?.taskId;
              if (!taskId) throw new Error("worker started without a task id");
              // Register immediately after spawn so shutdown can retry cleanup if
              // the first stop attempt fails.
              sessions.set(taskId, session);
              reservedCwds.set(taskId, cwdKey);
              activeTaskId = taskId;
              if (shuttingDown) {
                try {
                  await stopSession(session, "Pi session shutdown during worker start");
                  sessions.delete(taskId);
                  reservedCwds.delete(taskId);
                } finally {
                  if (session.state !== "stopped") {
                    // Keep the session registered for the shutdown retry below.
                    sessions.set(taskId, session);
                    reservedCwds.set(taskId, cwdKey);
                  }
                }
                throw new Error("Pi session shut down during worker start");
              }
              message = `Worker started: task=${taskId} worker=${handle.id} (pid ${handle.pid ?? "unknown"}); transport=${adapter.capabilities().transport}`;
            } catch (error) {
              // Register failed starts before the promise settles, so shutdown
              // cannot snapshot sessions before a returned handle is retained.
              const failedTaskId = session.task?.taskId;
              if (failedTaskId && session.handle) {
                sessions.set(failedTaskId, session);
                reservedCwds.set(failedTaskId, cwdKey);
                activeTaskId = failedTaskId;
              }
              throw error;
            }
          })();
          pendingStarts.add(startOperation);
          try {
            await startOperation;
          } catch (error) {
            // Preserve a failed startup in the registry when the adapter
            // returned a handle but lifecycle/event setup failed.
            const failedTaskId = session.task?.taskId;
            if (failedTaskId && session.handle) {
              sessions.set(failedTaskId, session);
              reservedCwds.set(failedTaskId, cwdKey);
              activeTaskId = failedTaskId;
            }
            throw error;
          } finally {
            pendingStarts.delete(startOperation);
            pendingStartSessions.delete(session);
            pendingCwds.delete(cwdKey);
          }
        } else if (operation === "recover") {
          const taskId = rest[0];
          if (!taskId) throw new Error("Usage: /supervise recover <task-id>");
          if (shuttingDown) throw new Error("Pi session is shutting down");
          if (sessions.has(taskId)) throw new Error(`Task session is already loaded: ${taskId}`);
          const record = await decisionStore.load(taskId);
          if (!record || record.state !== "active") throw new Error(`No recoverable Decision Worker session: ${taskId}`);
          if (!await decisionStore.sessionFileExists(taskId)) throw new Error(`Decision Worker session file is missing or unsafe: ${taskId}`);
          if (record.maxTurns > 0 && record.turn >= record.maxTurns) throw new Error(`Cannot recover task after its turn budget was exhausted: ${taskId}`);
          if (record.deadlineMs > 0 && Date.now() - Date.parse(record.startedAt) >= record.deadlineMs) throw new Error(`Cannot recover task after its wall-clock deadline: ${taskId}`);
          const cwdKey = await canonicalCwd(record.cwd);
          await releaseSettledReservations();
          if (shuttingDown) throw new Error("Pi session is shutting down");
          const reservedPaths = [...pendingCwds, ...reservedCwds.values()];
          if (reservedPaths.some((reserved) => pathsOverlap(reserved, cwdKey))) {
            throw new Error("An active, starting, or unreaped worker uses an overlapping cwd; use a separate worktree for recovery");
          }
          const policy = evaluateCommand(record.command, record.args);
          if (policy.decision === "deny") throw new Error(`Worker command denied: ${policy.reason}`);
          let approval = record.approval;
          if (policy.decision === "review" && !approval) {
            if (!ctx.hasUI) throw new Error(`Worker command requires interactive approval: ${policy.reason}`);
            const approved = await ctx.ui.confirm(
              "Approve recovered Claude worker command?",
              `${redactText([record.command, ...record.args].join(" "))}\n\nReason: ${redactText(policy.reason)}`,
            );
            if (!approved) throw new Error("Worker command not approved");
            approval = { actor: "human", reason: policy.reason };
          }
          pendingCwds.add(cwdKey);
          const session = new Supervisor(adapter, events, {
            onHumanRequired: async (notice) => {
              if (ctx.hasUI) ctx.ui.notify(`Claude Worker needs human intervention: ${notice.reason}`, "warning");
              if (humanWebhook.enabled) {
                try { await humanWebhook.notify(notice); }
                catch (error) { console.error(`pi-claude-supervisor human webhook failed: ${error instanceof Error ? error.message : String(error)}`); }
              } else {
                console.error(`pi-claude-supervisor human intervention required: ${notice.reason}`);
              }
            },
          });
          pendingStartSessions.add(session);
          const recoveryOperation = (async () => {
            try {
              const handle = await session.start({
                taskId: record.taskId,
                // Claude session resume is not supported by this adapter. Start
                // idle so recovery never replays the original task; the operator
                // must explicitly send the next instruction.
                task: record.task,
                initialInput: "",
                cwd: record.cwd,
                command: record.command,
                args: record.args,
                env: selectedWorkerEnvironment(),
                approval,
                automation: true,
                maxTurns: record.maxTurns,
                deadlineMs: record.deadlineMs,
                noOutputTimeoutMs: record.noOutputTimeoutMs,
                startedAt: record.startedAt,
                initialTurn: record.turn,
                decisionSessionFile: record.decisionSessionFile,
                decisionSessionDir: decisionStore.directory,
                onDecisionSessionReady: (info) => decisionStore.save({
                  taskId: info.taskId,
                  task: info.task,
                  cwd: info.cwd,
                  command: record.command,
                  args: record.args,
                  approval,
                  decisionSessionFile: info.sessionFile,
                  maxTurns: info.maxTurns,
                  deadlineMs: info.deadlineMs,
                  noOutputTimeoutMs: info.noOutputTimeoutMs,
                  startedAt: info.startedAt,
                  turn: info.turn,
                  state: "active",
                }),
                onDecisionSessionProgress: (info) => decisionStore.update(info.taskId, { turn: info.turn }),
                onDecisionSessionClosed: (closedTaskId) => decisionStore.close(closedTaskId),
              });
              sessions.set(record.taskId, session);
              reservedCwds.set(record.taskId, cwdKey);
              activeTaskId = record.taskId;
              await session.takeover();
              if (shuttingDown) {
                await stopSession(session, "Pi session shutdown during recovery");
                throw new Error("Pi session shut down during recovery");
              }
              message = `Worker recovered idle: task=${record.taskId} worker=${handle.id}; original task was not replayed; send an explicit continuation, then use resume-auto`;
            } catch (error) {
              if (session.handle) {
                sessions.set(record.taskId, session);
                reservedCwds.set(record.taskId, cwdKey);
                activeTaskId = record.taskId;
              }
              throw error;
            }
          })();
          pendingStarts.add(recoveryOperation);
          try {
            await recoveryOperation;
          } finally {
            pendingStarts.delete(recoveryOperation);
            pendingStartSessions.delete(session);
            pendingCwds.delete(cwdKey);
          }
        } else if (operation === "sessions") {
          const recoverable = await decisionStore.list({ activeOnly: true });
          message = formatSessions(sessions, recoverable);
        } else if (operation === "status") {
          const { session, sessionId } = resolveSession(sessions, activeTaskId, rest, true);
          message = session
            ? `task=${sessionId} state=${session.state} worker=${session.handle?.id ?? "none"}`
            : formatSessions(sessions, await decisionStore.list({ activeOnly: true }));
        } else if (operation === "capabilities") {
          message = JSON.stringify(adapter.capabilities(), null, 2);
        } else if (operation === "poll" && rest[0] === "all") {
          const reports = await Promise.all(activeSessions().map(async ([taskId, session]) => {
            const result = await session.poll();
            return `task=${taskId} ${formatStatus(result.status)}${result.output.length ? `\n${result.output.map((chunk) => `[${chunk.stream}] ${chunk.text}`).join("")}` : ""}`;
          }));
          message = reports.join("\n\n") || "No active sessions.";
        } else {
          const strictSelector = ["poll", "pause", "resume", "verify", "approve", "takeover", "resume-auto"].includes(operation);
          const { session, sessionId, remaining } = resolveSession(sessions, activeTaskId, rest, strictSelector);
          if (!session || !sessionId) throw new Error("No active task session. Use /supervise start <task>");
          activeTaskId = sessionId;
          if (operation === "poll") {
            const result = await session.poll();
            message = `${formatStatus(result.status)}\n${result.output.map((chunk) => `[${chunk.stream}] ${chunk.text}`).join("")}`.trim();
          } else if (operation === "send") {
            const text = remaining.join(" ").trim();
            if (!text) throw new Error("Usage: /supervise send [taskId] <message>");
            await session.send(text); message = `Message sent to ${sessionId}.`;
          } else if (operation === "pause") {
            await session.pause(); message = `Worker paused: ${sessionId}.`;
          } else if (operation === "resume") {
            await session.resume(); message = `Worker resumed: ${sessionId}.`;
          } else if (operation === "stop") {
            await session.stop(remaining.join(" ") || "human requested stop"); message = `Worker stopped: ${sessionId}.`;
          } else if (operation === "verify") {
            const result = await session.verify();
            message = `${result.ok ? "Verification passed" : "Verification failed"}: ${result.command}\n${result.output}`.trim();
          } else if (operation === "approve") {
            const behavior = remaining[0];
            if (behavior !== "allow" && behavior !== "deny") throw new Error("Usage: /supervise approve [taskId] <allow|deny> [requestId]");
            await session.approvePermission(behavior, remaining[1]);
            message = `Permission ${behavior} decision sent to ${sessionId}.`;
          } else if (operation === "takeover") {
            await session.takeover(); message = `Human takeover enabled: ${sessionId}.`;
          } else if (operation === "resume-auto") {
            await session.resumeAutomation(); message = `Automatic decisions resumed: ${sessionId}.`;
          } else {
            throw new Error("Usage: /supervise start|recover|sessions|status|poll [all|taskId]|send [taskId]|pause [taskId]|resume [taskId]|stop [taskId]|verify [taskId]|approve [taskId] <allow|deny>|takeover [taskId]|resume-auto [taskId]|capabilities");
          }
        }
        notify(ctx, message);
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  const shutdown = (exitCode?: number): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      const pending = [...pendingStarts];
      await Promise.race([Promise.allSettled(pending), delay(5_000)]);
      if (pendingStarts.size > 0) {
        await Promise.allSettled([...pendingStartSessions].map((session) => session.abortStart("Pi session shutdown during startup")));
        await Promise.race([Promise.allSettled([...pendingStarts]), delay(5_000)]);
      }
      const results = await Promise.allSettled([...sessions.values()].map((session) => stopSession(session, "Pi session shutdown")));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        for (const failure of failures) console.error(`pi-claude-supervisor shutdown cleanup failed: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`);
        if (exitCode === undefined) process.exitCode = 1;
      }
      if (exitCode !== undefined) process.exitCode = exitCode;
    })();
    return shutdownPromise;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    void shutdown().finally(() => process.exit(signal === "SIGTERM" ? 143 : 130));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  pi.on("session_shutdown", async () => {
    await shutdown();
  });
}

function resolveSession(
  sessions: Map<string, Supervisor>,
  activeTaskId: string | undefined,
  requestedArgs: string[],
  strictSelector = false,
): { session?: Supervisor; sessionId?: string; remaining: string[] } {
  const requestedId = requestedArgs[0];
  if (requestedId && sessions.has(requestedId)) return { session: sessions.get(requestedId), sessionId: requestedId, remaining: requestedArgs.slice(1) };
  if (requestedId && (strictSelector || looksLikeTaskId(requestedId))) {
    throw new Error(`Unknown task session: ${requestedId}`);
  }
  if (activeTaskId) return { session: sessions.get(activeTaskId), sessionId: activeTaskId, remaining: requestedArgs };
  return { remaining: requestedArgs };
}

function looksLikeTaskId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function canonicalCwd(cwd: string): Promise<string> {
  return realpath(cwd);
}

function pathsOverlap(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" || (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative));
}

function formatSessions(sessions: Map<string, Supervisor>, recoverable: DecisionSessionRecord[] = []): string {
  const active = [...sessions.entries()]
    .map(([taskId, session]) => `${taskId} state=${session.state} cwd=${session.task?.cwd ?? "-"} worker=${session.handle?.id ?? "-"}`);
  const pending = recoverable
    .filter((record) => !sessions.has(record.taskId))
    .map((record) => `${record.taskId} state=recoverable cwd=${record.cwd} worker=-`);
  return [...active, ...pending].join("\n") || "No task sessions.";
}

function selectedWorkerEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const names = (process.env.PI_CLAUDE_SUPERVISOR_WORKER_ENV ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
}

function parseCommand(value: string): string[] {
  const parts = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  return parts.map((part) => part.replace(/^("|')|("|')$/gu, ""));
}

function formatStatus(status: Awaited<ReturnType<ProcessWorkerAdapter["getStatus"]>>): string {
  return `running=${status.running} active=${status.activeRequests ?? "unknown"} lastInput=${status.lastInputAt ?? "-"} exit=${status.exitCode ?? "-"} signal=${status.signal ?? "-"} reason=${status.exitReason ?? "-"} cleanup=${status.processGroupCleaned ?? "unknown"}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactText(value: string): string {
  return value
    .replace(/\b(sk-ant-[A-Za-z0-9_-]+)\b/gu, "[REDACTED]")
    .replace(/\b(Bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/(--?(?:token|api[-_]?key|secret|password|authorization)(?:=|\s+))[^\s]+/giu, "$1[REDACTED]");
}
