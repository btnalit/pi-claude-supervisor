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

test("verifyAll records multiple required and optional check outcomes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-acceptance-"));
  try {
    const report = await verifyAll(cwd, [
      { id: "required-pass", name: "required pass", command: process.execPath, args: ["-e", "process.stdout.write('PASS')"], required: true, timeoutMs: 1_000 },
      { id: "required-fail", name: "required fail", command: process.execPath, args: ["-e", "process.stderr.write('REQUIRED_FAIL'); process.exit(7)"], required: true, timeoutMs: 1_000 },
      { id: "optional-fail", name: "optional fail", command: process.execPath, args: ["-e", "process.exit(2)"], required: false, timeoutMs: 1_000 },
      { id: "optional-pass", name: "optional pass", command: process.execPath, args: ["-e", "process.stdout.write('OPTIONAL_PASS')"], required: false, timeoutMs: 1_000 },
    ]);
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.map((check) => check.status), ["passed", "failed", "failed", "passed"]);
    assert.equal(report.checks[1]?.exitCode, 7);
    assert.match(report.checks[1]?.output ?? "", /REQUIRED_FAIL/u);
    assert.match(report.output, /PASS/u);
    assert.match(report.output, /OPTIONAL_PASS/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verifyAll records timeout evidence and bounds check output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-acceptance-"));
  try {
    const report = await verifyAll(cwd, [
      { id: "timeout", name: "timeout", command: process.execPath, args: ["-e", "setTimeout(() => {}, 5_000)"], required: true, timeoutMs: 1_000 },
      { id: "large-output", name: "large output", command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(300_000))"], required: false, timeoutMs: 1_000 },
    ]);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0]?.status, "timed_out");
    assert.notEqual(report.checks[0]?.output, "");
    assert.equal(report.checks[1]?.status, "failed");
    assert.match(report.checks[1]?.output ?? "", /TRUNCATED/u);
    assert.ok(Buffer.byteLength(report.checks[1]?.output ?? "", "utf8") <= 256 * 1024);
    assert.ok(Buffer.byteLength(report.output, "utf8") <= 256 * 1024);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
