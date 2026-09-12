import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";

const timeoutMs = Number(process.env.SPIKE_TIMEOUT_MS ?? 90_000);
const args = [
  "--safe-mode",
  "--no-session-persistence",
  "--session-id", randomUUID(),
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--tools", "",
];

const child = spawn("claude", args, {
  shell: false,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdin.end(JSON.stringify({
  type: "user",
  message: { role: "user", content: "Reply with exactly SPIKE_OK. Do not use tools or inspect files." },
}) + "\n");

const timer = setTimeout(() => {
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}, timeoutMs);
const exit = await new Promise((resolve) => child.once("close", (code, signal) => resolve({code, signal})));
clearTimeout(timer);

const records = stdout.split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const init = records.find((record) => record.type === "system" && record.subtype === "init");
const result = records.find((record) => record.type === "result");
const rateLimit = records.find((record) => record.type === "rate_limit_event");
const assistantText = records
  .filter((record) => record.type === "assistant")
  .flatMap((record) => Array.isArray(record.message?.content) ? record.message.content : [])
  .filter((block) => block?.type === "text")
  .map((block) => block.text)
  .join("");
const resultText = typeof result?.result === "string" ? result.result : "";
const responseText = assistantText || resultText;
console.log(JSON.stringify({
  version: init?.claude_code_version ?? null,
  protocolRecords: records.length,
  sawInit: Boolean(init),
  sawResult: Boolean(result),
  sessionId: init?.session_id ?? result?.session_id ?? null,
  terminalReason: result?.terminal_reason ?? null,
  apiErrorStatus: result?.api_error_status ?? null,
  rateLimitStatus: rateLimit?.rate_limit_info?.status ?? null,
  rateLimitResetsAt: rateLimit?.rate_limit_info?.resetsAt ?? null,
  isError: result?.is_error ?? null,
  responseTextExact: responseText === "SPIKE_OK",
  responseTextLength: responseText.length,
  exitCode: exit.code,
  signal: exit.signal,
  stderrPresent: Boolean(stderr),
}, null, 2));

if (!init || !result) process.exitCode = 1;
else if (result.is_error) process.exitCode = 2;
else if (responseText !== "SPIKE_OK") process.exitCode = 3;
