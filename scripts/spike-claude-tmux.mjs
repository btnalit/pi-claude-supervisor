import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLog } from "../src/events.ts";
import { Supervisor } from "../src/supervisor.ts";
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
let firstUnsubscribe;
let firstSupervisor;
let secondAdapter;

const waitForSequence = async (sequence, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = completed.find((candidate) => candidate.sequence === sequence);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for Claude tmux turn ${sequence}`);
};

const assertExactScreenResult = (event, marker) => {
  const screen = event?.result?.screen_tail;
  assert.equal(typeof screen, "string");
  assert.match(screen, new RegExp(`(?:^|\\n)\\s*●\\s*${marker}(?:\\s|$)`, "u"));
};

try {
  firstAdapter = new TmuxWorkerAdapter({ stateDir, pollIntervalMs: 250, startupTimeoutMs: 90_000, terminationGraceMs: 5_000 });
  firstSupervisor = new Supervisor(firstAdapter, new EventLog(join(stateDir, "events.jsonl")));
  owned = await firstSupervisor.start({
    task: "interactive tmux validation",
    initialInput: "",
    sendInitialInput: false,
    cwd,
    command: claude,
    args: ["--permission-mode", "plan"],
  });
  firstUnsubscribe = firstAdapter.subscribe(owned, (event) => { if (event.type === "turn_completed") completed.push(event); });
  await firstSupervisor.send("Reply with exactly TMUX_OK. Do not use tools, inspect files, or describe this instruction.");
  const firstTurn = await waitForSequence(1);
  assertExactScreenResult(firstTurn, "TMUX_OK");
  assert.equal((await firstAdapter.getStatus(owned)).activeRequests, 0);

  await firstAdapter.pause(owned);
  await firstAdapter.resume(owned);
  await firstSupervisor.send("Reply with exactly TMUX_SECOND_OK. Do not use tools or inspect files.");
  const secondTurn = await waitForSequence(2);
  assertExactScreenResult(secondTurn, "TMUX_SECOND_OK");
  assert.equal((await firstAdapter.getStatus(owned)).activeRequests, 0);

  await firstSupervisor.takeover();
  assert.equal(firstSupervisor.humanRequired, true);
  await firstSupervisor.send("Reply with exactly TMUX_TAKEOVER_OK. Do not use tools or inspect files.");
  const takeoverTurn = await waitForSequence(3);
  assertExactScreenResult(takeoverTurn, "TMUX_TAKEOVER_OK");
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
  await firstSupervisor.release("tmux spike restart handoff");

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
    ownedTurns: 3,
    exactOutput: true,
    pauseResume: true,
    humanTakeover: true,
    restartReadoption: true,
    adoptedDetachPreservedSession: true,
    modelOutputRecorded: false,
  }, null, 2));
} finally {
  firstUnsubscribe?.();
  if (owned?.tmuxSocket && owned?.sessionName) {
    spawnSync("tmux", ["-S", owned.tmuxSocket, "kill-session", "-t", owned.sessionName], { stdio: "ignore" });
  }
  await rm(stateDir, { recursive: true, force: true });
}
