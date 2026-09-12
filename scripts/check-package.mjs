import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (!pkg.pi?.extensions?.includes("./src/index.ts")) throw new Error("package must expose ./src/index.ts through pi.extensions");
if (!pkg.keywords.includes("pi-package")) throw new Error("package must include pi-package keyword");
if (pkg.dependencies && Object.keys(pkg.dependencies).length) throw new Error("runtime dependencies must remain empty; use peerDependencies for host APIs");
if (!pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]) throw new Error("Pi must be a peer dependency");
if (!pkg.files.includes("src/**/*.ts")) throw new Error("source files must be published");
const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {encoding: "utf8"});
const pack = JSON.parse(output.trim());
const names = new Set(pack[0].files.map((file) => file.path));
for (const required of ["package.json", "README.md", "LICENSE", "src/index.ts", "src/supervisor.ts"]) {
  if (!names.has(required)) throw new Error(`package missing ${required}`);
}
for (const forbidden of [".env", "key.conf", "node_modules/"]) {
  if ([...names].some((name) => name.includes(forbidden))) throw new Error(`package contains forbidden path ${forbidden}`);
}
console.log(`Package contents valid (${names.size} files)`);
