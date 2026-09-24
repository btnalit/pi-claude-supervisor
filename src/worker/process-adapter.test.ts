import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, constants, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { claudeJsonlArgs, cleanupCgroup, currentCgroupPath, PROCESS_EMBEDDED_SCRIPTS, preflightCgroupContainment, ProcessWorkerAdapter, processGroupHasLiveMember } from "./process-adapter.ts";

const requiredCgroupTestAvailable = process.platform === "linux" && await canCreateCgroup();

test("claude-jsonl arguments normalize controlled equals options and reject duplicates", () => {
  assert.deepEqual(claudeJsonlArgs(["--input-format=stream-json", "--output-format=stream-json", "--permission-prompt-tool=stdio", "--permission-prompts=host"]), [
    "--input-format", "stream-json", "--output-format", "stream-json", "--permission-prompt-tool", "stdio", "--permission-prompts", "host", "-p", "--verbose",
  ]);
  assert.throws(() => claudeJsonlArgs(["--input-format=stream-json", "--input-format", "stream-json"]), /may not be repeated/u);
  assert.throws(() => claudeJsonlArgs(["--permission-prompts=none"]), /must be host/u);
});

test("automatic process scope allows nested Claude and cleans all descendants", { skip: !requiredCgroupTestAvailable }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-process-nested-test-"));
  const fakeClaude = join(root, "claude");
  const nestedClaude = join(root, "nested", "claude");
  const nestedPidFile = join(root, "nested.pid");
  await mkdir(join(root, "nested"), { recursive: true });
  await copyFile(process.execPath, nestedClaude);
  await chmod(nestedClaude, 0o700);
  await writeFile(fakeClaude, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const nested = ${JSON.stringify(nestedClaude)};
const nestedPidFile = ${JSON.stringify(nestedPidFile)};
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => {
  if (!data.trim()) return;
  const child = spawn(nested, ["-e", "setInterval(() => {}, 10000)"], { detached: true, stdio: "ignore" });
  if (child.pid) writeFileSync(nestedPidFile, String(child.pid));
  child.unref();
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "nested-test" }) + "\\n");
});
`);
  await chmod(fakeClaude, 0o700);
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl", cgroupMode: "required", terminationGraceMs: 100, killGraceMs: 100 });
  let handle;
  let nestedPid: number | undefined;
  try {
    handle = await adapter.start({ task: "trigger", cwd: root, command: fakeClaude, args: [], automatic: true });
    let status = await adapter.getStatus(handle);
    for (let attempt = 0; attempt < 100 && status.activeRequests !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await adapter.getStatus(handle);
    }
    assert.equal(status.runtimeError, undefined);
    assert.equal(status.running, true);
    assert.equal(status.activeRequests, 0);
    for (let attempt = 0; attempt < 20 && nestedPid === undefined; attempt += 1) {
      try { nestedPid = Number(await readFile(nestedPidFile, "utf8")); }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.ok(nestedPid && nestedPid > 0);
  } finally {
    if (handle) await adapter.stop(handle, "nested Claude test cleanup").catch(() => {});
    if (nestedPid) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { process.kill(nestedPid, 0); }
        catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.throws(() => process.kill(nestedPid!, 0), /ESRCH/u);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic process adapter inherits capability variables when input env is partial", { skip: !requiredCgroupTestAvailable, concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-process-environment-test-"));
  const capture = join(root, "environment.json");
  const fakeClaude = join(root, "claude.mjs");
  const key = "PI_CLAUDE_SUPERVISOR_PROCESS_TEST_CAPABILITY";
  const previous = process.env[key];
  process.env[key] = "inherited-process-capability";
  await writeFile(fakeClaude, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ value: process.env[${JSON.stringify(key)}] }));
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "environment-test" }) + "\\n"));
`);
  await chmod(fakeClaude, 0o700);
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl", cgroupMode: "required", terminationGraceMs: 100, killGraceMs: 100 });
  let handle;
  try {
    handle = await adapter.start({ task: "capture", cwd: root, command: fakeClaude, args: [], env: { HOME: root }, automatic: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await adapter.getStatus(handle)).activeRequests === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), { value: "inherited-process-capability" });
  } finally {
    if (handle) await adapter.stop(handle, "environment test cleanup").catch(() => {});
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic process cleanup retains an empty cgroup until explicit lease release", { skip: !requiredCgroupTestAvailable }, async () => {
  const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 50, killGraceMs: 50 });
  let handle;
  try {
    handle = await adapter.start({
      task: "",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 10000)"],
      automatic: true,
      retainCgroupUntilLeaseRelease: true,
      preSpawnCheck: async (provisional) => {
        assert.ok(provisional?.cgroupPath);
        await access(join(provisional.cgroupPath, "cgroup.events"));
      },
    });
    const cgroupPath = handle.cgroupPath;
    assert.ok(cgroupPath);
    await adapter.stop(handle, "retained cgroup test");
    await access(cgroupPath);
    await cleanupCgroup(cgroupPath, 100, false);
    await assert.rejects(() => access(cgroupPath), /ENOENT/u);
  } finally {
    if (handle) await adapter.stop(handle, "retained cgroup test cleanup").catch(() => {});
  }
});

