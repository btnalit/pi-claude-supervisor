import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PiDecisionWorker } from "./decision-worker.ts";

test("Decision Worker refuses a symlinked recovery session file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-decision-worker-session-link-"));
  const cwd = join(root, "cwd");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd);
  await mkdir(sessionDir);
  const outside = join(root, "outside.jsonl");
  const sessionFile = join(sessionDir, "session.jsonl");
  const header = `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd })}\n`;
  await writeFile(outside, header);
  await symlink(outside, sessionFile);
  const worker = new PiDecisionWorker({
    context: {
      taskId: "33333333-3333-4333-8333-333333333333",
      task: "recovery symlink test",
      cwd,
      state: "starting",
      turn: 0,
      maxTurns: 1,
    },
    onAction: () => {},
    sessionFile,
    sessionDir,
  });

  await assert.rejects(() => worker.start(), /ELOOP|secure Decision Worker session-file opening is unavailable/u);
  assert.equal(await readFile(outside, "utf8"), header);
  await rm(root, { recursive: true, force: true });
});
