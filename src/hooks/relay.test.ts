import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
async function runRelay(event: unknown, hookDir: string): Promise<RelayRunResult> {
  return runScript(["-e", HOOK_RELAY_SCRIPT], event, hookDir);
}

/** Runs the relay as a written file, mirroring what install.ts produces. */
async function runRelayFile(event: unknown, hookDir: string, relayPath: string): Promise<RelayRunResult> {
  await writeFile(relayPath, HOOK_RELAY_SCRIPT, "utf8");
  return runScript([relayPath], event, hookDir);
}

async function runScript(args: string[], event: unknown, hookDir: string | undefined): Promise<RelayRunResult> {
  const start = Date.now();
  const { PI_CLAUDE_SUPERVISOR_HOOK_DIR: _ignored, ...inherited } = process.env;
  const child = spawn(process.execPath, args, {
    env: hookDir === undefined ? inherited : { ...inherited, PI_CLAUDE_SUPERVISOR_HOOK_DIR: hookDir },
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

test("StopFailure is relayed as a non-blocking event without stdout", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      let resolveObserved!: () => void;
      const observed = new Promise<void>((resolve) => { resolveObserved = resolve; });
      const unsubscribe = await server.subscribe(cwd, async (request: HookRelayRequest) => {
        assert.equal(request.event.hook_event_name, "StopFailure");
        resolveObserved();
        return { block: true, blockReason: "ignored for StopFailure" };
      });
      try {
        const event = baseEvent({ hook_event_name: "StopFailure", cwd, error: "stop failed" });
        const result = await runRelay(event, hookDir);
        assert.equal(result.code, 0);
        assert.equal(result.stdout, "");
        await Promise.race([observed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("StopFailure was not delivered")), 2_000))]);
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

test("a same-UID replacement socket cannot answer a blocking hook", async () => {
  await withServer(async (server, hookDir) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "allow" }));
      const links = await readdir(join(hookDir, "by-cwd"));
      assert.equal(links.length, 1);
      const route = join(hookDir, "by-cwd", links[0]!);
      const fakePath = join(hookDir, "replacement.sock");
      const fake = spawn(process.execPath, ["-e", [
        "const net = require('net');",
        "const path = process.argv[1];",
        "const server = net.createServer((socket) => socket.end(JSON.stringify({ permissionDecision: 'allow' }) + '\\n'));",
        "server.listen(path, () => process.stdout.write('ready\\n'));",
      ].join(""), fakePath], { stdio: ["ignore", "pipe", "pipe"] });
      let original: string | undefined;
      try {
        await new Promise<void>((resolveReady, rejectReady) => {
          const timer = setTimeout(() => rejectReady(new Error("replacement socket did not start")), 2_000);
          fake.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
          fake.once("close", (code) => { clearTimeout(timer); rejectReady(new Error(`replacement socket exited (${code ?? "unknown"})`)); });
          fake.stdout.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("ready")) { clearTimeout(timer); resolveReady(); }
          });
        });
        original = await readlink(route);
        await unlink(route);
        await symlink(fakePath, route);
        const result = await Promise.race([
          runRelay(baseEvent({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_use_id: "replacement" }), hookDir),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("replacement relay did not fail closed")), 4_000)),
        ]);
        assert.equal(result.code, 0);
        assert.equal(result.stdout, "");
      } finally {
        if (original !== undefined) {
          await unlink(route).catch(() => {});
          await symlink(original, route).catch(() => {});
        }
        if (fake.exitCode === null && fake.signalCode === null) fake.kill("SIGTERM");
        await new Promise<void>((resolveExit) => {
          if (fake.exitCode !== null || fake.signalCode !== null) { resolveExit(); return; }
          const timer = setTimeout(() => { fake.kill("SIGKILL"); resolveExit(); }, 1_000);
          fake.once("close", () => { clearTimeout(timer); resolveExit(); });
        });
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