test("automatic startup persists its planned and created cgroup in order", { skip: !requiredCgroupTestAvailable }, async () => {
  const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 50, killGraceMs: 50 });
  const phases: string[] = [];
  let handle;
  try {
    handle = await adapter.start({
      task: "",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 50)"],
      automatic: true,
      retainCgroupUntilLeaseRelease: true,
      onWorkerStartup: async (planned) => {
        phases.push("startup");
        assert.ok(planned.cgroupPath);
        await assert.rejects(() => access(planned.cgroupPath!), /ENOENT/u);
      },
      onWorkerPrepared: async (prepared) => {
        phases.push("prepared");
        assert.ok(prepared.cgroupPath);
        await access(join(prepared.cgroupPath!, "cgroup.events"));
      },
      preSpawnCheck: async () => { phases.push("preSpawn"); },
    });
    assert.deepEqual(phases, ["startup", "prepared", "preSpawn"]);
  } finally {
    if (handle) await adapter.stop(handle, "startup ordering test cleanup").catch(() => {});
  }
});

test("automatic natural exit retains an empty cgroup until lease finalization", { skip: !requiredCgroupTestAvailable }, async () => {
  const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 50, killGraceMs: 50 });
  let handle;
  try {
    handle = await adapter.start({
      task: "",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 50)"],
      automatic: true,
      retainCgroupUntilLeaseRelease: true,
    });
    let status = await adapter.getStatus(handle);
    for (let attempt = 0; attempt < 100 && status.running; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await adapter.getStatus(handle);
    }
    assert.equal(status.running, false);
    assert.equal(status.cgroupCleaned, true);
    const cgroupPath = handle.cgroupPath;
    assert.ok(cgroupPath);
    await access(cgroupPath);
    await cleanupCgroup(cgroupPath, 100, false);
    await assert.rejects(() => access(cgroupPath), /ENOENT/u);
  } finally {
    if (handle) await adapter.stop(handle, "natural exit retention cleanup").catch(() => {});
  }
});

test("cgroup preflight probes attachment and returns within its bounded cleanup", { skip: !requiredCgroupTestAvailable, timeout: 5_000 }, async () => {
  await preflightCgroupContainment();
});

test("cgroup preflight against a non-cgroup directory fails without leaving a probe behind", { skip: process.platform !== "linux" }, async () => {
  // A hybrid host's /sys/fs/cgroup is a tmpfs: mkdir succeeds there but no
  // control files appear. The probe must fail and remove its directory
  // rather than create a regular `cgroup.kill` that blocks the rmdir.
  const parent = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-not-cgroup-"));
  try {
    await assert.rejects(() => preflightCgroupContainment(parent), /required cgroup preflight failed/u);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("process adapter reports spawn failures instead of leaving a running record", async () => {
  const adapter = new ProcessWorkerAdapter();
  await assert.rejects(() => adapter.start({
    task: "",
    cwd: process.cwd(),
    command: "/definitely/not/a-real-worker",
  }), /ENOENT|spawn/u);
});

test("process adapter cancels startup before returning a handle", async () => {
  const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 50, killGraceMs: 50 });
  const controller = new AbortController();
  const start = adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    abortSignal: controller.signal,
  });
  const rejection = assert.rejects(start, /startup aborted/u);
  controller.abort();
  await adapter.abortStart("test cancellation");
  await rejection;
});

