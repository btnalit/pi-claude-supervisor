import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runSupervisorGit, supervisorGitArgs, supervisorGitEnvironment } from "./git-runner.ts";
import { remoteBranchHead, remoteUrl, repositoryClean, repositoryGitDirectoryIsLocal, repositorySlug, repositoryWorkTree, sameDestination } from "./verifier.ts";

const execFileAsync = promisify(execFile);

test("Supervisor Git pins command-executing local configuration", () => {
  const args = supervisorGitArgs(["status"]);
  assert.ok(args.includes("core.askPass="));
  assert.ok(args.includes("core.alternateRefsCommand="));
  assert.ok(args.includes("core.hooksPath=/dev/null"));
});

test("Supervisor Git isolates mutable global and system configuration", () => {
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND"] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_GLOBAL = "/operator/global.gitconfig";
  process.env.GIT_CONFIG_SYSTEM = "/operator/system.gitconfig";
  process.env.GIT_CONFIG_NOSYSTEM = "operator-value";
  process.env.GIT_SSH_COMMAND = "operator-ssh";
  try {
    const environment = supervisorGitEnvironment(true);
    assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(environment.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(environment.GIT_SSH_COMMAND, undefined);
    assert.equal(process.env.GIT_CONFIG_GLOBAL, "/operator/global.gitconfig");
    assert.equal(process.env.GIT_CONFIG_SYSTEM, "/operator/system.gitconfig");
    assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "operator-value");
    assert.equal(process.env.GIT_SSH_COMMAND, "operator-ssh");
  } finally {
    for (const key of keys) {
      const value = before[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Supervisor Git isolation does not change a sibling Git process", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-git-scope-"));
  const globalConfig = join(base, "global.gitconfig");
  const cwd = join(base, "repo");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  const previousSystem = process.env.GIT_CONFIG_SYSTEM;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  try {
    await execFileAsync("git", ["init", "-q", cwd]);
    await writeFile(globalConfig, "[user]\n\tname = sibling-visible\n", { mode: 0o600 });
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";

    const ordinary = await execFileAsync("git", ["config", "--global", "--get", "user.name"], { cwd, env: process.env });
    assert.equal(ordinary.stdout.trim(), "sibling-visible");

    const isolated = supervisorGitEnvironment(true);
    await assert.rejects(
      execFileAsync("git", ["config", "--global", "--get", "user.name"], { cwd, env: isolated }),
      (error: unknown) => (error as { code?: unknown }).code === 1,
      "the Supervisor's child environment must not read the sibling's global config",
    );
    assert.equal(process.env.GIT_CONFIG_GLOBAL, globalConfig);
    assert.equal(process.env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");
    await assert.rejects(
      runSupervisorGit(cwd, ["config", "--global", "--get", "user.name"], { network: true }),
      (error: unknown) => (error as { code?: unknown }).code === 1,
      "Supervisor Git itself must use the isolated child environment",
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
    if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = previousSystem;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    await rm(base, { recursive: true, force: true });
  }
});

test("a remote URL becomes the host/owner/repo gh accepts, or nothing", async () => {
  for (const [url, expected] of [
    ["https://github.com/acme/console.git", "github.com/acme/console"],
    ["https://github.com/acme/console", "github.com/acme/console"],
    ["git@github.com:acme/console.git", "github.com/acme/console"],
    ["ssh://git@github.com/acme/console.git", "github.com/acme/console"],
    ["ssh://git@ghe.corp:2222/org/repo.git", "ghe.corp/org/repo"],
    ["https://user:token@GitHub.com/acme/console.git", "github.com/acme/console"],
    // gh accepts none of these as a repository.
    ["../remote.git", undefined],
    ["/srv/git/x.git", undefined],
    ["file:///srv/git/x.git", undefined],
    ["https://github.com/acme", undefined],
    ["https://github.com/acme/console/extra", undefined],
    ["git@github.com:acme/con sole.git", undefined],
  ] as const) {
    assert.equal(await repositorySlug(url), expected, url);
  }
  // An SSH-config host alias is kept as the host when `ssh -G` has no
  // translation for it (the machine running this test has no such alias);
  // with one, the real hostname replaces it the way gh does.
  assert.equal(await repositorySlug("pi-claude-supervisor-no-such-alias:acme/console.git"), "pi-claude-supervisor-no-such-alias/acme/console");
});

test("a remote branch lookup tells an absent branch from a remote that cannot be asked", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-lookup-"));
  try {
    const remote = join(base, "remote.git");
    const cwd = join(base, "work");
    await execFileAsync("git", ["init", "-q", "--bare", remote]);
    await execFileAsync("git", ["init", "-q", "-b", "main", cwd]);
    await execFileAsync("git", ["-C", cwd, "remote", "add", "origin", remote]);
    await execFileAsync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one"]);
    const head = (await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();

    assert.deepEqual(await remoteBranchHead(cwd, "origin", "feat/x"), { outcome: "absent" });
    await execFileAsync("git", ["-C", cwd, "push", "-q", "origin", `${head}:refs/heads/feat/x`]);
    assert.deepEqual(await remoteBranchHead(cwd, "origin", "feat/x"), { outcome: "found", head });
    await execFileAsync("git", ["-C", cwd, "push", "-q", "origin", `${head}:refs/heads/notmain`]);
    assert.deepEqual(await remoteBranchHead(cwd, "origin", "main"), { outcome: "absent" }, "a similarly suffixed remote ref is not the requested branch");

    // The remote is gone: that is not a fact about the branch.
    await rm(remote, { recursive: true, force: true });
    const lookup = await remoteBranchHead(cwd, "origin", "feat/x");
    assert.equal(lookup.outcome, "unreachable");
    assert.ok(lookup.outcome === "unreachable" && lookup.error.length > 0);
    assert.deepEqual(await remoteBranchHead(cwd, "no-such-remote", "feat/x").then((result) => result.outcome), "unreachable");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a clean tree and a local .git directory are what the grant requires", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-clean-"));
  try {
    const cwd = join(base, "work");
    await execFileAsync("git", ["init", "-q", "-b", "main", cwd]);
    await execFileAsync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one"]);
    assert.equal(await repositoryClean(cwd), true);
    assert.equal(await repositoryWorkTree(cwd), true);
    const outside = join(base, "outside");
    await mkdir(outside);
    await execFileAsync("git", ["-C", cwd, "config", "core.worktree", outside]);
    assert.equal(await repositoryWorkTree(cwd), false, "a repository-local worktree redirect is not the task cwd");
    await execFileAsync("git", ["-C", cwd, "config", "--unset", "core.worktree"]);
    await writeFile(join(cwd, "untracked.txt"), "x\n");
    assert.equal(await repositoryClean(cwd), false, "an untracked file is not clean");
    assert.equal(await repositoryClean(join(base, "not-a-repo")), undefined, "git could not say");
    assert.equal(await repositoryGitDirectoryIsLocal(cwd), true);
    // A linked worktree's .git is a `gitdir:` file by design; its git dir sits
    // under the main repository's .git/worktrees/ and is accepted.
    const linked = join(base, "linked");
    await execFileAsync("git", ["-C", cwd, "worktree", "add", "-q", linked, "-b", "feat/linked"]);
    assert.equal(await repositoryGitDirectoryIsLocal(linked), true, "a linked worktree");
    const moved = join(base, "moved");
    await execFileAsync("git", ["init", "-q", "-b", "main", "--separate-git-dir", join(base, "gitdir"), moved]);
    assert.equal(await repositoryGitDirectoryIsLocal(moved), false, "a gitdir: pointer is not a local .git directory");
    assert.equal(await repositoryGitDirectoryIsLocal(join(base, "not-a-repo")), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a remote destination lists every URL git would push to, and compares as a whole", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-destination-"));
  try {
    const cwd = join(base, "work");
    await execFileAsync("git", ["init", "-q", "-b", "main", cwd]);
    await execFileAsync("git", ["-C", cwd, "remote", "add", "origin", "/srv/real.git"]);
    const before = await remoteUrl(cwd, "origin");
    assert.deepEqual(before, { fetch: ["/srv/real.git"], push: ["/srv/real.git"] });
    // An explicit URL is still rewritten by local `url.*.pushInsteadOf` (and
    // by its fetch/push cousin), so a grant cannot safely pin it. The whole
    // remote is rejected before a Worker can receive a publish command.
    await execFileAsync("git", ["-C", cwd, "config", "url./srv/evil.pushInsteadOf", "/srv/real.git"]);
    assert.equal(await remoteUrl(cwd, "origin"), undefined);
    await execFileAsync("git", ["-C", cwd, "config", "--unset-all", "url./srv/evil.pushInsteadOf"]);
    await execFileAsync("git", ["-C", cwd, "config", "url./srv/evil.insteadOf", "/srv/real.git"]);
    assert.equal(await remoteUrl(cwd, "origin"), undefined);
    await execFileAsync("git", ["-C", cwd, "config", "--unset-all", "url./srv/evil.insteadOf"]);
    await execFileAsync("git", ["-C", cwd, "config", "remote.origin.url", "https://example.invalid/a\nb"]);
    assert.equal(await remoteUrl(cwd, "origin"), undefined, "a control character in a raw remote value cannot become a second destination");
    await execFileAsync("git", ["-C", cwd, "config", "remote.origin.url", "/srv/real.git"]);
    // `git remote get-url --push` would still print only the first; git
    // pushes to both, so the second one is a second destination.
    await execFileAsync("git", ["-C", cwd, "config", "--add", "remote.origin.pushurl", "/srv/real.git"]);
    await execFileAsync("git", ["-C", cwd, "config", "--add", "remote.origin.pushurl", "/srv/evil.git"]);
    const after = await remoteUrl(cwd, "origin");
    assert.deepEqual(after, { fetch: ["/srv/real.git"], push: ["/srv/real.git", "/srv/evil.git"] });
    assert.equal(sameDestination(before, after), false);
    assert.equal(sameDestination(before, { fetch: ["/srv/real.git"], push: ["/srv/real.git"] }), true);
    assert.equal(sameDestination(before, undefined), false);
    assert.equal(await remoteUrl(cwd, "nope"), undefined);

    // Remote-helper protocols and credential-bearing URLs are not safe to
    // copy into the Worker-owned publish instruction.
    await execFileAsync("git", ["-C", cwd, "remote", "add", "helper", "ext::sh -c echo"], { cwd: base });
    assert.equal(await remoteUrl(cwd, "helper"), undefined);
    await execFileAsync("git", ["-C", cwd, "remote", "add", "secret", "https://user:token@example.com/acme/repo"], { cwd: base });
    assert.equal(await remoteUrl(cwd, "secret"), undefined);
    await execFileAsync("git", ["-C", cwd, "remote", "add", "secret-ssh", "ssh://git:token@example.com/acme/repo"], { cwd: base });
    assert.equal(await remoteUrl(cwd, "secret-ssh"), undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
