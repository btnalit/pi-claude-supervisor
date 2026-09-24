import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { TmuxWorkerAdapter, TMUX_EMBEDDED_SCRIPTS, claudeProjectSlug, effectiveToolInput, inputHoldsMessage, memoryRootFor, sweepDeadTmuxSockets, writeRootsOf } from "./tmux-adapter.ts";
import { isWorkerInputError } from "./input-error.ts";
import { isRoutinePermission, shellQuote } from "../policy.ts";
import { preflightCgroupContainment } from "./process-adapter.ts";
import type { HookEventSource, HookRelayReply, HookRelayRequest } from "../hooks/types.ts";
import type { WorkerEvent } from "../types.ts";

const tmuxAvailable = process.platform === "linux" && spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const automaticTmuxAvailable = tmuxAvailable && await (async () => {
  try { await preflightCgroupContainment(); return true; }
  catch { return false; }
})();

test("embedded tmux-adapter scripts are syntactically valid JavaScript", () => {
  for (const script of Object.values(TMUX_EMBEDDED_SCRIPTS)) {
    assert.doesNotThrow(() => new Function(script));
  }
});

test("automatic tmux preflight rejects disabled cgroup containment", { skip: process.platform !== "linux" || !tmuxAvailable }, async () => {
  const adapter = new TmuxWorkerAdapter({ cgroupMode: "off" });
  await assert.rejects(() => adapter.preflight({ cwd: process.cwd(), command: process.execPath, args: [], automatic: true }), /cgroup containment/u);
});

