import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { HumanWebhookNotifier } from "./notifications.ts";
import type { CandidateNotice, HumanInterventionNotice } from "./supervisor.ts";

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

test("candidate webhook is an optional status notification, not an approval request", async () => {
  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_input, init) => {
    body = String(init?.body ?? "");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const candidate: CandidateNotice = { taskId: "task-candidate", cwd: "/tmp/work", task: "candidate task", reason: "review passed", status: "ready", deliverable: true };
  try {
    await new HumanWebhookNotifier({ url: "https://example.test/hook" }).notifyCandidate(candidate);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(body, /candidate_status/u);
  assert.match(body, /"deliverable":true/u);
  assert.doesNotMatch(body, /approve_or_deny_permission/u);
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

test("webhook retries a transient 503 and succeeds once the server recovers", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    if (requests === 1) { res.writeHead(503); res.end(); return; }
    res.writeHead(200); res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed to bind");
  try {
    await new HumanWebhookNotifier({ url: `http://127.0.0.1:${address.port}/hook`, maxAttempts: 3, retryDelaysMs: [1, 1] }).notify(notice);
    assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("webhook does not retry a non-retryable status", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(400);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed to bind");
  try {
    await assert.rejects(
      () => new HumanWebhookNotifier({ url: `http://127.0.0.1:${address.port}/hook`, maxAttempts: 3, retryDelaysMs: [1, 1] }).notify(notice),
      /HTTP 400/u,
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
