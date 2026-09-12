import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const tag = process.env.RELEASE_TAG;
const manifest = JSON.parse(await readFile("dist/release-manifest.json", "utf8"));
execFileSync("gh", ["release", "upload", tag, `dist/${manifest.filename}`, "dist/SHA256SUMS", "dist/release-manifest.json", "--clobber"], { stdio: "inherit" });
console.log(`Attached immutable release assets for ${tag}`);
