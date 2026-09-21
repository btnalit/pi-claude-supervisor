/**
 * Contract between the Claude Code hook relay (a tiny script configured in
 * Claude's hook settings) and the Supervisor's hook server. Claude Code runs the
 * relay for every hook event of an interactive session; the relay forwards the
 * event over a unix socket and prints the reply as Claude's hook output.
 */

export type ClaudeHookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "Stop"
  | "StopFailure"
  | "Notification";

/** The subset of Claude Code hook input the Supervisor consumes (all fields untrusted). */
export interface ClaudeHookEvent {
  hook_event_name: ClaudeHookEventName;
  session_id: string;
  cwd: string;
  transcript_path?: string;
  permission_mode?: string;
  /** SessionStart */
  source?: string;
  /** SessionStart: Claude Code's per-session scratchpad directory (outside the cwd). */
  scratchpad_dir?: string;
  /** SessionEnd */
  reason?: string;
  /** UserPromptSubmit */
  prompt?: string;
  /** PreToolUse / PermissionRequest */
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  /** Stop */
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  /** StopFailure (an API/model error ended the turn; no Stop fires) */
  error?: unknown;
  /** Notification */
  notification_type?: string;
  message?: string;
}

export interface HookRelayRequest {
  version: 1;
  /** Relay process identity; ppid is the Claude Code process. */
  pid: number;
  ppid: number;
  /** Inherited from Claude's environment when it runs inside tmux. */
  tmuxPane?: string;
  /** Per-worker capability supplied by the Supervisor-owned Claude launch. */
  capability?: string;
  event: ClaudeHookEvent;
}

/**
 * The Supervisor's answer. `undefined`/empty means "no decision": the relay
 * prints nothing and Claude Code proceeds with its own permission mode.
 */
export interface HookRelayReply {
  /** PreToolUse / PermissionRequest */
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  /** Stop: keep Claude working with this instruction instead of ending the turn. */
  block?: boolean;
  blockReason?: string;
}

/** Hook events the relay waits for a reply on; the rest are fire-and-forget. */
export const BLOCKING_HOOK_EVENTS: ReadonlySet<ClaudeHookEventName> = new Set(["PreToolUse", "PermissionRequest", "Stop"]);

/** How long Claude waits for the relay before treating the hook as undecided. */
export const HOOK_TIMEOUT_SECONDS = 180;

/**
 * Socket routing: one socket per Pi process under `<stateDir>/hooks/`, plus a
 * per-cwd symlink `<stateDir>/hooks/by-cwd/<sha256(cwd)>` created when the
 * Supervisor takes the cwd lease, so a relay only needs the cwd to find its
 * supervisor and a cwd with no supervisor is a no-op.
 */
export interface HookEventSource {
  /** Route every event whose canonical cwd matches to this handler until unsubscribed. */
  subscribe(cwd: string, handler: (request: HookRelayRequest) => Promise<HookRelayReply | undefined>, options?: { capability?: string }): Promise<() => Promise<void>>;
}
