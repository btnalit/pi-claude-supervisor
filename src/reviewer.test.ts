import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObjects } from "./json-extract.ts";
import { normalizeReviewReport, parseReview, usageFromSessionStats } from "./reviewer.ts";

test("Reviewer parser accepts bounded structured findings", () => {
  const report = parseReview(JSON.stringify({
    verdict: "revise",
    summary: "missing regression coverage",
    findings: [{ id: "F001", severity: "P2", message: "Add a test", file: "src/x.ts", line: 4, requiredFix: "Add the regression test" }],
  }), 1);
  assert.equal(report.verdict, "revise");
  assert.equal(report.round, 1);
  assert.equal(report.findings[0]?.severity, "P2");
});

test("malformed custom Reviewer values are normalized to a blocking report", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const value of [undefined, null, "not an object", circular]) {
    const report = normalizeReviewReport(value, 3);
    assert.equal(report.verdict, "human");
    assert.equal(report.round, 3);
    assert.equal(report.findings[0]?.severity, "P1");
  }
});

test("Reviewer parser tolerates fences, prose and an identical repeated object", () => {
  const object = JSON.stringify({ verdict: "pass", summary: "ok", findings: [] });
  const fenced = "```json\n" + object + "\n```";
  for (const output of [fenced, `Here is the review:\n${object}\nDone.`, `${object}\n${object}`]) {
    const report = parseReview(output, 2);
    assert.equal(report.verdict, "pass");
    assert.equal(report.findings.length, 0);
  }
});

test("conflicting Reviewer verdict objects resolve to the most cautious verdict", () => {
  const pass = JSON.stringify({ verdict: "pass", summary: "ok", findings: [] });
  const human = JSON.stringify({ verdict: "human", summary: "uncertain", findings: [] });
  // Whichever order they come in, a quoted or restated `pass` never outvotes
  // the Reviewer's own `human`.
  for (const output of [`${pass}\n${human}`, `${human}\n${pass}`]) {
    const report = parseReview(output, 2);
    assert.equal(report.verdict, "human");
    assert.equal(report.summary, "uncertain");
  }
});

test("Reviewer parser accepts the schema variations models actually produce", () => {
  const schemaEcho = '{"verdict":"pass|revise|human","summary":"...","findings":[]}';
  const cases: Array<[string, string, number]> = [
    [JSON.stringify({ verdict: "pass", summary: "ok" }), "pass", 0],
    [JSON.stringify({ verdict: "PASS", summary: "ok", findings: null }), "pass", 0],
    [`The schema is ${schemaEcho}. My answer:\n${JSON.stringify({ verdict: "pass", summary: "ok", findings: [] })}`, "pass", 0],
    [`I checked {"a": 1} in config.json.\n${JSON.stringify({ verdict: "revise", summary: "fix", findings: [{ severity: "p2", message: "m", line: "42" }] })}`, "revise", 1],
    [JSON.stringify({ verdict: "revise", summary: "fix", findings: [{ severity: "medium", message: "m", line: null }, { severity: "odd", requiredFix: "do x", line: "10-20" }] }), "revise", 2],
  ];
  for (const [output, verdict, count] of cases) {
    const report = parseReview(output, 1);
    assert.equal(report.verdict, verdict, output);
    assert.equal(report.findings.length, count, output);
  }
  const detailed = parseReview(JSON.stringify({ verdict: "revise", summary: "fix", findings: [{ severity: "medium", message: "m", line: "42" }, { severity: "odd", requiredFix: "do x", line: "10-20" }, { severity: "high", message: "h", line: null }] }), 1);
  assert.deepEqual(detailed.findings.map((finding) => [finding.severity, finding.message, finding.line]), [["P2", "m", 42], ["P2", "do x", 10], ["P1", "h", undefined]]);
});

test("invalid Reviewer output escalates to human", () => {
  for (const output of ["not JSON", "{} trailing", JSON.stringify({ verdict: "maybe", summary: "unsupported" }), JSON.stringify({ verdict: "revise", summary: "missing findings", findings: [] })]) {
    const report = parseReview(output, 2);
    assert.equal(report.verdict, "human");
    assert.equal(report.findings[0]?.severity, "P1");
  }
});

test("Reviewer output and finding counts are bounded", () => {
  const tooLarge = parseReview(JSON.stringify({ verdict: "pass", summary: "x".repeat(140_000) }), 0);
  assert.equal(tooLarge.verdict, "human");
  const tooManyFindings = Array.from({ length: 65 }, (_, index) => ({ id: `F${index}`, severity: "P2", message: "too many findings" }));
  const bounded = parseReview(JSON.stringify({ verdict: "revise", summary: "too many", findings: tooManyFindings }), 0);
  assert.equal(bounded.verdict, "human");
});

test("extractJsonObjects finds every balanced JSON object in surrounding text", () => {
  const objects = extractJsonObjects('{"a":1} text {"b":2}');
  assert.equal(objects.length, 2);
  assert.deepEqual(objects[0], { a: 1 });
  assert.deepEqual(objects[1], { b: 2 });
});

test("usageFromSessionStats maps aggregate session token counters onto ReviewReport.usage", () => {
  const usage = usageFromSessionStats({ input: 500, output: 120, cacheRead: 40, cacheWrite: 10, total: 670 });
  assert.deepEqual(usage, { input: 500, output: 120, cacheRead: 40, cacheWrite: 10, totalTokens: 670 });
});

test("Reviewer pass with a blocking finding is normalized by the supervisor contract", () => {
  const report = parseReview(JSON.stringify({
    verdict: "pass",
    summary: "looks good",
    findings: [{ id: "F001", severity: "P1", message: "unsafe behavior" }],
  }), 0);
  assert.equal(report.verdict, "pass");
  assert.equal(report.findings[0]?.severity, "P1");
});
