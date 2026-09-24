import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitive } from "./redaction.ts";

test("redacts lowercase inline credential and authorization forms", () => {
  const secrets = ["lower-api", "lower-token", "lower-auth", "lower-header", "lower-password"];
  const redacted = String(redactSensitive("api_key=lower-api token: lower-token Authorization: Bearer lower-auth x-api-key: lower-header password=lower-password"));
  for (const secret of secrets) assert.doesNotMatch(redacted, new RegExp(secret, "u"));
  assert.match(redacted, /\[REDACTED\]/u);
});

test("does not redact ordinary code that merely mentions a sensitive-looking identifier", () => {
  assert.equal(redactSensitive("const token = request.token;"), "const token = request.token;");
  assert.equal(redactSensitive("token: string"), "token: string");
});

test("still redacts short-key inline secret assignments and quoted secret literals", () => {
  assert.equal(redactSensitive("token=abcdefgh12345678"), "token=[REDACTED]");
  assert.equal(redactSensitive('password: "hunter2hunter2"'), "password: [REDACTED]");
});

test("dotted secrets are redacted whole rather than leaking their tail", () => {
  assert.equal(redactSensitive("token=abcdefgh.ijklmnop1"), "token=[REDACTED]");
  assert.equal(redactSensitive("secret: sk_live_abcdefgh.suffixdata"), "secret: [REDACTED]");
  assert.equal(redactSensitive("token=dp.st.dev.abcdefghijklmnop"), "token=[REDACTED]");
  assert.equal(redactSensitive("token=abc.def-12345678"), "token=[REDACTED]");
  assert.doesNotMatch(String(redactSensitive("token=abcdefgh.ijklmnop1")), /ijklmnop/u);
  assert.equal(redactSensitive("password=hunterhunter"), "password=[REDACTED]");
  assert.equal(redactSensitive("token=ABCDEFGH"), "token=[REDACTED]");
});

test("token counts under a sensitive-looking key are numbers, not secrets", () => {
  assert.deepEqual(
    redactSensitive({ role: "decision", input: 3156, totalTokens: 3324, contextTokens: 8000, token: "abc123def456ghi789", tokens: ["abc123def456ghi789"] }),
    { role: "decision", input: 3156, totalTokens: 3324, contextTokens: 8000, token: "[REDACTED]", tokens: ["[REDACTED]"] },
  );
});

test("redacts OpenAI-style and Google model API keys wherever they appear", () => {
  // Placeholders with the real shapes; none of these is a key.
  const openaiStyle = `sk-${"0123456789abcdef".repeat(2)}`;
  const googleClassic = `AIza${"X".repeat(35)}`;
  const googleBound = `AQ.${"Ab8_example-placeholder".repeat(2)}`;
  const redacted = String(redactSensitive(`provider said: invalid key ${openaiStyle}; retry with ${googleClassic} or ${googleBound}.`));
  for (const key of [openaiStyle, googleClassic, googleBound]) assert.ok(!redacted.includes(key), key);
  assert.equal(redacted.match(/\[REDACTED\]/gu)?.length, 3);
  assert.equal(redactSensitive("the task-scheduler and sk-learn stay"), "the task-scheduler and sk-learn stay");
});
