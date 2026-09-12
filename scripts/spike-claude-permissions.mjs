import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const timeoutMs = Number(process.env.SPIKE_TIMEOUT_MS ?? 90_000);
const maxBytes = 512 * 1024;
const decision = process.env.SPIKE_PERMISSION_DECISION ?? "allow";
const target = join(process.env.TMPDIR ?? "/tmp", `pi-claude-permission-spike-${process.pid}`);
const args = [
  "--safe-mode",
  "--no-session-persistence",
  "--session-id", randomUUID(),
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--tools", "Bash",
  "--permission-mode", "default",
  "--permission-prompt-tool", "stdio",
];

await mkdir(join(process.env.TMPDIR ?? "/tmp"), { recursive: true });
await writeFile(target, "permission-spike-target\n");
const child = spawn("claude", args, { shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
let buffer = "";
let permissionRequest;
let result;
let init;
let responded = false;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout = boundedAppend(stdout, chunk, maxBytes);
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === "system" && record.subtype === "init") init = record;
    if (record.type === "control_request" && record.request?.subtype === "can_use_tool") {
      permissionRequest = record;
      if (!responded) {
        responded = true;
        const request = record.request;
        child.stdin.write(`${JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: record.request_id,
            response: decision === "deny"
              ? { behavior: "deny", message: "permission spike denied by host" }
              : { behavior: "allow", updatedInput: request.input },
            toolUseID: request.tool_use_id,
          },
        })}\n`);
      }
    }
    if (record.type === "result") {
      result = record;
      child.stdin.end();
    }
  }
});
child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk, maxBytes); });
child.stdin.write(`${JSON.stringify({
  type: "user",
  message: { role: "user", content: `Use Bash to run exactly: rm -f ${target}. Then reply with exactly PERM_SPIKE_OK.` },
})}\n`);

const timer = setTimeout(() => {
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
}, timeoutMs);
const exit = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
clearTimeout(timer);
await rm(target, { force: true });

const summary = {
  version: init?.claude_code_version ?? null,
  permissionRequest: Boolean(permissionRequest),
  permissionSubtype: permissionRequest?.request?.subtype ?? null,
  permissionTool: permissionRequest?.request?.tool_name ?? null,
  permissionDecision: decision,
  permissionRequestIdPresent: typeof permissionRequest?.request_id === "string",
  toolUseIdPresent: typeof permissionRequest?.request?.tool_use_id === "string",
  sawResult: Boolean(result),
  resultIsError: result?.is_error ?? null,
  resultText: typeof result?.result === "string" ? result.result : null,
  permissionDenials: result?.permission_denials ?? [],
  terminalReason: result?.terminal_reason ?? null,
  responseTextExact: decision === "deny"
    ? Array.isArray(result?.permission_denials) && result.permission_denials.length > 0
    : result?.result === "PERM_SPIKE_OK",
  exitCode: exit.code,
  signal: exit.signal,
  stderrPresent: Boolean(stderr),
  capturedBytes: Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8"),
};
console.log(JSON.stringify(summary, null, 2));
if (!init || !permissionRequest || !result || !summary.responseTextExact) process.exitCode = 1;

function boundedAppend(current, chunk, limit) {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= limit) return next;
  return Buffer.from(next, "utf8").subarray(-limit).toString("utf8");
}
