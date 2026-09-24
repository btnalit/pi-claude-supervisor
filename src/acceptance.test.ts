import assert from "node:assert/strict";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeTaskSpec } from "./acceptance.ts";
import { collectRepositoryEvidence, verifyAll } from "./verifier.ts";

const execFileAsync = promisify(execFile);

test("legacy tasks receive a default acceptance check", () => {
  const spec = normalizeTaskSpec(undefined, "inspect the repository");
  assert.equal(spec.goal, "inspect the repository");
  assert.deepEqual(spec.acceptance.map((check) => check.id), ["diff-check"]);
  assert.equal(spec.maxRepairRounds, 3);
  assert.deepEqual(spec.autonomy, { unattended: true, requireLocalCommit: true, maxDecisionRetries: 4, permissionAuthority: "hybrid", remoteAuthority: "none", remoteName: "origin" });
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

test("verifyAll cancels an in-flight acceptance command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-acceptance-cancel-"));
  const controller = new AbortController();
  try {
    const pending = verifyAll(cwd, [{ id: "cancel", name: "cancel", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], required: true, timeoutMs: 30_000 }], { signal: controller.signal });
    setTimeout(() => controller.abort(), 30).unref();
    const report = await pending;
    assert.equal(report.ok, false);
    assert.equal(report.checks[0]?.status, "cancelled");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository evidence includes staged and untracked changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-evidence-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "base\\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "staged change\\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await writeFile(join(cwd, "new.txt"), "new file content\\n");

    const evidence = await collectRepositoryEvidence(cwd);
    assert.equal(evidence.complete, true);
    assert.ok(evidence.branch);
    assert.match(evidence.diff, /staged change/u);
    assert.match(evidence.untracked ?? "", /new\.txt/u);
    assert.match(evidence.untracked ?? "", /new file content/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository evidence includes commits after an explicit task baseline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-evidence-commits-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "base\\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd });
    const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    await writeFile(join(cwd, "tracked.txt"), "candidate\\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "candidate"], { cwd });

    const evidence = await collectRepositoryEvidence(cwd, { baseRef: base });
    assert.equal(evidence.complete, true);
    assert.equal(evidence.baseRef, base);
    assert.match(evidence.commits ?? "", /candidate/u);
    assert.match(evidence.diff, /candidate/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository evidence rejects untracked symlinks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-evidence-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-claude-evidence-outside-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd });
    await writeFile(join(outside, "secret.txt"), "outside content\\n");
    await symlink(join(outside, "secret.txt"), join(cwd, "link.txt"));
    const evidence = await collectRepositoryEvidence(cwd);
    assert.equal(evidence.complete, false);
    assert.match(evidence.untracked ?? "", /non-regular file|symlink|read failed/u);
    assert.doesNotMatch(evidence.untracked ?? "", /outside content/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("repository evidence omits untracked hard-link aliases", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-evidence-hard-link-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "secret.txt"), "sensitive metadata\n");
    await link(join(cwd, "secret.txt"), join(cwd, "alias.txt"));
    const evidence = await collectRepositoryEvidence(cwd);
    assert.equal(evidence.complete, false);
    assert.match(evidence.untracked ?? "", /hard-link|read failed|untracked/i);
    assert.doesNotMatch(evidence.untracked ?? "", /sensitive metadata/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository evidence marks a maxBuffer overflow as truncated instead of an outright failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-evidence-maxbuffer-"));
  const originalMaxBytes = process.env.PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_BYTES;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "base\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "x".repeat(2_000_000));

    // A tiny evidence bound (64 KiB, the configured minimum) keeps the exec maxBuffer
    // (8x that) well under the ~2 MiB diff this rewrite produces, forcing execFile to
    // throw ERR_CHILD_PROCESS_STDIO_MAXBUFFER instead of returning full output.
    process.env.PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_BYTES = String(64 * 1024);
    const evidence = await collectRepositoryEvidence(cwd);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.truncated, true);
  } finally {
    if (originalMaxBytes === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_BYTES;
    else process.env.PI_CLAUDE_SUPERVISOR_EVIDENCE_MAX_BYTES = originalMaxBytes;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verifyAll records timeout evidence and bounds check output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-acceptance-"));
  try {
    const report = await verifyAll(cwd, [
      { id: "timeout", name: "timeout", command: process.execPath, args: ["-e", "setTimeout(() => {}, 5_000)"], required: true, timeoutMs: 1_000 },
      { id: "large-output", name: "large output", command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(1_500_000))"], required: false, timeoutMs: 1_000 },
    ]);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0]?.status, "timed_out");
    assert.notEqual(report.checks[0]?.output, "");
    assert.equal(report.checks[1]?.status, "passed");
    assert.ok(Buffer.byteLength(report.checks[1]?.output ?? "", "utf8") <= 1024 * 1024);
    assert.ok(Buffer.byteLength(report.output, "utf8") <= 1024 * 1024);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("remote authority is validated and defaults to none", () => {
  assert.equal(normalizeTaskSpec({ goal: "g" }, "g").autonomy.remoteAuthority, "none");
  assert.equal(normalizeTaskSpec({ goal: "g", autonomy: { remoteAuthority: "pr" } }, "g").autonomy.remoteAuthority, "pr");
  assert.equal(normalizeTaskSpec({ goal: "g", autonomy: { remoteName: "upstream" } }, "g").autonomy.remoteName, "upstream");
  assert.throws(() => normalizeTaskSpec({ goal: "g", autonomy: { remoteAuthority: "merge" } }, "g"), /remoteAuthority must be none, push or pr/u);
  assert.throws(() => normalizeTaskSpec({ goal: "g", autonomy: { remoteName: "a b" } }, "g"), /remoteName must be a plain remote name/u);
});

test("a spec file that omits a key, or the whole autonomy block, keeps the operator's environment defaults", () => {
  const defaults = { unattended: false, requireLocalCommit: false, maxDecisionRetries: 5, permissionAuthority: "policy" as const, remoteAuthority: "push" as const, remoteName: "upstream", maxWorkerCostUsd: 3 };
  // No block at all is the common spec file; it must not fall back to hardcoded values.
  assert.deepEqual(normalizeTaskSpec({ goal: "g" }, "g", defaults).autonomy, defaults);
  assert.deepEqual(normalizeTaskSpec({ goal: "g", autonomy: {} }, "g", defaults).autonomy, defaults);
  // A key the spec does name wins over the default, key by key.
  const partial = normalizeTaskSpec({ goal: "g", autonomy: { remoteAuthority: "none", unattended: true } }, "g", defaults).autonomy;
  assert.deepEqual(partial, { ...defaults, remoteAuthority: "none", unattended: true });
  // Without defaults the hardcoded values still apply.
  assert.deepEqual(normalizeTaskSpec({ goal: "g" }, "g").autonomy, { unattended: true, requireLocalCommit: true, maxDecisionRetries: 4, permissionAuthority: "hybrid", remoteAuthority: "none", remoteName: "origin" });
});
