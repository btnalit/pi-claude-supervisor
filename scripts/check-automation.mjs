import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");
const dependabot = readFileSync(".github/dependabot.yml", "utf8");
const releaseConfig = JSON.parse(readFileSync("release-please-config.json", "utf8"));
const manifest = JSON.parse(readFileSync(".release-please-manifest.json", "utf8"));

for (const script of ["check", "check:docs", "check:automation", "test:install", "test:pi", "build"]) {
  assert.equal(typeof packageJson.scripts[script], "string", `missing npm script: ${script}`);
}
for (const text of ["pull_request:", "branches: [main]", "npm run check", "npm run test:install", "npm audit", "gate:", "needs:"]) {
  assert.ok(ci.includes(text), `CI workflow missing gate requirement: ${text}`);
}
assert.ok(ci.includes("workflow_call:"), "CI must be reusable for exact-tag release verification");
for (const text of ["release-please-action", "publish-package.mjs", "id-token: write", "environment: npm", "NPM_TOKEN"]) {
  assert.ok(release.includes(text), `release workflow missing publication control: ${text}`);
}
assert.equal(releaseConfig["release-type"], "node");
assert.equal(manifest["."], packageJson.version, "release-please manifest must match package version");
assert.ok(dependabot.includes("package-ecosystem: npm"), "Dependabot npm updates are not configured");
assert.ok(dependabot.includes("package-ecosystem: github-actions"), "Dependabot Actions updates are not configured");
console.log("CI, release, Dependabot and release-please policy checks passed");
