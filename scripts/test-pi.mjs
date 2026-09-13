const extension = await import(new URL("../src/index.ts", import.meta.url));
const previousCgroupMode = process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
// This smoke test intentionally exercises the explicit process-group fallback;
// production defaults to required cgroup cleanup and fails closed when the host
// cannot provide it.
process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = "off";
const registrations = {commands: [], events: []};
const fakePi = {
  registerCommand(name, definition) { registrations.commands.push({name, definition}); },
  on(name, handler) { registrations.events.push({name, handler}); },
};
extension.default(fakePi);
if (!registrations.commands.some(({name}) => name === "supervise")) throw new Error("supervise command was not registered");
if (!registrations.events.some(({name}) => name === "session_shutdown")) throw new Error("shutdown handler was not registered");

const command = registrations.commands.find(({name}) => name === "supervise").definition;
const messages = [];
let approved = false;
const context = {
  cwd: process.cwd(),
  hasUI: true,
  ui: {
    async confirm() { approved = true; return true; },
    notify(message) { messages.push(message); },
  },
};
await command.handler("capabilities", context);
if (!messages.at(-1)?.includes('"process-pipe"')) throw new Error("capabilities handler did not execute");

const previousWorker = process.env.PI_CLAUDE_SUPERVISOR_WORKER;
process.env.PI_CLAUDE_SUPERVISOR_WORKER = `${process.execPath} -e "setTimeout(() => {}, 200)" git push`;
try {
  await command.handler("start approval smoke test", context);
  if (!approved) throw new Error("review command did not request approval");
  if (!messages.some((message) => message.startsWith("Worker started:"))) throw new Error("approved worker did not start");
} finally {
  if (previousWorker === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_WORKER;
  else process.env.PI_CLAUDE_SUPERVISOR_WORKER = previousWorker;
  await registrations.events.find(({name}) => name === "session_shutdown").handler();
  if (previousCgroupMode === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE;
  else process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = previousCgroupMode;
}
console.log("Pi extension registration and command smoke tests passed");
