import { spawn } from "node:child_process";

// Automatic tmux/cgroup tests use real PTYs and delegated process trees. Keep
// CI's full, zero-skip suite deterministic on hosted runners; local developers
// retain Node's normal file-level parallelism unless they opt into the same
// safety gate.
const testConcurrency = process.env.PI_CLAUDE_SUPERVISOR_FAIL_ON_TEST_SKIP === "1" ? ["--test-concurrency=1"] : [];
const child = spawn(process.execPath, ["--test", ...testConcurrency, "src/**/*.test.ts", "scripts/*.test.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

let output = "";
const forward = (stream, chunk) => {
  const text = String(chunk);
  output += text;
  stream.write(chunk);
};
child.stdout.on("data", (chunk) => forward(process.stdout, chunk));
child.stderr.on("data", (chunk) => forward(process.stderr, chunk));

const result = await new Promise((resolve) => {
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  child.once("close", (code, signal) => resolve({ code, signal, spawnError }));
});

if (result.spawnError) throw result.spawnError;
if (result.code !== 0) process.exit(result.code ?? 1);

if (process.env.PI_CLAUDE_SUPERVISOR_FAIL_ON_TEST_SKIP !== "1") process.exit(0);

// Node's default spec reporter is the stable machine-readable summary used by
// the CI gate. Refuse to guess if the summary format changes: a missing count
// must not silently turn skipped automatic tests into a green job.
const matches = [...output.matchAll(/(?:^|\n)\s*(?:ℹ|#)\s+skipped\s+(\d+)/gu)];
const summary = matches.at(-1);
if (!summary) {
  console.error("CI safety gate: test skip summary was not found; refusing to treat coverage as complete");
  process.exit(1);
}
const skipped = Number(summary[1]);
if (!Number.isSafeInteger(skipped) || skipped !== 0) {
  console.error(`CI safety gate: ${summary[1]} test(s) skipped; automatic-path coverage is incomplete`);
  process.exit(1);
}
