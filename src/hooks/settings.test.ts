import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_HOOK_EVENT_NAMES } from "./types.ts";
import { hookSettingsDocument, writeHookSettingsFile } from "./settings.ts";

test("a supervised session's settings register every hook and turn prompt suggestions off", async () => {
  const document = hookSettingsDocument("node relay.js");
  assert.deepEqual(Object.keys(document.hooks).sort(), [...CLAUDE_HOOK_EVENT_NAMES].sort());
  // Ghost suggestion text in the input box would hold every send back as leftover input.
  assert.equal(document.promptSuggestionEnabled, false);
  const dir = await mkdtemp(join(tmpdir(), "pi-cs-hook-settings-"));
  try {
    const path = join(dir, "settings.json");
    await writeHookSettingsFile(path, "node relay.js");
    assert.equal(JSON.parse(await readFile(path, "utf8")).promptSuggestionEnabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
