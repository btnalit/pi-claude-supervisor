import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

const registry = "https://registry.npmjs.org/";
const packageVersion = `${manifest.name}@${manifest.version}`;
const registryArgs = ["view", packageVersion, "version", "dist.integrity", "--json", "--registry", registry];
const readPublished = () => {
  const result = spawnSync("npm", registryArgs, { encoding: "utf8" });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
};
const assertPublished = (published) => {
  assert.equal(published?.version, manifest.version, "npm registry reported an unexpected version");
  assert.equal(published?.["dist.integrity"], manifest.integrity, "published package integrity does not match the verified archive");
};

let published = readPublished();
if (published) {
  assertPublished(published);
  console.log(`Already published: ${packageVersion}; exact integrity verified.`);
} else {
  // npm treats a bare relative tarball path as a package spec and may resolve it
  // as a git dependency. Use an absolute archive path for npm's tarball flow.
  const archive = resolve("dist", manifest.filename);
  execFileSync("npm", ["publish", archive, "--access", "public", "--provenance", "--ignore-scripts", "--registry", registry], { stdio: "inherit" });

  // npm now queues a fresh publish for processing ("may take a few minutes
  // to become available"); the registry view can lag the publish by minutes.
  // Poll for up to ten minutes before treating the verification as failed.
  const deadline = Date.now() + 10 * 60_000;
  while (!(published = readPublished()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  assertPublished(published);
  console.log(`Published ${packageVersion} with verified integrity.`);
}
