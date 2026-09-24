import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_EMBEDDED_SCRIPTS, HOOK_RELAY_SCRIPT } from "./relay.ts";
import { HookServer } from "./server.ts";
import type { ClaudeHookEvent, HookRelayReply, HookRelayRequest } from "./types.ts";

test("embedded relay script is syntactically valid JavaScript", () => {
  for (const script of Object.values(HOOK_EMBEDDED_SCRIPTS)) {
    assert.doesNotThrow(() => new Function(script));
  }
});

async function withTempCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cs-hook-relay-cwd-"));
  try {
    return await run(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseEvent(overrides: Partial<ClaudeHookEvent> & { cwd: string }): ClaudeHookEvent {
  return {
    hook_event_name: "Notification",
    session_id: "session-1",
    ...overrides,
  } as ClaudeHookEvent;
}

interface RelayRunResult {
  stdout: string;
  code: number | null;
  durationMs: number;
}

/** Runs the relay via `node -e SCRIPT`, feeding `event` on stdin. */
async function runRelay(event: unknown, hookDir: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<RelayRunResult> {
  return runScript(["-e", HOOK_RELAY_SCRIPT], event, hookDir, extraEnv);
}

/** Runs the relay as a written file, mirroring what install.ts produces. */
async function runRelayFile(event: unknown, hookDir: string, relayPath: string): Promise<RelayRunResult> {
  await writeFile(relayPath, HOOK_RELAY_SCRIPT, "utf8");
  return runScript([relayPath], event, hookDir);
}

async function runScript(args: string[], event: unknown, hookDir: string | undefined, extraEnv: NodeJS.ProcessEnv = {}): Promise<RelayRunResult> {
  const start = Date.now();
  // The test runner may itself run under Claude Code; its project directory must not steer routing here.
  const { PI_CLAUDE_SUPERVISOR_HOOK_DIR: _ignored, CLAUDE_PROJECT_DIR: _project, ...inherited } = process.env;
  const child = spawn(process.execPath, args, {
    env: { ...inherited, ...(hookDir === undefined ? {} : { PI_CLAUDE_SUPERVISOR_HOOK_DIR: hookDir }), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stdin.end(JSON.stringify(event));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolveExit(exitCode));
  });
  return { stdout: Buffer.concat(stdoutChunks).toString("utf8"), code, durationMs: Date.now() - start };
}

async function withServer<T>(run: (server: HookServer, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-cs-hook-server-"));
  const server = new HookServer({ directory });
  await server.listen();
  try {
    return await run(server, directory);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("PreToolUse reply is translated into Claude's permissionDecision JSON", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async (request: HookRelayRequest) => {
        assert.equal(request.event.hook_event_name, "PreToolUse");
        assert.equal(request.event.tool_use_id, "tool-1");
        const reply: HookRelayReply = { permissionDecision: "deny", permissionDecisionReason: "nope" };
        return reply;
      });
      try {
        const event = baseEvent({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_use_id: "tool-1" });
        const result = await runRelay(event, hookDir);
        assert.equal(result.code, 0);
        assert.deepEqual(JSON.parse(result.stdout), {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "nope",
          },
        });
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("PreToolUse reply also works via a written relay.js file", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "allow" }));
      try {
        const event = baseEvent({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_use_id: "tool-1" });
        const relayPath = join(hookDir, "relay.js");
        const result = await runRelayFile(event, hookDir, relayPath);
        assert.equal(result.code, 0);
        assert.deepEqual(JSON.parse(result.stdout), {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        });
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("an installed relay.js finds its hooks directory from its own location without any environment", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "deny", permissionDecisionReason: "boundary" }));
      try {
        const relayPath = join(hookDir, "relay.js");
        await writeFile(relayPath, HOOK_RELAY_SCRIPT, "utf8");
        const event = baseEvent({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_use_id: "tool-2" });
        // No PI_CLAUDE_SUPERVISOR_HOOK_DIR: Claude's hook subprocess never has Pi's environment.
        const result = await runScript([relayPath], event, undefined);
        assert.equal(result.code, 0);
        assert.deepEqual(JSON.parse(result.stdout), {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "boundary" },
        });
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("Stop reply with block:true is translated into a top-level decision", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({ block: true, blockReason: "keep going" }));
      try {
        const event = baseEvent({ hook_event_name: "Stop", cwd, last_assistant_message: "done" });
        const result = await runRelay(event, hookDir);
        assert.equal(result.code, 0);
        assert.deepEqual(JSON.parse(result.stdout), { decision: "block", reason: "keep going" });
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("a non-blocking Notification event returns instantly with empty stdout", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "deny" }));
      try {
        const event = baseEvent({ hook_event_name: "Notification", cwd, notification_type: "permission_prompt" });
        const result = await runRelay(event, hookDir);
        assert.equal(result.code, 0);
        assert.equal(result.stdout, "");
        assert.ok(result.durationMs < 2000, `Notification took ${result.durationMs}ms`);
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("PermissionRequest allow reply carries no message field (doc: message is deny-only)", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "allow", permissionDecisionReason: "ignored for allow" }));
      try {
        const event = baseEvent({ hook_event_name: "PermissionRequest", cwd, tool_name: "Bash" });
        const result = await runRelay(event, hookDir);
        assert.equal(result.code, 0);
        assert.deepEqual(JSON.parse(result.stdout), {
          hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
        });
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("PermissionRequest deny reply carries the reason as message", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "deny", permissionDecisionReason: "Database writes are not allowed" }));
      try {
        const event = baseEvent({ hook_event_name: "PermissionRequest", cwd, tool_name: "Bash" });
        const result = await runRelay(event, hookDir);
        assert.equal(result.code, 0);
        assert.deepEqual(JSON.parse(result.stdout), {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: "Database writes are not allowed" },
          },
        });
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("PermissionRequest ask reply prints nothing (not representable in the documented decision shape)", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "ask" }));
      try {
        const event = baseEvent({ hook_event_name: "PermissionRequest", cwd, tool_name: "Bash" });
        const result = await runRelay(event, hookDir);
        assert.equal(result.code, 0);
        assert.equal(result.stdout, "");
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("a Worker that cd'd into a subdirectory is still routed by CLAUDE_PROJECT_DIR", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const subdir = join(cwd, "packages", "app");
      await mkdir(subdir, { recursive: true });
      const seen: HookRelayRequest[] = [];
      const unsubscribe = await server.subscribe(cwd, async (request) => {
        seen.push(request);
        return { permissionDecision: "deny", permissionDecisionReason: "routed" };
      });
      try {
        const event = baseEvent({ hook_event_name: "PreToolUse", cwd: subdir, tool_name: "Bash", tool_use_id: "tool-cd" });
        const result = await runRelay(event, hookDir, { CLAUDE_PROJECT_DIR: cwd });
        assert.equal(result.code, 0);
        assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, "routed");
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.routeCwd, cwd);
        assert.equal(seen[0]!.event.cwd, subdir);
        // Without the project directory the same event has no owner, as before.
        const unrouted = await runRelay(event, hookDir);
        assert.equal(unrouted.stdout, "");
        assert.equal(seen.length, 1);
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("an unsupervised CLAUDE_PROJECT_DIR falls back to routing by the event cwd", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "allow" }));
      try {
        const event = baseEvent({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_use_id: "tool-fallback" });
        const result = await runRelay(event, hookDir, { CLAUDE_PROJECT_DIR: join(tmpdir(), "pi-cs-no-such-project") });
        assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("a nested Claude in a subdirectory of a supervised cwd is not routed to that Supervisor", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const subdir = join(cwd, "nested");
      await mkdir(subdir);
      let calls = 0;
      const unsubscribe = await server.subscribe(cwd, async () => { calls += 1; return { permissionDecision: "deny" }; });
      try {
        const event = baseEvent({ hook_event_name: "PreToolUse", cwd: subdir, tool_name: "Bash", tool_use_id: "tool-nested" });
        // A nested Claude reports its own launch directory as the project directory.
        const result = await runRelay(event, hookDir, { CLAUDE_PROJECT_DIR: subdir });
        assert.equal(result.stdout, "");
        assert.equal(calls, 0);
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("an event for a cwd with no Supervisor exits fast with empty stdout", async () => {
  const hookDir = await mkdtemp(join(tmpdir(), "pi-cs-hook-relay-nohookdir-"));
  try {
    await withTempCwd(async (cwd) => {
      const event = baseEvent({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_use_id: "tool-1" });
      const result = await runRelay(event, hookDir);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
      assert.ok(result.durationMs < 500, `unknown-cwd relay took ${result.durationMs}ms`);
    });
  } finally {
    await rm(hookDir, { recursive: true, force: true });
  }
});

test("a reply with no fields prints nothing", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({}));
      try {
        const event = baseEvent({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_use_id: "tool-1" });
        const result = await runRelay(event, hookDir);
        assert.equal(result.code, 0);
        assert.equal(result.stdout, "");
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("malformed stdin exits 0 silently", async () => {
  const hookDir = await mkdtemp(join(tmpdir(), "pi-cs-hook-relay-malformed-"));
  try {
    const child = spawn(process.execPath, ["-e", HOOK_RELAY_SCRIPT], {
      env: { ...process.env, PI_CLAUDE_SUPERVISOR_HOOK_DIR: hookDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stdin.end("not json");
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolveExit(exitCode));
    });
    assert.equal(code, 0);
    assert.equal(Buffer.concat(stdoutChunks).toString("utf8"), "");
  } finally {
    await rm(hookDir, { recursive: true, force: true });
  }
});
