import {execFileSync} from "node:child_process";
import {mkdir, cp, rm} from "node:fs/promises";
import {join} from "node:path";

await rm("dist", {recursive: true, force: true});
await mkdir("dist", {recursive: true});
execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", "dist"], {stdio: "inherit"});
console.log(`Package archive written to ${join(process.cwd(), "dist")}`);