test("startup cancellation only aborts the targeted concurrent start", async () => {
  const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 50, killGraceMs: 50 });
  const first = adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    startupToken: "first-start",
  });
  const second = adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    startupToken: "second-start",
  });
  const firstRejection = assert.rejects(first, /startup aborted/u);
  const abortFirst = adapter.abortStart("cancel first", "first-start");
  const secondHandle = await second;
  await abortFirst;
  await firstRejection;
  assert.equal((await adapter.getStatus(secondHandle)).running, true);
  await adapter.stop(secondHandle, "cleanup second start");
});

test("remote push is denied at the adapter gate even with legacy approval", async () => {
  const adapter = new ProcessWorkerAdapter();
  await assert.rejects(() => adapter.start({
    task: "denied remote command",
    cwd: process.cwd(),
    command: "git",
    args: ["push"],
    approval: { actor: "human", reason: "explicit test approval" },
  }), /blocked by policy \(deny\)/u);
});

test("external SIGINT and SIGKILL are reported as crashed worker exits", async () => {
  for (const signal of ["SIGINT", "SIGKILL"] as const) {
    const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 25, killGraceMs: 25 });
    const handle = await adapter.start({
      task: "",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    assert.ok(handle.pid);
    process.kill(handle.pid, signal);
    const status = await waitForStatus(adapter, handle, (value) => !value.running);
    assert.equal(status.signal, signal);
    assert.equal(status.exitReason, "crashed");
    await adapter.stop(handle, `cleanup after ${signal}`);
  }
});

test("pause and resume control the entire worker process group", async () => {
  const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 25, killGraceMs: 25 });
  const handle = await adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setInterval(() => process.stdout.write('.'), 10)"],
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await adapter.readOutput(handle);
    await adapter.pause(handle);
    let pausedEmptyReads = 0;
    for (let attempt = 0; attempt < 20 && pausedEmptyReads < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      pausedEmptyReads = (await adapter.readOutput(handle)).length === 0 ? pausedEmptyReads + 1 : 0;
    }
    assert.equal(pausedEmptyReads, 2);
    await adapter.resume(handle);
    let resumedOutput = [];
    for (let attempt = 0; attempt < 20 && resumedOutput.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      resumedOutput = await adapter.readOutput(handle);
    }
    assert.ok(resumedOutput.length > 0);
  } finally {
    await adapter.stop(handle, "pause/resume test complete");
  }
});

test("process adapter bounds captured output and reports truncation", async () => {
  const adapter = new ProcessWorkerAdapter({ maxOutputChunks: 2, maxOutputBytes: 16 });
  const handle = await adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "process.stdout.write('0123456789abcdef0123456789abcdef'); setInterval(() => {}, 1000)"],
  });
  try {
    let status = await adapter.getStatus(handle);
    let output = await adapter.readOutput(handle);
    for (let attempt = 0; attempt < 20 && !status.outputTruncated; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      output = [...output, ...await adapter.readOutput(handle)];
      status = await adapter.getStatus(handle);
    }
    assert.equal(status.outputTruncated, true);
    assert.ok(output.length <= 2);
    assert.ok(Buffer.byteLength(output.map((chunk) => chunk.text).join(""), "utf8") <= 16);
  } finally {
    await adapter.stop(handle, "test complete");
  }
});

test("send and stop racing with worker exit do not consume a failed write", async () => {
  const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 25, killGraceMs: 25 });
  const handle = await adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(0), 10)"],
  });
  const [sendResult, stopResult] = await Promise.allSettled([
    adapter.send(handle, "race", "race-1"),
    adapter.stop(handle, "send/exit race"),
  ]);
  assert.equal(stopResult.status, "fulfilled");
  if (sendResult.status === "rejected") assert.match(String(sendResult.reason), /stopping|unavailable|running|write|EPIPE/u);
  assert.equal((await adapter.getStatus(handle)).running, false);
});

