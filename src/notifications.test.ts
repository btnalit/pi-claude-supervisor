import assert from "node:assert/strict";
import test from "node:test";
import { HumanWebhookNotifier } from "./notifications.ts";
import type { HumanInterventionNotice } from "./supervisor.ts";

const notice: HumanInterventionNotice = {
  taskId: "task-1",
  workerId: "worker-1",
  cwd: "/tmp/work",
  task: "review sk-ant-very-secret Bearer hidden-token OPENAI_API_KEY=task-secret ghp_123456789012345678901234567890123456 github_pat_12345678901234567890 xoxb-12345678901234567890 npm_123456789012345678901234567890123456 AKIA1234567890ABCDEF",
  reason: "permission required X-Api-Key: reason-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
  question: "Should I use sk-ant-question-secret? --token question-secret",
  permission: {
    requestId: "request-1",
    toolUseId: "tool-1",
    toolName: "Bash",
    input: { command: "curl -H 'Authorization: Bearer hidden-value'", token: "raw-secret" },
  },
};

test("generic human webhook sanitizes all untrusted notice fields", async () => {
  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_input, init) => {
    body = String(init?.body ?? "");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    await new HumanWebhookNotifier({ url: "https://example.test/hook" }).notify(notice);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.doesNotMatch(body, /sk-ant-very-secret|hidden-token|hidden-value|raw-secret|task-secret|reason-secret|question-secret|ghp_123456789012345678901234567890123456|github_pat_12345678901234567890|xoxb-12345678901234567890|npm_123456789012345678901234567890123456|AKIA1234567890ABCDEF|eyJhbGciOiJIUzI1NiJ9/u);
  assert.match(body, /\[REDACTED\]/u);
});

test("wecom human webhook sanitizes task and question text", async () => {
  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_input, init) => {
    body = String(init?.body ?? "");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    await new HumanWebhookNotifier({ url: "https://example.test/hook", format: "wecom" }).notify(notice);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.doesNotMatch(body, /sk-ant-very-secret|sk-ant-question-secret|hidden-token|task-secret|reason-secret|question-secret|ghp_123456789012345678901234567890123456|github_pat_12345678901234567890|xoxb-12345678901234567890|npm_123456789012345678901234567890123456|AKIA1234567890ABCDEF|eyJhbGciOiJIUzI1NiJ9/u);
  assert.match(body, /\[REDACTED\]/u);
});
