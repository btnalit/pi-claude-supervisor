import assert from "node:assert/strict";
import { access, constants, readFile } from "node:fs/promises";
import test from "node:test";
import { ProcessWorkerAdapter } from "./process-adapter.ts";

const requiredCgroupTestAvailable = process.platform === "linux" && await canCreateCgroup();

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

test("approved review-level worker command passes the adapter gate", async () => {
  const adapter = new ProcessWorkerAdapter();
  const handle = await adapter.start({
    task: "approved review command",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 100)", "git", "push"],
    approval: { actor: "human", reason: "explicit test approval" },
  });
  assert.equal((await adapter.getStatus(handle)).running, true);
  await adapter.stop(handle, "test complete");
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
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await adapter.readOutput(handle)).length, 0);
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
  try {
    process.kill(childPid, 0);
    assert.fail(`descendant process ${childPid} survived automatic cleanup`);
  } catch (error) {
    assert.ok(error instanceof Error && /ESRCH/u.test(error.message));
  }
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
  await adapter.stop(handle, "setsid descendant cleanup");
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
    try { process.kill(childPid, 0); } catch (error) {
      if (error instanceof Error && /ESRCH/u.test(error.message)) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant process ${childPid} survived group cleanup`);
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

async function canCreateCgroup(): Promise<boolean> {
  try {
    const contents = await readFile("/proc/self/cgroup", "utf8");
    const match = contents.match(/^0::([^\n]*)$/mu);
    if (!match) return false;
    await access(`/sys/fs/cgroup${match[1]}`, constants.W_OK);
    return true;
  } catch {
    return false;
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
