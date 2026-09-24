import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookSocketDirectory, HookServer } from "./server.ts";
import { CLAUDE_HOOK_EVENT_NAMES, type ClaudeHookEvent, type HookRelayReply, type HookRelayRequest } from "./types.ts";

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

async function withTempCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cs-hook-server-cwd-"));
  try {
    return await run(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function byCwdPath(directory: string, cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex");
  return join(directory, "by-cwd", hash);
}

function request(cwd: string, overrides: Partial<ClaudeHookEvent> = {}): HookRelayRequest {
  return {
    version: 1,
    pid: 1234,
    ppid: 1,
    event: {
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      cwd,
      tool_name: "Bash",
      tool_use_id: "tool-1",
      ...overrides,
    },
  };
}

/** Sends one line and reads one reply line over a raw connection to the server's socket. */
async function send(socketPath: string, line: string): Promise<{ reply: string; closed: boolean }> {
  return new Promise((resolveReply, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk) => { buffer += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolveReply({ reply: buffer, closed: true }));
  });
}

test("a deep state directory still yields a connectable socket (unix sun_path limit)", async () => {
  const deep = join(await mkdtemp(join(tmpdir(), "pi-cs-hooks-")), "a".repeat(60), "b".repeat(40), "hooks");
  await mkdir(deep, { recursive: true });
  assert.ok(Buffer.byteLength(join(deep, "by-cwd", "x".repeat(64))) > 108, "fixture path must exceed sun_path");
  const server = new HookServer({ directory: deep });
  await server.listen();
  try {
    assert.ok(Buffer.byteLength(server.socketPath ?? "") <= 100);
    const cwd = await mkdtemp(join(tmpdir(), "pi-cs-cwd-"));
    const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "deny", permissionDecisionReason: "deep" }));
    try {
      const link = join(deep, "by-cwd", createHash("sha256").update(await realpath(cwd)).digest("hex"));
      const target = await realpath(link);
      const reply = await new Promise<string>((resolveReply, reject) => {
        const socket = createConnection(target, () => {
          socket.write(`${JSON.stringify({ version: 1, pid: process.pid, ppid: process.ppid, event: { hook_event_name: "PreToolUse", session_id: "s", cwd, tool_name: "Bash", tool_input: {}, tool_use_id: "t" } })}\n`);
        });
        let data = "";
        socket.on("data", (chunk) => { data += String(chunk); });
        socket.on("end", () => resolveReply(data));
        socket.on("error", reject);
      });
      assert.equal(JSON.parse(reply).permissionDecision, "deny");
    } finally {
      await unsubscribe();
      await rm(cwd, { recursive: true, force: true });
    }
  } finally {
    await server.close();
  }
});

