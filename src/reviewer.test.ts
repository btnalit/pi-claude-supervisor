import assert from "node:assert/strict";
import test from "node:test";
import { balancedObjectEnd, extractJsonObjects } from "./json-extract.ts";
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

test("conflicting Reviewer JSON objects remain blocking", () => {
  const report = parseReview(
    `${JSON.stringify({ verdict: "pass", summary: "ok", findings: [] })}\n${JSON.stringify({ verdict: "human", summary: "uncertain", findings: [] })}`,
    2,
  );
  assert.equal(report.verdict, "human");
  assert.match(report.summary, /multiple distinct JSON objects/u);
});

test("invalid Reviewer output escalates to human", () => {
  for (const output of ["not JSON", "{} trailing", JSON.stringify({ verdict: "pass", summary: "missing findings" }), JSON.stringify({ verdict: "revise", summary: "missing findings", findings: [] })]) {
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

test("balanced JSON ignores escaped quotes, backslashes and braces inside strings", () => {
  const first = JSON.stringify({ message: 'brace } and { quote " and slash \\', nested: { ok: true } });
  const text = `${first} trailing ${JSON.stringify({ ok: true })}`;
  assert.equal(balancedObjectEnd(text, 0), first.length - 1);
  assert.deepEqual(extractJsonObjects(text), [{ message: 'brace } and { quote " and slash \\', nested: { ok: true } }, { ok: true }]);
  assert.equal(balancedObjectEnd('{"message":"unterminated\\\\', 0), -1);
});

test("malformed outer JSON cannot promote a nested verdict or duplicate key", () => {
  const malformed = '{"verdict":"human","summary":"no","findings":[],"nested":{"verdict":"pass","summary":"ok","findings":[]},}';
  assert.deepEqual(extractJsonObjects(malformed), []);
  assert.deepEqual(extractJsonObjects('{"verdict":"pass","verdict":"human","summary":"x","findings":[]}'), []);
  assert.equal(parseReview(malformed, 0).verdict, "human");
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