test("blocked stdin writes time out and do not strand the worker", async () => {
  const adapter = new ProcessWorkerAdapter({ inputWriteTimeoutMs: 10, terminationGraceMs: 25, killGraceMs: 25 });
  const handle = await adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "process.stdin.pause(); setInterval(() => {}, 1000)"],
  });
  try {
    await assert.rejects(
      () => adapter.send(handle, "x".repeat(16 * 1024 * 1024), "blocked-write"),
      /worker stdin write timed out/u,
    );
  } finally {
    await adapter.stop(handle, "blocked write test complete");
  }
  assert.equal((await adapter.getStatus(handle)).running, false);
});

test("stop escalates when the worker refuses SIGTERM", async () => {
  const adapter = new ProcessWorkerAdapter({ terminationGraceMs: 25, killGraceMs: 25 });
  const handle = await adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    const output = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    if (output.includes("ready")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await adapter.stop(handle, "SIGTERM refusal test");
  const status = await adapter.getStatus(handle);
  assert.equal(status.running, false);
  assert.equal(status.signal, "SIGKILL");
});

test("leader exit automatically cleans descendants before status is terminal", async () => {
  const adapter = new ProcessWorkerAdapter({ killGraceMs: 100 });
  const handle = await adapter.start({
    task: "early leader exit",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); process.exit(0)", "--"],
  });
  let childPid: number | undefined;
  for (let attempt = 0; attempt < 30 && !childPid; attempt++) {
    const text = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    childPid = Number(text.trim()) || undefined;
    if (!childPid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(childPid);
  const status = await waitForStatus(adapter, handle, (value) => !value.running);
  assert.equal(status.processGroupCleaned, true);
  assert.equal(status.cleanupError, undefined);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await processIsLive(childPid))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant process ${childPid} survived automatic cleanup`);
});

test("required cgroup bootstrap contains a descendant created before attachment", { skip: !requiredCgroupTestAvailable }, async () => {
  const adapter = new ProcessWorkerAdapter({ cgroupMode: "required", terminationGraceMs: 25, killGraceMs: 200 });
  const handle = await adapter.start({
    task: "early detached descendant",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); process.stdout.write(String(c.pid)); const until=Date.now()+200; while(Date.now()<until){}; setInterval(()=>{},1000)", "--"],
  });
  let childPid: number | undefined;
  for (let attempt = 0; attempt < 30 && !childPid; attempt++) {
    const text = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    childPid = Number(text.trim()) || undefined;
    if (!childPid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(childPid);
  await adapter.stop(handle, "early detached descendant cleanup");
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(childPid, 0); } catch (error) {
      if (error instanceof Error && /ESRCH/u.test(error.message)) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`early detached descendant process ${childPid} survived cgroup cleanup`);
});

test("guarded bootstrap cleans a detached descendant when the worker leader exits", { skip: !requiredCgroupTestAvailable }, async () => {
  const adapter = new ProcessWorkerAdapter({ cgroupMode: "required", terminationGraceMs: 25, killGraceMs: 200 });
  const handle = await adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); setTimeout(() => process.exit(0), 40)", "--"],
  });
  const cgroupPath = handle.cgroupPath;
  const status = await waitForStatus(adapter, handle, (value) => !value.running);
  assert.equal(status.exitCode, 0);
  assert.equal(status.cgroupCleaned, true);
  if (cgroupPath) await assert.rejects(() => access(cgroupPath), /ENOENT/u);
});

test("required cgroup cleanup kills a setsid descendant", { skip: !requiredCgroupTestAvailable }, async () => {
  const adapter = new ProcessWorkerAdapter({ cgroupMode: "required", terminationGraceMs: 25, killGraceMs: 200 });
  const handle = await adapter.start({
    task: "setsid descendant cleanup",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000)", "--"],
  });
  let childPid: number | undefined;
  for (let attempt = 0; attempt < 20 && !childPid; attempt++) {
    const text = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    childPid = Number(text.trim()) || undefined;
    if (!childPid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(childPid);
  const cgroupPath = handle.cgroupPath;
  await adapter.stop(handle, "setsid descendant cleanup");
  assert.equal((await adapter.getStatus(handle)).cgroupCleaned, true);
  if (cgroupPath) await assert.rejects(() => access(cgroupPath), /ENOENT/u);
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(childPid, 0); } catch (error) {
      if (error instanceof Error && /ESRCH/u.test(error.message)) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`setsid descendant process ${childPid} survived cgroup cleanup`);
});

test("stop cleans descendants after the worker leader exits", async () => {
  const adapter = new ProcessWorkerAdapter();
  const handle = await adapter.start({
    task: "orphan cleanup",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000)", "--"],
  });
  let childPid: number | undefined;
  for (let attempt = 0; attempt < 20 && !childPid; attempt++) {
    const text = (await adapter.readOutput(handle)).map((chunk) => chunk.text).join("");
    childPid = Number(text.trim()) || undefined;
    if (!childPid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(childPid);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await adapter.stop(handle, "test orphan cleanup");
  for (let attempt = 0; attempt < 20; attempt++) {
    // A killed orphan can linger as a zombie when the container's PID 1 does
    // not reap; that is dead for cleanup purposes.
    if (!(await processIsLive(childPid))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant process ${childPid} survived group cleanup`);
});

