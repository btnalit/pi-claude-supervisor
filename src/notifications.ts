import { createHmac, randomUUID } from "node:crypto";
import type { CandidateNotice, HumanInterventionNotice } from "./supervisor.ts";
import { redactSensitive } from "./redaction.ts";

export interface HumanWebhookOptions {
  url?: string;
  format?: "generic" | "wecom";
  secret?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelaysMs?: number[];
  /** Total wall-clock budget for retries; a delay that would cross it fails fast with the last error. */
  retryDeadlineMs?: number;
}

/** Optional outbound candidate delivery. It never grants permission or controls the Worker. */
export class HumanWebhookNotifier {
  readonly #url?: string;
  readonly #format: "generic" | "wecom";
  readonly #secret?: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelaysMs: number[];
  readonly #retryDeadlineMs: number;

  constructor(options: HumanWebhookOptions = {}) {
    this.#url = options.url;
    this.#format = options.format ?? "generic";
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryDelaysMs = options.retryDelaysMs ?? [500, 2_000];
    this.#retryDeadlineMs = options.retryDeadlineMs ?? 30_000;
  }

  get enabled(): boolean { return Boolean(this.#url); }

  async notify(notice: HumanInterventionNotice): Promise<void> {
    if (!this.#url) return;
    const body = this.#format === "wecom" ? JSON.stringify(toWeCom(notice)) : JSON.stringify(toGeneric(notice));
    await this.#send(body);
  }

  async notifyCandidate(notice: CandidateNotice): Promise<void> {
    if (!this.#url) return;
    const body = this.#format === "wecom" ? JSON.stringify(toWeCom(notice)) : JSON.stringify(toGeneric(notice));
    await this.#send(body);
  }

  async #send(body: string): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "pi-claude-supervisor/0.1" };
    if (this.#secret) headers["x-pi-supervisor-signature"] = `sha256=${createHmac("sha256", this.#secret).update(body).digest("hex")}`;
    const startedAt = Date.now();
    let lastError: unknown;
    for (let attempt = 1; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response: Response | undefined;
      try {
        response = await fetch(this.#url!, { method: "POST", headers, body, signal: controller.signal });
      } catch (error) {
        if (attempt >= this.#maxAttempts) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
      if (response) {
        if (response.ok) return;
        if (!isRetryableStatus(response.status) || attempt >= this.#maxAttempts) {
          throw new Error(`candidate webhook returned HTTP ${response.status}`);
        }
        lastError = new Error(`candidate webhook returned HTTP ${response.status}`);
      }
      const nextDelay = this.#retryDelaysMs[attempt - 1] ?? this.#retryDelaysMs.at(-1) ?? 0;
      if (Date.now() - startedAt + nextDelay > this.#retryDeadlineMs) throw lastError;
      await sleep(nextDelay);
    }
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toGeneric(notice: HumanInterventionNotice | CandidateNotice): Record<string, unknown> {
  const candidate = "status" in notice;
  return {
    schema: candidate ? "pi-claude-supervisor/candidate/v1" : "pi-claude-supervisor/human-intervention/v1",
    eventId: randomUUID(),
    event: candidate ? "candidate_status" : "human_intervention_required",
    occurredAt: new Date().toISOString(),
    task: { id: sanitize(notice.taskId), goal: sanitize(notice.task), cwd: sanitize(notice.cwd) },
    worker: { id: sanitize(notice.workerId) },
    reason: sanitize(notice.reason),
    question: sanitize(notice.question),
    permission: notice.permission ? sanitize(notice.permission) : undefined,
    ...(notice.attach ? { attach: sanitize(notice.attach) } : {}),
    ...(candidate ? { status: notice.status, deliverable: notice.deliverable, ...(notice.prUrl ? { prUrl: sanitize(notice.prUrl) } : {}), ...(notice.usage ? { usage: usageSummary(notice.usage) } : {}) } : { actions: ["approve_or_deny_permission", "send_instruction", "stop_worker", "takeover"] }),
    note: candidate
      ? "This is an optional candidate notification. It does not grant remote push or main/integration merge permission."
      : "This is an outbound notification. Use the Pi session or a separately authenticated callback service to approve actions.",
  };
}

function toWeCom(notice: HumanInterventionNotice | CandidateNotice): Record<string, unknown> {
  const candidate = "status" in notice;
  const permission = notice.permission ? `\n工具: ${safeText(notice.permission.toolName)}\n请求 ID: ${safeText(notice.permission.requestId)}` : "";
  const question = notice.question ? `\n问题: ${safeText(notice.question)}` : "";
  const attach = notice.attach ? `\n接入: ${safeText(notice.attach)}` : "";
  // Not Markdown-escaped: `escapeMarkdown` would turn an `_` in the org or
  // repository name into `\_` and break the link. The URL is already sanitized.
  const pullRequest = "status" in notice && notice.prUrl ? `\nPR: ${safeText(notice.prUrl)}` : "";
  const title = candidate ? "Claude Supervisor 候选状态" : "Claude Supervisor 需要人工介入";
  const usage = candidate && notice.usage ? `\n> Worker 费用: $${notice.usage.workerCostUsd.toFixed(2)} (${notice.usage.workerTurns} turns)\n> Pi tokens: ${usageSummary(notice.usage).piTokens}` : "";
  const suffix = candidate
    ? `\n> 状态: ${safeText(notice.status)}\n> 可交付: ${notice.deliverable ? "yes" : "no"}${usage}\n\n该通知不授予远程 push 或 main/integration merge 权限。`
    : "\n\n请在 Pi 中执行对应的 approve/deny、send、stop 或 takeover 操作。";
  return {
    msgtype: "markdown",
    markdown: {
      content: `### ${title}\n> 任务: ${safeText(notice.task)}\n> Task ID: ${safeText(notice.taskId)}\n> 原因: ${safeText(notice.reason)}${escapeMarkdown(question)}${escapeMarkdown(permission)}${escapeMarkdown(attach)}${pullRequest}${suffix}`,
    },
  };
}

/** Numeric-only cost summary for outbound payloads; never includes free text. */
function usageSummary(usage: NonNullable<CandidateNotice["usage"]>): { workerCostUsd: number; workerTurns: number; workerTokens: number; piTokens: number; decisionCalls: number; reviewerCalls: number } {
  const total = (tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return {
    workerCostUsd: Number(usage.workerCostUsd.toFixed(4)),
    workerTurns: usage.workerTurns,
    workerTokens: total(usage.workerTokens),
    piTokens: total(usage.decision) + total(usage.reviewer),
    decisionCalls: usage.decision.calls,
    reviewerCalls: usage.reviewer.calls,
  };
}

function sanitize(value: unknown, key?: string): unknown {
  if (typeof value === "string") return String(redactSensitive(value, key)).slice(0, 4_000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  return redactSensitive(value, key);
}

function safeText(value: unknown): string {
  return String(sanitize(value));
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]<>]/gu, "\\$&").slice(0, 2_000);
}
