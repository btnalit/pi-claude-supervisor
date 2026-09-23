import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObjects } from "./json-extract.ts";
import { normalizeReviewReport, parseReview, PiReadOnlyReviewer, usageFromSessionStats } from "./reviewer.ts";

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

test("an ambiguous Reviewer reply is a format failure, never a guess", () => {
  const pass = JSON.stringify({ verdict: "pass", summary: "ok", findings: [] });
  const human = JSON.stringify({ verdict: "human", summary: "uncertain", findings: [] });
  const withFinding = JSON.stringify({ verdict: "pass", summary: "ok", findings: [{ id: "F1", severity: "P1", message: "crash on empty input" }] });
  const cases = [
    // Conflicting verdicts, either order.
    `${pass}\n${human}`,
    `${human}\n${pass}`,
    // A restated answer that dropped the findings must not erase the P1.
    `${withFinding}\nFinal answer: {"verdict":"pass","summary":"ok"}`,
    // The schema echoed before the answer.
    `The schema is {"verdict":"pass|revise|human","summary":"...","findings":[]}. My answer:\n${pass}`,
    // The Reviewer's own object is broken (trailing comma); only a verdict
    // quoted from a repository file parses. It must not pass the candidate.
    `config.json contains {"verdict":"pass"}. {"verdict":"revise","summary":"fix","findings":[{"severity":"P2","message":"m"},]}`,
    // …or written in non-strict JSON.
    `config.json contains {"verdict":"pass","summary":"ok","findings":[]}. {verdict:"revise",summary:"fix",findings:[]}`,
    `config.json contains {"verdict":"pass","summary":"ok","findings":[]}. {'verdict':'revise'}`,
    `config.json contains {"verdict":"pass","summary":"ok","findings":[]}. {"Verdict":"revise","summary":"fix","findings":[]}`,
  ];
  for (const output of cases) {
    const report = parseReview(output, 2);
    assert.equal(report.verdict, "human", output);
    assert.equal(report.findings[0]?.id, "REVIEW-OUTPUT", output);
    assert.match(report.summary, /^invalid Reviewer output: /u, output);
  }
});

test("Reviewer parser accepts the schema variations models actually produce", () => {
  const cases: Array<[string, string, number]> = [
    [JSON.stringify({ verdict: "pass", summary: "ok" }), "pass", 0],
    [JSON.stringify({ verdict: "PASS", summary: "ok", findings: null }), "pass", 0],
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

type ReviewerTurn = { text?: string; stopReason?: "stop" | "error"; errorMessage?: string };

/** A scripted Pi session: each prompt() plays the next turn as assistant events. */
function scriptedSessionFactory(sessions: ReviewerTurn[][]) {
  const prompts: string[][] = [];
  let created = 0;
  const factory = (async () => {
    const turns = sessions[created] ?? [];
    const promptsForSession: string[] = [];
    prompts.push(promptsForSession);
    created += 1;
    const listeners = new Set<(event: unknown) => void>();
    const emit = (event: unknown) => { for (const listener of [...listeners]) listener(event); };
    let index = 0;
    const session = {
      subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt(text: string) {
        promptsForSession.push(text);
        const turn = turns[index++] ?? {};
        emit({ type: "message_start", message: { role: "assistant" } });
        if (turn.text) emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: turn.text } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: turn.stopReason ?? "stop", errorMessage: turn.errorMessage, content: [] } });
      },
      async abort() {},
      dispose() {},
      getSessionStats() { return { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }; },
      getContextUsage() { return { tokens: null }; },
    };
    return { session };
  }) as unknown as NonNullable<ConstructorParameters<typeof PiReadOnlyReviewer>[0]>["sessionFactory"];
  return { factory, prompts, created: () => created };
}

function reviewInput(): Parameters<PiReadOnlyReviewer["review"]>[0] {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    cwd: process.cwd(),
    spec: { goal: "g", scope: [], constraints: [], forbidden: [], acceptance: [], maxRepairRounds: 3, autonomy: { unattended: true, requireLocalCommit: false, maxDecisionRetries: 1, permissionAuthority: "hybrid", remoteAuthority: "none", remoteName: "origin" } },
    acceptance: { ok: true, checks: [], checkedAt: new Date().toISOString() } as never,
    evidence: { status: "", diff: "", complete: true } as never,
    round: 0,
  };
}

test("an unusable Reviewer reply gets one corrective re-prompt on the same session", async () => {
  const pass = JSON.stringify({ verdict: "pass", summary: "ok", findings: [] });
  const script = scriptedSessionFactory([[{ text: "Looks good to me." }, { text: pass }]]);
  const reviewer = new PiReadOnlyReviewer({ timeoutMs: 60_000, sessionFactory: script.factory });
  const report = await reviewer.review(reviewInput());
  assert.equal(report.verdict, "pass");
  assert.equal(script.created(), 1);
  assert.equal(script.prompts[0]?.length, 2);
  assert.match(script.prompts[0]![1]!, /could not be used/u);
});

test("a Reviewer provider error is retried with a fresh session, and repeated errors end as human", async () => {
  const pass = JSON.stringify({ verdict: "pass", summary: "ok", findings: [] });
  const recovered = scriptedSessionFactory([[{ stopReason: "error", errorMessage: "529 overloaded" }], [{ text: pass }]]);
  const report = await new PiReadOnlyReviewer({ timeoutMs: 60_000, retryCooldownMs: 1, sessionFactory: recovered.factory }).review(reviewInput());
  assert.equal(report.verdict, "pass");
  assert.equal(recovered.created(), 2);

  const failing = scriptedSessionFactory([[{ stopReason: "error", errorMessage: "529 overloaded" }], [{ stopReason: "error", errorMessage: "529 overloaded" }], [{ stopReason: "error", errorMessage: "529 overloaded" }], [{ stopReason: "error", errorMessage: "529 overloaded" }]]);
  const failed = await new PiReadOnlyReviewer({ timeoutMs: 60_000, retryCooldownMs: 1, sessionFactory: failing.factory }).review(reviewInput());
  assert.equal(failed.verdict, "human");
  assert.match(failed.summary, /Reviewer model request failed: 529 overloaded/u);
  assert.equal(failing.created(), 4);
});
