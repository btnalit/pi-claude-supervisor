import assert from "node:assert/strict";
import test from "node:test";
import { parseReview } from "./reviewer.ts";

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

test("invalid Reviewer output escalates to human", () => {
  for (const output of ["not JSON", "```json\n{\"verdict\":\"pass\",\"summary\":\"ok\"}\n```", "{} trailing", JSON.stringify({ verdict: "revise", summary: "missing findings", findings: [] })]) {
    const report = parseReview(output, 2);
    assert.equal(report.verdict, "human");
    assert.equal(report.findings[0]?.severity, "P1");
  }
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
