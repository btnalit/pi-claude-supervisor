import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const output = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", "dist"], { encoding: "utf8" });
const filename = output.trim().split("\n").at(-1);
assert.ok(filename?.endsWith(".tgz"), "npm pack did not report an archive");
const archivePath = join("dist", filename);
const bytes = await readFile(archivePath);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = {
  schema: 1,
  name: packageJson.name,
  version: packageJson.version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  filename,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
};
await writeFile("dist/release-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await writeFile("dist/SHA256SUMS", `${manifest.sha256}  ${filename}\n`, { mode: 0o600 });
assert.deepEqual((await readdir("dist")).sort(), [filename, "SHA256SUMS", "release-manifest.json"].sort());
console.log(`Package archive and release manifest written to ${join(process.cwd(), "dist")}`);
