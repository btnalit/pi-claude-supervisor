import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const timeoutMs = Number(process.env.SPIKE_TIMEOUT_MS ?? 30_000);
const maxBytes = 256 * 1024;
const signals = ["SIGTERM", "SIGINT"];
const results = [];
for (const signal of signals) results.push(await runSignal(signal));
console.log(JSON.stringify({ version: results.find((item) => item.version)?.version ?? null, results }, null, 2));
if (results.some((item) => !item.init || !item.signalDelivered)) process.exitCode = 1;

async function runSignal(signal) {
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
  const child = spawn("claude", args, { shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stdout = "";
  let stderr = "";
  let init;
  let result;
  let sentSignal = false;
  const sendSignal = () => {
    if (sentSignal) return;
    sentSignal = true;
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  };
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
      if (record.type === "system" && record.subtype === "init") {
        init = record;
        // Kill immediately after the exact CLI init handshake, before a model
        // response can be mistaken for signal behavior.
        sendSignal();
      }
      if (record.type === "result") result = record;
    }
  });
  child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk, maxBytes); });
  child.stdin.write(`${JSON.stringify({
    type: "user",
    message: { role: "user", content: "Respond with exactly SIGNAL_SPIKE_OK after thinking carefully for a while." },
  })}\n`);

  const timer = setTimeout(sendSignal, timeoutMs);
  const exit = await new Promise((resolve) => child.once("close", (code, observedSignal) => resolve({ code, observedSignal })));
  clearTimeout(timer);
  return {
    signal,
    version: init?.claude_code_version ?? null,
    init: Boolean(init),
    signalDelivered: sentSignal,
    sawResult: Boolean(result),
    resultIsError: result?.is_error ?? null,
    terminalReason: result?.terminal_reason ?? null,
    exitCode: exit.code,
    observedSignal: exit.observedSignal,
    stderrPresent: Boolean(stderr),
    capturedBytes: Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8"),
  };
}

function boundedAppend(current, chunk, limit) {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= limit) return next;
  return Buffer.from(next, "utf8").subarray(-limit).toString("utf8");
}
