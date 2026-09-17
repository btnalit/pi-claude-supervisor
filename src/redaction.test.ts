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
