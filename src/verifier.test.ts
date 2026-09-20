import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { remoteBranchHead, remoteUrl, repositoryClean, repositoryGitDirectoryIsLocal, repositorySlug, sameDestination } from "./verifier.ts";

const execFileAsync = promisify(execFile);

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
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
