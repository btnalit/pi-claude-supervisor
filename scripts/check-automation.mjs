// Repository policy assertions complement actionlint's workflow/schema validation.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";

const read = (path) => readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
assert.equal(pkg.scripts.test, "node scripts/run-tests.mjs", "The test runner must enforce the CI skip gate");
assert.equal(JSON.parse(read(".release-please-manifest.json"))["."], pkg.version, "Release manifest/version drift");
const lock = JSON.parse(read("package-lock.json"));
assert.equal(lock.packages[""].version, pkg.version);
assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies, "Lockfile dev dependency drift");
const config = JSON.parse(read("release-please-config.json"));
assert.equal(config.packages["."]["release-type"], "node");
assert.equal(config["include-component-in-tag"], false);
for (const file of readdirSync(".github/workflows")) {
  const workflow = parse(read(`.github/workflows/${file}`));
  assert.ok(!workflow.on.pull_request_target, "Never run untrusted PR code with a privileged trigger");
  assert.deepEqual(workflow.permissions, { contents: "read" }, "Default workflow token must be read-only");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(job["timeout-minutes"] || job.uses?.startsWith("./"), `${file}/${name} needs a time limit`);
    assert.notEqual(job.secrets, "inherit", "Reusable verification must not inherit publishing secrets");
    for (const [permission, value] of Object.entries(job.permissions ?? {})) {
      if (value === "write") assert.ok(file === "release.yml" && ["plan", "publish"].includes(name), `Unexpected writable ${permission} in ${file}/${name}`);
    }
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/u, "External actions must use immutable commit pins");
      if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
      if (step.run) assert.ok(!step.run.includes("${{"), "Pass dynamic data through environment variables, not shell interpolation");
    }
  }
}
const ci = parse(read(".github/workflows/ci.yml"));
assert.equal(ci.env.PI_CLAUDE_SUPERVISOR_FAIL_ON_TEST_SKIP, "1", "CI must fail when automatic-path tests skip");
for (const event of ["pull_request", "push", "workflow_dispatch", "schedule", "workflow_call"]) assert.ok(event in ci.on);
assert.equal(ci.jobs.gate.name, "Quality gate");
assert.equal(ci.jobs.gate.if, "always()");
assert.deepEqual([...ci.jobs.gate.needs].sort(), ["build", "checks", "checks_npm_latest", "integration", "policy"]);
assert.deepEqual(ci.jobs.checks_npm_latest.strategy.matrix.npm, ["10", "12"]);
for (const command of ["npm run check", "npm run test:install", "npm run build"]) {
  assert.ok(ci.jobs.checks_npm_latest.steps.some((step) => step.run === command || step.run?.includes(`run-in-cgroup.sh ${command}`)), `Explicit npm lanes must run ${command}`);
}
for (const jobName of ["checks", "checks_npm_latest"]) {
  const steps = ci.jobs[jobName].steps;
  assert.ok(steps.some((step) => step.run === "bash scripts/ci/prepare-cgroup.sh"), `${jobName} must prepare a delegated cgroup`);
  assert.ok(steps.some((step) => step.run?.includes("run-in-cgroup.sh npm run check")), `${jobName} must run the suite in the delegated cgroup`);
  assert.ok(steps.some((step) => step.run === "bash scripts/ci/cleanup-cgroup.sh"), `${jobName} must clean the delegated cgroup`);
}
assert.ok(ci.jobs.checks_npm_latest.steps.some((step) => step.run?.includes("npm install --global --ignore-scripts \"npm@$NPM_VERSION\"")), "npm major selection must actually run, not use an unsupported action input");
assert.ok(!ci.on.pull_request.paths && !ci.on.pull_request["paths-ignore"], "Required checks cannot be skipped by path filters");
const release = parse(read(".github/workflows/release.yml"));
assert.equal(release.jobs.publish.environment, "npm");
assert.deepEqual(release.jobs.publish.needs, ["plan", "verify"]);
assert.equal(release.jobs.verify.uses, "./.github/workflows/ci.yml");
assert.ok(release.jobs.plan.steps.some((step) => step.with?.script?.includes("createWorkflowDispatch")), "Bot PRs need explicit CI dispatch when using GITHUB_TOKEN");
const dependabot = parse(read(".github/dependabot.yml"));
assert.deepEqual(dependabot.updates.map((update) => update["package-ecosystem"]).sort(), ["github-actions", "npm"]);
console.log("PASS: release metadata, read-only CI, pinned actions, protected publication graph and dependency update configuration.");
