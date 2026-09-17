export type SupervisorState =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "paused"
  | "verifying"
  | "completed"
  | "blocked"
  | "failed"
  | "stopped";

export type WorkerExitReason = "completed" | "failed" | "stopped" | "crashed" | "unknown";

export interface WorkerPermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  raw: Record<string, unknown>;
  /**
   * Interactive (hook-driven) sessions ask twice: `pre` is the PreToolUse veto
   * point before Claude's own permission mode runs — only a policy denial is
   * answered there — and `prompt` means Claude would now show a permission
   * prompt to a human. Bridge/JSONL requests have no phase.
   */
  phase?: "pre" | "prompt";
}

export type WorkerEvent =
  | { type: "output"; handle: WorkerHandle; chunk: WorkerOutputChunk }
  | { type: "jsonl"; handle: WorkerHandle; record: Record<string, unknown> }
  | { type: "turn_completed"; handle: WorkerHandle; result: Record<string, unknown>; sequence: number }
  | { type: "permission_request"; handle: WorkerHandle; request: WorkerPermissionRequest }
  | { type: "exited"; handle: WorkerHandle; exitCode?: number | null; signal?: NodeJS.Signals }
  /** A prompt the Supervisor did not send reached an interactive Worker: a human is driving. */
  | { type: "human_input"; handle: WorkerHandle; text: string };

export type WorkerEventListener = (event: WorkerEvent) => void | Promise<void>;

export interface WorkerStartInput {
  task: string;
  cwd: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  approval?: { actor: "human"; reason: string };
  eventListener?: WorkerEventListener;
  /** Attach to an existing tmux session instead of starting a new worker. */
  tmuxSession?: string;
  /** Optional tmux socket path; omitted means the user's default server. */
  tmuxSocket?: string;
  /** Persisted identity required when handing off an existing tmux lease. */
  tmuxExpectedIdentity?: {
    pid?: number;
    startTime?: string;
    tmuxTarget?: string;
    tmuxPaneId?: string;
    paneStartTime?: string;
    paneCommand?: string;
  };
  /** Adopted sessions must not replay the task as a new user message. */
  sendInitialInput?: boolean;
  /** Automatic mode selects the structured tmux bridge instead of the manual TUI transport. */
  automatic?: boolean;
  /**
   * Automatic mode that drives the real interactive Claude TUI through Claude
   * Code hooks instead of the stream-json bridge. Requires `hookSource`.
   */
  interactive?: boolean;
  /** Hook event routing for interactive sessions (owned or adopted). */
  hookSource?: import("./hooks/types.ts").HookEventSource;
  /** Hook settings file the owned interactive launch passes as `--settings`. */
  hookSettingsPath?: string;
  /** Keep an empty automatic cgroup until the owning cwd lease is finalized. */
  retainCgroupUntilLeaseRelease?: boolean;
  /** Persist the planned automatic resource identity before adapter setup. */
  onWorkerStartup?: (provisionalHandle: WorkerHandle) => Promise<void> | void;
  /** Persist the cgroup identity before creating any external Worker resource. */
  onWorkerPrepared?: (provisionalHandle: WorkerHandle) => Promise<void> | void;
  /** Cancel startup before a worker is fully returned to the supervisor. */
  abortSignal?: AbortSignal;
  /** Internal token that scopes out-of-band startup cancellation. */
  startupToken?: string;
  /**
   * Automatic-start repository/settings assertion. Built-in adapters invoke
   * this after asynchronous setup; the tmux bridge repeats its permission
   * check immediately before spawning the Claude child. The provisional
   * handle contains the cgroup identity before Worker spawn.
   */
  preSpawnCheck?: (provisionalHandle?: WorkerHandle) => Promise<void>;
}

export interface WorkerHandle {
  id: string;
  pid?: number;
  startedAt: string;
  cwd: string;
  sessionId?: string;
  sessionName?: string;
  tmuxSocket?: string;
  ownership?: "owned" | "adopted";
  /** Verified process-boundary metadata persisted in the cwd lease registry. */
  cgroupPath?: string;
  cgroupIdentity?: { device: string; inode: string };
  /** Automatic adapters retain the empty cgroup until the cwd lease is released. */
  retainCgroupUntilLeaseRelease?: boolean;
  tmuxServerPid?: number;
  tmuxServerStartTime?: string;
  tmuxTarget?: string;
  tmuxPaneId?: string;
  paneStartTime?: string;
  paneCommand?: string;
}

export interface WorkerStatus {
  handle: WorkerHandle;
  running: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  lastOutputAt?: string;
  lastInputAt?: string;
  activeRequests?: number;
  exitReason?: WorkerExitReason;
  /** Whether the detached process group or cgroup has been confirmed gone. */
  processGroupCleaned?: boolean;
  /** Whether a Linux cgroup provided descendant cleanup for this worker. */
  cgroupCleaned?: boolean;
  /** Whether cgroup attachment was required for this worker. */
  cgroupRequired?: boolean;
  /** cgroup attachment was unavailable and a fallback may have been used. */
  cgroupError?: string;
  /** Cleanup failure is diagnostic and must be treated as a safety failure. */
  cleanupError?: string;
  runtimeError?: string;
  outputTruncated?: boolean;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
  /** Interactive sessions only: answer "no decision" so Claude's own permission mode decides. */
  defer?: boolean;
}

