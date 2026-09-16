import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workerEnvironment } from "../src/worker/environment.ts";
import { assertSupportedClaudeVersion, MIN_SUPPORTED_CLAUDE_VERSION, resolveClaudeExecutable } from "./claude-version.mjs";

if (process.env.PI_CLAUDE_SUPERVISOR_REAL_CLAUDE !== "1") {
  throw new Error("Set PI_CLAUDE_SUPERVISOR_REAL_CLAUDE=1 to run the authenticated Claude tmux interactive spike");
}

const claude = resolveClaudeExecutable();
const model = process.env.PI_CLAUDE_SUPERVISOR_REAL_CLAUDE_MODEL ?? "opus";
const version = execFileSync(claude, ["--version"], { encoding: "utf8" }).trim();
assertSupportedClaudeVersion(version);
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
  let lastScreen = "";
  while (Date.now() < deadline) {
    lastScreen = capture();
    if (predicate(lastScreen)) return lastScreen;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${description}; last screen:\n${lastScreen.slice(-4_000)}`);
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
  // Wait for Ink to finish mounting the choice before sending keys; newer
  // Claude releases can render the prompt before they accept input.
  await new Promise((resolve) => setTimeout(resolve, 500));
  sendKeys("Down", "Enter");
  await waitFor((screen) => /manual mode on/iu.test(screen) && /❯/u.test(screen), 30_000, "trusted Claude prompt");

  paste(`Use Bash to run exactly: rm -f ${target}. Then reply with exactly TMUX_PERMISSION_DONE. Do not use any other tools.`);
  const permissionPrompt = await waitFor(
    (screen) => /Do you want to proceed\?/u.test(screen) && /\d+\. Yes(?:,|\s|$)/u.test(screen) && /\d+\. No(?:\s|$)/u.test(screen),
    120_000,
    "Claude Bash permission prompt",
  );
  assert.match(permissionPrompt, /permission-target/u);
  await new Promise((resolve) => setTimeout(resolve, 500));
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
    claudeMinimumVersion: MIN_SUPPORTED_CLAUDE_VERSION,
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
