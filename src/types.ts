export type SupervisorState =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "paused"
  | "verifying"
  | "completed"
  | "failed"
  | "stopped";

export type WorkerExitReason = "completed" | "failed" | "stopped" | "crashed" | "unknown";

export interface WorkerPermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  raw: Record<string, unknown>;
}

export type WorkerEvent =
  | { type: "output"; handle: WorkerHandle; chunk: WorkerOutputChunk }
  | { type: "jsonl"; handle: WorkerHandle; record: Record<string, unknown> }
  | { type: "turn_completed"; handle: WorkerHandle; result: Record<string, unknown>; sequence: number }
  | { type: "permission_request"; handle: WorkerHandle; request: WorkerPermissionRequest }
  | { type: "exited"; handle: WorkerHandle; exitCode?: number | null; signal?: NodeJS.Signals };

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
  /** Adopted sessions must not replay the task as a new user message. */
  sendInitialInput?: boolean;
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
}

export interface WorkerAdapter {
  capabilities(): WorkerCapabilities;
  start(input: WorkerStartInput): Promise<WorkerHandle>;
  /** Cancel adapter-owned startup work before a WorkerHandle is returned. */
  abortStart?(reason: string): Promise<void>;
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
  /** The worker can remain alive while Pi disconnects from it. */
  persistentSession?: boolean;
}

export interface TaskContext {
  taskId: string;
  task: string;
  cwd: string;
  maxTurns: number;
  startedAt: string;
}

export interface VerificationResult {
  ok: boolean;
  command: string;
  exitCode: number;
  output: string;
  checkedAt: string;
}
