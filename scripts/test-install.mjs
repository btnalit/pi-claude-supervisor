import {execFileSync} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const temp = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-install-"));
try {
  const output = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", temp], {encoding: "utf8"});
  const archive = output.trim().split("\n").at(-1);
  if (!archive) throw new Error("npm pack did not report an archive");
  execFileSync("npm", ["install", "--ignore-scripts", "--no-save", "--package-lock=false", join(temp, archive)], {cwd: temp, stdio: "inherit"});
  const installed = await readFile(join(temp, "node_modules", "pi-claude-supervisor", "src", "index.ts"), "utf8");
  if (!installed.includes("piClaudeSupervisor")) throw new Error("installed package entry point is invalid");
  console.log("Native npm installation smoke test passed");
} finally {
  await rm(temp, {recursive: true, force: true});
}
