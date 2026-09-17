import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __resetPiModelCacheForTests, resolvePiModel } from "./pi-model.ts";

async function tempAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-model-test-"));
}

test("undefined and empty specs resolve to undefined", async () => {
  const agentDir = await tempAgentDir();
  try {
    assert.equal(await resolvePiModel(undefined, agentDir), undefined);
    assert.equal(await resolvePiModel("", agentDir), undefined);
    assert.equal(await resolvePiModel("   ", agentDir), undefined);
  } finally {
    __resetPiModelCacheForTests();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a spec without a provider/model-id slash is rejected", async () => {
  const agentDir = await tempAgentDir();
  try {
    await assert.rejects(() => resolvePiModel("anthropic-claude-opus", agentDir), /Pi model must be written as provider\/model-id/u);
    await assert.rejects(() => resolvePiModel("/claude-opus", agentDir), /Pi model must be written as provider\/model-id/u);
    await assert.rejects(() => resolvePiModel("anthropic/", agentDir), /Pi model must be written as provider\/model-id/u);
  } finally {
    __resetPiModelCacheForTests();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("an unknown provider/model is rejected as unavailable", async () => {
  const agentDir = await tempAgentDir();
  try {
    await assert.rejects(() => resolvePiModel("not-a-real-provider/not-a-real-model", agentDir), /Pi model is not available: not-a-real-provider\/not-a-real-model/u);
  } finally {
    __resetPiModelCacheForTests();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a model spec containing extra slashes splits on the first one", async () => {
  const agentDir = await tempAgentDir();
  try {
    await assert.rejects(() => resolvePiModel("provider/model/with/slashes", agentDir), /Pi model is not available: provider\/model\/with\/slashes/u);
  } finally {
    __resetPiModelCacheForTests();
    await rm(agentDir, { recursive: true, force: true });
  }
});
