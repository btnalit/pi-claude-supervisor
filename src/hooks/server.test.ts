import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookSocketDirectory, HookServer } from "./server.ts";
import type { ClaudeHookEvent, HookRelayReply, HookRelayRequest } from "./types.ts";

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