test("a multi-byte character split across two pipe reads is decoded intact", async () => {
  const adapter = new ProcessWorkerAdapter();
  // "中" is e4 b8 ad: write its first two bytes, pause so they arrive as their
  // own read, then the last byte.
  const handle = await adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0xe4, 0xb8])); setTimeout(() => { process.stdout.write(Buffer.from([0xad, 0x0a])); setTimeout(() => process.exit(0), 50); }, 150);", "--"],
  });
  let text = "";
  for (let attempt = 0; attempt < 60 && !text.includes("\n"); attempt += 1) {
    text += (await adapter.readOutput(handle)).filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text).join("");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(text, "中\n");
  await adapter.stop(handle, "test cleanup").catch(() => {});
});

test("claude-jsonl result sequence distinguishes repeated session ids", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const events: import("../types.ts").WorkerEvent[] = [];
  const handle = await adapter.start({
    task: "first",
    cwd: process.cwd(),
    command: process.execPath,
    eventListener: (event) => { events.push(event); },
    args: ["-e", "let n=0; process.stdin.on('data', () => { n++; process.stdout.write(JSON.stringify({type:'result',session_id:'same-session'}) + '\\n'); if (n === 2) process.exit(0); })", "--"],
  });
  for (let attempt = 0; attempt < 20 && !events.some((event) => event.type === "turn_completed"); attempt += 1) {
    await adapter.readOutput(handle);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await adapter.send(handle, "second", "turn-2");
  for (let attempt = 0; attempt < 40 && events.filter((event) => event.type === "turn_completed").length < 2; attempt += 1) {
    await adapter.readOutput(handle);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const completed = events.filter((event): event is Extract<import("../types.ts").WorkerEvent, { type: "turn_completed" }> => event.type === "turn_completed");
  assert.deepEqual(completed.map((event) => event.sequence), [1, 2]);
  await adapter.stop(handle, "test complete");
});

test("claude-jsonl delivers a permission request for a large Write by default", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const events: import("../types.ts").WorkerEvent[] = [];
  // A 1 MB file body in one can_use_tool request: dropping it would leave
  // Claude waiting forever for the control_response.
  const script = "process.stdin.once('data', () => { process.stdout.write(JSON.stringify({type:'control_request', request_id:'req-large', request:{subtype:'can_use_tool', tool_use_id:'tool-large', tool_name:'Write', input:{file_path:'/tmp/big.txt', content:'x'.repeat(1024*1024)}}}) + '\\n'); }); setInterval(() => {}, 1000)";
  const handle = await adapter.start({
    task: "write a large file",
    cwd: process.cwd(),
    command: process.execPath,
    eventListener: (event) => { events.push(event); },
    args: ["-e", script, "--"],
  });
  try {
    for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === "permission_request"); attempt += 1) {
      await adapter.readOutput(handle);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const request = events.find((event): event is Extract<import("../types.ts").WorkerEvent, { type: "permission_request" }> => event.type === "permission_request");
    assert.equal(request?.request.requestId, "req-large");
    assert.equal(((request?.request.input as { content?: string }).content ?? "").length, 1024 * 1024);
  } finally {
    await adapter.stop(handle, "large permission request test complete");
  }
});

