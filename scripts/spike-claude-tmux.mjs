import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TmuxWorkerAdapter } from "../src/worker/tmux-adapter.ts";

if (process.env.PI_CLAUDE_SUPERVISOR_REAL_CLAUDE !== "1") {
  throw new Error("Set PI_CLAUDE_SUPERVISOR_REAL_CLAUDE=1 to run the authenticated Claude tmux spike");
}

const cwd = process.env.PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_CWD ?? process.cwd();
const claude = execFileSync("bash", ["-lc", "command -v claude"], { encoding: "utf8" }).trim();
const version = execFileSync(claude, ["--version"], { encoding: "utf8" }).trim();
const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-real-tmux-"));
const completed = [];
let owned;
let firstAdapter;
let secondAdapter;

const waitForSequence = async (sequence, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (completed.some((event) => event.sequence === sequence)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for Claude tmux turn ${sequence}`);
};

try {
  firstAdapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 250, startupTimeoutMs: 90_000, terminationGraceMs: 5_000 });
  owned = await firstAdapter.start({
    task: "Reply with exactly TMUX_OK. Do not use tools, inspect files, or describe this instruction.",
    cwd,
    command: claude,
    args: ["--permission-mode", "plan"],
    eventListener: (event) => { if (event.type === "turn_completed") completed.push(event); },
  });
  await waitForSequence(1);
  assert.equal((await firstAdapter.getStatus(owned)).activeRequests, 0);

  await firstAdapter.pause(owned);
  await firstAdapter.resume(owned);
  await firstAdapter.send(owned, "Reply with exactly TMUX_SECOND_OK. Do not use tools or inspect files.", "real-tmux-second-turn");
  await waitForSequence(2);
  assert.equal((await firstAdapter.getStatus(owned)).activeRequests, 0);

  const expectedIdentity = {
    pid: owned.pid,
    tmuxTarget: owned.tmuxTarget,
    tmuxPaneId: owned.tmuxPaneId,
    paneStartTime: owned.paneStartTime,
    paneCommand: owned.paneCommand,
  };
  const sessionName = owned.sessionName;
  const tmuxSocket = owned.tmuxSocket;
  await firstAdapter.release(owned, "tmux spike restart handoff");

  secondAdapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 250, startupTimeoutMs: 30_000, terminationGraceMs: 5_000 });
  const adopted = await secondAdapter.start({
    task: "must not replay during explicit re-adoption",
    cwd,
    command: claude,
    args: ["--permission-mode", "plan"],
    tmuxSession: sessionName,
    tmuxSocket,
    tmuxExpectedIdentity: expectedIdentity,
    sendInitialInput: false,
  });
  assert.equal(adopted.ownership, "adopted");
  assert.equal((await secondAdapter.getStatus(adopted)).running, true);
  await secondAdapter.release(adopted, "tmux spike adopted detach");

  console.log(JSON.stringify({
    claudeVersion: version,
    claudePath: claude,
    cwd,
    ownedTurns: 2,
    pauseResume: true,
    restartReadoption: true,
    adoptedDetachPreservedSession: true,
    modelOutputRecorded: false,
  }, null, 2));
} finally {
  if (owned?.tmuxSocket && owned?.sessionName) {
    spawnSync("tmux", ["-S", owned.tmuxSocket, "kill-session", "-t", owned.sessionName], { stdio: "ignore" });
  }
  await rm(stateDir, { recursive: true, force: true });
}
