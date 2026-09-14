import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workerEnvironment } from "../src/worker/environment.ts";

if (process.env.PI_CLAUDE_SUPERVISOR_REAL_CLAUDE !== "1") {
  throw new Error("Set PI_CLAUDE_SUPERVISOR_REAL_CLAUDE=1 to run the authenticated Claude tmux interactive spike");
}

const claude = process.env.PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_PATH;
const expectedVersion = process.env.PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_VERSION ?? "2.1.270 (Claude Code)";
const model = process.env.PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_MODEL ?? "opus";
if (!claude) throw new Error("Set PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_PATH to the pinned Claude executable");
const version = execFileSync(claude, ["--version"], { encoding: "utf8" }).trim();
assert.equal(version, expectedVersion, `unexpected Claude version: expected ${expectedVersion}, got ${version}`);
const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-real-tmux-interactive-"));
const cwd = await mkdtemp(join(root, "untrusted-cwd-"));
const socket = join(root, "tmux.sock");
const session = `pi-real-interactive-${process.pid}`;
const target = join(cwd, "permission-target");
const environment = workerEnvironment(process.env);
let sessionStarted = false;

const tmux = (args, input) => execFileSync("tmux", ["-S", socket, ...args], {
  encoding: "utf8",
  input,
  env: environment,
  stdio: ["pipe", "pipe", "pipe"],
});
const capture = () => {
  try { return tmux(["capture-pane", "-p", "-J", "-t", session, "-S", "-100"]); }
  catch { return ""; }
};
const sendKeys = (...keys) => { tmux(["send-keys", "-t", session, ...keys]); };
const paste = (text) => {
  tmux(["load-buffer", "-b", "pi-real-interactive", "-"], `${text}\n`);
  tmux(["paste-buffer", "-p", "-d", "-b", "pi-real-interactive", "-t", session]);
  sendKeys("Enter");
};
const waitFor = async (predicate, timeoutMs, description) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = capture();
    if (predicate(screen)) return screen;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${description}`);
};

try {
  await writeFile(target, "permission-spike-target\n");
  tmux([
    "-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "180", "-y", "50", "-c", cwd,
    "--", claude, "--model", model, "--permission-mode", "default", "--tools", "Bash",
  ]);
  sessionStarted = true;

  const trustPrompt = await waitFor(
    (screen) => /Quick safety check|Do you trust the files in this folder|Yes, I trust this folder/iu.test(screen),
    30_000,
    "Claude trust prompt",
  );
  assert.match(trustPrompt, /No, exit[\s\S]*Yes, I trust this folder/iu);
  sendKeys("Down", "Enter");
  await waitFor((screen) => /manual mode on/iu.test(screen) && /❯/u.test(screen), 30_000, "trusted Claude prompt");

  paste(`Use Bash to run exactly: rm -f ${target}. Then reply with exactly TMUX_PERMISSION_DONE. Do not use any other tools.`);
  const permissionPrompt = await waitFor(
    (screen) => /Do you want to proceed\?/u.test(screen) && /1\. Yes/u.test(screen) && /4\. No/u.test(screen),
    120_000,
    "Claude Bash permission prompt",
  );
  assert.match(permissionPrompt, /(?:Delete|Remove) the permission-target/u);
  sendKeys("Enter");
  const result = await waitFor(
    (screen) => /(?:^|\n)\s*●\s*TMUX_PERMISSION_DONE(?:\s|$)/u.test(screen),
    120_000,
    "exact Claude permission result",
  );
  assert.match(result, /(?:^|\n)\s*●\s*TMUX_PERMISSION_DONE(?:\s|$)/u);
  await assert.rejects(() => readFile(target), /ENOENT/u);

  console.log(JSON.stringify({
    claudeVersion: version,
    claudePath: claude,
    claudeModel: model,
    trustPrompt: true,
    permissionPrompt: true,
    permissionDecision: "allow-once",
    exactOutput: true,
    rawModelOutputRecorded: false,
  }, null, 2));
} finally {
  if (sessionStarted) {
    try { tmux(["kill-session", "-t", session]); } catch {}
  }
  await rm(root, { recursive: true, force: true });
}
