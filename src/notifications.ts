import { createHmac, randomUUID } from "node:crypto";
import type { HumanInterventionNotice } from "./supervisor.ts";

export interface HumanWebhookOptions {
  url?: string;
  format?: "generic" | "wecom";
  secret?: string;
  timeoutMs?: number;
}

/** Outbound-only human escalation. Approval still happens through Pi/manual control. */
export class HumanWebhookNotifier {
  readonly #url?: string;
  readonly #format: "generic" | "wecom";
  readonly #secret?: string;
  readonly #timeoutMs: number;

  constructor(options: HumanWebhookOptions = {}) {
    this.#url = options.url;
    this.#format = options.format ?? "generic";
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  get enabled(): boolean { return Boolean(this.#url); }

  async notify(notice: HumanInterventionNotice): Promise<void> {
    if (!this.#url) return;
    const body = this.#format === "wecom" ? JSON.stringify(toWeCom(notice)) : JSON.stringify(toGeneric(notice));
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "pi-claude-supervisor/0.1" };
    if (this.#secret) headers["x-pi-supervisor-signature"] = `sha256=${createHmac("sha256", this.#secret).update(body).digest("hex")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(this.#url, { method: "POST", headers, body, signal: controller.signal });
      if (!response.ok) throw new Error(`human webhook returned HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function toGeneric(notice: HumanInterventionNotice): Record<string, unknown> {
  return {
    schema: "pi-claude-supervisor/human-intervention/v1",
    eventId: randomUUID(),
    event: "human_intervention_required",
    occurredAt: new Date().toISOString(),
    task: { id: notice.taskId, goal: notice.task, cwd: notice.cwd },
    worker: { id: notice.workerId },
    reason: notice.reason,
    question: notice.question,
    permission: notice.permission ? { ...notice.permission, input: sanitize(notice.permission.input) } : undefined,
    actions: ["approve_or_deny_permission", "send_instruction", "stop_worker", "takeover"],
    note: "This is an outbound notification. Use the Pi session or a separately authenticated callback service to approve actions.",
  };
}

function toWeCom(notice: HumanInterventionNotice): Record<string, unknown> {
  const permission = notice.permission ? `\n工具: ${notice.permission.toolName}\n请求 ID: ${notice.permission.requestId}` : "";
  const question = notice.question ? `\n问题: ${notice.question}` : "";
  return {
    msgtype: "markdown",
    markdown: {
      content: `### Claude Supervisor 需要人工介入\n> 任务: ${escapeMarkdown(notice.task)}\n> Task ID: ${notice.taskId}\n> 原因: ${escapeMarkdown(notice.reason)}${escapeMarkdown(question)}${escapeMarkdown(permission)}\n\n请在 Pi 中执行对应的 approve/deny、send、stop 或 takeover 操作。`,
    },
  };
}

function sanitize(value: unknown, key?: string): unknown {
  if (key && /(password|secret|token|api[-_]?key|authorization|credential)/iu.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/\\b(sk-ant-[A-Za-z0-9_-]+)\\b/gu, "[REDACTED]")
      .replace(/\\b(Bearer\\s+)[^\\s]+/giu, "$1[REDACTED]")
      .slice(0, 4_000);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  return value;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]<>]/gu, "\\$&").slice(0, 2_000);
}