test("interactive preflight skips claude-jsonl stream-json arg validation", { skip: !automaticTmuxAvailable }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-interactive-preflight-"));
  const adapter = new TmuxWorkerAdapter({ stateDir });
  try {
    // "--model sonnet" is an ordinary interactive TUI arg; interactive mode
    // must preflight it as-is instead of injecting/validating stream-json flags.
    await adapter.preflight({ cwd: process.cwd(), command: process.execPath, args: ["--model", "sonnet"], automatic: true, interactive: true });
    // Same args, interactive: false, still resolve (claudeJsonlArgs tolerates them).
    await adapter.preflight({ cwd: process.cwd(), command: process.execPath, args: ["--model", "sonnet"], automatic: true, interactive: false });
    // An arg claudeJsonlArgs actively rejects proves the structured path still
    // validates while interactive bypasses it entirely.
    const conflictingArgs = ["--input-format", "text"];
    await adapter.preflight({ cwd: process.cwd(), command: process.execPath, args: conflictingArgs, automatic: true, interactive: true });
    await assert.rejects(
      () => adapter.preflight({ cwd: process.cwd(), command: process.execPath, args: conflictingArgs, automatic: true, interactive: false }),
      /--input-format must be stream-json in claude-jsonl mode/u,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("tmux adapter owns a private PTY, completes turns, and preserves output", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-test-"));
  const events: Array<{ type: string }> = [];
  const adapter = new TmuxWorkerAdapter({
    stateDir,
    pollIntervalMs: 40,
    startupTimeoutMs: 5_000,
    terminationGraceMs: 200,
  });
  try {
    const handle = await adapter.start({
      task: "first line\nsecond line",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "process.stdout.write('>\\n--------------------\\n'); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { for (const line of d.split('\\n').filter(Boolean)) { process.stdout.write('> ' + line + '\\n--------------------\\n'); setTimeout(() => process.stdout.write('DONE:' + line + '\\n>\\n--------------------\\n'), 180); } });"],
      eventListener: (event) => { events.push({ type: event.type }); },
    });
    assert.equal(handle.ownership, "owned");
    assert.match(handle.tmuxSocket ?? "", /pi-cs-/u);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(events.some((event) => event.type === "turn_completed"), false);
    await waitFor(() => events.some((event) => event.type === "turn_completed"));
    const firstOutput = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    assert.match(firstOutput, /first line/u);
    assert.match(firstOutput, /second line/u);

    // Coloured check output inside a repair message is neutralised, not refused.
    await adapter.send(handle, "coloured\u001b[31mred\u001b[0m\u0007", "coloured-input");
    await waitFor(() => events.filter((event) => event.type === "turn_completed").length === 2);
    const colouredOutput = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    assert.match(colouredOutput, /DONE:colouredred/u);
    await adapter.send(handle, "follow-up", "test-follow-up");
    await waitFor(() => events.filter((event) => event.type === "turn_completed").length === 3);
    const secondOutput = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    assert.match(secondOutput, /DONE:.*follow-up/u);

    await adapter.stop(handle, "test complete");
    const status = await adapter.getStatus(handle);
    assert.equal(status.running, false);
    assert.equal(status.processGroupCleaned, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("owned tmux startup tears down a partially created server", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-partial-start-test-"));
  const wrapper = join(stateDir, "tmux-wrapper.sh");
  const argsLog = join(stateDir, "new-session-args.log");
  await writeFile(wrapper, "#!/bin/sh\nif [ \"$3\" = \"new-session\" ]; then printf '%s\\n' \"$@\" > \"$TMUX_ARGS_LOG\"; fi\nif [ \"$3\" = \"set-window-option\" ]; then exit 77; fi\nexec tmux \"$@\"\n");
  await chmod(wrapper, 0o700);
  const adapter = new TmuxWorkerAdapter({ stateDir, tmuxBinary: wrapper, startupTimeoutMs: 5_000 });
  let failure;
  try {
    await adapter.start({ task: "partial startup", cwd: process.cwd(), command: process.execPath, args: ["-e", "process.stdout.write('>\\n'); process.stdin.resume();"], env: { TMUX_ARGS_LOG: argsLog } });
  } catch (error) {
    failure = error as Error & { workerHandle?: { tmuxSocket?: string; sessionName?: string } };
  }
  try {
    assert.ok(failure);
    const newSessionArgs = (await readFile(argsLog, "utf8")).trim().split("\n");
    assert.ok(newSessionArgs.includes(process.execPath));
    const handle = failure.workerHandle;
    assert.ok(handle?.tmuxSocket);
    assert.notEqual(spawnSync("tmux", ["-S", handle.tmuxSocket, "has-session", "-t", handle.sessionName!], { stdio: "ignore" }).status, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("owned tmux guardian kills the session after an unexpected Supervisor death", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-guardian-test-"));
  const childScript = join(stateDir, "parent.mjs");
  const adapterUrl = new URL("./tmux-adapter.ts", import.meta.url).href;
  await writeFile(childScript, `import { TmuxWorkerAdapter } from ${JSON.stringify(adapterUrl)};\nconst adapter = new TmuxWorkerAdapter({ stateDir: process.env.STATE_DIR, pollIntervalMs: 40, startupTimeoutMs: 5_000 });\nconst handle = await adapter.start({ task: "guardian", cwd: "/tmp", command: process.execPath, args: ["-e", "process.stdout.write('>\\\\n'); process.stdin.resume(); setInterval(() => {}, 10000);"], sendInitialInput: false });\nprocess.stdout.write(JSON.stringify({ socket: handle.tmuxSocket, session: handle.sessionName }) + "\\n");\nsetInterval(() => {}, 10_000);\n`);
  const child = spawn(process.execPath, ["--experimental-strip-types", childScript], { env: { ...process.env, STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const ready = new Promise<{ socket: string; session: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`guardian child startup timed out: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n").find(Boolean);
      if (!line) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(line) as { socket: string; session: string }); }
      catch (error) { reject(error); }
    });
    child.once("error", reject);
  });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    const identity = await ready;
    assert.equal(spawnSync("tmux", ["-S", identity.socket, "has-session", "-t", identity.session], { stdio: "ignore" }).status, 0);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (spawnSync("tmux", ["-S", identity.socket, "has-session", "-t", identity.session], { stdio: "ignore" }).status !== 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`guardian did not remove ${identity.session}`);
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("release stops the owned interactive guardian, so a released session survives Supervisor exit", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-interactive-guardian-release-"));
  const fakeClaude = join(stateDir, "claude");
  const pidFile = join(stateDir, "claude.pid");
  const hookSettingsPath = join(stateDir, "hook-settings.json");
  await writeFile(hookSettingsPath, "{}");
  await writeFile(fakeClaude, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.PI_TEST_PIDFILE, String(process.pid));
process.stdout.write("\\n>\\n");
process.stdin.resume();
setInterval(() => {}, 10000);
`);
  await chmod(fakeClaude, 0o700);
  const driverScript = join(stateDir, "driver.mjs");
  const adapterUrl = new URL("./tmux-adapter.ts", import.meta.url).href;
  await writeFile(driverScript, `
import { TmuxWorkerAdapter } from ${JSON.stringify(adapterUrl)};
import { readFileSync } from "node:fs";
const stateDir = process.env.STATE_DIR;
const pidFile = process.env.PID_FILE;
const hookSettingsPath = process.env.HOOK_SETTINGS;
const fakeClaude = process.env.FAKE_CLAUDE;
let handler;
const hookSource = {
  subscribe: async (cwd, h) => { handler = h; return async () => { handler = undefined; }; },
};
const adapter = new TmuxWorkerAdapter({ stateDir, inputConfirmTimeoutMs: 300, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
const startPromise = adapter.start({
  task: "guardian release test",
  cwd: stateDir,
  command: fakeClaude,
  args: [],
  env: { HOME: stateDir + "/home", CLAUDE_CONFIG_DIR: stateDir + "/config", PI_TEST_PIDFILE: pidFile },
  automatic: true,
  interactive: true,
  hookSource,
  hookSettingsPath,
  sendInitialInput: false,
});
let fakePid;
for (let attempt = 0; attempt < 200; attempt += 1) {
  try {
    const content = readFileSync(pidFile, "utf8").trim();
    if (content) { fakePid = Number(content); break; }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 20));
}
for (let attempt = 0; attempt < 200 && !handler; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
await handler({ version: 1, pid: fakePid + 1, ppid: fakePid, event: { hook_event_name: "SessionStart", session_id: "session-1", cwd: stateDir } });
const handle = await startPromise;
// Simulate a normal completion: Supervisor releases the session (leaving it
// open for the user) before the process later exits.
await adapter.release(handle, "simulate normal completion before Supervisor exit");
process.stdout.write(JSON.stringify({ socket: handle.tmuxSocket, session: handle.sessionName }) + "\\n");
setInterval(() => {}, 10_000);
`);
  const child = spawn(process.execPath, ["--experimental-strip-types", driverScript], {
    env: { ...process.env, STATE_DIR: stateDir, PID_FILE: pidFile, HOOK_SETTINGS: hookSettingsPath, FAKE_CLAUDE: fakeClaude },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const ready = new Promise<{ socket: string; session: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`driver did not become ready: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n").find(Boolean);
      if (!line) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(line) as { socket: string; session: string }); }
      catch (error) { reject(error); }
    });
    child.once("error", reject);
  });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  let identity: { socket: string; session: string } | undefined;
  try {
    identity = await ready;
    assert.equal(spawnSync("tmux", ["-S", identity.socket, "has-session", "-t", identity.session], { stdio: "ignore" }).status, 0);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    // A still-armed guardian polls every 100ms and would remove the session
    // shortly after the parent dies; give it several chances to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(spawnSync("tmux", ["-S", identity.socket, "has-session", "-t", identity.session], { stdio: "ignore" }).status, 0);
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    if (identity) spawnSync("tmux", ["-S", identity.socket, "kill-server"], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("release migrates an owned interactive session's cgroup, leaving it detached and still running", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  // Interactive sessions are always started with retainCgroupUntilLeaseRelease
  // (index.ts passes retainCgroupUntilLeaseRelease: taskAutomation, and
  // interactive implies taskAutomation), so the production shape leaves the
  // verified-empty cgroup directory for the cwd lease's own release to reclaim.
  const fixture = await startInteractiveOwnedFixture({ retainCgroupUntilLeaseRelease: true });
  const { adapter, handle, stateDir } = fixture;
  try {
    const cgroupPath = handle.cgroupPath;
    assert.ok(cgroupPath, "an owned interactive session must be cgroup-contained");
    await adapter.release(handle, "task completed; interactive session kept open");
    const status = await adapter.getStatus(handle);
    assert.equal(status.detached, true);
    assert.equal(status.running, true);
    // The processes are intentionally still alive; the released Supervisor
    // must not claim the process-group boundary was cleaned.
    assert.equal(status.processGroupCleaned, false);
    assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "has-session", "-t", handle.sessionName!], { stdio: "ignore" }).status, 0);
    // Every process (the launcher and the fake Claude it spawned) was
    // migrated out of the Worker cgroup, which is left behind verified empty
    // for the cwd lease to reclaim.
    const cgroupProcs = (await readFile(join(cgroupPath!, "cgroup.procs"), "utf8")).trim();
    assert.equal(cgroupProcs, "");
  } finally {
    await adapter.killProcessGroup(handle, "test cleanup").catch(() => {});
    // retainCgroupUntilLeaseRelease leaves the emptied directory behind for
    // the cwd lease's own release to reclaim; nothing here plays that role.
    if (handle.cgroupPath) await rmdir(handle.cgroupPath).catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("killProcessGroup after release still closes a kept-open interactive session", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture({ retainCgroupUntilLeaseRelease: true });
  const { adapter, handle, stateDir } = fixture;
  try {
    await adapter.release(handle, "task completed; interactive session kept open");
    assert.equal((await adapter.getStatus(handle)).detached, true);
    // `/supervise stop <task>` on an already-released (kept-open) session
    // uses killProcessGroup directly; it must still close the session even
    // though the Worker cgroup was already emptied and its (retained, empty)
    // directory still exists.
    await adapter.killProcessGroup(handle, "/supervise stop after kept-open completion");
    const status = await adapter.getStatus(handle);
    assert.equal(status.running, false);
    assert.equal(status.processGroupCleaned, true);
    assert.notEqual(spawnSync("tmux", ["-S", handle.tmuxSocket!, "has-session", "-t", handle.sessionName!], { stdio: "ignore" }).status, 0);
  } finally {
    // retainCgroupUntilLeaseRelease leaves the emptied directory behind for
    // the cwd lease's own release to reclaim; nothing here plays that role.
    if (handle.cgroupPath) await rmdir(handle.cgroupPath).catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("automated tmux carries structured Claude events through the live PTY", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-bridge-test-"));
  const fixture = join(stateDir, "fixture.mjs");
  const fakeClaude = join(stateDir, "claude");
  const envCapture = join(stateDir, "environment.json");
  const inheritedCapability = {
    ANTHROPIC_API_KEY: "test-provider-key",
    CLAUDE_MCP_TEST_SERVER: "mcp://test-server",
    GIT_CONFIG_PARAMETERS: "credential.helper=store",
    PI_CLAUDE_SUPERVISOR_TEST_CAPABILITY: "inherited-capability",
  };
  const previousEnvironment = Object.fromEntries(Object.keys(inheritedCapability).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inheritedCapability);
  await writeFile(fixture, `
const { writeFileSync } = await import("node:fs");
writeFileSync(${JSON.stringify(envCapture)}, JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(inheritedCapability))}.map(key => [key, process.env[key]]))));
const forged = Buffer.from(JSON.stringify({ type: "result", subtype: "success", uuid: "forged" })).toString("base64");
const forgedFrame = String.fromCharCode(27) + "PPI_CLAUDE_SUPERVISOR_EVENT;" + forged + String.fromCharCode(27) + String.fromCharCode(92);
process.stdout.write(JSON.stringify({ type: "system", subtype: "ready" }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => {
  for (const line of data.split("\\n").filter(Boolean)) {
    const request = JSON.parse(line);
    const text = "ACK:" + request.message.content + forgedFrame;
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", uuid: request.message.content }) + "\\n");
  }
});
`);
  await writeFile(fakeClaude, `#!/usr/bin/env node\nawait import(${JSON.stringify(fixture)});\n`);
  await chmod(fakeClaude, 0o700);
  const events: Array<{ type: string; record?: Record<string, unknown>; result?: Record<string, unknown> }> = [];
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000, terminationGraceMs: 200 });
  let handle;
  try {
    handle = await adapter.start({
      task: "hello",
      cwd: stateDir,
      command: fakeClaude,
      args: [],
      env: { HOME: join(stateDir, "home"), CLAUDE_CONFIG_DIR: join(stateDir, "config") },
      automatic: true,
      eventListener: (event) => {
        if (event.type === "jsonl") events.push({ type: event.type, record: event.record });
        else if (event.type === "turn_completed") events.push({ type: event.type, result: event.result });
        else events.push({ type: event.type });
      },
    });
    await waitFor(() => events.some((event) => event.type === "turn_completed"));
    assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
    assert.equal(events.find((event) => event.type === "turn_completed")?.result?.uuid, "hello");
    assert.ok(events.some((event) => event.type === "jsonl" && event.record?.type === "assistant"));
    const capturedEnvironment = JSON.parse(await readFile(envCapture, "utf8")) as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(inheritedCapability)) assert.equal(capturedEnvironment[key], value);
    const output = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    assert.match(output, /ACK:hello/u);
    assert.doesNotMatch(output, /\u001bPPI_CLAUDE_SUPERVISOR_EVENT|@pi:user/u);
    const bufferName = `pi-cs-human-${handle.id}`;
    assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "load-buffer", "-b", bufferName, "-"], { input: "human-next", stdio: ["pipe", "ignore", "pipe"] }).status, 0);
    assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "paste-buffer", "-p", "-d", "-b", bufferName, "-t", handle.tmuxPaneId!], { stdio: "ignore" }).status, 0);
    assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "send-keys", "-t", handle.tmuxPaneId!, "Enter"], { stdio: "ignore" }).status, 0);
    await waitFor(() => events.filter((event) => event.type === "turn_completed").length === 2);
    assert.match((await adapter.readOutput(handle)).map((chunk) => chunk.text).join(""), /ACK:human-next/u);
    // A repair-sized message is past the PTY's 4095-byte line limit; it must
    // arrive whole, and the echoed control lines must not look like a new
    // human turn once the result is in.
    const long = `repair:${"L".repeat(6_000)}`;
    await adapter.send(handle, long, "long-message");
    await waitFor(() => events.filter((event) => event.type === "turn_completed").length === 3);
    assert.equal(events.filter((event) => event.type === "turn_completed").at(-1)?.result?.uuid, long);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
    await adapter.stop(handle, "bridge test complete");
    const status = await adapter.getStatus(handle);
    assert.equal(status.cleanupError, undefined);
    assert.equal(status.runtimeError, undefined);
  } finally {
    if (handle) await adapter.stop(handle, "bridge test cleanup").catch(() => {});
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("automatic tmux rechecks permission settings in the bridge before Claude spawn", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-pre-spawn-check-"));
  const home = join(stateDir, "home");
  const configDir = join(stateDir, "config");
  const cwd = join(stateDir, "repo");
  const fakeClaude = join(stateDir, "claude");
  const spawned = join(stateDir, "spawned");
  let preSpawnChecks = 0;
  let startupCalls = 0;
  let preparedCalls = 0;
  try {
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Edit"] } }));
    await writeFile(fakeClaude, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(spawned)}, "spawned"); process.stdout.write(JSON.stringify({ type: "system", subtype: "ready" }) + "\\n"); process.stdin.resume();\n`);
    await chmod(fakeClaude, 0o700);
    const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 30, startupTimeoutMs: 1_000, terminationGraceMs: 100 });
    await assert.rejects(
      () => adapter.start({
        task: "must not spawn",
        cwd,
        command: fakeClaude,
        args: [],
        env: { HOME: home, CLAUDE_CONFIG_DIR: configDir },
        automatic: true,
        sendInitialInput: false,
        onWorkerStartup: async (handle) => {
          startupCalls += 1;
          assert.equal(startupCalls, 1);
          assert.ok(handle.cgroupPath);
          await assert.rejects(() => access(handle.cgroupPath!), /ENOENT/u);
          await assert.rejects(() => access(handle.tmuxSocket!), /ENOENT/u);
        },
        onWorkerPrepared: async (handle) => {
          preparedCalls += 1;
          assert.ok(handle.cgroupPath);
          await access(join(handle.cgroupPath!, "cgroup.events"));
          if (preparedCalls === 1) {
            // The cgroup identity is persisted before the guardian/server
            // startup window begins.
            await assert.rejects(() => access(handle.tmuxSocket!), /ENOENT/u);
          } else {
            assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "has-session", "-t", handle.sessionName!], { stdio: "ignore" }).status, 0);
          }
        },
        preSpawnCheck: async () => {
          preSpawnChecks += 1;
          await writeFile(join(configDir, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }));
        },
      }),
      /startup timeout|did not reach an input prompt/u,
    );
    assert.equal(startupCalls, 1);
    assert.equal(preparedCalls, 2);
    assert.equal(preSpawnChecks, 1);
    await assert.rejects(() => access(spawned), /ENOENT/u);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("automatic tmux prevents a queued permission response reaching a respawned pane", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-permission-race-"));
  const fixture = join(stateDir, "fixture.mjs");
  const fakeClaude = join(stateDir, "claude");
  const firstDelivered = join(stateDir, "first-delivered");
  const firstHold = join(stateDir, "first-hold");
  const firstRelease = join(stateDir, "first-release");
  const secondHold = join(stateDir, "second-hold");
  const secondAt = join(stateDir, "second-at-send");
  const secondRelease = join(stateDir, "second-release");
  const replacementAccepted = join(stateDir, "replacement-accepted");
  const tmuxWrapper = join(stateDir, "tmux-wrapper.sh");
  await writeFile(fixture, `
import { writeFileSync } from "node:fs";
process.stdout.write(JSON.stringify({ type: "system", subtype: "ready" }) + "\\n");
process.stdin.setEncoding("utf8");
let responses = 0;
process.stdin.on("data", data => {
  for (const line of data.split("\\n").filter(Boolean)) {
    const value = JSON.parse(line);
    if (value.type === "user") for (const [requestId, toolUseId] of [["race-request-1", "race-tool-1"], ["race-request-2", "race-tool-2"]]) {
      process.stdout.write(JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_use_id: toolUseId, tool_name: "Bash", input: { command: "printf RACE" } } }) + "\\n");
    }
    if (value.type === "control_response" && ++responses === 1) writeFileSync(process.env.PI_CLAUDE_SUPERVISOR_RACE_DELIVERED, "delivered");
  }
});
process.stdin.resume();
setInterval(() => {}, 10000);
`);
  await writeFile(fakeClaude, `#!/usr/bin/env node\nawait import(${JSON.stringify(fixture)});\n`);
  await chmod(fakeClaude, 0o700);
  await writeFile(tmuxWrapper, `#!/bin/sh
real=/usr/bin/tmux
case " $* " in
  *" send-keys "*)
    if [ -e ${firstHold} ] && [ ! -e ${firstRelease} ]; then
      "$real" "$@"
      status=$?
      while [ ! -e ${firstRelease} ]; do sleep 0.01; done
      exit "$status"
    fi
    if [ -e ${secondHold} ] && [ ! -e ${secondRelease} ]; then
      : > ${secondAt}
      while [ ! -e ${secondRelease} ]; do sleep 0.01; done
    fi
    ;;
esac
exec "$real" "$@"
`);
  await chmod(tmuxWrapper, 0o700);
  const events: import("../types.ts").WorkerEvent[] = [];
  const adapter = new TmuxWorkerAdapter({ tmuxBinary: tmuxWrapper, stateDir, pollIntervalMs: 30, startupTimeoutMs: 5_000, terminationGraceMs: 100 });
  let handle;
  try {
    handle = await adapter.start({
      task: "permission race",
      cwd: stateDir,
      command: fakeClaude,
      args: [],
      env: {
        HOME: join(stateDir, "home"),
        CLAUDE_CONFIG_DIR: join(stateDir, "config"),
        PI_CLAUDE_SUPERVISOR_RACE_DELIVERED: firstDelivered,
      },
      automatic: true,
      eventListener: (event) => { events.push(event); },
    });
    let permissions: Array<Extract<import("../types.ts").WorkerEvent, { type: "permission_request" }>> = [];
    await waitFor(() => {
      permissions = events.filter((event): event is Extract<import("../types.ts").WorkerEvent, { type: "permission_request" }> => event.type === "permission_request");
      return permissions.length === 2;
    });
    await writeFile(firstHold, "");
    const firstResponse = adapter.respondPermission(handle, permissions[0].request.requestId, permissions[0].request.toolUseId, { behavior: "allow" }, permissions[0].request.input);
    const queuedResponse = adapter.respondPermission(handle, permissions[1].request.requestId, permissions[1].request.toolUseId, { behavior: "allow" }, permissions[1].request.input);
    await waitForFile(firstDelivered);
    // The first response has reached the original Claude process, but its
    // tmux command remains in the input gate so the second response is queued.
    await writeFile(secondHold, "");
    await writeFile(firstRelease, "");
    await waitForFile(secondAt);
    const replacementGeneration = "replacement-generation";
    const replacementScript = `const fs = require("node:fs"); const generation = ${JSON.stringify(replacementGeneration)}; process.stdin.setEncoding("utf8"); process.stdin.on("data", data => { for (const line of data.split("\\n").filter(Boolean)) { if (line.startsWith("@pi:control " + generation + " ") || line.startsWith("@pi:user ") || line.startsWith("@pi:json ") || line === "@pi:stop") fs.appendFileSync(${JSON.stringify(replacementAccepted)}, "accepted\\n"); } }); process.stdin.resume(); setInterval(() => {}, 10000);`;
    assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "respawn-pane", "-k", "-t", handle.tmuxPaneId!, "--", process.execPath, "-e", replacementScript], { stdio: "ignore" }).status, 0);
    await writeFile(secondRelease, "");
    await firstResponse;
    await assert.rejects(
      queuedResponse,
      /tmux pane identity changed|pane identity unavailable|pane is no longer available/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(() => access(replacementAccepted), /ENOENT/u);
  } finally {
    await writeFile(firstRelease, "").catch(() => {});
    await writeFile(secondRelease, "").catch(() => {});
    if (handle) await adapter.stop(handle, "permission pane replacement cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("automatic tmux ignores wrapped Supervisor input after a result", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-wrapped-input-test-"));
  const fixture = join(stateDir, "fixture.mjs");
  const fakeClaude = join(stateDir, "claude");
  await writeFile(fixture, `
process.stdout.write(JSON.stringify({ type: "system", subtype: "ready" }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => {
  for (const line of data.split("\\n").filter(Boolean)) {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", uuid: request.message.content }) + "\\n");
  }
});
process.stdin.resume();
setInterval(() => {}, 10000);
`);
  await writeFile(fakeClaude, `#!/usr/bin/env node\nawait import(${JSON.stringify(fixture)});\n`);
  await chmod(fakeClaude, 0o700);
  const events: Array<{ type: string; sequence?: number }> = [];
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 30, startupTimeoutMs: 5_000, terminationGraceMs: 100 });
  const task = "long Supervisor input that must not look like a human prompt ".repeat(20);
  let handle;
  try {
    handle = await adapter.start({ task, cwd: stateDir, command: fakeClaude, args: [], env: { HOME: join(stateDir, "home"), CLAUDE_CONFIG_DIR: join(stateDir, "config") }, automatic: true,
      eventListener: (event) => { if (event.type === "turn_completed") events.push({ type: event.type, sequence: event.sequence }); } });
    await waitFor(() => events.some((event) => event.sequence === 1));
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
    await adapter.send(handle, "second turn", "wrapped-input-second");
    await waitFor(() => events.some((event) => event.sequence === 2));
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
  } finally {
    if (handle) await adapter.stop(handle, "wrapped input cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("automatic tmux pane exit is clean teardown, not a nested-process failure", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-pane-exit-test-"));
  const fixture = join(stateDir, "fixture.mjs");
  const fakeClaude = join(stateDir, "claude");
  await writeFile(fixture, `
process.stdout.write(JSON.stringify({ type: "system", subtype: "ready" }) + "\\n");
process.stdin.resume();
setInterval(() => {}, 10000);
`);
  await writeFile(fakeClaude, `#!/usr/bin/env node\nawait import(${JSON.stringify(fixture)});\n`);
  await chmod(fakeClaude, 0o700);
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 30, startupTimeoutMs: 5_000, terminationGraceMs: 100 });
  let handle;
  try {
    handle = await adapter.start({ task: "pane exit", cwd: stateDir, command: fakeClaude, args: [], env: { HOME: join(stateDir, "home"), CLAUDE_CONFIG_DIR: join(stateDir, "config") }, automatic: true });
    assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "kill-pane", "-t", handle.tmuxPaneId!], { stdio: "ignore" }).status, 0);
    let status;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await adapter.getStatus(handle);
      if (!status.running) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(status?.running, false);
    assert.equal(status?.processGroupCleaned, true);
    assert.equal(status?.cgroupCleaned, true);
    assert.equal(status?.runtimeError, undefined);
    assert.equal(status?.cleanupError, undefined);
    assert.notEqual(spawnSync("tmux", ["-S", handle.tmuxSocket!, "has-session", "-t", handle.sessionName!], { stdio: "ignore" }).status, 0);
  } finally {
    if (handle) await adapter.stop(handle, "pane exit cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("automatic tmux allows a Claude child and cgroup cleanup reaps it", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-nested-test-"));
  const fixture = join(stateDir, "fixture.mjs");
  const fakeClaude = join(stateDir, "claude");
  const nestedClaude = join(stateDir, "nested", "claude");
  const nestedPidFile = join(stateDir, "nested.pid");
  await mkdir(join(stateDir, "nested"), { recursive: true });
  await copyFile(process.execPath, nestedClaude);
  await chmod(nestedClaude, 0o700);
  await writeFile(fixture, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const nested = ${JSON.stringify(nestedClaude)};
const nestedPidFile = ${JSON.stringify(nestedPidFile)};
process.stdout.write(JSON.stringify({ type: "system", subtype: "ready" }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => {
  for (const line of data.split("\\n").filter(Boolean)) {
    const request = JSON.parse(line);
    const child = spawn(nested, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    if (child.pid) writeFileSync(nestedPidFile, String(child.pid));
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", uuid: request.message.content }) + "\\n");
  }
});
`);
  await writeFile(fakeClaude, `#!/usr/bin/env node\nawait import(${JSON.stringify(fixture)});\n`);
  await chmod(fakeClaude, 0o700);
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 30, startupTimeoutMs: 5_000, terminationGraceMs: 100 });
  let handle;
  let nestedPid: number | undefined;
  try {
    handle = await adapter.start({ task: "trigger", cwd: stateDir, command: fakeClaude, args: [], env: { HOME: join(stateDir, "home"), CLAUDE_CONFIG_DIR: join(stateDir, "config") }, automatic: true });
    let status;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await adapter.getStatus(handle);
      if (status.activeRequests === 0 || status.runtimeError || !status.running) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(status?.running, true);
    assert.equal(status?.runtimeError, undefined);
    assert.equal(status?.activeRequests, 0);
    for (let attempt = 0; attempt < 20 && nestedPid === undefined; attempt += 1) {
      try { nestedPid = Number(await readFile(nestedPidFile, "utf8")); }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.ok(nestedPid && nestedPid > 0);
  } finally {
    if (handle) await adapter.stop(handle, "nested Claude test cleanup").catch(() => {});
    if (nestedPid) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { process.kill(nestedPid, 0); }
        catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.throws(() => process.kill(nestedPid!, 0), /ESRCH/u);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("owned tmux identity can be re-adopted after restart", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-re-adopt-test-"));
  const claudeBinary = join(stateDir, "claude");
  await copyFile(process.execPath, claudeBinary);
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
  let handle;
  try {
    handle = await adapter.start({
      task: "owned task",
      cwd: process.cwd(),
      command: claudeBinary,
      args: ["-e", "process.stdout.write('>\\n'); process.stdin.resume(); setInterval(() => {}, 10000);"],
      sendInitialInput: false,
    });
    assert.equal(handle.ownership, "owned");
    assert.match(handle.tmuxPaneId ?? "", /^%[0-9]+$/u);
    await adapter.release(handle, "simulate Pi restart");
    const readoptedAdapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
    const readopted = await readoptedAdapter.start({
      task: "owned task must not replay",
      cwd: process.cwd(),
      command: "claude",
      tmuxSession: handle.sessionName,
      tmuxSocket: handle.tmuxSocket,
      tmuxExpectedIdentity: {
        pid: handle.pid,
        startTime: handle.paneStartTime,
        tmuxTarget: handle.tmuxTarget,
        tmuxPaneId: handle.tmuxPaneId,
        paneStartTime: handle.paneStartTime,
        paneCommand: handle.paneCommand,
      },
    });
    assert.equal(readopted.ownership, "adopted");
    await readoptedAdapter.stop(readopted, "detach after re-adopt");
    const releasedStatus = await readoptedAdapter.getStatus(readopted);
    assert.equal(releasedStatus.running, true);
    assert.equal(releasedStatus.processGroupCleaned, true);
  } finally {
    if (handle) {
      await adapter.stop(handle, "owned re-adopt test complete").catch(() => {});
      if (handle.tmuxSocket && handle.sessionName) spawnSync("tmux", ["-S", handle.tmuxSocket, "kill-session", "-t", handle.sessionName], { stdio: "ignore" });
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("released tmux identity mismatch retains live status and cleanup uncertainty", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-identity-mismatch-"));
  const claudeBinary = join(stateDir, "claude");
  await copyFile(process.execPath, claudeBinary);
  const fixture = "process.stdout.write('>\\n--------------------\\n'); process.stdin.resume(); setInterval(() => {}, 10000);";
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
  let handle;
  try {
    handle = await adapter.start({ task: "identity mismatch", cwd: process.cwd(), command: claudeBinary, args: ["-e", fixture], sendInitialInput: false });
    await adapter.release(handle, "identity mismatch probe");
    const replacement = spawnSync("tmux", ["-S", handle.tmuxSocket!, "respawn-pane", "-k", "-t", handle.tmuxPaneId!, "--", claudeBinary, "-e", fixture], { encoding: "utf8" });
    assert.equal(replacement.status, 0, replacement.stderr);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await adapter.getStatus(handle);
    assert.equal(status.running, true);
    assert.match(status.cleanupError ?? "", /identity/u);
  } finally {
    if (handle?.tmuxSocket && handle.sessionName) spawnSync("tmux", ["-S", handle.tmuxSocket, "kill-session", "-t", handle.sessionName], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("explicit idle startup does not submit a blank turn", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-idle-test-"));
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
  let handle;
  try {
    handle = await adapter.start({
      task: "original task must not be replayed",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "process.stdout.write('>\\n'); process.stdin.resume(); setInterval(() => {}, 10000);"],
      sendInitialInput: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
    const output = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    assert.doesNotMatch(output, /original task/u);
  } finally {
    if (handle) await adapter.stop(handle, "idle test complete");
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adoption setup failure leaves the user's tmux server alive", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-adopt-failure-test-"));
  const sessionName = `pi-adopt-failure-${process.pid}-${Date.now()}`;
  const claudeBinary = join(stateDir, "claude");
  await copyFile(process.execPath, claudeBinary);
  const created = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", process.cwd(), claudeBinary, "-e", "process.stdout.write('>\\n'); setInterval(() => {}, 1000)"], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const pipePath = join(stateDir, "existing-pipe.log");
  spawnSync("tmux", ["pipe-pane", "-t", sessionName, `cat >> '${pipePath.replaceAll("'", "'\\''")}'`], { encoding: "utf8" });
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
  try {
    await assert.rejects(() => adapter.start({ task: "observe", cwd: process.cwd(), command: "claude", tmuxSession: sessionName, sendInitialInput: false }), /already has an output pipe/u);
    const listed = spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
    assert.equal(listed.status, 0);
  } finally {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adoption rejects a node process that only mentions claude in its arguments", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-adopt-node-test-"));
  const sessionName = `pi-adopt-node-${process.pid}-${Date.now()}`;
  const created = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", process.cwd(), process.execPath, "-e", "process.stdout.write('>\\n'); setInterval(() => {}, 1000); console.log('claude')"], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
  try {
    await assert.rejects(() => adapter.start({ task: "must not adopt node", cwd: process.cwd(), command: "claude", tmuxSession: sessionName, sendInitialInput: false }), /not a Claude Code executable/u);
    assert.equal(spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" }).status, 0);
  } finally {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adoption accepts a Node launcher whose Claude script has a Claude executable name", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-adopt-node-wrapper-test-"));
  const sessionName = `pi-adopt-node-wrapper-${process.pid}-${Date.now()}`;
  const claudeScript = join(stateDir, "claude");
  await writeFile(claudeScript, `#!/usr/bin/env node
process.stdout.write(">\\n");
setInterval(() => {}, 1000);
`);
  await chmod(claudeScript, 0o700);
  const created = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", process.cwd(), claudeScript], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
  try {
    const handle = await adapter.start({ task: "observe node wrapper", cwd: process.cwd(), command: "claude", tmuxSession: sessionName, sendInitialInput: false });
    assert.equal(handle.ownership, "adopted");
    await adapter.stop(handle, "detach node wrapper");
    assert.equal(spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" }).status, 0);
  } finally {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adoption accepts a shell -c Claude launcher", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-adopt-shell-wrapper-test-"));
  const sessionName = `pi-adopt-shell-wrapper-${process.pid}-${Date.now()}`;
  const claudeScript = join(stateDir, "claude");
  await writeFile(claudeScript, `#!/usr/bin/env node
process.stdout.write(">\\n");
setInterval(() => {}, 1000);
`);
  await chmod(claudeScript, 0o700);
  const created = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", process.cwd(), "sh", "-c", claudeScript], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
  try {
    const handle = await adapter.start({ task: "observe shell wrapper", cwd: process.cwd(), command: "claude", tmuxSession: sessionName, sendInitialInput: false });
    assert.equal(handle.ownership, "adopted");
    await adapter.stop(handle, "detach shell wrapper");
    assert.equal(spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" }).status, 0);
  } finally {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adopting a tmux session never kills the user's session on stop", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-adopt-test-"));
  const sessionName = `pi-adopt-test-${process.pid}-${Date.now()}`;
  const claudeBinary = join(stateDir, "claude");
  await copyFile(process.execPath, claudeBinary);
  const created = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, "-c", process.cwd(), claudeBinary, "-e", "process.stdout.write('>\\n'); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { for (const line of d.split('\\n').filter(Boolean)) process.stdout.write('DONE:' + line + '\\n>\\n'); }); setInterval(() => {}, 1000);"], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
  try {
    let completions = 0;
    const handle = await adapter.start({ task: "observe current session", cwd: process.cwd(), command: "claude", tmuxSession: sessionName, sendInitialInput: false, eventListener: (event) => { if (event.type === "turn_completed") completions += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(completions, 0);
    assert.equal(handle.ownership, "adopted");
    await adapter.stop(handle, "detach only");
    const status = await adapter.getStatus(handle);
    assert.equal(status.running, true);
    const listed = spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
    assert.equal(listed.status, 0);
    const secondAdapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000 });
    const readopted = await secondAdapter.start({ task: "re-adopt", cwd: process.cwd(), command: "claude", tmuxSession: sessionName, sendInitialInput: false });
    assert.equal(readopted.ownership, "adopted");
    await secondAdapter.stop(readopted, "second detach");
  } finally {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("interactive owned session subscribes hooks, accepts the trust dialog and becomes ready", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-interactive-ready-")));
  const fakeClaude = join(stateDir, "claude");
  const pidFile = join(stateDir, "claude.pid");
  const hookSettingsPath = join(stateDir, "hook-settings.json");
  await writeFile(hookSettingsPath, "{}");
  await writeFile(fakeClaude, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.PI_TEST_PIDFILE, String(process.pid));
process.stdout.write("Quick safety check\\n\\u276f No, exit\\n  Yes, I trust this folder\\n");
let buffer = "";
let accepted = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (!accepted && buffer.includes("\\x1b[B") && /[\\r\\n]/.test(buffer)) {
    accepted = true;
    process.stdout.write("\\n>\\n");
  }
});
process.stdin.resume();
setInterval(() => {}, 10000);
`);
  await chmod(fakeClaude, 0o700);
  const hookSource = createFakeHookSource();
  const events: WorkerEvent[] = [];
  const adapter = new TmuxWorkerAdapter({ stateDir, inputConfirmTimeoutMs: 300, pollIntervalMs: 30, startupTimeoutMs: 5_000, terminationGraceMs: 200 });
  let handle;
  try {
    const startPromise = adapter.start({
      task: "hello interactive",
      cwd: stateDir,
      command: fakeClaude,
      args: [],
      env: { HOME: join(stateDir, "home"), CLAUDE_CONFIG_DIR: join(stateDir, "config"), PI_TEST_PIDFILE: pidFile },
      automatic: true,
      interactive: true,
      hookSource,
      hookSettingsPath,
      sendInitialInput: false,
      eventListener: (event) => { events.push(event); },
    });
    const fakePid = Number(await waitForFileContent(pidFile));
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "SessionStart", session_id: "session-1", cwd: stateDir, transcript_path: join(stateDir, "transcript.jsonl") },
    });
    handle = await startPromise;
    assert.equal(handle.ownership, "owned");
    const output = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    assert.match(output, /accepted the workspace trust dialog/u);
  } finally {
    if (handle) await adapter.stop(handle, "interactive ready test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("interactive owned session accepts the trust dialog when cwd is a symlink", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-interactive-symlink-")));
  const realCwd = join(rootDir, "real-cwd");
  await mkdir(realCwd, { recursive: true });
  const symlinkCwd = join(rootDir, "symlink-cwd");
  await symlink(realCwd, symlinkCwd);
  const stateDir = join(rootDir, "state");
  await mkdir(stateDir, { recursive: true });
  const fakeClaude = join(stateDir, "claude");
  const pidFile = join(stateDir, "claude.pid");
  const hookSettingsPath = join(stateDir, "hook-settings.json");
  await writeFile(hookSettingsPath, "{}");
  await writeFile(fakeClaude, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.PI_TEST_PIDFILE, String(process.pid));
process.stdout.write("Quick safety check\\n\\u276f No, exit\\n  Yes, I trust this folder\\n");
let buffer = "";
let accepted = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (!accepted && buffer.includes("\\x1b[B") && /[\\r\\n]/.test(buffer)) {
    accepted = true;
    process.stdout.write("\\n>\\n");
  }
});
process.stdin.resume();
setInterval(() => {}, 10000);
`);
  await chmod(fakeClaude, 0o700);
  const hookSource = createFakeHookSource();
  const events: WorkerEvent[] = [];
  const adapter = new TmuxWorkerAdapter({ stateDir, inputConfirmTimeoutMs: 300, pollIntervalMs: 30, startupTimeoutMs: 5_000, terminationGraceMs: 200 });
  let handle;
  try {
    // tmux reports #{pane_current_path} resolved (the real directory); the
    // adapter is started with the symlink path, so the raw string comparison
    // used to accept the trust dialog would never match without realpath.
    const startPromise = adapter.start({
      task: "hello interactive symlink",
      cwd: symlinkCwd,
      command: fakeClaude,
      args: [],
      env: { HOME: join(stateDir, "home"), CLAUDE_CONFIG_DIR: join(stateDir, "config"), PI_TEST_PIDFILE: pidFile },
      automatic: true,
      interactive: true,
      hookSource,
      hookSettingsPath,
      sendInitialInput: false,
      eventListener: (event) => { events.push(event); },
    });
    const fakePid = Number(await waitForFileContent(pidFile));
    await hookSource.dispatch(symlinkCwd, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "SessionStart", session_id: "session-1", cwd: symlinkCwd, transcript_path: join(stateDir, "transcript.jsonl") },
    });
    handle = await startPromise;
    assert.equal(handle.ownership, "owned");
    const output = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    assert.match(output, /accepted the workspace trust dialog/u);
  } finally {
    if (handle) await adapter.stop(handle, "interactive symlink cwd test cleanup").catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("a launcher-wrapped owned interactive session can be re-adopted after restart", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, stateDir, fakePid } = fixture;
  let readoptedAdapter: TmuxWorkerAdapter | undefined;
  let readopted: Awaited<ReturnType<TmuxWorkerAdapter["start"]>> | undefined;
  try {
    // The owned pane runs `node -e TMUX_INTERACTIVE_LAUNCHER_SCRIPT`, not
    // Claude directly; Claude (the fake worker script) is its spawnSync
    // child. Recovery must scan for that child instead of rejecting the
    // launcher as "not a Claude Code executable".
    await adapter.release(handle, "simulate Pi restart");
    readoptedAdapter = new TmuxWorkerAdapter({ stateDir, inputConfirmTimeoutMs: 300, pollIntervalMs: 30, startupTimeoutMs: 5_000, terminationGraceMs: 200 });
    const readoptedHookSource = createFakeHookSource();
    readopted = await readoptedAdapter.start({
      task: "must not replay after recovery",
      cwd: stateDir,
      command: "claude",
      tmuxSession: handle.sessionName,
      tmuxSocket: handle.tmuxSocket,
      tmuxExpectedIdentity: {
        pid: handle.pid,
        startTime: handle.paneStartTime,
        tmuxTarget: handle.tmuxTarget,
        tmuxPaneId: handle.tmuxPaneId,
        paneStartTime: handle.paneStartTime,
        paneCommand: handle.paneCommand,
      },
      automatic: true,
      interactive: true,
      hookSource: readoptedHookSource,
      sendInitialInput: false,
    });
    assert.equal(readopted.ownership, "adopted");
    // #bindsToRecord must resolve hook requests via the real Claude child
    // pid (fakePid), not the launcher pid still occupying the pane.
    const events: WorkerEvent[] = [];
    readoptedAdapter.subscribe(readopted, (event) => { events.push(event); });
    const reply = await readoptedHookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "UserPromptSubmit", session_id: "session-2", cwd: stateDir, prompt: "hello after recovery" },
    });
    assert.deepEqual(reply, {});
    const humanEvent = events.find((event): event is Extract<WorkerEvent, { type: "human_input" }> => event.type === "human_input");
    assert.ok(humanEvent);
    assert.equal(humanEvent.text, "hello after recovery");
  } finally {
    if (readoptedAdapter && readopted) await readoptedAdapter.stop(readopted, "recovery test cleanup").catch(() => {});
    if (handle.tmuxSocket && handle.sessionName) spawnSync("tmux", ["-S", handle.tmuxSocket, "kill-session", "-t", handle.sessionName], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("StopFailure and an idle_prompt without a Stop both close the turn", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, hookSource, events, stateDir, fakePid } = fixture;
  try {
    await adapter.send(handle, "do y", "test-do-y");
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "StopFailure", session_id: "session-1", cwd: stateDir, error: { type: "rate_limit_error", message: "overloaded" } },
    });
    const failed = events.find((event): event is Extract<WorkerEvent, { type: "turn_completed" }> => event.type === "turn_completed");
    assert.ok(failed);
    assert.equal((failed.result as { subtype?: string }).subtype, "error");
    assert.equal((failed.result as { is_error?: boolean }).is_error, true);
    assert.match(String((failed.result as { result?: string }).result), /rate_limit_error.*overloaded/u);
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);

    await adapter.send(handle, "do z", "test-do-z");
    assert.equal((await adapter.getStatus(handle)).activeRequests, 1);
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "Notification", session_id: "session-1", cwd: stateDir, notification_type: "idle_prompt", message: "waiting" },
    });
    const completions = events.filter((event) => event.type === "turn_completed");
    assert.equal(completions.length, 2);
    assert.equal(((completions[1] as Extract<WorkerEvent, { type: "turn_completed" }>).result as { subtype?: string }).subtype, "idle");
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
    // An idle notification while nothing is in flight is not a turn.
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "Notification", session_id: "session-1", cwd: stateDir, notification_type: "idle_prompt", message: "waiting" },
    });
    assert.equal(events.filter((event) => event.type === "turn_completed").length, 2);
  } finally {
    await adapter.stop(handle, "stop failure test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Stop hook completes the turn", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, hookSource, events, stateDir, fakePid } = fixture;
  try {
    await adapter.send(handle, "do x", "test-do-x");
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "UserPromptSubmit", session_id: "session-1", cwd: stateDir, prompt: "do x" },
    });
    assert.equal(events.some((event) => event.type === "human_input"), false);
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "Stop", session_id: "session-1", cwd: stateDir, last_assistant_message: "done", stop_hook_active: false },
    });
    const completion = events.find((event): event is Extract<WorkerEvent, { type: "turn_completed" }> => event.type === "turn_completed");
    assert.ok(completion);
    assert.equal((completion.result as { result?: string }).result, "done");
    assert.equal((completion.result as { subtype?: string }).subtype, "stop");
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
  } finally {
    await adapter.stop(handle, "stop hook test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a human prompt is reported", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, hookSource, events, stateDir, fakePid } = fixture;
  try {
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "UserPromptSubmit", session_id: "session-1", cwd: stateDir, prompt: "hello from human" },
    });
    const humanEvent = events.find((event): event is Extract<WorkerEvent, { type: "human_input" }> => event.type === "human_input");
    assert.ok(humanEvent);
    assert.equal(humanEvent.text, "hello from human");
    assert.equal((await adapter.getStatus(handle)).activeRequests, 1);
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "Stop", session_id: "session-1", cwd: stateDir, last_assistant_message: "ack" },
    });
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
  } finally {
    await adapter.stop(handle, "human prompt test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("PreToolUse waits for respondPermission and maps defer/deny/allow", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, hookSource, events, stateDir, fakePid } = fixture;
  try {
    const firstReplyPromise = hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "PreToolUse", session_id: "session-1", cwd: stateDir, tool_name: "Bash", tool_input: { command: "echo hi" }, tool_use_id: "tool-1" },
    });
    await waitFor(() => events.some((event) => event.type === "permission_request" && event.request.requestId === "tool-1"));
    const firstRequest = events.find((event): event is Extract<WorkerEvent, { type: "permission_request" }> => event.type === "permission_request" && event.request.requestId === "tool-1")!;
    assert.equal(firstRequest.request.phase, "pre");
    assert.equal(firstRequest.request.toolUseId, "tool-1");
    await adapter.respondPermission(handle, firstRequest.request.requestId, firstRequest.request.toolUseId, { behavior: "allow", defer: true });
    assert.deepEqual(await firstReplyPromise, {});

    const secondReplyPromise = hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "PreToolUse", session_id: "session-1", cwd: stateDir, tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "tool-2" },
    });
    await waitFor(() => events.some((event) => event.type === "permission_request" && event.request.requestId === "tool-2"));
    const secondRequest = events.find((event): event is Extract<WorkerEvent, { type: "permission_request" }> => event.type === "permission_request" && event.request.requestId === "tool-2")!;
    await adapter.respondPermission(handle, secondRequest.request.requestId, secondRequest.request.toolUseId, { behavior: "deny", message: "not allowed" });
    assert.deepEqual(await secondReplyPromise, { permissionDecision: "deny", permissionDecisionReason: "not allowed" });
  } finally {
    await adapter.stop(handle, "pre tool use test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a UserPromptSubmit carrying Claude's own task notification is not human input", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, hookSource, events, stateDir, fakePid } = fixture;
  try {
    for (const prompt of [
      "<task-notification>\n<task-id>b1k34un3w</task-id>\n<summary>Monitor event: \"reviewer transcripts idle\"</summary>\n<event>both idle for 45s</event>\n</task-notification>",
      "  <system-reminder>\nBackground task completed.\n</system-reminder>",
      "<agent-message from=\"a883949751acb2c0b\">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\n</agent-message>",
    ]) {
      const reply = await hookSource.dispatch(stateDir, {
        version: 1,
        pid: fakePid + 1,
        ppid: fakePid,
        event: { hook_event_name: "UserPromptSubmit", session_id: "session-1", cwd: stateDir, prompt },
      });
      assert.deepEqual(reply, {});
    }
    assert.equal(events.some((event) => event.type === "human_input"), false);
    const reply = await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "UserPromptSubmit", session_id: "session-1", cwd: stateDir, prompt: "please also update the changelog" },
    });
    assert.deepEqual(reply, {});
    assert.equal(events.filter((event) => event.type === "human_input").length, 1);
    // Pasted markup without a hyphenated runtime tag is still a person.
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "UserPromptSubmit", session_id: "session-1", cwd: stateDir, prompt: "<div>why does this render twice?</div>" },
    });
    assert.equal(events.filter((event) => event.type === "human_input").length, 2);
  } finally {
    await adapter.stop(handle, "runtime prompt test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("SessionStart scratchpad_dir becomes an extra write root on permission requests", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, hookSource, events, stateDir, fakePid } = fixture;
  try {
    const scratchpad = join(stateDir, "claude-scratchpad");
    await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "SessionStart", session_id: "session-1", cwd: stateDir, scratchpad_dir: scratchpad },
    });
    const replyPromise = hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "PreToolUse", session_id: "session-1", cwd: stateDir, tool_name: "Write", tool_input: { file_path: join(scratchpad, "probe.ts"), content: "" }, tool_use_id: "tool-1" },
    });
    await waitFor(() => events.some((event) => event.type === "permission_request" && event.request.requestId === "tool-1"));
    const request = events.find((event): event is Extract<WorkerEvent, { type: "permission_request" }> => event.type === "permission_request" && event.request.requestId === "tool-1")!;
    assert.deepEqual(request.request.writeRoots, [scratchpad]);
    await adapter.respondPermission(handle, request.request.requestId, request.request.toolUseId, { behavior: "allow", defer: true });
    assert.deepEqual(await replyPromise, {});
  } finally {
    await adapter.stop(handle, "scratchpad test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("PermissionRequest maps to phase prompt with a derived requestId", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, hookSource, events, stateDir, fakePid } = fixture;
  try {
    const replyPromise = hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "PermissionRequest", session_id: "session-1", cwd: stateDir, tool_name: "Bash", tool_input: { command: "echo hi" } },
    });
    await waitFor(() => events.some((event) => event.type === "permission_request"));
    const request = events.find((event): event is Extract<WorkerEvent, { type: "permission_request" }> => event.type === "permission_request")!;
    assert.equal(request.request.phase, "prompt");
    assert.match(request.request.requestId, /^prompt:[0-9a-f]{16}:\d+$/u);
    await adapter.respondPermission(handle, request.request.requestId, request.request.toolUseId, { behavior: "allow" });
    const reply = await replyPromise;
    assert.equal(reply?.permissionDecision, "allow");
    assert.equal(reply?.permissionDecisionReason, undefined);

    // The same tool+input reuses the deterministic digest id; a repeat
    // occurrence must supersede the prior answer rather than dedupe away and
    // hang the relay (see the collision this id scheme creates across turns).
    const secondReplyPromise = hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "PermissionRequest", session_id: "session-1", cwd: stateDir, tool_name: "Bash", tool_input: { command: "echo hi" } },
    });
    await waitFor(() => events.filter((event) => event.type === "permission_request").length === 2);
    const secondRequest = events.filter((event): event is Extract<WorkerEvent, { type: "permission_request" }> => event.type === "permission_request")[1]!;
    // A byte-identical repeat (the same `npm test` after a repair round) must be a
    // distinct request: the Supervisor dedupes worker events by requestId.
    assert.notEqual(secondRequest.request.requestId, request.request.requestId);
    assert.equal(secondRequest.request.requestId.split(":")[1], request.request.requestId.split(":")[1]);
    await adapter.respondPermission(handle, secondRequest.request.requestId, secondRequest.request.toolUseId, { behavior: "allow" });
    const secondReply = await secondReplyPromise;
    assert.equal(secondReply?.permissionDecision, "allow");
  } finally {
    await adapter.stop(handle, "permission request test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an unanswered PermissionRequest is denied for a retry, and a late answer is a no-op", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture({ permissionDecisionTimeoutMs: 300 });
  const { adapter, handle, hookSource, events, stateDir, fakePid } = fixture;
  try {
    const reply = await hookSource.dispatch(stateDir, {
      version: 1,
      pid: fakePid + 1,
      ppid: fakePid,
      event: { hook_event_name: "PermissionRequest", session_id: "session-1", cwd: stateDir, tool_name: "Bash", tool_input: { command: "npm test" } },
    });
    // An empty reply would open Claude's own dialog and wait for a human.
    assert.equal(reply?.permissionDecision, "deny");
    assert.match(String(reply?.permissionDecisionReason), /timed out; retry/u);
    const request = events.find((event): event is Extract<WorkerEvent, { type: "permission_request" }> => event.type === "permission_request")!;
    await adapter.respondPermission(handle, request.request.requestId, request.request.toolUseId, { behavior: "allow" });
  } finally {
    await adapter.stop(handle, "permission timeout test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("requests that do not bind to the pane are ignored", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, events, stateDir, hookSource } = fixture;
  try {
    const reply = await hookSource.dispatch(stateDir, {
      version: 1,
      pid: 999_999,
      ppid: 999_999,
      tmuxPane: "%999999",
      event: { hook_event_name: "UserPromptSubmit", session_id: "session-1", cwd: stateDir, prompt: "should be ignored" },
    });
    assert.deepEqual(reply, {});
    assert.equal(events.some((event) => event.type === "human_input"), false);
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
  } finally {
    await adapter.stop(handle, "ignored binding test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("interactive mode never emits turn_completed from screen scraping", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const fixture = await startInteractiveOwnedFixture();
  const { adapter, handle, events, stateDir } = fixture;
  try {
    await adapter.send(handle, "no hook reply for this turn", "test-no-hook-reply");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(events.some((event) => event.type === "turn_completed"), false);
    assert.equal((await adapter.getStatus(handle)).activeRequests, 1);
  } finally {
    await adapter.stop(handle, "no screen scrape completion test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adopting an interactive tmux session subscribes hooks, completes a Stop turn, and stop() only releases it", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-adopt-interactive-"));
  const socketPath = join(stateDir, "tmux.sock");
  const sessionName = `pi-adopt-interactive-${process.pid}-${Date.now()}`;
  const claudeScript = join(stateDir, "claude");
  // Mirror the real TUI: a prompt glyph with the input separator beneath it
  // is what the readiness check treats as an idle prompt.
  await writeFile(claudeScript, `#!/usr/bin/env node
process.stdout.write("\\u276f \\n" + "\\u2500".repeat(40) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { process.stdout.write(chunk); });
process.stdin.resume();
setInterval(() => {}, 10000);
`);
  await chmod(claudeScript, 0o700);
  const created = spawnSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", sessionName, "-c", stateDir, claudeScript], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const hookSource = createFakeHookSource();
  const events: WorkerEvent[] = [];
  const adapter = new TmuxWorkerAdapter({ stateDir, inputConfirmTimeoutMs: 300, pollIntervalMs: 40, startupTimeoutMs: 5_000, terminationGraceMs: 200 });
  let handle;
  try {
    handle = await adapter.start({
      task: "observe interactive adoption",
      cwd: stateDir,
      command: "claude",
      tmuxSession: sessionName,
      tmuxSocket: socketPath,
      automatic: true,
      interactive: true,
      hookSource,
      sendInitialInput: false,
      eventListener: (event) => { events.push(event); },
    });
    assert.equal(handle.ownership, "adopted");
    assert.match(handle.tmuxPaneId ?? "", /^%[0-9]+$/u);
    // The adopted session was idle at its prompt, so babysitting starts by
    // typing the task; the fake worker echoes what it receives.
    let typed = "";
    for (let attempt = 0; attempt < 50 && !typed.includes("observe interactive adoption"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      typed = spawnSync("tmux", ["-S", socketPath, "capture-pane", "-p", "-t", sessionName], { encoding: "utf8" }).stdout ?? "";
    }
    assert.match(typed, /observe interactive adoption/u);
    assert.equal((await adapter.getStatus(handle)).activeRequests, 1);
    // A dispatch that resolves (rather than throwing "no hook subscription
    // for cwd") proves the adapter subscribed the hook source for the pane's cwd.
    // A real hook's ppid is the pane's Claude process; a matching pane id alone
    // is client-supplied and no longer binds once the pid anchor is known.
    const spoofed = await hookSource.dispatch(stateDir, {
      version: 1,
      pid: 111_111,
      ppid: 222_222,
      tmuxPane: handle.tmuxPaneId,
      event: { hook_event_name: "Stop", session_id: "session-1", cwd: stateDir, last_assistant_message: "spoofed" },
    });
    assert.deepEqual(spoofed, {});
    assert.equal(events.some((event) => event.type === "turn_completed"), false);
    const reply = await hookSource.dispatch(stateDir, {
      version: 1,
      pid: 111_111,
      ppid: handle.pid!,
      tmuxPane: handle.tmuxPaneId,
      event: { hook_event_name: "Stop", session_id: "session-1", cwd: stateDir, last_assistant_message: "adopted turn done" },
    });
    assert.deepEqual(reply, {});
    const completion = events.find((event): event is Extract<WorkerEvent, { type: "turn_completed" }> => event.type === "turn_completed");
    assert.ok(completion);
    assert.equal((completion.result as { result?: string }).result, "adopted turn done");
    await adapter.stop(handle, "adopted interactive detach only");
    const status = await adapter.getStatus(handle);
    assert.equal(status.running, true);
    assert.equal(spawnSync("tmux", ["-S", socketPath, "has-session", "-t", sessionName], { stdio: "ignore" }).status, 0);
  } finally {
    spawnSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
});

/** A fake HookEventSource that routes synthetic requests directly to whatever subscribed for a cwd. */
function createFakeHookSource(): HookEventSource & { dispatch: (cwd: string, request: HookRelayRequest) => Promise<HookRelayReply | undefined> } {
  const subscriptions = new Map<string, (request: HookRelayRequest) => Promise<HookRelayReply | undefined>>();
  return {
    subscribe: async (cwd, handler) => {
      subscriptions.set(cwd, handler);
      return async () => { subscriptions.delete(cwd); };
    },
    dispatch: async (cwd, request) => {
      const handler = subscriptions.get(cwd);
      if (!handler) throw new Error(`no hook subscription for cwd: ${cwd}`);
      return handler(request);
    },
  };
}

async function waitForFileContent(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const content = (await readFile(path, "utf8")).trim();
      if (content) return content;
    } catch {
      // Retry until the fake worker has written its identity.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`file content was not observed before timeout: ${path}`);
}

/** Owned interactive fixture already past the trust dialog and bound via a SessionStart hook. */
async function startInteractiveOwnedFixture(options: { retainCgroupUntilLeaseRelease?: boolean; permissionDecisionTimeoutMs?: number } = {}): Promise<{
  stateDir: string;
  adapter: TmuxWorkerAdapter;
  handle: Awaited<ReturnType<TmuxWorkerAdapter["start"]>>;
  hookSource: ReturnType<typeof createFakeHookSource>;
  events: WorkerEvent[];
  fakePid: number;
}> {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-interactive-")));
  const fakeClaude = join(stateDir, "claude");
  const pidFile = join(stateDir, "claude.pid");
  const hookSettingsPath = join(stateDir, "hook-settings.json");
  await writeFile(hookSettingsPath, "{}");
  await writeFile(fakeClaude, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.PI_TEST_PIDFILE, String(process.pid));
process.stdout.write("\\n>\\n");
process.stdin.resume();
setInterval(() => {}, 10000);
`);
  await chmod(fakeClaude, 0o700);
  const hookSource = createFakeHookSource();
  const events: WorkerEvent[] = [];
  const adapter = new TmuxWorkerAdapter({ stateDir, inputConfirmTimeoutMs: 300, pollIntervalMs: 30, startupTimeoutMs: 5_000, terminationGraceMs: 200, ...(options.permissionDecisionTimeoutMs !== undefined ? { permissionDecisionTimeoutMs: options.permissionDecisionTimeoutMs } : {}) });
  const startPromise = adapter.start({
    task: "interactive fixture task",
    cwd: stateDir,
    command: fakeClaude,
    args: [],
    env: { HOME: join(stateDir, "home"), CLAUDE_CONFIG_DIR: join(stateDir, "config"), PI_TEST_PIDFILE: pidFile },
    automatic: true,
    interactive: true,
    hookSource,
    hookSettingsPath,
    sendInitialInput: false,
    retainCgroupUntilLeaseRelease: options.retainCgroupUntilLeaseRelease,
    eventListener: (event) => { events.push(event); },
  });
  const fakePid = Number(await waitForFileContent(pidFile));
  await hookSource.dispatch(stateDir, {
    version: 1,
    pid: fakePid + 1,
    ppid: fakePid,
    event: { hook_event_name: "SessionStart", session_id: "session-1", cwd: stateDir },
  });
  const handle = await startPromise;
  return { stateDir, adapter, handle, hookSource, events, fakePid };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail("condition was not observed before timeout");
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`file was not created before timeout: ${path}`);
}

test("sweepDeadTmuxSockets removes pi-cs sockets no server answers on and keeps live ones", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-sockets-"));
  const live = join(directory, "pi-cs-11111111-1111-4111-8111-111111111111.sock");
  const dead = join(directory, "pi-cs-22222222-2222-4222-8222-222222222222.sock");
  try {
    assert.equal(spawnSync("tmux", ["-S", live, "new-session", "-d", "-s", "sweep-live", "sleep 30"], { stdio: "ignore" }).status, 0);
    // The real case: a server killed outright (as by its cgroup) leaves its socket behind.
    assert.equal(spawnSync("tmux", ["-S", dead, "new-session", "-d", "-s", "sweep-dead", "sleep 30"], { stdio: "ignore" }).status, 0);
    const serverPid = Number(spawnSync("tmux", ["-S", dead, "display-message", "-p", "#{pid}"], { encoding: "utf8" }).stdout.trim());
    assert.ok(serverPid > 0);
    process.kill(serverPid, "SIGKILL");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { process.kill(serverPid, 0); await new Promise((resolve) => setTimeout(resolve, 20)); } catch { break; }
    }
    await access(dead);
    await writeFile(join(directory, "pi-cs-not-a-socket.txt"), "x");
    const removed = sweepDeadTmuxSockets(directory);
    assert.equal(removed, 1);
    await assert.rejects(access(dead));
    await access(live);
    await access(join(directory, "pi-cs-not-a-socket.txt"));
  } finally {
    spawnSync("tmux", ["-S", live, "kill-server"], { stdio: "ignore" });
    await rm(directory, { recursive: true, force: true });
  }
});

test("the memory write root is accepted only for this project's own session transcript", () => {
  const cwd = "/mnt/work/Repo";
  const slug = "-mnt-work-Repo";
  const configDir = "/home/u/.claude";
  const projects = `${configDir}/projects/${slug}`;

  assert.equal(memoryRootFor(`${projects}/1234.jsonl`, cwd, configDir), `${projects}/memory`);

  // A subagent transcript sits one level deeper; deriving from it would freeze a
  // bogus root that the first-wins capture could never correct.
  assert.equal(memoryRootFor(`${projects}/1234/subagents/agent-a.jsonl`, cwd, configDir), undefined);
  // Another project's memory, a bare home directory, and anything outside
  // Claude's real projects directory are refused: transcript_path is untrusted
  // hook input, and a `.claude/projects/<slug>` shape somewhere else on disk is
  // an imitation, not the real thing.
  assert.equal(memoryRootFor(`${configDir}/projects/-other-repo/1.jsonl`, cwd, configDir), undefined);
  assert.equal(memoryRootFor("/home/u/1.jsonl", cwd, configDir), undefined);
  assert.equal(memoryRootFor("/tmp/evil/projects/-mnt-work-Repo/1.jsonl", cwd, configDir), undefined);
  assert.equal(memoryRootFor("/tmp/evil/.claude/projects/-mnt-work-Repo/1.jsonl", cwd, configDir), undefined);
  assert.equal(memoryRootFor(undefined, cwd, configDir), undefined);
  // A relocated configuration directory (CLAUDE_CONFIG_DIR) is the real one.
  assert.equal(memoryRootFor("/opt/claude-cfg/projects/-mnt-work-Repo/9.jsonl", cwd, "/opt/claude-cfg"), "/opt/claude-cfg/projects/-mnt-work-Repo/memory");
  assert.equal(memoryRootFor(`${projects}/1234.jsonl`, cwd, "/opt/claude-cfg"), undefined);

  // The slug is Claude's: every character outside [A-Za-z0-9] becomes `-`, so
  // a cwd with `.`, `_` or a space must still find its memory directory.
  assert.equal(claudeProjectSlug("/home/u/my_app"), "-home-u-my-app");
  assert.equal(claudeProjectSlug("/srv/foo.bar"), "-srv-foo-bar");
  assert.equal(claudeProjectSlug("/home/u/My Project"), "-home-u-My-Project");
  assert.equal(memoryRootFor(`${configDir}/projects/-home-u-my-app/1.jsonl`, "/home/u/my_app", configDir), `${configDir}/projects/-home-u-my-app/memory`);
  assert.equal(memoryRootFor(`${configDir}/projects/-srv-foo-bar/1.jsonl`, "/srv/foo.bar", configDir), `${configDir}/projects/-srv-foo-bar/memory`);
});

test("writeRoots carry the scratchpad and the project memory directory", () => {
  const cwd = "/mnt/work/Repo";
  const handle = { cwd };
  const scratchpadDir = "/tmp/claude-1000/-mnt-work-Repo/abc/scratchpad";
  const transcriptPath = "/home/u/.claude/projects/-mnt-work-Repo/1234.jsonl";

  const configDir = "/home/u/.claude";

  assert.deepEqual(writeRootsOf({ handle, scratchpadDir, transcriptPath }, configDir),
    [scratchpadDir, "/home/u/.claude/projects/-mnt-work-Repo/memory"]);
  // An adopted session has no scratchpad until SessionStart, which it never replays.
  assert.deepEqual(writeRootsOf({ handle, transcriptPath }, configDir), ["/home/u/.claude/projects/-mnt-work-Repo/memory"]);
  assert.deepEqual(writeRootsOf({ handle, scratchpadDir }, configDir), [scratchpadDir]);
  assert.deepEqual(writeRootsOf({ handle }, configDir), []);
  // An adopted session that Claude started with another CLAUDE_CONFIG_DIR keeps
  // its memory there; the record carries the directory read from that process.
  const relocated = "/home/u/.claude-work/projects/-mnt-work-Repo/1.jsonl";
  assert.deepEqual(writeRootsOf({ handle, transcriptPath: relocated, claudeConfigDir: "/home/u/.claude-work" }), ["/home/u/.claude-work/projects/-mnt-work-Repo/memory"]);
  assert.deepEqual(writeRootsOf({ handle, transcriptPath: relocated }, configDir), [], "without it, another configuration directory is not this Claude's");
});

test("the bridge reassembles a framed long message and drops a failed send's leftover part", { skip: !tmuxAvailable, concurrency: false }, async () => {
  // Drives the embedded bridge script directly in a private tmux server with
  // a fake Claude, so the framing protocol is exercised without cgroups.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-supervisor-bridge-frame-")));
  const socket = join(dir, "tmux.sock");
  const received = join(dir, "received.jsonl");
  const paneLog = join(dir, "pane.log");
  const fakeClaude = join(dir, "fake-claude.mjs");
  await writeFile(fakeClaude, `import { appendFileSync } from "node:fs";
import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(${JSON.stringify(received)}, line + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\\n");
});
`);
  await writeFile(paneLog, "");
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const env = {
    ...process.env,
    PI_CLAUDE_SUPERVISOR_TMUX_COMMAND: encode(process.execPath),
    PI_CLAUDE_SUPERVISOR_TMUX_ARGS: encode(JSON.stringify([fakeClaude])),
    PI_CLAUDE_SUPERVISOR_TMUX_CWD: encode(dir),
    PI_CLAUDE_SUPERVISOR_TMUX_CGROUP: encode(""),
  };
  const tmux = (...args: string[]) => spawnSync("tmux", ["-f", "/dev/null", "-S", socket, ...args], { env, encoding: "utf8" });
  try {
    assert.equal(tmux("new-session", "-d", "-s", "bridge", "-x", "160", "-y", "40", "-c", dir, "--", "sh", "-c", "sleep 0.3; exec \"$0\" -e \"$1\"", process.execPath, TMUX_EMBEDDED_SCRIPTS.bridge).status, 0);
    assert.equal(tmux("pipe-pane", "-o", "-t", "bridge", `cat >> ${paneLog}`).status, 0);
    let generation = "";
    for (let attempt = 0; attempt < 50 && !generation; attempt += 1) {
      const frame = (await readFile(paneLog, "utf8")).match(/PI_CLAUDE_SUPERVISOR_EVENT;([A-Za-z0-9+/=]+)/u);
      if (frame) generation = (JSON.parse(Buffer.from(frame[1]!, "base64").toString("utf8")) as { generation?: string }).generation ?? "";
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(generation, "the bridge announced its generation");
    const sendLine = async (line: string) => {
      assert.equal(spawnSync("tmux", ["-f", "/dev/null", "-S", socket, "load-buffer", "-b", "frame", "-"], { input: line, env }).status, 0);
      assert.equal(tmux("paste-buffer", "-p", "-d", "-b", "frame", "-t", "bridge").status, 0);
      assert.equal(tmux("send-keys", "-t", "bridge", "Enter").status, 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    const sendFramed = async (message: string) => {
      const base64 = encode(message);
      let parts = 0;
      for (let offset = 0; offset + 2_000 < base64.length; offset += 2_000) await sendLine(`@pi:control ${generation} @pi:part ${parts++} ${base64.slice(offset, offset + 2_000)}`);
      await sendLine(`@pi:control ${generation} @pi:user ${parts} ${base64.slice(Math.floor(Math.max(0, base64.length - 1) / 2_000) * 2_000)}`);
    };
    // A send that failed after its first part left this behind.
    await sendLine(`@pi:control ${generation} @pi:part 0 ${encode("LEFTOVER".repeat(300)).slice(0, 2_000)}`);
    await sendFramed("short follow-up");
    const long = `repair:${"界".repeat(3_000)}`;
    await sendFramed(long);
    let lines: string[] = [];
    for (let attempt = 0; attempt < 50 && lines.length < 2; attempt += 1) {
      lines = (await readFile(received, "utf8").catch(() => "")).split("\n").filter(Boolean);
      if (lines.length < 2) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const contents = lines.map((line) => (JSON.parse(line) as { message: { content: string } }).message.content);
    assert.deepEqual(contents, ["short follow-up", long]);
  } finally {
    tmux("kill-server");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Bash request from a shell that left the task directory is judged where it actually runs", async () => {
  const taskCwd = await realpath(await mkdtemp(join(tmpdir(), "pi-cs-effective-input-")));
  try {
    await mkdir(join(taskCwd, ".git", "hooks"), { recursive: true });
    const command = "echo x > hooks/pre-commit";
    const inTask = effectiveToolInput({ tool_name: "Bash", tool_input: { command }, cwd: taskCwd }, taskCwd);
    assert.deepEqual(inTask, { command });
    const drifted = effectiveToolInput({ tool_name: "Bash", tool_input: { command, description: "d" }, cwd: join(taskCwd, ".git") }, taskCwd);
    assert.deepEqual(drifted, { command: `cd ${shellQuote(join(taskCwd, ".git"))} && ${command}`, description: "d" });
    // Unprefixed, the write looks like a routine one in the task root; as it actually runs, it is not.
    assert.equal(isRoutinePermission("Bash", { command }, taskCwd), true);
    assert.equal(isRoutinePermission("Bash", drifted, taskCwd), false);
    // Only Bash commands are rewritten; file tools carry absolute paths.
    const write = { file_path: join(taskCwd, "a.txt"), content: "" };
    assert.equal(effectiveToolInput({ tool_name: "Write", tool_input: write, cwd: join(taskCwd, ".git") }, taskCwd), write);
  } finally {
    await rm(taskCwd, { recursive: true, force: true });
  }
});

test("inputHoldsMessage recognizes the pasted message, Claude's long-paste placeholder, and not a selection menu", () => {
  const separator = "\u2500".repeat(40);
  assert.equal(inputHoldsMessage(`\u276f Fix the failing test in src/a.ts\n${separator}`, "Fix the failing test in src/a.ts please"), true);
  assert.equal(inputHoldsMessage(`\u276f [Pasted text #1 +42 lines]\n${separator}`, "anything"), true);
  assert.equal(inputHoldsMessage(`\u276f \n${separator}`, "Fix the failing test"), false);
  assert.equal(inputHoldsMessage("Do you want to proceed?\n\u276f 1. Yes\n  2. No", "Fix the failing test"), false);
  // After submission the message sits in the transcript above an empty box.
  assert.equal(inputHoldsMessage(`\u276f Fix the failing test\n\nWorking on it.\n\u276f \n${separator}`, "Fix the failing test"), false);
});

interface FakeTuiConfig { busy: boolean; dropEnters: number }

/**
 * An adopted interactive session running a raw-mode fake of Claude's TUI:
 * `❯ <input>` over a separator, a busy spinner while `busy`, and Enter
 * submitting the input (appended to a log) unless `dropEnters` swallows it.
 * The test flips the config file to change its state.
 */
async function withFakeTui(
  options: { inputReadyTimeoutMs: number; inputConfirmTimeoutMs: number; acknowledge: boolean },
  run: (context: { adapter: TmuxWorkerAdapter; handle: Awaited<ReturnType<TmuxWorkerAdapter["start"]>>; setConfig: (config: FakeTuiConfig) => Promise<void>; submitted: () => Promise<string[]>; socketPath: string; sessionName: string; output: () => Promise<string> }) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-fake-tui-"));
  const socketPath = join(stateDir, "tmux.sock");
  const sessionName = `pi-fake-tui-${process.pid}-${Date.now()}`;
  const configPath = join(stateDir, "config.json");
  const logPath = join(stateDir, "submitted.log");
  const claudeScript = join(stateDir, "claude");
  await writeFile(configPath, JSON.stringify({ busy: false, dropEnters: 0 }));
  await writeFile(logPath, "");
  await writeFile(claudeScript, `#!/usr/bin/env node
const fs = require("fs");
let buffer = "";
let config = { busy: false, dropEnters: 0 };
let raw = "";
// Redraw in place like Ink (cursor up, erase below) rather than clearing
// the screen, which tmux would push into the scrollback the adapter reads.
let drawn = 0;
process.stdout.write("fake claude\\r\\n");
const render = () => {
  const frame = (config.busy ? ["* Working (esc to interrupt)"] : []).concat(["\\u276f " + buffer, "\\u2500".repeat(40)]);
  process.stdout.write((drawn ? "\\x1b[" + drawn + "A" : "") + "\\r\\x1b[J" + frame.join("\\r\\n") + "\\r\\n");
  drawn = frame.length;
};
setInterval(() => {
  let next;
  try { next = fs.readFileSync(${JSON.stringify(configPath)}, "utf8"); } catch { return; }
  if (next === raw) return;
  try { config = JSON.parse(next); } catch { return; }
  raw = next;
  render();
}, 30);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const char of chunk) {
    if (char === "\\r") {
      if (config.dropEnters > 0) { config.dropEnters -= 1; continue; }
      fs.appendFileSync(${JSON.stringify(logPath)}, buffer + "\\n");
      buffer = "";
    } else if (char >= " ") buffer += char;
  }
  render();
});
render();
`);
  await chmod(claudeScript, 0o700);
  const created = spawnSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", sessionName, "-x", "200", "-c", stateDir, claudeScript], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const hookSource = createFakeHookSource();
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000, terminationGraceMs: 200, inputReadyTimeoutMs: options.inputReadyTimeoutMs, inputConfirmTimeoutMs: options.inputConfirmTimeoutMs });
  let stopAcks = false;
  let collected = "";
  try {
    const handle = await adapter.start({ task: " ", cwd: stateDir, command: "claude", tmuxSession: sessionName, tmuxSocket: socketPath, automatic: true, interactive: true, hookSource, sendInitialInput: false });
    const submitted = async () => (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
    // Claude reports each submitted prompt through UserPromptSubmit.
    const acknowledger = (async () => {
      let seen = 0;
      while (options.acknowledge && !stopAcks) {
        const lines = await submitted();
        for (; seen < lines.length; seen += 1) {
          await hookSource.dispatch(stateDir, { version: 1, pid: 111_111, ppid: handle.pid!, tmuxPane: handle.tmuxPaneId, event: { hook_event_name: "UserPromptSubmit", session_id: "session-1", cwd: stateDir, prompt: lines[seen] } });
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    })();
    try {
      await run({
        adapter,
        handle,
        // Atomic, so the fake never reads a half-written config.
        setConfig: async (config) => { await writeFile(`${configPath}.tmp`, JSON.stringify(config)); await rename(`${configPath}.tmp`, configPath); await new Promise((resolve) => setTimeout(resolve, 150)); },
        submitted,
        socketPath,
        sessionName,
        output: async () => { collected += (await adapter.readOutput(handle)).map((chunk) => chunk.text).join(""); return collected; },
      });
    } finally {
      stopAcks = true;
      await acknowledger;
      await adapter.stop(handle, "fake tui test done").catch(() => {});
    }
  } finally {
    spawnSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("an interactive send waits out a busy screen instead of refusing it", { skip: !tmuxAvailable, concurrency: false }, async () => {
  await withFakeTui({ inputReadyTimeoutMs: 5_000, inputConfirmTimeoutMs: 1_000, acknowledge: true }, async ({ adapter, handle, setConfig, submitted }) => {
    await setConfig({ busy: true, dropEnters: 0 });
    setTimeout(() => { void setConfig({ busy: false, dropEnters: 0 }); }, 800);
    await adapter.send(handle, "continue with the next step", "busy-1");
    assert.deepEqual(await submitted(), ["continue with the next step"]);
  });
});

test("a send that never finds an idle prompt is refused as retryable", { skip: !tmuxAvailable, concurrency: false }, async () => {
  await withFakeTui({ inputReadyTimeoutMs: 600, inputConfirmTimeoutMs: 500, acknowledge: true }, async ({ adapter, handle, setConfig, submitted }) => {
    await setConfig({ busy: true, dropEnters: 0 });
    await assert.rejects(adapter.send(handle, "never delivered", "busy-2"), (error) => isWorkerInputError(error) && error.retryable);
    assert.deepEqual(await submitted(), []);
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
  });
});

test("a lost Enter is resent while the input box still holds the message", { skip: !tmuxAvailable, concurrency: false }, async () => {
  await withFakeTui({ inputReadyTimeoutMs: 2_000, inputConfirmTimeoutMs: 400, acknowledge: true }, async ({ adapter, handle, setConfig, submitted, output }) => {
    await setConfig({ busy: false, dropEnters: 1 });
    await adapter.send(handle, "run the tests again", "enter-1");
    assert.deepEqual(await submitted(), ["run the tests again"]);
    assert.match(await output(), /sent Enter again/u);
  });
});

test("a message stuck in the input box is not retryable and is not resent a third time", { skip: !tmuxAvailable, concurrency: false }, async () => {
  await withFakeTui({ inputReadyTimeoutMs: 2_000, inputConfirmTimeoutMs: 300, acknowledge: true }, async ({ adapter, handle, setConfig, submitted, output }) => {
    await setConfig({ busy: false, dropEnters: 3 });
    await assert.rejects(adapter.send(handle, "stuck message", "enter-2"), (error) => isWorkerInputError(error) && !error.retryable);
    assert.deepEqual(await submitted(), []);
    assert.equal((await output()).match(/sent Enter again/gu)?.length, 2);
  });
});

test("an interactive send leaves tmux copy mode so Enter reaches Claude", { skip: !tmuxAvailable, concurrency: false }, async () => {
  await withFakeTui({ inputReadyTimeoutMs: 2_000, inputConfirmTimeoutMs: 1_000, acknowledge: true }, async ({ adapter, handle, submitted, socketPath, sessionName, output }) => {
    assert.equal(spawnSync("tmux", ["-S", socketPath, "copy-mode", "-t", sessionName]).status, 0);
    assert.equal(spawnSync("tmux", ["-S", socketPath, "display-message", "-p", "-t", sessionName, "#{pane_in_mode}"], { encoding: "utf8" }).stdout.trim(), "1");
    await adapter.send(handle, "scrolled but still supervised", "copy-1");
    assert.deepEqual(await submitted(), ["scrolled but still supervised"]);
    assert.match(await output(), /left tmux copy mode/u);
  });
});

test("a delivered message without a UserPromptSubmit hook is accepted and logged", { skip: !tmuxAvailable, concurrency: false }, async () => {
  await withFakeTui({ inputReadyTimeoutMs: 2_000, inputConfirmTimeoutMs: 300, acknowledge: false }, async ({ adapter, handle, submitted, output }) => {
    await adapter.send(handle, "hooks are silent", "silent-1");
    assert.deepEqual(await submitted(), ["hooks are silent"]);
    assert.match(await output(), /no UserPromptSubmit hook confirmed the message/u);
  });
});
