import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const tag = process.env.RELEASE_TAG;
assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/u, "RELEASE_TAG must be a stable vX.Y.Z tag");
const manifest = JSON.parse(await readFile("dist/release-manifest.json", "utf8"));
assert.equal(`v${manifest.version}`, tag, "release assets do not match the release tag");
execFileSync("gh", ["release", "upload", tag, `dist/${manifest.filename}`, "dist/SHA256SUMS", "dist/release-manifest.json"], { stdio: "inherit" });
console.log(`Attached immutable release assets for ${tag}`);