test("routes a request to the handler subscribed for its canonical cwd and replies with its result", async () => {
  await withServer(async (server, directory) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async (req) => {
        assert.equal(req.event.tool_use_id, "tool-1");
        const reply: HookRelayReply = { permissionDecision: "allow" };
        return reply;
      });
      try {
        const result = await send(server.socketPath!, JSON.stringify(request(cwd)));
        assert.deepEqual(JSON.parse(result.reply), { permissionDecision: "allow" });
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("routes by the relay's routeCwd when present, so an event from a subdirectory reaches the task's handler", async () => {
  await withServer(async (server) => {
    await withTempCwd(async (cwd) => {
      const subdir = join(cwd, "sub");
      await mkdir(subdir);
      const unsubscribe = await server.subscribe(cwd, async () => ({ permissionDecision: "allow" }));
      try {
        const routed = await send(server.socketPath!, JSON.stringify({ ...request(subdir), routeCwd: cwd }));
        assert.deepEqual(JSON.parse(routed.reply), { permissionDecision: "allow" });
        const unrouted = await send(server.socketPath!, JSON.stringify(request(subdir)));
        assert.deepEqual(JSON.parse(unrouted.reply), {});
        const relative = await send(server.socketPath!, JSON.stringify({ ...request(cwd), routeCwd: "relative/dir" }));
        assert.deepEqual(JSON.parse(relative.reply), {});
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("every hook event the Supervisor installs reaches its handler through the server", async () => {
  await withServer(async (server) => {
    await withTempCwd(async (cwd) => {
      const seen: string[] = [];
      const unsubscribe = await server.subscribe(cwd, async (req) => {
        seen.push(req.event.hook_event_name);
        return {};
      });
      try {
        // StopFailure (a turn ended by an API/model error) used to be dropped
        // here while install and settings registered it.
        for (const name of CLAUDE_HOOK_EVENT_NAMES) await send(server.socketPath!, JSON.stringify(request(cwd, { hook_event_name: name })));
        assert.deepEqual(seen, [...CLAUDE_HOOK_EVENT_NAMES]);
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("10 concurrent requests for different cwds are all answered without serialization", async () => {
  await withServer(async (server) => {
    const cwdDirs = await Promise.all(Array.from({ length: 10 }, () => mkdtemp(join(tmpdir(), "pi-cs-hook-server-cwd-"))));
    const cwds = await Promise.all(cwdDirs.map((dir) => realpath(dir)));
    const unsubscribers = await Promise.all(cwds.map((cwd, index) => server.subscribe(cwd, async (req) => {
      assert.equal(req.event.tool_use_id, `tool-${index}`);
      return { permissionDecision: "allow", permissionDecisionReason: `ok-${index}` };
    })));
    try {
      const results = await Promise.all(cwds.map((cwd, index) => send(server.socketPath!, JSON.stringify(request(cwd, { tool_use_id: `tool-${index}` })))));
      results.forEach((result, index) => {
        assert.deepEqual(JSON.parse(result.reply), { permissionDecision: "allow", permissionDecisionReason: `ok-${index}` });
      });
    } finally {
      await Promise.all(unsubscribers.map((unsubscribe) => unsubscribe()));
      await Promise.all(cwdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });
});

test("a request for a cwd with no subscriber gets an empty reply", async () => {
  await withServer(async (server) => {
    await withTempCwd(async (cwd) => {
      const result = await send(server.socketPath!, JSON.stringify(request(cwd)));
      assert.deepEqual(JSON.parse(result.reply), {});
    });
  });
});

test("a handler that throws still replies with an empty object", async () => {
  await withServer(async (server) => {
    await withTempCwd(async (cwd) => {
      const unsubscribe = await server.subscribe(cwd, async () => {
        throw new Error("boom");
      });
      try {
        const result = await send(server.socketPath!, JSON.stringify(request(cwd)));
        assert.deepEqual(JSON.parse(result.reply), {});
      } finally {
        await unsubscribe();
      }
    });
  });
});

test("a malformed line gets an empty reply and the connection is closed", async () => {
  await withServer(async (server) => {
    const result = await send(server.socketPath!, "not json");
    assert.deepEqual(JSON.parse(result.reply), {});
    assert.equal(result.closed, true);
  });
});

test("subscribe creates a by-cwd symlink and unsubscribe removes it", async () => {
  await withServer(async (server, directory) => {
    await withTempCwd(async (cwd) => {
      const linkPath = byCwdPath(directory, cwd);
      const unsubscribe = await server.subscribe(cwd, async () => ({}));
      const link = await readlink(linkPath);
      assert.equal(link, server.socketPath);
      await unsubscribe();
      await assert.rejects(() => lstat(linkPath), /ENOENT/);
    });
  });
});

test("close removes the socket file and every by-cwd symlink pointing at it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cs-hook-server-"));
  const server = new HookServer({ directory });
  await server.listen();
  const socketPath = server.socketPath!;
  try {
    await withTempCwd(async (cwd) => {
      await server.subscribe(cwd, async () => ({}));
      const linkPath = byCwdPath(directory, cwd);
      await server.close();
      await assert.rejects(() => stat(socketPath), /ENOENT/);
      await assert.rejects(() => lstat(linkPath), /ENOENT/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hookSocketDirectory joins the state dir with hooks", () => {
  assert.equal(hookSocketDirectory("/home/user/.pi/agent/claude-supervisor"), join("/home/user/.pi/agent/claude-supervisor", "hooks"));
});
