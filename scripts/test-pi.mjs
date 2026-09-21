const previousSupervisorEnvironment = Object.fromEntries([
  "PI_CLAUDE_SUPERVISOR_MODE",
  "PI_CLAUDE_SUPERVISOR_AUTOMATION",
  "PI_CLAUDE_SUPERVISOR_TRANSPORT",
  "PI_CLAUDE_SUPERVISOR_TMUX_MODE",
  "PI_CLAUDE_SUPERVISOR_CGROUP_MODE",
].map((name) => [name, process.env[name]]));
process.env.PI_CLAUDE_SUPERVISOR_MODE = "manual";
process.env.PI_CLAUDE_SUPERVISOR_AUTOMATION = "0";
process.env.PI_CLAUDE_SUPERVISOR_TRANSPORT = "process-pipe";
process.env.PI_CLAUDE_SUPERVISOR_CGROUP_MODE = "off";
const extension = await import(new URL("../src/index.ts", import.meta.url));
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
let approvals = 0;
const context = {
  cwd: process.cwd(),
  hasUI: true,
  ui: {
    async confirm() { approvals += 1; return true; },
    notify(message) { messages.push(message); },
  },
};
await command.handler("capabilities", context);
if (!messages.at(-1)?.includes('"process-pipe"')) throw new Error("capabilities handler did not execute");

const previousWorker = process.env.PI_CLAUDE_SUPERVISOR_WORKER;
process.env.PI_CLAUDE_SUPERVISOR_WORKER = "git push";
try {
  await command.handler("start denied boundary smoke test", context);
  if (!messages.at(-1)?.includes("Worker command denied")) throw new Error("remote boundary command was not denied");
  if (approvals !== 0) throw new Error("remote boundary denial requested interactive approval");

  process.env.PI_CLAUDE_SUPERVISOR_WORKER = `${process.execPath} -e "setTimeout(() => {}, 200)"`;
  await command.handler("start unattended local smoke test", context);
  if (approvals !== 0) throw new Error("ordinary local development requested interactive approval");
  if (!messages.some((message) => message.startsWith("Worker started:"))) throw new Error("local worker did not start");
} finally {
  if (previousWorker === undefined) delete process.env.PI_CLAUDE_SUPERVISOR_WORKER;
  else process.env.PI_CLAUDE_SUPERVISOR_WORKER = previousWorker;
  await registrations.events.find(({name}) => name === "session_shutdown").handler();
  for (const [name, value] of Object.entries(previousSupervisorEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
console.log("Pi extension registration and command smoke tests passed");