test("claude-jsonl discards split continuations after an overlong protocol record", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl", maxProtocolBufferBytes: 128 });
  const events: import("../types.ts").WorkerEvent[] = [];
  const handle = await adapter.start({
    task: "first",
    cwd: process.cwd(),
    command: process.execPath,
    eventListener: (event) => { events.push(event); },
    args: ["-e", "process.stdin.on('data', () => { const write = () => process.stdout.write(JSON.stringify({type:'result', uuid:'continuation'}) + '\\n', () => setTimeout(() => process.stdout.write(JSON.stringify({type:'result', uuid:'legitimate'}) + '\\n'), 10)); process.stdout.write('x'.repeat(100000), write); }); setInterval(() => {}, 1000)", "--"],
  });
  try {
    for (let attempt = 0; attempt < 50 && events.filter((event) => event.type === "turn_completed").length < 1; attempt += 1) {
      await adapter.readOutput(handle);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completed = events.filter((event): event is Extract<import("../types.ts").WorkerEvent, { type: "turn_completed" }> => event.type === "turn_completed");
    assert.equal(completed.length, 1);
    assert.equal((completed[0].result as { uuid?: string }).uuid, "legitimate");
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
    assert.equal((await adapter.getStatus(handle)).outputTruncated, true);
  } finally {
    await adapter.stop(handle, "protocol buffer bound test complete");
  }
});

test("claude-jsonl ignores unsolicited results when no request is active", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const events: import("../types.ts").WorkerEvent[] = [];
  const handle = await adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    eventListener: (event) => { events.push(event); },
    args: ["-e", "setTimeout(() => process.stdout.write(JSON.stringify({type:'result', uuid:'stray-result'}) + '\\n'), 10); setInterval(() => {}, 1000)", "--"],
  });
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await adapter.readOutput(handle);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(events.filter((event) => event.type === "turn_completed").length, 0);
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
  } finally {
    await adapter.stop(handle, "unsolicited result test complete");
  }
});

test("claude-jsonl does not let an unsolicited result poison a later matching result", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const events: import("../types.ts").WorkerEvent[] = [];
  const handle = await adapter.start({
    task: "",
    cwd: process.cwd(),
    command: process.execPath,
    eventListener: (event) => { events.push(event); },
    args: ["-e", "const result = JSON.stringify({type:'result', uuid:'collision-result'}); process.stdout.write(result + '\\n'); process.stdin.on('data', () => setTimeout(() => process.stdout.write(result + '\\n'), 10)); setInterval(() => {}, 1000)", "--"],
  });
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await adapter.readOutput(handle);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(events.filter((event) => event.type === "turn_completed").length, 0);
    await adapter.send(handle, "second", "turn-2");
    for (let attempt = 0; attempt < 40 && events.filter((event) => event.type === "turn_completed").length < 1; attempt += 1) {
      await adapter.readOutput(handle);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
  } finally {
    await adapter.stop(handle, "result collision test complete");
  }
});

