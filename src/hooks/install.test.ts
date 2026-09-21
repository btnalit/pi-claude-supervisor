import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installUserHooks, uninstallUserHooks } from "./install.ts";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cs-hook-install-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const EVENT_NAMES = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "StopFailure", "Notification"];

test("a fresh settings file gains all eight hook events", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, "settings.json");
    const stateDir = join(dir, "state");
    const result = await installUserHooks({ settingsPath, stateDir });
    assert.equal(result.changed, true);
    assert.equal(result.settingsPath, settingsPath);
    const relayContent = await readFile(result.relayPath, "utf8");
    assert.ok(relayContent.includes("HOOK_TIMEOUT_SECONDS") === false); // plain JS, no leaked TS identifiers
    const document = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const name of EVENT_NAMES) {
      assert.equal(document.hooks[name].length, 1);
      const entry = document.hooks[name][0].hooks[0];
      assert.equal(entry.type, "command");
      assert.ok(entry.command.includes(result.relayPath));
      assert.equal(entry.timeout, 180);
    }
  });
});

test("running install twice is idempotent", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, "settings.json");
    const stateDir = join(dir, "state");
    const first = await installUserHooks({ settingsPath, stateDir });
    assert.equal(first.changed, true);
    const second = await installUserHooks({ settingsPath, stateDir });
    assert.equal(second.changed, false);
    const document = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const name of EVENT_NAMES) assert.equal(document.hooks[name].length, 1);
  });
});

test("existing unrelated hooks are preserved", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, "settings.json");
    const stateDir = join(dir, "state");
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      },
    }));
    await installUserHooks({ settingsPath, stateDir });
    const document = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(document.hooks.UserPromptSubmit.length, 2);
    assert.deepEqual(document.hooks.UserPromptSubmit[0], { hooks: [{ type: "command", command: "echo hi" }] });
    assert.ok(document.hooks.UserPromptSubmit[1].hooks[0].command.includes("/hooks/relay.js"));
  });
});

test("invalid JSON throws and the settings file is left untouched", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, "settings.json");
    const stateDir = join(dir, "state");
    await writeFile(settingsPath, "{ not valid json");
    await assert.rejects(() => installUserHooks({ settingsPath, stateDir }), /not valid JSON/);
    const raw = await readFile(settingsPath, "utf8");
    assert.equal(raw, "{ not valid json");
  });
});

test("uninstall removes only our entries", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, "settings.json");
    const stateDir = join(dir, "state");
    await installUserHooks({ settingsPath, stateDir });
    let document = JSON.parse(await readFile(settingsPath, "utf8"));
    document.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "echo hi" }] });
    await writeFile(settingsPath, JSON.stringify(document));

    const result = await uninstallUserHooks({ settingsPath, stateDir });
    assert.equal(result.changed, true);
    document = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const name of EVENT_NAMES) {
      if (name === "UserPromptSubmit") {
        assert.deepEqual(document.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: "echo hi" }] }]);
      } else {
        assert.equal(document.hooks[name], undefined);
      }
    }

    const second = await uninstallUserHooks({ settingsPath, stateDir });
    assert.equal(second.changed, false);
  });
});

test("a symlinked settings file is written through, not replaced", async () => {
  await withTempDir(async (dir) => {
    const realPath = join(dir, "real-settings.json");
    const settingsPath = join(dir, "settings.json");
    await writeFile(realPath, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    await symlink(realPath, settingsPath);
    const stateDir = join(dir, "state");
    const result = await installUserHooks({ settingsPath, stateDir });
    assert.equal(result.changed, true);
    const linkInfo = await lstat(settingsPath);
    assert.ok(linkInfo.isSymbolicLink(), "settings path must still be a symlink");
    const document = JSON.parse(await readFile(realPath, "utf8"));
    assert.equal(document.hooks.Stop.length, 1);
    assert.deepEqual(document.hooks.UserPromptSubmit[0], { hooks: [{ type: "command", command: "echo hi" }] });
  });
});

test("an unrelated executable at a relay.js path is left alone", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-cs-install-"));
  const settingsPath = join(stateDir, "settings.json");
  const foreign = { type: "command", command: `python /home/me/hooks/relay.js`, timeout: 5 };
  await writeFile(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] } }), "utf8");
  await uninstallUserHooks({ stateDir, settingsPath });
  const after = JSON.parse(await readFile(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  assert.equal(after.hooks.Stop[0]?.hooks[0]?.command, foreign.command);
  await rm(stateDir, { recursive: true, force: true });
});

test("an unrelated hook whose command merely mentions relay.js is left alone", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-cs-install-"));
  const settingsPath = join(stateDir, "settings.json");
  const foreign = { type: "command", command: "/home/me/bin/notify-me.sh --log /home/me/hooks/relay.js.log", timeout: 5 };
  await writeFile(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] } }), "utf8");
  await installUserHooks({ stateDir, settingsPath });
  const installed = JSON.parse(await readFile(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  assert.ok(installed.hooks.Stop.some((group) => group.hooks.some((entry) => entry.command === foreign.command)), "foreign entry preserved by install");
  await uninstallUserHooks({ stateDir, settingsPath });
  const after = JSON.parse(await readFile(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  assert.ok(after.hooks.Stop.some((group) => group.hooks.some((entry) => entry.command === foreign.command)), "foreign entry preserved by uninstall");
  assert.ok(!after.hooks.Stop.some((group) => group.hooks.some((entry) => /\/hooks\/relay\.js['"]?$/u.test(entry.command))), "our entry removed");
  await rm(stateDir, { recursive: true, force: true });
});

test("installing under a settings directory that does not yet exist creates it", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = join(dir, "nested", "claude", "settings.json");
    const stateDir = join(dir, "state");
    const result = await installUserHooks({ settingsPath, stateDir });
    assert.equal(result.changed, true);
    const document = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(document.hooks.Stop.length, 1);
  });
});
