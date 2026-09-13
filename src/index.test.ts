import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import extension from "./index.ts";

test("index rejects an unknown worker transport instead of falling back", () => {
  const previous = process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
  process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "not-a-transport";
  try {
    assert.throws(() => extension({} as never), /Unsupported PI_CLAUDE_SUPERVISOR_TRANSPORT/u);
  } finally {
    if (previous === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
    else process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = previous;
  }
});

test("index rejects an unknown cgroup mode instead of falling back", () => {
  const previous = process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
  process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = "unsafe-fallback";
  try {
    assert.throws(() => extension({} as never), /Unsupported PI_CLAUDE_SUPERVISOR_CGROUP_MODE/u);
  } finally {
    if (previous === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
    else process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = previous;
  }
});

test("index releases a confirmed-clean failed worker cwd reservation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-index-"));
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-state-"));
  const previousWorker = process.env.PI_CLAUDE_SUPERVISOR_WORKER;
  const previousStateDir = process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR;
  const previousTransport = process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
  const previousCgroupMode = process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
  const previousMode = process.env.PI_CLAUDE_SUPERVISOR_MODE;
  const previousAutomation = process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION;
  process.env.PI_CLAUDE_SUPERVISOR_WORKER = `${process.execPath} -e "const { existsSync } = require('node:fs'); const timer = setInterval(() => { if (existsSync('.worker-failed')) { clearInterval(timer); process.exit(1); } }, 10)"`;
  process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR = stateDir;
  process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "process-pipe";
  // This test exercises process-group cleanup on hosts without a writable
  // cgroup; production defaults to required and fails closed instead.
  process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = "off";
  process.env.PI_CLAUDE_SUPERVISOR_MODE = "manual";
  process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION = "0";

  const registrations: { commands: Array<{ name: string; definition: { handler: (args: string, ctx: TestContext) => Promise<void> } }>; events: Array<{ name: string; handler: () => Promise<void> }> } = { commands: [], events: [] };
  const messages: string[] = [];
  const context: TestContext = {
    cwd,
    hasUI: true,
    ui: { confirm: async () => false, notify: (message) => messages.push(message) },
  };
  let shutdownHandler: (() => Promise<void>) | undefined;
  const fakePi = {
    registerCommand(name: string, definition: { handler: (args: string, ctx: TestContext) => Promise<void> }) {
      registrations.commands.push({ name, definition });
    },
    on(name: string, handler: () => Promise<void>) {
      registrations.events.push({ name, handler });
    },
  };

  try {
    extension(fakePi as never);
    const command = registrations.commands.find(({ name }) => name === "supervise")?.definition;
    const shutdown = registrations.events.find(({ name }) => name === "session_shutdown")?.handler;
    assert.ok(command);
    assert.ok(shutdown);
    shutdownHandler = shutdown;

    await command.handler("start failing worker", context);
    assert.match(messages.at(-1) ?? "", /^Worker started:/u);

    await command.handler("start overlapping worker", context);
    assert.match(messages.at(-1) ?? "", /overlapping cwd/u);

    await writeFile(join(cwd, ".worker-failed"), "fail\n");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await command.handler("poll", context);
      if ((messages.at(-1) ?? "").includes("running=false")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(messages.at(-1) ?? "", /running=false/u);

    process.env.PI_CLAUDE_SUPERVISOR_WORKER = `${process.execPath} -e "setInterval(() => {}, 10000)"`;
    await command.handler("start reusable worker", context);
    const startedMessage = messages.at(-1) ?? "";
    assert.match(startedMessage, /^Worker started:/u);
    const pid = Number(startedMessage.match(/pid (\d+)/u)?.[1]);
    assert.ok(pid);
    await shutdown();
    assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  } finally {
    if (shutdownHandler) {
      try {
        await shutdownHandler();
      } catch (error) {
        console.error(`index test cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (previousWorker === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_WORKER;
    else process.env.PI_CLAUDE_SUPERVISOR_WORKER = previousWorker;
    if (previousStateDir === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR;
    else process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR = previousStateDir;
    if (previousTransport === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT;
    else process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = previousTransport;
    if (previousCgroupMode === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
    else process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = previousCgroupMode;
    if (previousMode === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_MODE;
    else process.env.PI_CLAUDE_SUPERVISOR_MODE = previousMode;
    if (previousAutomation === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION;
    else process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION = previousAutomation;
    await rm(cwd, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

type TestContext = {
  cwd: string;
  hasUI: boolean;
  ui: { confirm: () => Promise<boolean>; notify: (message: string) => void };
};