export interface WorkerAdapter {
  capabilities(): WorkerCapabilities;
  /** Validate host/transport prerequisites before starting a Worker. */
  preflight?(input: Pick<WorkerStartInput, "cwd" | "command" | "args" | "env" | "approval" | "automatic" | "interactive">): Promise<void>;
  start(input: WorkerStartInput): Promise<WorkerHandle>;
  /** Cancel adapter-owned startup work before a WorkerHandle is returned. */
  abortStart?(reason: string, startupToken?: string): Promise<void>;
  getStatus(handle: WorkerHandle): Promise<WorkerStatus>;
  readOutput(handle: WorkerHandle): Promise<WorkerOutputChunk[]>;
  /** Restore chunks when diagnostic event persistence fails before acknowledgement. */
  restoreOutput?(handle: WorkerHandle, chunks: WorkerOutputChunk[]): Promise<void>;
  /** Subscribe to transport and process lifecycle events without polling. */
  subscribe?(handle: WorkerHandle, listener: WorkerEventListener): () => void;
  /** Respond to Claude Code's stdio permission request. */
  respondPermission?(handle: WorkerHandle, requestId: string, toolUseId: string, decision: PermissionDecision, updatedInput?: unknown): Promise<void>;
  send(handle: WorkerHandle, message: string, idempotencyKey: string): Promise<void>;
  pause(handle: WorkerHandle): Promise<void>;
  resume(handle: WorkerHandle): Promise<void>;
  stop(handle: WorkerHandle, reason: string): Promise<void>;
  /** Disconnect the supervisor without stopping a persistent worker, if supported. */
  release?(handle: WorkerHandle, reason: string): Promise<void>;
  killProcessGroup(handle: WorkerHandle, reason: string): Promise<void>;
  resumeSession(sessionId: string): Promise<WorkerHandle>;
}

export interface WorkerOutputChunk {
  stream: "stdout" | "stderr";
  text: string;
  at: string;
}

export interface WorkerCapabilities {
  transport: "process-pipe" | "pty" | "jsonl" | "tmux";
  interactiveInput: boolean;
  pause: boolean;
  resumeSession: boolean;
  processGroupControl: boolean;
  /** The worker can remain alive while Pi disconnects from it and be explicitly re-adopted. */
  persistentSession?: boolean;
  /** The current Supervisor can send another bounded turn after a result. */
  repairableSession?: boolean;
}

export interface AcceptanceCheck {
  id: string;
  name: string;
  command: string;
  args: string[];
  required: boolean;
  timeoutMs: number;
}

export type AcceptanceCheckStatus = "passed" | "failed" | "timed_out" | "blocked" | "cancelled";

export interface AcceptanceCheckResult {
  check: AcceptanceCheck;
  status: AcceptanceCheckStatus;
  ok: boolean;
  exitCode: number;
  output: string;
  startedAt: string;
  finishedAt: string;
}

export interface TaskAutonomy {
  /** Local development continues without synchronous human approval. */
  unattended: boolean;
  /** The Worker should commit the candidate on its local branch before completion. */
  requireLocalCommit: boolean;
  /** Number of autonomous Decision Worker retries before parking a candidate. */
  maxDecisionRetries: number;
  /**
   * Who answers Worker permission requests. `policy` never consults the
   * Decision Worker; `decision-worker` always does; `hybrid` (default) answers
   * routine in-cwd file edits and read-only/local-dev shell commands from the
   * deterministic policy and asks the Decision Worker for everything else.
   */
  permissionAuthority: PermissionAuthority;
  /** Park the candidate once the Worker's cumulative API cost exceeds this amount; undefined disables the cap. */
  maxWorkerCostUsd?: number;
}

export type PermissionAuthority = "policy" | "hybrid" | "decision-worker";

/** One model call's token accounting for a Pi-side session (Decision Worker or Reviewer). */
export interface PiUsageSample {
  role: "decision" | "reviewer";
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd?: number;
  /** Estimated context size after the call, when the session reports it. */
  contextTokens?: number | null;
}

export interface TaskSpec {
  goal: string;
  scope: string[];
  constraints: string[];
  forbidden: string[];
  acceptance: AcceptanceCheck[];
  maxRepairRounds: number;
  autonomy: TaskAutonomy;
}

/** Public input shape; nested autonomy fields may be omitted and are defaulted. */
export type TaskSpecInput = Partial<Omit<TaskSpec, "autonomy">> & { autonomy?: Partial<TaskAutonomy> };

export type ReviewVerdict = "pass" | "revise" | "human";
export type ReviewSeverity = "P0" | "P1" | "P2" | "P3";

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  message: string;
  evidence?: string;
  requiredFix?: string;
  file?: string;
  line?: number;
  acceptanceRef?: string;
}

export interface ReviewReport {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  round: number;
  checkedAt: string;
  /** Aggregate Reviewer session usage for this round, when the Reviewer reports it. */
  usage?: Omit<PiUsageSample, "role">;
}

export interface TaskContext {
  taskId: string;
  task: string;
  cwd: string;
  maxTurns: number;
  startedAt: string;
  /** Repository HEAD before this task; used to review local commits as well as worktree changes. */
  baseCommit?: string;
  /** The branch the task started on; the Worker may move to another branch, the baseline commit stays the anchor. */
  baseBranch?: string;
  spec: TaskSpec;
  repairRound: number;
  lastFindingSignature?: string;
}

export interface VerificationResult {
  ok: boolean;
  command: string;
  exitCode: number;
  output: string;
  checkedAt: string;
}

export interface AcceptanceReport extends VerificationResult {
  checks: AcceptanceCheckResult[];
  review?: ReviewReport;
}
