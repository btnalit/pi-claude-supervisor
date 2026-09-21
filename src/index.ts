import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { accessSync, chmodSync, constants as fsConstants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { EventLog } from "./events.ts";
import { redactSensitive } from "./redaction.ts";
import { ProcessWorkerAdapter } from "./worker/process-adapter.ts";
import { automaticWorkerEnvironment, claudeConfigDir } from "./worker/environment.ts";
import { TmuxWorkerAdapter, attachCommand, sweepDeadTmuxSockets } from "./worker/tmux-adapter.ts";
import { Supervisor, extendedDeadlineMs, type DecisionSessionClosedInfo, type HumanInterventionNotice, type SupervisorProgress, type SupervisorTokenUsage } from "./supervisor.ts";
import { evaluateCommand } from "./policy.ts";
import { HumanWebhookNotifier } from "./notifications.ts";
import { autoInstallHooks, automationEnabled, autonomyDefaults, cgroupMode, closeWorkerOnCompletion, deadlineGraceMs, deadlineMs, deadlineWarningMs, decisionCompactionTokens, decisionModel, decisionSessionRetentionDays, eventLogMaxBytes, formatDurationMs, loadSupervisorEnvironment, noOutputTimeoutMs, parseDurationMs, progressHeartbeatMs, reviewTimeoutMs, reviewerModel, supervisorTransport, tmuxMode, webhookFormat, workerAutocompactTokens, workerMcpConfigPath, workerModel } from "./config.ts";
import { DecisionSessionStore, type DecisionSessionRecord } from "./decision-session-store.ts";
import { CwdLeaseStore, type CwdLeaseHandle, leaseOwnerLive, pathsOverlap, workerIdentity } from "./cwd-lease.ts";
import { normalizeTaskSpec } from "./acceptance.ts";
import { PiReadOnlyReviewer } from "./reviewer.ts";
import { resolvePiModel } from "./pi-model.ts";
import type { PiModel } from "./decision-worker.ts";
import { HookServer, hookSocketDirectory } from "./hooks/server.ts";
import { installUserHooks, uninstallUserHooks } from "./hooks/install.ts";
import { writeHookSettingsFile } from "./hooks/settings.ts";
import { HOOK_RELAY_SCRIPT, hookRelayCommand } from "./hooks/relay.ts";
import type { TaskSpec, WorkerHandle } from "./types.ts";

/** Substring that marks a hook command entry as ours; kept in sync with src/hooks/install.ts's RELAY_MARKER. */
const RELAY_HOOK_MARKER = "/hooks/relay.js";

function claudeUserSettingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

/** `src/hooks/install.ts` does not export its relay-script writer; this mirrors it for an owned launch's static relay path. */
async function writeRelayScript(path: string): Promise<void> {
  const target = resolve(path);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (typeof process.getuid === "function" && parentInfo.uid !== process.getuid()) || (parentInfo.mode & 0o077) !== 0) throw new Error("hook relay parent is not a private directory");
  if (await realpath(parent) !== parent) throw new Error("hook relay parent contains a symlink");
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("hook relay target is not a regular file");
    if (typeof process.getuid === "function" && existing.uid !== process.getuid()) throw new Error("hook relay target is owned by another user");
    if (existing.nlink > 1) throw new Error("hook relay target is a hard-link alias");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("secure hook relay writing is unavailable");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(HOOK_RELAY_SCRIPT, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** True when the user's Claude Code settings already register our relay for at least one hook event. */
async function userHooksInstalled(settingsPath: string): Promise<boolean> {
  let raw: string;
  try {
    const bytes = await readFile(settingsPath);
    if (bytes.byteLength > 4 * 1024 * 1024) return false;
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const hooks = parsed && typeof parsed === "object" ? (parsed as { hooks?: unknown }).hooks : undefined;
  if (!hooks || typeof hooks !== "object") return false;
  return Object.values(hooks as Record<string, unknown>).some((groups) =>
    Array.isArray(groups) && groups.some((group) =>
      group && typeof group === "object" && Array.isArray((group as { hooks?: unknown }).hooks)
      && (group as { hooks: unknown[] }).hooks.some((entry) =>
        entry && typeof entry === "object" && typeof (entry as { command?: unknown }).command === "string"
        && (entry as { command: string }).command.includes(RELAY_HOOK_MARKER)
        && /(?:^|\s)(?:'[^']*\/hooks\/relay\.js'|"[^"]*\/hooks\/relay\.js"|\S*\/hooks\/relay\.js)$/u.test((entry as { command: string }).command.trim()))));
}

/**
 * Pi Claude Supervisor.
 *
 * Each task gets an independent Supervisor and Worker process. Multiple task
 * sessions may run concurrently, but active sessions must use different
 * working directories so workers cannot silently overwrite one another.
 */
export default function piClaudeSupervisor(pi: ExtensionAPI): void {
  loadSupervisorEnvironment();
  const automation = automationEnabled(process.env);
  const stateDir = process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR ?? join(homedir(), ".pi", "agent", "claude-supervisor");
  const leaseDir = process.env.PI_CLAUDE_SUPERVISOR_CWD_LEASE_DIR ?? join(homedir(), ".pi", "agent", "claude-supervisor", "cwd-leases");
  assertRuntimeDirectory(stateDir, "state");
  assertRuntimeDirectory(leaseDir, "lease");
  const transport = supervisorTransport(process.env, automation);
  const configuredCgroupMode = cgroupMode(process.env);
  if (!(["process-pipe", "jsonl", "tmux"] as string[]).includes(transport)) {
    throw new Error(`Unsupported PI_CLAUDE_SUPERVISOR_TRANSPORT: ${transport}; expected process-pipe, jsonl, or tmux`);
  }
  if (transport === "tmux" && configuredCgroupMode === "required" && !automation) {
    throw new Error("PI_CLAUDE_SUPERVISOR_CGROUP_MODE=required is unsupported with manual tmux; use automatic mode or cgroup mode auto/off");
  }
  if (automation && !["jsonl", "tmux"].includes(transport)) {
    throw new Error("automatic supervision requires PI_CLAUDE_SUPERVISOR_TRANSPORT=jsonl or tmux; process-pipe is manual-only");
  }
  const adapter = transport === "tmux"
    ? new TmuxWorkerAdapter({ stateDir, cgroupMode: automation ? "required" : configuredCgroupMode })
    : new ProcessWorkerAdapter({
      // Automatic decisions require Claude's structured event stream. The pipe
      // transport remains available for manual/compatibility sessions.
      mode: automation || transport === "jsonl" ? "claude-jsonl" : "process-pipe",
      cgroupMode: automation ? "required" : configuredCgroupMode,
    });
  const humanWebhook = new HumanWebhookNotifier({
    url: process.env.PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_URL,
    format: webhookFormat(process.env),
    secret: process.env.PI_CLAUDE_SUPERVISOR_HUMAN_WEBHOOK_SECRET,
  });
  const onHumanRequired = (ctx: ExtensionContext) => async (notice: HumanInterventionNotice): Promise<void> => {
    if (ctx.hasUI) notify(ctx, `Human required: ${notice.reason}${notice.question ? ` — ${notice.question}` : ""}${notice.attach ? ` (${notice.attach})` : ""}`, "warning");
    // The person who just typed into the session does not need a WeCom alert
    // telling them so; outbound notices are for decisions nobody is present for.
    if (humanWebhook.enabled && notice.source !== "worker_prompt") {
      try { await humanWebhook.notify(notice); }
      catch (error) { console.error(`pi-claude-supervisor human intervention webhook failed: ${redactText(error instanceof Error ? error.message : String(error))}`); }
    }
  };
  // Hook-driven interactive tmux supervision: the real Claude TUI reports its
  // events (Stop, permission prompts, AskUserQuestion, human input) through
  // Claude Code hooks relayed over a unix socket. See docs/architecture.md.
  const interactiveHooksEnabled = transport === "tmux" && tmuxMode() === "interactive";
  const hookServer = interactiveHooksEnabled ? new HookServer({ directory: hookSocketDirectory(stateDir) }) : undefined;
  const relayPath = join(hookSocketDirectory(stateDir), "relay.js");
  let hookServerReady: Promise<void> | undefined;
  // Adoption needs the relay in the user's own Claude settings (a running
  // Claude only picks hooks up from live-reloaded settings files). Installing
  // at extension load rather than at npm install time keeps it under the
  // operator's explicit transport configuration, idempotent, and reversible
  // with /supervise uninstall-hooks; the relay is a ~1 ms no-op when no
  // Supervisor is listening, so leaving it installed costs nothing.
  let hookInstallNotice: string | undefined;
  // A Worker killed with its cgroup leaves its tmux socket behind; sweep the
  // ones no server answers on so the temp directory does not fill with them.
  if (transport === "tmux") sweepDeadTmuxSockets();
  if (hookServer) {
    hookServerReady = (async () => {
      await hookServer.listen();
      await writeRelayScript(relayPath);
      if (autoInstallHooks()) {
        try {
          const installed = await installUserHooks({ stateDir, settingsPath: claudeUserSettingsPath() });
          if (installed.changed) hookInstallNotice = `Installed the Claude Code hook relay in ${installed.settingsPath} so running sessions can be adopted (PI_CLAUDE_SUPERVISOR_AUTO_INSTALL_HOOKS=0 disables this; /supervise uninstall-hooks removes it)`;
        } catch (error) {
          console.error(`pi-claude-supervisor automatic hook install failed: ${redactText(error instanceof Error ? error.message : String(error))}`);
        }
      }
    })();
    hookServerReady.catch((error) => {
      console.error(`pi-claude-supervisor hook server startup failed: ${redactText(error instanceof Error ? error.message : String(error))}`);
    });
  }
  const events = new EventLog(join(stateDir, "events.jsonl"), { maxBytes: eventLogMaxBytes() });
  const decisionStore = new DecisionSessionStore(join(stateDir, "decision-sessions"));
  const retentionDays = decisionSessionRetentionDays();
  if (retentionDays > 0) {
    void decisionStore.prune({ maxAgeMs: retentionDays * 86_400_000 }).catch((error) => {
      console.error(`pi-claude-supervisor decision session retention prune failed: ${redactText(error instanceof Error ? error.message : String(error))}`);
    });
  }
  const cwdLeaseStore = new CwdLeaseStore(leaseDir);
  const decisionModelSpec = decisionModel();
  const reviewerModelSpec = reviewerModel();
  // Resolve once and cache the promise so a misconfigured model fails closed on
  // every subsequent start/recover rather than silently falling back.
  let decisionPiModelPromise: Promise<PiModel | undefined> | undefined;
  // Resolve each model once, but forget a rejected resolution so a transient
  // failure (or a corrected env file) does not poison the rest of the process.
  const resolveDecisionPiModel = (): Promise<PiModel | undefined> => {
    if (!decisionPiModelPromise) {
      const attempt = resolvePiModel(decisionModelSpec);
      decisionPiModelPromise = attempt;
      attempt.catch(() => { if (decisionPiModelPromise === attempt) decisionPiModelPromise = undefined; });
    }
    return decisionPiModelPromise;
  };
  let reviewerPiModelPromise: Promise<PiModel | undefined> | undefined;
  const getReviewer = async (): Promise<PiReadOnlyReviewer> => {
    if (!reviewerPiModelPromise) {
      const attempt = resolvePiModel(reviewerModelSpec);
      reviewerPiModelPromise = attempt;
      attempt.catch(() => { if (reviewerPiModelPromise === attempt) reviewerPiModelPromise = undefined; });
    }
    return new PiReadOnlyReviewer({ timeoutMs: reviewTimeoutMs(), model: await reviewerPiModelPromise });
  };
  const sessions = new Map<string, Supervisor>();
  const cwdLeases = new Map<string, CwdLeaseHandle>();
  const cleanupRequiredTasks = new Set<string>();
  const reservedCwds = new Map<string, string>();
  const pendingCwds = new Set<string>();
  const pendingStarts = new Set<Promise<void>>();
  const pendingStartSessions = new Set<Supervisor>();
  const unconfirmedSweepAttempts = new Map<string, number>();
  let activeTaskId: string | undefined;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let detachedLeaseSweepTimer: NodeJS.Timeout | undefined;

  const handleDecisionSessionClosed = async (taskId: string, info: DecisionSessionClosedInfo): Promise<void> => {
    const record = await decisionStore.load(taskId);
    if (!record || record.state !== "active") return;
    const terminal = info.reason === "completed" || info.reason === "human_stop";
    if (terminal && info.cleanupConfirmed) {
      await decisionStore.close(taskId);
      return;
    }
    await decisionStore.markRecoveryInterrupted(taskId);
  };

  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(redactText(message), type);
  };
  const progress = (ctx: ExtensionContext) => (info: SupervisorProgress) => {
    notify(ctx, `Worker progress: task=${info.taskId} phase=${info.phase} ${info.message}`, info.phase === "human" || info.phase === "failed" ? "warning" : "info");
  };
  const activeSessions = () => [...sessions.entries()].filter(([, session]) =>
    ["starting", "running", "waiting", "paused"].includes(session.state));
  const tmuxModeLabel = (): string | undefined => (adapter.capabilities().transport === "tmux" ? tmuxMode() : undefined);
  const releaseLease = async (taskId: string): Promise<boolean> => {
    const lease = cwdLeases.get(taskId);
    if (!lease) return false;
    try {
      await lease.release();
      cwdLeases.delete(taskId);
      return true;
    } catch (error) {
      console.error(`pi-claude-supervisor cwd lease release failed: ${redactText(error instanceof Error ? error.message : String(error))}`);
      return false;
    }
  };
  const forgetSession = (taskId: string): void => {
    sessions.delete(taskId);
    reservedCwds.delete(taskId);
    cleanupRequiredTasks.delete(taskId);
    unconfirmedSweepAttempts.delete(taskId);
    if (activeTaskId === taskId) activeTaskId = undefined;
    if (interactiveHooksEnabled) {
      void rm(join(hookSocketDirectory(stateDir), `settings-${taskId}.json`), { force: true }).catch(() => {});
    }
  };
  const releaseSettledReservations = async (): Promise<void> => {
    for (const [taskId, session] of sessions) {
      const terminal = ["completed", "blocked", "stopped", "failed"].includes(session.state);
      const detached = session.released;
      if (!terminal && !detached) continue;
      if (!session.handle) {
        if (await releaseLease(taskId)) forgetSession(taskId);
        continue;
      }
      // A stuck session is otherwise polled at 1 Hz forever; back off to once
      // every 10 sweeps after the first 10 unconfirmed attempts.
      const attempts = unconfirmedSweepAttempts.get(taskId) ?? 0;
      if (!(attempts < 10 || attempts % 10 === 0)) {
        unconfirmedSweepAttempts.set(taskId, attempts + 1);
        continue;
      }
      try {
        const status = await adapter.getStatus(session.handle);
        const adoptedDetachConfirmed = detached
          && session.handle.ownership === "adopted"
          && !status.running;
        // A hand-back (owned interactive `release()`) leaves the Worker
        // intentionally running; `detached` is its own cleanup confirmation
        // and does not wait for `!status.running`.
        const handedBackConfirmed = status.detached === true;
        const cleanupConfirmed = status.processGroupCleaned === true || adoptedDetachConfirmed || handedBackConfirmed;
        if ((handedBackConfirmed || !status.running) && cleanupConfirmed && !status.cleanupError && (!status.cgroupError || status.cgroupRequired === false)) {
          if (await releaseLease(taskId)) forgetSession(taskId);
          else unconfirmedSweepAttempts.set(taskId, attempts + 1);
        } else {
          unconfirmedSweepAttempts.set(taskId, attempts + 1);
        }
      } catch {
        // Keep the reservation when cleanup status cannot be confirmed.
        unconfirmedSweepAttempts.set(taskId, attempts + 1);
      }
    }
  };
  detachedLeaseSweepTimer = setInterval(() => {
    void releaseSettledReservations().catch((error) => {
      console.error(`pi-claude-supervisor detached lease sweep failed: ${redactText(error instanceof Error ? error.message : String(error))}`);
    });
  }, 1_000);
  detachedLeaseSweepTimer.unref();
  const workerCleanupConfirmed = async (handle: NonNullable<Supervisor["handle"]>): Promise<boolean> => {
    try {
      const status = await adapter.getStatus(handle);
      return (status.detached === true || !status.running)
        && (status.processGroupCleaned === true || status.detached === true)
        && !status.cleanupError
        && (!status.cgroupError || status.cgroupRequired === false);
    } catch {
      return false;
    }
  };
  const stopSession = async (session: Supervisor, reason: string, releasePersistent = false, preserveDecisionSession = false): Promise<void> => {
    // Already handed back to the operator (a kept-open interactive session,
    // or an adopted session released earlier in this same shutdown pass) and
    // this call is itself a hand-back sweep (`releasePersistent`, used only
    // at shutdown): there is nothing left to stop, and polling for
    // `!running` would wait out the deadline against a Worker that is alive
    // on purpose. An explicit `/supervise stop` (`releasePersistent` false)
    // must still fall through so it can kill a kept-open session on request.
    if (session.released && releasePersistent) return;
    const handle = session.handle;
    const persistent = adapter.capabilities().persistentSession && Boolean(handle);
    const taskId = session.task?.taskId;
    const adoptedPersistent = persistent && handle?.ownership === "adopted";
    const healthyPersistent = persistent && !["failed", "completed", "stopped"].includes(session.state);
    const cleanupRequired = taskId ? cleanupRequiredTasks.has(taskId) : false;
    const markCleanupRequired = () => { if (taskId) cleanupRequiredTasks.add(taskId); };
    if (adoptedPersistent || (releasePersistent && healthyPersistent && !cleanupRequired)) {
      await session.release(reason);
      return;
    }
    if (!handle && ["failed", "completed", "blocked", "stopped"].includes(session.state)) return;
    let lifecycleError: unknown;
    try {
      await session.stop(reason, { preserveDecisionSession });
    } catch (error) {
      lifecycleError = error;
    }

    if (!handle) {
      if (lifecycleError) {
        markCleanupRequired();
        throw lifecycleError;
      }
      return;
    }

    const deadline = Date.now() + 5_000;
    let cleanupError: unknown;
    while (Date.now() <= deadline) {
      try {
        const status = await adapter.getStatus(handle);
        if (!status.running && status.processGroupCleaned === true && !status.cleanupError && (!status.cgroupError || status.cgroupRequired === false)) {
          if (lifecycleError) {
            markCleanupRequired();
            throw lifecycleError;
          }
          if (taskId) cleanupRequiredTasks.delete(taskId);
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

    markCleanupRequired();
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
        if (operation === "start" || operation === "adopt-tmux") {
          const specPath = takeOption(rest, "--spec");
          const deadlineOption = takeOption(rest, "--deadline");
          const remoteOption = takeOption(rest, "--remote");
          if (remoteOption !== undefined && !["none", "push", "pr"].includes(remoteOption)) throw new Error(`--remote expects none, push or pr: ${remoteOption}`);
          const taskDeadlineMs = deadlineOption === undefined ? deadlineMs() : parseTaskDeadline(deadlineOption);
          const tmuxSession = operation === "adopt-tmux" ? rest.shift() : undefined;
          const task = rest.join(" ").trim();
          const fileSpec = specPath ? await readTaskSpecFile(specPath, ctx.cwd) : undefined;
          const spec = fileSpec ?? { autonomy: autonomyDefaults() };
          // An explicit --remote overrides both the spec file and the env default.
          if (remoteOption) spec.autonomy = { ...spec.autonomy, remoteAuthority: remoteOption as "none" | "push" | "pr" };
          const goal = fileSpec?.goal ?? task;
          // Adopted sessions are explicit manual compatibility controls; they
          // never enter the automatic Reviewer/decision loop, even when the
          // extension is globally configured for unattended starts — except
          // in interactive tmux mode, where an adopted session reports its
          // own events through hooks exactly like an owned one.
          const taskAutomation = (operation !== "adopt-tmux" || tmuxMode() === "interactive") && automation && spec.autonomy.unattended;
          const interactive = taskAutomation && adapter.capabilities().transport === "tmux" && tmuxMode() === "interactive";
          if (!goal) throw new Error(operation === "adopt-tmux" ? "Usage: /supervise adopt-tmux [--spec <file>] [--deadline <duration>] [--remote none|push|pr] <tmux-session> <task>" : "Usage: /supervise start [--spec <file>] [--deadline <duration>] [--remote none|push|pr] <task>");
          if (operation === "adopt-tmux" && adapter.capabilities().transport !== "tmux") throw new Error("/supervise adopt-tmux requires PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux");
          if (operation === "adopt-tmux" && interactive && !await userHooksInstalled(claudeUserSettingsPath())) {
            await hookServerReady?.catch(() => {});
            if (!await userHooksInstalled(claudeUserSettingsPath())) throw new Error("run /supervise install-hooks first so the adopted session can report its events");
          }
          const [command, ...workerArgs] = parseCommand(process.env.PI_CLAUDE_SUPERVISOR_WORKER ?? "claude");
          if (!command) throw new Error("PI_CLAUDE_SUPERVISOR_WORKER must contain an executable");
          const policy = evaluateCommand(command, workerArgs);
          const approval: { actor: "human"; reason: string } | undefined = undefined;
          if (policy.decision === "deny") throw new Error(`Worker command denied: ${policy.reason}`);
          // Resolve models before any lease/reservation state is mutated below, so
          // a misconfigured model spec fails closed without leaking a reservation.
          const decisionPiModel = await resolveDecisionPiModel();
          const reviewer = taskAutomation ? await getReviewer() : undefined;
          if (shuttingDown) throw new Error("Pi session is shutting down");
          const cwdKey = await canonicalCwd(ctx.cwd);
          await releaseSettledReservations();
          if (shuttingDown) throw new Error("Pi session is shutting down");
          const reservedPaths = [...pendingCwds, ...reservedCwds.values()];
          if (reservedPaths.some((reserved) => pathsOverlap(reserved, cwdKey))) {
            throw new Error("An active, starting, or unreaped worker uses an overlapping cwd; use a separate worktree for concurrent sessions");
          }
          const taskId = randomUUID();
          const lease = await cwdLeaseStore.acquire(cwdKey, taskId, adapter.capabilities().transport, {
            startup: taskAutomation,
            ...(tmuxSession ? { handoff: { sessionName: tmuxSession, tmuxSocket: process.env.PI_CLAUDE_SUPERVISOR_TMUX_SOCKET } } : {}),
          });
          cwdLeases.set(taskId, lease);
          if (shuttingDown) {
            await releaseLease(taskId);
            throw new Error("Pi session is shutting down");
          }
          pendingCwds.add(cwdKey);
          const session = new Supervisor(adapter, events, {
            reviewer,
            reviewTimeoutMs: reviewTimeoutMs(),
            progressHeartbeatMs: progressHeartbeatMs(),
            decisionModel: decisionPiModel,
            decisionCompactionTokens: decisionCompactionTokens(),
            onCandidate: async (notice) => {
              if (ctx.hasUI) notify(ctx, `Candidate ${notice.status}: ${notice.reason}${formatUsageSuffix(notice.usage)}`, notice.status === "ready" ? "info" : "warning");
              if (humanWebhook.enabled) {
                try { await humanWebhook.notifyCandidate(notice); }
                catch (error) { console.error(`pi-claude-supervisor candidate webhook failed: ${redactText(error instanceof Error ? error.message : String(error))}`); }
              }
            },
            onHumanRequired: onHumanRequired(ctx),
          });
          pendingStartSessions.add(session);
          let startupCleanupCompleted = false;
          let startupCleanupAttempted = false;
          const hookSettingsPath = interactive && !tmuxSession ? join(hookSocketDirectory(stateDir), `settings-${taskId}.json`) : undefined;
          const startOperation = (async () => {
            try {
              if (interactive) {
                if (!hookServer || !hookServerReady) throw new Error("interactive tmux supervision requires PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux");
                await hookServerReady;
                if (hookSettingsPath) await writeHookSettingsFile(hookSettingsPath, hookRelayCommand(relayPath));
              }
              const handle = await session.start({
                taskId,
                onProgress: progress(ctx),
                task: goal,
                spec,
                cwd: cwdKey,
                command,
                args: workerArgs,
                env: selectedWorkerEnvironment(taskAutomation),
                approval,
                automation: taskAutomation,
                interactive,
                deadlineMs: taskDeadlineMs,
                deadlineGraceMs: deadlineGraceMs(),
                deadlineWarningMs: deadlineWarningMs(),
                noOutputTimeoutMs: noOutputTimeoutMs(),
                hookSource: interactive ? hookServer : undefined,
                hookSettingsPath,
                keepWorkerOnCompletion: interactive ? !closeWorkerOnCompletion() : undefined,
                retainCgroupUntilLeaseRelease: taskAutomation,
                workerArgOptions: taskAutomation
                  ? { model: workerModel(), autocompactTokens: workerAutocompactTokens(), mcpConfigPath: workerMcpConfigPath() }
                  : undefined,
                onWorkerStartup: taskAutomation
                  ? async (startupHandle) => {
                      await lease.updateWorker({
                        transport: adapter.capabilities().transport,
                        workerId: startupHandle.id,
                        cgroupPath: startupHandle.cgroupPath,
                        sessionName: startupHandle.sessionName,
                        tmuxSocket: startupHandle.tmuxSocket,
                        ownership: startupHandle.ownership,
                        retainCgroupUntilLeaseRelease: startupHandle.retainCgroupUntilLeaseRelease,
                      }, { preserveStartup: true });
                    }
                  : undefined,
                onWorkerPrepared: taskAutomation
                  ? async (preparedHandle) => {
                      await lease.updateWorker({
                        transport: adapter.capabilities().transport,
                        ...(await workerIdentity(preparedHandle)),
                        sessionName: preparedHandle.sessionName,
                        tmuxSocket: preparedHandle.tmuxSocket,
                        ownership: preparedHandle.ownership,
                      }, { preserveStartup: true });
                    }
                  : undefined,
                onWorkerPreSpawn: taskAutomation
                  ? async (preSpawnHandle) => {
                      await lease.updateWorker({
                        transport: adapter.capabilities().transport,
                        ...(await workerIdentity(preSpawnHandle)),
                        sessionName: preSpawnHandle.sessionName,
                        tmuxSocket: preSpawnHandle.tmuxSocket,
                        ownership: preSpawnHandle.ownership,
                      });
                    }
                  : undefined,
                tmuxSession,
                tmuxSocket: process.env.PI_CLAUDE_SUPERVISOR_TMUX_SOCKET,
                tmuxExpectedIdentity: tmuxSession && lease.record.worker ? {
                  pid: lease.record.worker.pid,
                  startTime: lease.record.worker.startTime,
                  tmuxTarget: lease.record.worker.tmuxTarget,
                  tmuxPaneId: lease.record.worker.tmuxPaneId,
                  paneStartTime: lease.record.worker.paneStartTime,
                  paneCommand: lease.record.worker.paneCommand,
                } : undefined,
                sendInitialInput: !tmuxSession,
                decisionSessionDir: decisionStore.directory,
                onDecisionSessionReady: async (info) => {
                  const current = await decisionStore.load(info.taskId);
                  await decisionStore.save({
                    taskId: info.taskId,
                    task: info.task,
                    spec: info.spec,
                    cwd: info.cwd,
                    command,
                    args: workerArgs,
                    approval,
                    decisionSessionFile: info.sessionFile,
                    maxTurns: info.maxTurns,
                    deadlineMs: info.deadlineMs,
                    noOutputTimeoutMs: info.noOutputTimeoutMs,
                    startedAt: info.startedAt,
                    ...(info.baseCommit ? { baseCommit: info.baseCommit } : {}),
                    ...(info.baseBranch ? { baseBranch: info.baseBranch } : {}),
                    ...(info.remoteBaseline ? { remoteBaseline: info.remoteBaseline } : {}),
                    ...(info.resolvedExecutable ? { resolvedExecutable: info.resolvedExecutable } : {}),
                    turn: info.turn,
                    repairRound: info.repairRound,
                    ...(info.lastFindingSignature ? { lastFindingSignature: info.lastFindingSignature } : {}),
                    state: "active",
                    recoveryState: current?.recoveryState ?? "ready",
                    recoveryAttempt: current?.recoveryAttempt ?? 0,
                    ...(current?.recoveryOwnerPid !== undefined ? { recoveryOwnerPid: current.recoveryOwnerPid } : {}),
                    ...(current?.recoveryOwnerStartTime ? { recoveryOwnerStartTime: current.recoveryOwnerStartTime } : {}),
                    ...(current?.recoveryWorker ? { recoveryWorker: current.recoveryWorker } : {}),
                  });
                },
                onDecisionSessionProgress: (info) => decisionStore.update(info.taskId, { turn: info.turn, repairRound: info.repairRound, workerCostUsd: info.workerCostUsd, ...(info.lastFindingSignature ? { lastFindingSignature: info.lastFindingSignature } : {}) }),
                onDecisionSessionClosed: handleDecisionSessionClosed,
              });
              const startedTaskId = session.task?.taskId;
              if (!startedTaskId) throw new Error("worker started without a task id");
              try {
                await lease.updateWorker({
                  transport: adapter.capabilities().transport,
                  ...(await workerIdentity(handle)),
                  sessionName: handle.sessionName,
                  tmuxSocket: handle.tmuxSocket,
                  ownership: handle.ownership,
                });
              } catch (error) {
                const registrationError = error instanceof Error ? error : new Error(String(error));
                if (handle.ownership !== "adopted") {
                  try {
                    await stopSession(session, "cwd lease metadata registration failed");
                    startupCleanupAttempted = true;
                    startupCleanupCompleted = await releaseLease(taskId);
                  } catch (cleanupError) {
                    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
                    registrationError.message = `${registrationError.message}; worker cleanup failed: ${message}`;
                    Object.defineProperty(registrationError, "workerCleanupRequired", { value: true, enumerable: false });
                  }
                }
                throw registrationError;
              }
              if (lease.replacedTaskId) await decisionStore.close(lease.replacedTaskId);
              // Register immediately after spawn so shutdown can retry cleanup if
              // the first stop attempt fails.
              sessions.set(startedTaskId, session);
              reservedCwds.set(startedTaskId, cwdKey);
              activeTaskId = startedTaskId;
              if (shuttingDown) {
                try {
                  await stopSession(session, "Pi session shutdown during worker start", true, true);
                  sessions.delete(startedTaskId);
                  reservedCwds.delete(startedTaskId);
                } finally {
                  if (session.state !== "stopped") {
                    // Keep the session registered for the shutdown retry below.
                    sessions.set(startedTaskId, session);
                    reservedCwds.set(startedTaskId, cwdKey);
                  }
                }
                throw new Error("Pi session shut down during worker start");
              }
              const attach = handle.sessionName ? ` attach=${attachCommand(handle)}` : "";
              message = `${tmuxSession ? "Tmux worker adopted" : "Worker started"}: task=${startedTaskId} worker=${handle.id} (pid ${handle.pid ?? "unknown"}); transport=${adapter.capabilities().transport}${attach}`;
            } catch (error) {
              // Register failed starts before the promise settles, so shutdown
              // cannot snapshot sessions before a returned handle is retained.
              const failedTaskId = session.task?.taskId;
              const cleanupRequired = requiresWorkerCleanup(error);
              if (cleanupRequired && failedTaskId) cleanupRequiredTasks.add(failedTaskId);
              const retainHandle = !startupCleanupCompleted && failedTaskId && session.handle
                && (cleanupRequired || session.handle.ownership === "adopted");
              if (retainHandle) {
                sessions.set(failedTaskId, session);
                reservedCwds.set(failedTaskId, cwdKey);
                activeTaskId = failedTaskId;
              } else if (!cleanupRequired && !startupCleanupCompleted && !startupCleanupAttempted) {
                startupCleanupAttempted = true;
                const released = await releaseLease(taskId);
                startupCleanupCompleted = released;
                if (!released && failedTaskId) {
                  sessions.set(failedTaskId, session);
                  reservedCwds.set(failedTaskId, cwdKey);
                  activeTaskId = failedTaskId;
                }
              } else if (!cleanupRequired && startupCleanupAttempted && !startupCleanupCompleted && failedTaskId) {
                // The inner start operation already owns the one cleanup
                // attempt. Retain the failed session for the shutdown/reap
                // sweep instead of calling release a second time.
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
            const cleanupRequired = requiresWorkerCleanup(error);
            if (cleanupRequired && failedTaskId) cleanupRequiredTasks.add(failedTaskId);
            const retainHandle = !startupCleanupCompleted && failedTaskId && session.handle
              && (cleanupRequired || session.handle.ownership === "adopted");
            if (retainHandle) {
              sessions.set(failedTaskId, session);
              reservedCwds.set(failedTaskId, cwdKey);
              activeTaskId = failedTaskId;
            } else if (!cleanupRequired && !startupCleanupCompleted && !startupCleanupAttempted) {
              startupCleanupAttempted = true;
              const released = await releaseLease(taskId);
              startupCleanupCompleted = released;
              if (!released && failedTaskId) {
                sessions.set(failedTaskId, session);
                reservedCwds.set(failedTaskId, cwdKey);
                activeTaskId = failedTaskId;
              }
            } else if (!cleanupRequired && startupCleanupAttempted && !startupCleanupCompleted && failedTaskId) {
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
          const usage = "Usage: /supervise recover [--takeover] [--extend <duration>] <task-id>";
          const extendOption = takeOption(rest, "--extend", ["--takeover"]);
          const takeover = rest.includes("--takeover");
          const taskId = rest.find((value) => value !== "--takeover");
          if (!taskId || rest.some((value) => value !== "--takeover" && value !== taskId)) throw new Error(usage);
          const extendMs = extendOption === undefined ? undefined : parseDurationMs(extendOption);
          if (extendOption !== undefined && extendMs === undefined) throw new Error(`--extend expects a duration such as 30m, 2h or 0 (close out now): ${extendOption}`);
          if (shuttingDown) throw new Error("Pi session is shutting down");
          if (sessions.has(taskId)) throw new Error(`Task session is already loaded: ${taskId}`);
          const record = await decisionStore.load(taskId);
          if (!record || record.state !== "active") throw new Error(`No recoverable Decision Worker session: ${taskId}`);
          const staleRecovery = !["ready", "interrupted"].includes(record.recoveryState);
          if (staleRecovery && !takeover) throw new Error(`Decision Worker recovery is stale (${record.recoveryState}); retry with --takeover only after verifying the old Worker is gone: ${taskId}`);
          if (!await decisionStore.sessionFileExists(taskId)) throw new Error(`Decision Worker session file is missing or unsafe: ${taskId}`);
          if (record.maxTurns > 0 && record.turn >= record.maxTurns) throw new Error(`Cannot recover task after its turn budget was exhausted: ${taskId}`);
          if (extendMs !== undefined && record.deadlineMs <= 0) throw new Error(`Task has no wall-clock deadline to extend: ${taskId}`);
          const elapsedMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
          // A task past its budget is not lost: `--extend` grants a fresh budget
          // from now (0 opens the close-out at once, verifying the repository as
          // it stands), which the recovered Supervisor persists as the deadline.
          const recoveryDeadlineMs = extendMs === undefined ? record.deadlineMs : extendedDeadlineMs(record.deadlineMs, elapsedMs, extendMs);
          // With --extend the new deadline is measured from now by construction
          // (`--extend 0` deliberately lands on it, so the close-out opens at once).
          if (extendMs === undefined && recoveryDeadlineMs > 0 && elapsedMs >= recoveryDeadlineMs) {
            throw new Error(`Cannot recover task after its wall-clock deadline (${formatDurationMs(elapsedMs - recoveryDeadlineMs)} ago); pass --extend <duration> to grant a close-out budget from now, or /supervise discard ${taskId} to drop the record`);
          }
          const cwdKey = await canonicalCwd(record.cwd);
          await releaseSettledReservations();
          if (shuttingDown) throw new Error("Pi session is shutting down");
          const reservedPaths = [...pendingCwds, ...reservedCwds.values()];
          if (reservedPaths.some((reserved) => pathsOverlap(reserved, cwdKey))) {
            throw new Error("An active, starting, or unreaped worker uses an overlapping cwd; use a separate worktree for recovery");
          }
          const policy = evaluateCommand(record.command, record.args);
          if (policy.decision === "deny") throw new Error(`Worker command denied: ${policy.reason}`);
          const automaticRecovery = record.spec?.autonomy.unattended !== false;
          if (automaticRecovery && !record.resolvedExecutable) throw new Error("automatic recovery requires a persisted resolved Claude executable identity");
          // The decision-session record does not persist whether the original
          // task was interactive; the current transport/mode configuration is
          // used instead, so it must not change between start and recovery.
          const recoveryInteractive = automaticRecovery && adapter.capabilities().transport === "tmux" && tmuxMode() === "interactive";
          const recoveryHookSettingsPath = recoveryInteractive ? join(hookSocketDirectory(stateDir), `settings-${record.taskId}.json`) : undefined;
          // Resolve models before any lease/recovery state is mutated below, so a
          // misconfigured model spec fails closed without leaking a reservation.
          const decisionPiModel = await resolveDecisionPiModel();
          const reviewer = automaticRecovery ? await getReviewer() : undefined;
          const approval = record.approval;
          const lease = await cwdLeaseStore.acquire(cwdKey, record.taskId, adapter.capabilities().transport, {
            startup: automaticRecovery,
            ...(takeover ? {
              takeover: {
                taskId: record.taskId,
                ...(staleRecovery ? { beforeReplace: () => decisionStore.reconcileStaleRecovery(record.taskId) } : {}),
              },
            } : {}),
          });
          if (staleRecovery && lease.replacedTaskId !== record.taskId) {
            await lease.release();
            throw new Error(`Stale Decision Worker recovery has no verified old lease to take over: ${record.taskId}`);
          }
          cwdLeases.set(record.taskId, lease);
          let recoveryClaimed = false;
          try {
            await decisionStore.beginRecovery(record.taskId);
            recoveryClaimed = true;
            if (shuttingDown) throw new Error("Pi session is shutting down");
          } catch (error) {
            if (recoveryClaimed) await decisionStore.markRecoveryInterrupted(record.taskId).catch(() => {});
            await releaseLease(record.taskId);
            throw error;
          }
          pendingCwds.add(cwdKey);
          const session = new Supervisor(adapter, events, {
            reviewer,
            reviewTimeoutMs: reviewTimeoutMs(),
            progressHeartbeatMs: progressHeartbeatMs(),
            decisionModel: decisionPiModel,
            decisionCompactionTokens: decisionCompactionTokens(),
            onCandidate: async (notice) => {
              if (ctx.hasUI) notify(ctx, `Candidate ${notice.status}: ${notice.reason}${formatUsageSuffix(notice.usage)}`, notice.status === "ready" ? "info" : "warning");
              if (humanWebhook.enabled) {
                try { await humanWebhook.notifyCandidate(notice); }
                catch (error) { console.error(`pi-claude-supervisor candidate webhook failed: ${redactText(error instanceof Error ? error.message : String(error))}`); }
              }
            },
            onHumanRequired: onHumanRequired(ctx),
          });
          pendingStartSessions.add(session);
          const recoveryOperation = (async () => {
            let startedHandle: WorkerHandle | undefined;
            try {
              if (recoveryInteractive) {
                if (!hookServer || !hookServerReady) throw new Error("interactive tmux supervision requires PI_CLAUDE_SUPERVISOR_TRANSPORT=tmux");
                await hookServerReady;
                if (recoveryHookSettingsPath) await writeHookSettingsFile(recoveryHookSettingsPath, hookRelayCommand(relayPath));
              }
              const handle = await session.start({
                taskId: record.taskId,
                onProgress: progress(ctx),
                // Claude session resume is not supported by this adapter. Start
                // idle so recovery never replays the original task; the operator
                // must explicitly send the next instruction.
                task: record.spec?.goal ?? record.task,
                spec: record.spec,
                initialInput: "",
                sendInitialInput: false,
                cwd: cwdKey,
                command: record.command,
                args: record.args,
                env: selectedWorkerEnvironment(automaticRecovery),
                approval,
                automation: automaticRecovery,
                interactive: recoveryInteractive,
                hookSource: recoveryInteractive ? hookServer : undefined,
                hookSettingsPath: recoveryHookSettingsPath,
                keepWorkerOnCompletion: recoveryInteractive ? !closeWorkerOnCompletion() : undefined,
                retainCgroupUntilLeaseRelease: automaticRecovery,
                workerArgOptions: automaticRecovery
                  ? { model: workerModel(), autocompactTokens: workerAutocompactTokens(), mcpConfigPath: workerMcpConfigPath() }
                  : undefined,
                onWorkerStartup: automaticRecovery
                  ? async (startupHandle) => {
                      await lease.updateWorker({
                        transport: adapter.capabilities().transport,
                        workerId: startupHandle.id,
                        cgroupPath: startupHandle.cgroupPath,
                        sessionName: startupHandle.sessionName,
                        tmuxSocket: startupHandle.tmuxSocket,
                        ownership: startupHandle.ownership,
                        retainCgroupUntilLeaseRelease: startupHandle.retainCgroupUntilLeaseRelease,
                      }, { preserveStartup: true });
                    }
                  : undefined,
                onWorkerPrepared: automaticRecovery
                  ? async (preparedHandle) => {
                      await lease.updateWorker({
                        transport: adapter.capabilities().transport,
                        ...(await workerIdentity(preparedHandle)),
                        sessionName: preparedHandle.sessionName,
                        tmuxSocket: preparedHandle.tmuxSocket,
                        ownership: preparedHandle.ownership,
                      }, { preserveStartup: true });
                    }
                  : undefined,
                onWorkerPreSpawn: automaticRecovery
                  ? async (preSpawnHandle) => {
                      await lease.updateWorker({
                        transport: adapter.capabilities().transport,
                        ...(await workerIdentity(preSpawnHandle)),
                        sessionName: preSpawnHandle.sessionName,
                        tmuxSocket: preSpawnHandle.tmuxSocket,
                        ownership: preSpawnHandle.ownership,
                      });
                    }
                  : undefined,
                ...(automaticRecovery && record.resolvedExecutable ? { expectedClaudeExecutable: record.resolvedExecutable } : {}),
                maxTurns: record.maxTurns,
                deadlineMs: recoveryDeadlineMs,
                deadlineGraceMs: deadlineGraceMs(),
                deadlineWarningMs: deadlineWarningMs(),
                noOutputTimeoutMs: record.noOutputTimeoutMs,
                startedAt: record.startedAt,
                baseCommit: record.baseCommit,
                baseBranch: record.baseBranch,
                remoteBaseline: record.remoteBaseline,
                initialTurn: record.turn,
                initialRepairRound: record.repairRound,
                initialFindingSignature: record.lastFindingSignature,
                initialWorkerCostUsd: record.workerCostUsd,
                decisionSessionFile: record.decisionSessionFile,
                decisionSessionDir: decisionStore.directory,
                onDecisionSessionReady: async (info) => {
                  const current = await decisionStore.load(info.taskId);
                  if (!current || current.state !== "active") throw new Error("Decision Worker recovery record disappeared before session registration");
                  await decisionStore.save({
                    taskId: info.taskId,
                    task: info.task,
                    spec: info.spec,
                    cwd: info.cwd,
                    command: record.command,
                    args: record.args,
                    approval,
                    decisionSessionFile: info.sessionFile,
                    maxTurns: info.maxTurns,
                    deadlineMs: info.deadlineMs,
                    noOutputTimeoutMs: info.noOutputTimeoutMs,
                    startedAt: info.startedAt,
                    ...(info.baseCommit ? { baseCommit: info.baseCommit } : {}),
                    ...(info.baseBranch ? { baseBranch: info.baseBranch } : {}),
                    ...(info.remoteBaseline ? { remoteBaseline: info.remoteBaseline } : {}),
                    ...(info.resolvedExecutable ? { resolvedExecutable: info.resolvedExecutable } : {}),
                    turn: info.turn,
                    repairRound: info.repairRound,
                    ...(info.lastFindingSignature ? { lastFindingSignature: info.lastFindingSignature } : {}),
                    state: "active",
                    recoveryState: current.recoveryState,
                    recoveryAttempt: current.recoveryAttempt,
                    ...(current.recoveryOwnerPid !== undefined ? { recoveryOwnerPid: current.recoveryOwnerPid } : {}),
                    ...(current.recoveryOwnerStartTime ? { recoveryOwnerStartTime: current.recoveryOwnerStartTime } : {}),
                    ...(current.recoveryWorker ? { recoveryWorker: current.recoveryWorker } : {}),
                  });
                },
                onDecisionSessionProgress: (info) => decisionStore.update(info.taskId, { turn: info.turn, repairRound: info.repairRound, workerCostUsd: info.workerCostUsd, ...(info.lastFindingSignature ? { lastFindingSignature: info.lastFindingSignature } : {}) }),
                onDecisionSessionClosed: handleDecisionSessionClosed,
              });
              startedHandle = handle;
              await lease.updateWorker({
                transport: adapter.capabilities().transport,
                ...(await workerIdentity(handle)),
                sessionName: handle.sessionName,
                tmuxSocket: handle.tmuxSocket,
                ownership: handle.ownership,
              });
              await decisionStore.recordRecoveryWorker(record.taskId, {
                id: handle.id,
                pid: handle.pid,
                startedAt: handle.startedAt,
              });
              const registered = await decisionStore.load(record.taskId);
              if (!registered || registered.state !== "active" || registered.recoveryState !== "registered" || registered.recoveryWorker?.id !== handle.id) {
                throw new Error("Recovered Worker registration was not durably confirmed");
              }
              sessions.set(record.taskId, session);
              reservedCwds.set(record.taskId, cwdKey);
              activeTaskId = record.taskId;
              await session.takeover();
              await decisionStore.markRecoveryIdle(record.taskId);
              const idle = await decisionStore.load(record.taskId);
              if (!idle || idle.state !== "active" || idle.recoveryState !== "recovered_idle" || idle.recoveryWorker?.id !== handle.id) {
                throw new Error("Recovered idle state was not durably confirmed");
              }
              if (shuttingDown) {
                await stopSession(session, "Pi session shutdown during recovery", true, true);
                throw new Error("Pi session shut down during recovery");
              }
              message = `Worker recovered idle: task=${record.taskId} worker=${handle.id}; original task was not replayed; send an explicit continuation, then use resume-auto`;
            } catch (error) {
              const handle = session.handle ?? startedHandle;
              let cleanupConfirmed = !handle;
              const retainedWorker = handle?.ownership === "adopted";
              if (handle && !retainedWorker) {
                try {
                  await stopSession(session, "Decision Worker recovery cleanup", false, true);
                  cleanupConfirmed = await workerCleanupConfirmed(handle);
                } catch {
                  cleanupConfirmed = false;
                }
              }
              if (!cleanupConfirmed) cleanupRequiredTasks.add(record.taskId);
              try {
                await decisionStore.markRecoveryInterrupted(record.taskId);
              } catch (stateError) {
                cleanupConfirmed = false;
                console.error(`pi-claude-supervisor recovery state update failed: ${redactText(stateError instanceof Error ? stateError.message : String(stateError))}`);
              }
              if (cleanupConfirmed && !retainedWorker) {
                const released = await releaseLease(record.taskId);
                if (released) {
                  forgetSession(record.taskId);
                } else {
                  cleanupRequiredTasks.add(record.taskId);
                  sessions.set(record.taskId, session);
                  reservedCwds.set(record.taskId, cwdKey);
                  activeTaskId = record.taskId;
                }
              } else {
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
        } else if (operation === "discard") {
          const [taskId, ...extra] = rest;
          if (!taskId || extra.length > 0) throw new Error("Usage: /supervise discard <task-id>");
          if (sessions.has(taskId)) throw new Error(`Task session is loaded in this Pi; use /supervise stop ${taskId} instead`);
          const record = await decisionStore.load(taskId);
          if (!record || record.state !== "active") throw new Error(`No recoverable Decision Worker session: ${taskId}`);
          // "starting"/"registered"/"recovered_idle" mean another Pi owns a
          // recovery of this task; only a settled record may be dropped here.
          if (!["ready", "interrupted"].includes(record.recoveryState)) throw new Error(`Decision Worker recovery is in progress elsewhere (${record.recoveryState}); discard only after that Pi has released it: ${taskId}`);
          // The cwd lease is the ownership record: a live owner means the task
          // is running in another Pi ("ready" is also its normal state); a dead
          // owner's lease still guards the cwd against a possibly-live detached
          // Worker and is only reclaimed through recover --takeover's cleanup
          // proof, which needs this record. Neither may be discarded from here.
          const lease = (await cwdLeaseStore.list()).find((candidate) => candidate.taskId === taskId);
          if (lease) {
            if (await leaseOwnerLive(lease)) throw new Error(`Task is still owned by a live Pi (pid ${lease.ownerPid}); stop it there instead of discarding it: ${taskId}`);
            // An adopted session's tmux server is the user's own and stays
            // alive, so a takeover can never prove the Worker gone; adopting
            // the session again hands the dead owner's lease over in place.
            if (lease.worker?.ownership === "adopted" && lease.worker.sessionName) {
              throw new Error(`Task still holds the cwd lease for ${redactText(lease.cwd)} (owner pid ${lease.ownerPid} is gone); adopt the session again with /supervise adopt-tmux ${lease.worker.sessionName} <task> to take the lease over, then discard this record`);
            }
            throw new Error(`Task still holds the cwd lease for ${redactText(lease.cwd)} (owner pid ${lease.ownerPid} is gone); run /supervise recover --takeover --extend 0 ${taskId} to prove the old Worker is gone and close the task out, then stop it if needed`);
          }
          await decisionStore.close(taskId);
          message = `Discarded recoverable task ${taskId} (cwd ${redactText(record.cwd)}); its Decision Worker session file is kept until retention pruning`;
        } else if (operation === "sessions") {
          const recoverable = await decisionStore.list({ activeOnly: true });
          message = formatSessions(sessions, recoverable, tmuxModeLabel());
          const quarantined = await cwdLeaseStore.quarantined();
          if (quarantined.length > 0) {
            message += `\nQuarantined cwd lease records (${quarantined.length}) in ${leaseDir}/quarantine: ${redactText(quarantined.join(", "))}`;
          }
        } else if (operation === "status") {
          const { session, sessionId } = resolveSession(sessions, activeTaskId, rest, true);
          message = session
            ? `task=${sessionId} state=${session.state} worker=${session.handle?.id ?? "none"}${tmuxModeLabel() ? ` mode=${tmuxModeLabel()}` : ""}${formatDeadline(session.deadline)} ${formatUsageDetail(session.usage)}`
            : formatSessions(sessions, await decisionStore.list({ activeOnly: true }), tmuxModeLabel());
        } else if (operation === "capabilities") {
          message = JSON.stringify(adapter.capabilities(), null, 2);
        } else if (operation === "install-hooks" || operation === "uninstall-hooks") {
          const settingsPath = claudeUserSettingsPath();
          const result = operation === "install-hooks"
            ? await installUserHooks({ stateDir, settingsPath })
            : await uninstallUserHooks({ stateDir, settingsPath });
          message = `${operation}: ${result.changed ? "updated" : "already up to date"} ${result.settingsPath}`;
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
            await stopSession(session, remaining.join(" ") || "human requested stop");
            await releaseSettledReservations();
            message = `Worker stopped: ${sessionId}.`;
          } else if (operation === "verify") {
            const result = await session.verify();
            await releaseSettledReservations();
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
            throw new Error("Usage: /supervise start [--spec <file>] [--deadline <duration>] [--remote none|push|pr]|adopt-tmux [--spec <file>] [--deadline <duration>] [--remote none|push|pr]|recover [--takeover] [--extend <duration>]|discard <task-id>|sessions|status|poll [all|taskId]|send [taskId]|pause [taskId]|resume [taskId]|stop [taskId]|verify [taskId]|approve [taskId] <allow|deny>|takeover [taskId]|resume-auto [taskId]|capabilities|install-hooks|uninstall-hooks");
          }
        }
        if (hookInstallNotice) { notify(ctx, hookInstallNotice); hookInstallNotice = undefined; }
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
      if (detachedLeaseSweepTimer) {
        clearInterval(detachedLeaseSweepTimer);
        detachedLeaseSweepTimer = undefined;
      }
      const pending = [...pendingStarts];
      let startupFailures: PromiseRejectedResult[] = [];
      await Promise.race([Promise.allSettled(pending), delay(5_000)]);
      if (pendingStarts.size > 0) {
        const abortResults = await Promise.allSettled([...pendingStartSessions].map((session) => session.abortStart("Pi session shutdown during startup")));
        startupFailures = abortResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        // Do not snapshot sessions or release leases until every startup has
        // settled. Otherwise a provider that resolves after a fixed timeout
        // could register a live handle after shutdown cleanup had completed.
        // Adapters expose bounded cancellation; an uncooperative provider must
        // keep shutdown fail-closed rather than allowing a late worker escape.
        while (pendingStarts.size > 0) {
          const results = await Promise.allSettled([...pendingStarts]);
          startupFailures.push(...results.filter((result): result is PromiseRejectedResult => result.status === "rejected"));
        }
      }
      const results = await Promise.allSettled([...sessions.values()].map((session) => stopSession(session, "Pi session shutdown", true, true)));
      await releaseSettledReservations();
      if (hookServer) {
        try {
          // listen() may still be in flight (e.g. shutdown racing startup, or
          // a task that never reached an interactive start); close() only
          // tears down the socket once #server is set, so an unawaited
          // listen() here would leak an open listening socket forever.
          if (hookServerReady) await hookServerReady.catch(() => {});
          await hookServer.close();
        } catch (error) {
          console.error(`pi-claude-supervisor hook server shutdown failed: ${redactText(error instanceof Error ? error.message : String(error))}`);
        }
      }
      const failures = [...startupFailures, ...results.filter((result): result is PromiseRejectedResult => result.status === "rejected")];
      if (failures.length > 0) {
        for (const failure of failures) console.error(`pi-claude-supervisor shutdown cleanup failed: ${redactText(failure.reason instanceof Error ? failure.reason.message : String(failure.reason))}`);
        if (exitCode === undefined) process.exitCode = 1;
      }
      if (exitCode !== undefined) process.exitCode = exitCode;
    })();
    return shutdownPromise;
  };
  // Pi owns process signal handling and invokes session_shutdown. Installing a
  // second extension-level process.exit() handler races Pi's terminal restore and
  // other extension shutdown hooks.
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

function requiresWorkerCleanup(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { workerCleanupRequired?: unknown }).workerCleanupRequired === true);
}

/**
 * Remove a `--name value` or `--name=value` option and return its value.
 * `--name value` is recognised only in the leading option block (walking
 * over other options and their values; `flags` take no value), so a task
 * description that mentions `--deadline` is left alone; `--name=value` is
 * accepted anywhere, as `--spec=` always was.
 */
function takeOption(rest: string[], name: string, flags: readonly string[] = []): string | undefined {
  for (let index = 0; index < rest.length && rest[index].startsWith("--"); index += 1) {
    if (rest[index] === name) return rest.splice(index, 2)[1];
    if (rest[index].startsWith(`${name}=`)) return rest.splice(index, 1)[0]?.slice(name.length + 1);
    // Another option: its value (when it has one and it is not inline) is the next token.
    if (!flags.includes(rest[index]) && !rest[index].includes("=")) index += 1;
  }
  const inline = rest.findIndex((value) => value.startsWith(`${name}=`));
  return inline >= 0 ? rest.splice(inline, 1)[0]?.slice(name.length + 1) : undefined;
}

/** `--deadline` accepts `8h`, `90m`, `2h30m`, plain milliseconds, or `0` to disable the deadline for this task; the same 5m–7d range as `DEADLINE_MS`. */
function parseTaskDeadline(value: string): number {
  const parsed = parseDurationMs(value);
  if (parsed === undefined) throw new Error(`--deadline expects a duration such as 8h, 90m or 0 (disabled): ${value}`);
  if (parsed !== 0 && (parsed < 5 * 60_000 || parsed > 7 * 24 * 60 * 60_000)) throw new Error("--deadline must be between 5m and 7d, or 0 to disable the deadline");
  return parsed;
}

/** A recoverable record's budget: how much is left, or how long ago it expired (recover then needs `--extend`). */
function formatRecordDeadline(record: DecisionSessionRecord): string {
  if (record.deadlineMs <= 0) return "";
  const remaining = record.deadlineMs - (Date.now() - Date.parse(record.startedAt));
  return remaining > 0 ? ` deadline=${formatDurationMs(remaining)} left` : ` deadline=expired ${formatDurationMs(-remaining)} ago (recover --extend)`;
}

function formatDeadline(deadline: Supervisor["deadline"]): string {
  if (!deadline) return "";
  if (!deadline.closeOut) return ` deadline=${formatDurationMs(deadline.remainingMs)} left`;
  return ` deadline=close-out (${formatDurationMs(deadline.closeOutRemainingMs ?? 0)} left)`;
}

function formatSessions(sessions: Map<string, Supervisor>, recoverable: DecisionSessionRecord[] = [], tmuxModeLabel?: string): string {
  const modeSuffix = tmuxModeLabel ? ` mode=${tmuxModeLabel}` : "";
  const active = [...sessions.entries()]
    .map(([taskId, session]) => `${taskId} state=${session.state} cwd=${session.task?.cwd ?? "-"} worker=${session.handle?.id ?? "-"}${modeSuffix}`);
  const pending = recoverable
    .filter((record) => !sessions.has(record.taskId))
    .map((record) => `${record.taskId} state=recoverable recovery=${record.recoveryState} cwd=${record.cwd} worker=${record.recoveryWorker?.id ?? "-"}${modeSuffix}${formatRecordDeadline(record)}`);
  return [...active, ...pending].join("\n") || "No task sessions.";
}

function tokenTotal(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

function formatUsageDetail(usage: SupervisorTokenUsage): string {
  const workerTokens = tokenTotal(usage.workerTokens);
  const piTokens = tokenTotal(usage.decision) + tokenTotal(usage.reviewer);
  return `cost=$${usage.workerCostUsd.toFixed(2)} workerTurns=${usage.workerTurns} workerTokens=${workerTokens} piTokens=${piTokens} decisionCalls=${usage.decision.calls} reviewerCalls=${usage.reviewer.calls}`;
}

function formatUsageSuffix(usage?: SupervisorTokenUsage): string {
  if (!usage) return "";
  const piTokens = tokenTotal(usage.decision) + tokenTotal(usage.reviewer);
  return ` (worker $${usage.workerCostUsd.toFixed(2)}, Pi ${piTokens} tokens)`;
}

function selectedWorkerEnvironment(automatic = false): NodeJS.ProcessEnv {
  if (automatic) return automaticWorkerEnvironment(process.env);
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

async function readTaskSpecFile(path: string, cwd: string): Promise<TaskSpec> {
  const file = resolve(cwd, path.replace(/^['"]|['"]$/gu, ""));
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("secure task specification opening is unavailable");
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let contents: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("task specification is not a regular file");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("task specification is owned by another user");
    if (info.nlink > 1) throw new Error("task specification is a hard-link alias");
    if (info.size > 1 * 1024 * 1024) throw new Error("task specification exceeds the safe size limit");
    contents = await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)) as unknown;
  // A spec that omits an autonomy key inherits the operator's environment
  // default for it, the way a plain-text task does.
  return normalizeTaskSpec(value, "", autonomyDefaults());
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

function assertRuntimeDirectory(path: string, label: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} directory is not a real directory`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${label} directory is owned by another user`);
    if (realpathSync.native(path) !== resolve(path)) throw new Error(`${label} directory contains a symlink`);
    chmodSync(path, 0o700);
    accessSync(path, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch (error) {
    throw new Error(`${label} directory preflight failed for ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function redactText(value: string): string {
  return String(redactSensitive(value));
}
