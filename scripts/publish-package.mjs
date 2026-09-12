import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const tag = process.env.RELEASE_TAG;
const sha = process.env.RELEASE_SHA;
assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/u, "RELEASE_TAG must be a stable vX.Y.Z tag");
assert.match(sha ?? "", /^[a-f0-9]{40}$/u, "RELEASE_SHA must be a commit SHA");
const manifest = JSON.parse(await readFile("dist/release-manifest.json", "utf8"));
assert.equal(`v${manifest.version}`, tag, "archive version does not match release tag");
assert.equal(manifest.commit, sha, "archive was not built from the release commit");
const archives = (await readdir("dist")).filter((name) => name.endsWith(".tgz"));
assert.deepEqual(archives, [manifest.filename], "release artifact directory must contain exactly one archive");
// npm treats a bare relative tarball path as a package spec and may resolve it
// as a git dependency. Use an absolute archive path, as required by npm's
// publish-tarball flow.
const npmArgs = ["publish", resolve("dist", manifest.filename), "--access", "public", "--provenance"];
execFileSync("npm", npmArgs, { stdio: "inherit" });
const published = execFileSync("npm", ["view", `${manifest.name}@${manifest.version}`, "version", "--json"], { encoding: "utf8" }).trim();
assert.equal(JSON.parse(published), manifest.version, "npm registry did not report the published version");
console.log(`Published ${manifest.name}@${manifest.version} from ${sha}`);
