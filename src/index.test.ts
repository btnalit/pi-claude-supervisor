import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import extension from "./index.ts";

test("index releases a confirmed-clean failed worker cwd reservation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-index-"));
  const stateDir = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-state-"));
  const previousWorker = process.env.PI_CLAUDE_SUPERVISOR_WORKER;
  const previousStateDir = process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR;
  process.env.PI_CLAUDE_SUPERVISOR_WORKER = `${process.execPath} -e "process.exit(1)"`;
  process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR = stateDir;

  const registrations: { commands: Array<{ name: string; definition: { handler: (args: string, ctx: TestContext) => Promise<void> } }>; events: Array<{ name: string; handler: () => Promise<void> }> } = { commands: [], events: [] };
  const messages: string[] = [];
  const context: TestContext = {
    cwd,
    hasUI: true,
    ui: { confirm: async () => false, notify: (message) => messages.push(message) },
  };
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

    await command.handler("start failing worker", context);
    assert.match(messages.at(-1) ?? "", /^Worker started:/u);

    await command.handler("start overlapping worker", context);
    assert.match(messages.at(-1) ?? "", /overlapping cwd/u);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await command.handler("poll", context);
      if ((messages.at(-1) ?? "").includes("running=false")) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
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
    if (previousWorker === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_WORKER;
    else process.env.PI_CLAUDE_SUPERVISOR_WORKER = previousWorker;
    if (previousStateDir === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR;
    else process.env.PI_CLAUDE_SUPERVISOR_STATE_DIR = previousStateDir;
    await rm(cwd, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

type TestContext = {
  cwd: string;
  hasUI: boolean;
  ui: { confirm: () => Promise<boolean>; notify: (message: string) => void };
};