test("claude-jsonl ignores malformed lines and duplicate result records", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const events: import("../types.ts").WorkerEvent[] = [];
  const handle = await adapter.start({
    task: "malformed and duplicate result test",
    cwd: process.cwd(),
    command: process.execPath,
    eventListener: (event) => { events.push(event); },
    args: ["-e", `
      process.stdin.once('data', () => {
        const result = JSON.stringify({type:'result', uuid:'stable-result', result:'OK'});
        process.stdout.write(result.slice(0, 8));
        setTimeout(() => process.stdout.write(result.slice(8) + String.fromCharCode(10) + 'not-json' + String.fromCharCode(10) + result + String.fromCharCode(10)), 10);
      });
      setInterval(() => {}, 1000);
    `, "--"],
  });
  try {
    for (let attempt = 0; attempt < 50 && events.filter((event) => event.type === "turn_completed").length < 1; attempt += 1) {
      await adapter.readOutput(handle);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completed = events.filter((event) => event.type === "turn_completed");
    assert.equal(completed.length, 1);
    assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
  } finally {
    await adapter.stop(handle, "malformed/duplicate test complete");
  }
});

test("claude-jsonl suppresses duplicate permission requests before response", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const events: import("../types.ts").WorkerEvent[] = [];
  const handle = await adapter.start({
    task: "duplicate permission test",
    cwd: process.cwd(),
    command: process.execPath,
    eventListener: (event) => { events.push(event); },
    args: ["-e", `
      const request = {type:'control_request', request_id:'duplicate-request', request:{subtype:'can_use_tool', tool_use_id:'tool-1', tool_name:'Bash', input:{command:'printf OK'}}};
      const text = JSON.stringify(request) + String.fromCharCode(10) + JSON.stringify(request) + String.fromCharCode(10);
      process.stdout.write(text);
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `, "--"],
  });
  try {
    for (let attempt = 0; attempt < 30 && events.filter((event) => event.type === "permission_request").length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const permissions = events.filter((event) => event.type === "permission_request");
    assert.equal(permissions.length, 1);
    assert.equal((permissions[0] as Extract<import("../types.ts").WorkerEvent, { type: "permission_request" }>).request.requestId, "duplicate-request");
  } finally {
    await adapter.stop(handle, "duplicate permission test complete");
  }
});

test("claude-jsonl stop preempts an active request and confirms cleanup", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl", terminationGraceMs: 25, killGraceMs: 50 });
  const handle = await adapter.start({
    task: "active request stop",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', () => {}); setInterval(() => {}, 1000)", "--"],
  });
  assert.equal((await adapter.getStatus(handle)).activeRequests, 1);
  await adapter.stop(handle, "active request shutdown");
  const status = await adapter.getStatus(handle);
  assert.equal(status.running, false);
  assert.equal(status.exitReason, "stopped");
  assert.equal(status.processGroupCleaned, true);
});

test("claude-jsonl active requests survive no false completion across external signals", async () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl", terminationGraceMs: 25, killGraceMs: 50 });
    const handle = await adapter.start({
      task: "active request signal",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', () => {}); setInterval(() => {}, 1000)", "--"],
    });
    assert.equal((await adapter.getStatus(handle)).activeRequests, 1);
    assert.ok(handle.pid);
    process.kill(handle.pid, signal);
    const status = await waitForStatus(adapter, handle, (value) => !value.running);
    assert.equal(status.signal, signal);
    assert.equal(status.exitReason, "crashed");
    await adapter.stop(handle, `cleanup after ${signal}`);
  }
});

test("claude-jsonl status tracks active requests until a result record", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const handle = await adapter.start({
    task: "first",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "process.stdin.once('data', () => setTimeout(() => { process.stdout.write(JSON.stringify({type:'result'}) + '\\n'); }, 25))", "--"],
  });
  assert.equal((await adapter.getStatus(handle)).activeRequests, 1);
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await adapter.getStatus(handle)).activeRequests === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await adapter.readOutput(handle);
  }
  assert.equal((await adapter.getStatus(handle)).activeRequests, 0);
  await adapter.stop(handle, "test complete");
});

