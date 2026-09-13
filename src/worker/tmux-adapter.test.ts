import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TmuxWorkerAdapter } from "./tmux-adapter.ts";

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

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

test("owned cleanup remains confirmed when the pane exits before stop", { skip: !tmuxAvailable, concurrency: false }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-tmux-exit-test-"));
  const adapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 40, startupTimeoutMs: 5_000, terminationGraceMs: 100 });
  let handle;
  try {
    handle = await adapter.start({
      task: "early pane exit",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "process.stdout.write('>\\n'); setTimeout(() => process.exit(0), 100)"],
      sendInitialInput: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await adapter.stop(handle, "pane exited before stop");
    const status = await adapter.getStatus(handle);
    assert.equal(status.running, false);
    assert.equal(status.processGroupCleaned, true);
    assert.equal(status.cleanupError, undefined);
  } finally {
    if (handle) {
      try { await adapter.stop(handle, "early exit test cleanup"); } catch { /* preserve the test failure */ }
    }
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
      args: ["-e", "process.stdout.write('>\\n'); process.stdin.resume();"],
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
