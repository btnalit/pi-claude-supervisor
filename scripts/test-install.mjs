import {execFileSync} from "node:child_process";
import {cp, mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const temp = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-install-"));
try {
  const output = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", temp], {encoding: "utf8"});
  const archive = output.trim().split("\n").at(-1);
  if (!archive) throw new Error("npm pack did not report an archive");
  execFileSync("npm", ["install", "--ignore-scripts", "--no-save", "--package-lock=false", join(temp, archive)], {cwd: temp, stdio: "inherit"});
  const packageRoot = join(temp, "node_modules", "pi-claude-supervisor");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const entry = manifest.pi?.extensions?.[0];
  if (typeof entry !== "string" || entry.startsWith("../") || entry.startsWith("/")) throw new Error("installed package Pi entry point is invalid");
  // Node deliberately refuses type stripping for .ts files below node_modules.
  // Copy the installed package to a staging path and load the exact manifest
  // entry there; its relative imports still resolve the installed peer modules.
  const stagedRoot = join(temp, "installed-package");
  await cp(packageRoot, stagedRoot, {recursive: true});
  const module = await import(pathToFileURL(join(stagedRoot, entry)).href);
  const registrations = {commands: [], events: []};
  const fakePi = {
    registerCommand(name, definition) { registrations.commands.push({name, definition}); },
    on(name, handler) { registrations.events.push({name, handler}); },
  };
  module.default(fakePi);
  if (!registrations.commands.some(({name}) => name === "supervise")) throw new Error("installed package did not register supervise");
  const command = registrations.commands.find(({name}) => name === "supervise").definition;
  const messages = [];
  await command.handler("capabilities", {
    cwd: temp,
    hasUI: true,
    ui: { async confirm() { return false; }, notify(message) { messages.push(message); } },
  });
  if (!messages.at(-1)?.includes('"process-pipe"')) throw new Error("installed package capabilities handler did not execute");
  await registrations.events.find(({name}) => name === "session_shutdown").handler();
  console.log("Native npm installation and installed-entry smoke test passed");
} finally {
  await rm(temp, {recursive: true, force: true});
}
