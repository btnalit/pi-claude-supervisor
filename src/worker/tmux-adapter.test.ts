import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { TmuxWorkerAdapter } from "./tmux-adapter.ts";
import { preflightCgroupContainment } from "./process-adapter.ts";

const tmuxAvailable = process.platform === "linux" && spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const automaticTmuxAvailable = tmuxAvailable && await (async () => {
  try { await preflightCgroupContainment(); return true; }
  catch { return false; }
})();

test("automatic tmux preflight rejects disabled cgroup containment", { skip: process.platform !== "linux" || !tmuxAvailable }, async () => {
  const adapter = new TmuxWorkerAdapter({ cgroupMode: "off" });
  await assert.rejects(() => adapter.preflight({ cwd: process.cwd(), command: process.execPath, args: [], automatic: true }), /cgroup containment/u);
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

    await assert.rejects(() => adapter.send(handle, "unsafe\u001b[31m", "unsafe-input"), /control bytes/u);
    await adapter.send(handle, "follow-up", "test-follow-up");
    await waitFor(() => events.filter((event) => event.type === "turn_completed").length === 2);
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

test("automated tmux carries structured Claude events through the live PTY", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-bridge-test-"));
  const fixture = join(stateDir, "fixture.mjs");
  const fakeClaude = join(stateDir, "claude");
  await writeFile(fixture, `
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
      cwd: process.cwd(),
      command: fakeClaude,
      args: [],
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
    const output = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    assert.match(output, /ACK:hello/u);
    assert.doesNotMatch(output, /\u001bPPI_CLAUDE_SUPERVISOR_EVENT|@pi:user/u);
    const bufferName = `pi-cs-human-${handle.id}`;
    assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "load-buffer", "-b", bufferName, "-"], { input: "human-next", stdio: ["pipe", "ignore", "pipe"] }).status, 0);
    assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "paste-buffer", "-p", "-d", "-b", bufferName, "-t", handle.tmuxPaneId!], { stdio: "ignore" }).status, 0);
    assert.equal(spawnSync("tmux", ["-S", handle.tmuxSocket!, "send-keys", "-t", handle.tmuxPaneId!, "Enter"], { stdio: "ignore" }).status, 0);
    await waitFor(() => events.filter((event) => event.type === "turn_completed").length === 2);
    assert.match((await adapter.readOutput(handle)).map((chunk) => chunk.text).join(""), /ACK:human-next/u);
    await adapter.stop(handle, "bridge test complete");
  } finally {
    if (handle) await adapter.stop(handle, "bridge test cleanup").catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("automatic tmux rejects a Claude child started by a Worker script", { skip: !automaticTmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-nested-test-"));
  const fixture = join(stateDir, "fixture.mjs");
  const fakeClaude = join(stateDir, "claude");
  const nestedClaude = join(stateDir, "nested", "claude");
  await mkdir(join(stateDir, "nested"), { recursive: true });
  await copyFile(process.execPath, nestedClaude);
  await chmod(nestedClaude, 0o700);
  await writeFile(fixture, `
import { spawn } from "node:child_process";
const nested = ${JSON.stringify(nestedClaude)};
process.stdout.write(JSON.stringify({ type: "system", subtype: "ready" }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => {
  for (const line of data.split("\\n").filter(Boolean)) {
    const request = JSON.parse(line);
    spawn(nested, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", uuid: request.message.content }) + "\\n");
  }
});
`);
  await writeFile(fakeClaude, `#!/usr/bin/env node\nawait import(${JSON.stringify(fixture)});\n`);
  await chmod(fakeClaude, 0o700);
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 30, startupTimeoutMs: 5_000, terminationGraceMs: 100 });
  let handle;
  try {
    handle = await adapter.start({ task: "trigger", cwd: process.cwd(), command: fakeClaude, args: [], automatic: true });
    let status;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await adapter.getStatus(handle);
      if (!status.running) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(status?.running, false);
    assert.match(status?.runtimeError ?? "", /nested Claude process denied/u);
  } finally {
    if (handle) await adapter.stop(handle, "nested Claude test cleanup").catch(() => {});
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail("condition was not observed before timeout");
}
