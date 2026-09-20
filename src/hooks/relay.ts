import { BLOCKING_HOOK_EVENTS, HOOK_TIMEOUT_SECONDS } from "./types.ts";
import { nodeScriptCommand } from "../worker/runtime.ts";
import { shellQuote } from "../policy.ts";

/**
 * Plain JavaScript (no TypeScript syntax), executed by Claude Code as a hook
 * command via `node -e` or as a written file — the same embedded-script
 * pattern as GUARDED_BOOTSTRAP_SCRIPT in src/worker/process-adapter.ts. Runs
 * once per Claude Code hook event with the event JSON on stdin.
 *
 * Fails closed toward "no decision": any parse/IO/protocol problem exits 0
 * with empty stdout, so a relay bug never blocks Claude Code. The fast path
 * (no Supervisor listening for this cwd) never requires "net", matching the
 * expectation that it costs about a millisecond.
 */
export const HOOK_RELAY_SCRIPT = `
(function () {
  "use strict";
  var fs = require("fs");

  function sleepMs(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (e) { /* best effort; a missed sleep just spins the retry loop */ }
  }

  function readStdin() {
    var chunks = [];
    var buf = Buffer.alloc(65536);
    var eagainAttempts = 0;
    while (true) {
      var bytesRead;
      try {
        bytesRead = fs.readSync(0, buf, 0, buf.length, null);
      } catch (e) {
        // A non-blocking inherited stdin fd (a known Node/libuv quirk with
        // shared stdio) can raise EAGAIN before data is ready; retry with a
        // short sleep instead of silently dropping the event.
        if (e && e.code === "EAGAIN") {
          eagainAttempts += 1;
          if (eagainAttempts > 2000) return undefined;
          sleepMs(5);
          continue;
        }
        if (e && (e.code === "EOF" || e.code === "ENXIO")) break;
        return undefined;
      }
      if (!bytesRead) break;
      chunks.push(Buffer.from(buf.slice(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  var raw = readStdin();
  if (raw === undefined) return;
  var event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!event || typeof event !== "object" || typeof event.hook_event_name !== "string" || typeof event.cwd !== "string" || !event.cwd) return;

  var path = require("path");
  var os = require("os");
  var crypto = require("crypto");

  // The installed relay.js lives inside the hooks directory itself, so a
  // non-default state directory is found without any environment from Pi
  // (Claude's hook subprocess never sees Pi's env file). The env override
  // serves owned launches and tests; the home-directory path is the last resort.
  var scriptPath = typeof process.argv[1] === "string" ? process.argv[1] : "";
  var hookDir = process.env.PI_CLAUDE_SUPERVISOR_HOOK_DIR
    || (/[\\/]relay\.js$/.test(scriptPath) ? path.dirname(scriptPath) : "")
    || path.join(os.homedir(), ".pi", "agent", "claude-supervisor", "hooks");
  var canonicalCwd = event.cwd;
  try {
    canonicalCwd = fs.realpathSync(event.cwd);
  } catch (e) { /* fall back to the raw cwd */ }
  var hash = crypto.createHash("sha256").update(canonicalCwd).digest("hex");
  var socketPath = path.join(hookDir, "by-cwd", hash);

  // Fast path: no Supervisor owns this cwd. Check before requiring "net" so
  // the common case (no hooks configured / no owning Supervisor) is cheap.
  var socketInfo;
  try {
    socketInfo = fs.statSync(socketPath);
  } catch (e) {
    return;
  }
  if (!socketInfo.isSocket()) return;

  var BLOCKING_EVENTS = ${JSON.stringify([...BLOCKING_HOOK_EVENTS])};
  var blocking = BLOCKING_EVENTS.indexOf(event.hook_event_name) !== -1;
  var payload = JSON.stringify({
    version: 1,
    pid: process.pid,
    ppid: process.ppid,
    tmuxPane: process.env.TMUX_PANE,
    event: event,
  }) + "\\n";

  // The by-cwd entry is a symlink from the (possibly deep) state directory to
  // the real socket in a short runtime directory; connect to the resolved
  // target, since connect(2) needs the path itself to fit in sun_path.
  var connectPath = socketPath;
  try { connectPath = fs.realpathSync(socketPath); } catch (e) { /* connect through the symlink */ }
  if (Buffer.byteLength(connectPath, "utf8") > 104) return;

  var net = require("net");
  var socket = net.createConnection(connectPath);
  var finished = false;
  var timer;

  function finish() {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    try { socket.destroy(); } catch (e) { /* already closed */ }
  }

  socket.on("error", finish);

  if (!blocking) {
    // Fire-and-forget: hand the payload to the kernel and exit without
    // waiting for a reply.
    socket.on("connect", function () {
      socket.write(payload, function () { finish(); });
    });
    return;
  }

  timer = setTimeout(finish, ${(HOOK_TIMEOUT_SECONDS - 5) * 1000});
  if (timer.unref) timer.unref();

  var buffer = "";
  socket.setEncoding("utf8");
  socket.on("connect", function () { socket.write(payload); });
  socket.on("data", function (chunk) {
    if (finished) return;
    buffer += chunk;
    var newlineIndex = buffer.indexOf("\\n");
    if (newlineIndex === -1) return;
    var line = buffer.slice(0, newlineIndex);
    clearTimeout(timer);
    handleReply(line);
    finish();
  });
  socket.on("close", finish);

  function handleReply(line) {
    var reply;
    try {
      reply = JSON.parse(line);
    } catch (e) {
      return;
    }
    emitOutput(event.hook_event_name, reply);
  }

  function emitOutput(eventName, reply) {
    if (!reply || typeof reply !== "object") return;
    if (eventName === "PreToolUse" && (reply.permissionDecision === "allow" || reply.permissionDecision === "deny" || reply.permissionDecision === "ask")) {
      var preOutput = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: reply.permissionDecision } };
      if (typeof reply.permissionDecisionReason === "string") preOutput.hookSpecificOutput.permissionDecisionReason = reply.permissionDecisionReason;
      process.stdout.write(JSON.stringify(preOutput));
    } else if (eventName === "PermissionRequest" && (reply.permissionDecision === "allow" || reply.permissionDecision === "deny")) {
      // Documented shape (code.claude.com/docs/en/hooks.md, "PermissionRequest
      // decision control"): "message" is deny-only, never valid on allow.
      var decision = { behavior: reply.permissionDecision };
      if (reply.permissionDecision === "deny" && typeof reply.permissionDecisionReason === "string") decision.message = reply.permissionDecisionReason;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: decision } }));
    } else if (eventName === "Stop" && reply.block === true) {
      var stopOutput = { decision: "block" };
      if (typeof reply.blockReason === "string") stopOutput.reason = reply.blockReason;
      process.stdout.write(JSON.stringify(stopOutput));
    }
  }
})();
`;

export const HOOK_EMBEDDED_SCRIPTS = { relay: HOOK_RELAY_SCRIPT } as const;

/** The shell command line Claude's hook settings should run for a written relay.js at `relayPath`. */
export function hookRelayCommand(relayPath: string): string {
  return `${shellQuote(nodeScriptCommand())} ${shellQuote(relayPath)}`;
}