test("claude-jsonl emits permission events and accepts the exact allow response", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const events: import("../types.ts").WorkerEvent[] = [];
  const handle = await adapter.start({
    task: "permission test",
    cwd: process.cwd(),
    command: process.execPath,
    eventListener: (event) => { events.push(event); },
    args: ["-e", `
      const request = {type:'control_request', request_id:'req-1', request:{subtype:'can_use_tool', tool_use_id:'tool-1', tool_name:'Bash', input:{command:'printf OK'}}};
      process.stdout.write(JSON.stringify(request)+String.fromCharCode(10));
      process.stdin.on('data', data => {
        for (const line of data.toString().split(String.fromCharCode(10)).filter(Boolean)) {
          const value = JSON.parse(line);
          if (value.type === 'control_response') {
            process.stdout.write(JSON.stringify({type:'result', result:'PERMISSION_OK'})+String.fromCharCode(10));
            process.exit(0);
          }
        }
      });
    `, "--"],
  });
  for (let attempt = 0; attempt < 30 && !events.some((event) => event.type === "permission_request"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const permission = events.find((event): event is Extract<import("../types.ts").WorkerEvent, { type: "permission_request" }> => event.type === "permission_request");
  assert.ok(permission);
  assert.equal(permission.request.requestId, "req-1");
  await adapter.respondPermission(handle, permission.request.requestId, permission.request.toolUseId, { behavior: "allow" }, permission.request.input);
  const status = await waitForStatus(adapter, handle, (value) => !value.running);
  assert.equal(status.exitReason, "completed");
  assert.ok(events.some((event) => event.type === "turn_completed"));
  await adapter.stop(handle, "permission test complete");
});

test("JSONL exposes attached repairability without claiming persistent recovery", () => {
  const jsonl = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const pipe = new ProcessWorkerAdapter({ mode: "process-pipe" });
  assert.equal(jsonl.capabilities().repairableSession, true);
  assert.equal(jsonl.capabilities().persistentSession, undefined);
  assert.equal(pipe.capabilities().repairableSession, false);
});

test("claude-jsonl mode frames initial and subsequent messages", async () => {
  const adapter = new ProcessWorkerAdapter({ mode: "claude-jsonl" });
  const handle = await adapter.start({
    task: "first",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "let n=0; process.stdin.on('data', d => { n += (d.toString().match(/\\n/g) || []).length; process.stdout.write(d); if (n >= 2) process.exit(0); })", "--"],
  });
  await adapter.send(handle, "second", "turn-1");
  await adapter.send(handle, "duplicate-must-not-be-delivered", "turn-1");
  const chunks = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    chunks.push(...await adapter.readOutput(handle));
    if (chunks.map((chunk) => chunk.text).join("").split("\n").filter(Boolean).length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const lines = chunks.flatMap((chunk) => chunk.text.split("\n")).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.message.content), ["first", "second"]);
  await adapter.stop(handle, "test complete");
  assert.equal((await adapter.getStatus(handle)).running, false);
  assert.equal(adapter.capabilities().transport, "jsonl");
});

test("embedded process-adapter scripts are syntactically valid JavaScript", () => {
  for (const script of Object.values(PROCESS_EMBEDDED_SCRIPTS)) {
    assert.doesNotThrow(() => new Function(script));
  }
});

test("processGroupHasLiveMember detects live and reaped process groups", { skip: process.platform !== "linux" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    assert.ok(child.pid);
    assert.equal(await processGroupHasLiveMember(child.pid!), true);
    process.kill(-child.pid!, "SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let stillLive = true;
    for (let attempt = 0; attempt < 200 && stillLive; attempt += 1) {
      stillLive = await processGroupHasLiveMember(child.pid!);
      if (stillLive) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stillLive, false);
  } finally {
    child.unref();
  }
});

async function canCreateCgroup(): Promise<boolean> {
  try {
    await access(await currentCgroupPath(), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function processIsLive(pid: number): Promise<boolean> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = contents.lastIndexOf(")");
    return close < 0 || contents[close + 2] !== "Z";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForStatus(
  adapter: ProcessWorkerAdapter,
  handle: Awaited<ReturnType<ProcessWorkerAdapter["start"]>>,
  predicate: (status: Awaited<ReturnType<ProcessWorkerAdapter["getStatus"]>>) => boolean,
) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const status = await adapter.getStatus(handle);
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return adapter.getStatus(handle);
}
