import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeTaskSpec } from "./acceptance.ts";
import { verifyAll } from "./verifier.ts";

test("legacy tasks receive a default acceptance check", () => {
  const spec = normalizeTaskSpec(undefined, "inspect the repository");
  assert.equal(spec.goal, "inspect the repository");
  assert.deepEqual(spec.acceptance.map((check) => check.id), ["diff-check"]);
  assert.equal(spec.maxRepairRounds, 3);
});

test("task specs validate checks and reject duplicate ids", () => {
  const spec = normalizeTaskSpec({
    goal: "implement the feature",
    scope: ["API"],
    constraints: ["keep compatibility"],
    forbidden: ["deploy"],
    acceptance: [{ id: "tests", command: process.execPath, args: ["-e", "process.exit(0)"] }],
    maxRepairRounds: 2,
  }, "fallback");
  assert.equal(spec.acceptance[0]?.required, true);
  assert.equal(spec.maxRepairRounds, 2);
  assert.throws(() => normalizeTaskSpec({
    goal: "duplicate",
    acceptance: [
      { id: "same", command: "true", args: [] },
      { id: "same", command: "true", args: [] },
    ],
  }, "fallback"), /duplicate acceptance check id/u);
});

test("verifyAll records required and optional check outcomes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-acceptance-"));
  try {
    const report = await verifyAll(cwd, [
      { id: "pass", name: "pass", command: process.execPath, args: ["-e", "process.stdout.write('PASS')"], required: true, timeoutMs: 1_000 },
      { id: "optional", name: "optional", command: process.execPath, args: ["-e", "process.exit(2)"], required: false, timeoutMs: 1_000 },
    ]);
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.map((check) => check.status), ["passed", "failed"]);
    assert.match(report.output, /PASS/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
