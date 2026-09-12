import assert from "node:assert/strict";
import test from "node:test";
import { workerEnvironment } from "./environment.ts";

test("worker environment keeps essentials and excludes unrelated credentials", () => {
  const result = workerEnvironment(
    { PATH: "/bin", HOME: "/home/test", ANTHROPIC_API_KEY: "secret", RANDOM_TOKEN: "hidden" },
    { ANTHROPIC_API_KEY: "explicit" },
  );
  assert.equal(result.PATH, "/bin");
  assert.equal(result.HOME, "/home/test");
  assert.equal(result.ANTHROPIC_API_KEY, "explicit");
  assert.equal(result.RANDOM_TOKEN, undefined);
});
