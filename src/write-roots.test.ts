import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  cleanupTaskTempRoot,
  createTaskTempRoot,
  pinWriteRoots,
  reverifyOrRecreateTaskTempRoot,
  reverifyPinnedWriteRoots,
  verifyPinnedWriteRoot,
} from "./write-roots.ts";

test("pinWriteRoots validates and pins real directories and rejects invalid or dangerous roots", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-wroots-"));
  const cwdParent = join(base, "worktrees");
  const cwd = join(cwdParent, "worktree-main");
  const sibling = join(base, "lane-a");
  const nestedInSibling = join(sibling, "sub");
  const insideCwd = join(cwd, "nested");
  const symlinkDir = join(base, "link-to-sibling");
  const regularFile = join(base, "not-a-dir.txt");
  const fakeState = join(base, "supervisor-state");
  const fakeHooks = join(fakeState, "hooks");
  const fakeHome = join(base, "fake-home");
  const fakeClaude = join(fakeHome, ".claude");
  const fakeSsh = join(fakeHome, ".ssh");
  try {
    await Promise.all([
      mkdir(insideCwd, { recursive: true }),
      mkdir(nestedInSibling, { recursive: true }),
      mkdir(fakeHooks, { recursive: true }),
      mkdir(fakeClaude, { recursive: true }),
      mkdir(fakeSsh, { recursive: true }),
    ]);
    await writeFile(regularFile, "file\n");
    await symlink(sibling, symlinkDir);

    const env = { ...process.env, HOME: fakeHome, CLAUDE_CONFIG_DIR: undefined };
    const protectedPaths = [fakeState, fakeHooks];

    // Valid sibling directory pins with dev/ino/canonical.
    const pinned = pinWriteRoots([sibling], cwd, { protectedPaths, env });
    assert.equal(pinned.length, 1);
    assert.equal(verifyPinnedWriteRoot(pinned[0]!), pinned[0]!.canonical);

    // Invalid roots are all rejected at startup.
    assert.throws(() => pinWriteRoots(["../lane-a"], cwd, { protectedPaths, env }), /safe absolute path/u);
    assert.throws(() => pinWriteRoots([join(base, "does-not-exist")], cwd, { protectedPaths, env }), /must already exist/u);
    assert.throws(() => pinWriteRoots([regularFile], cwd, { protectedPaths, env }), /must be a directory/u);
    assert.throws(() => pinWriteRoots([symlinkDir], cwd, { protectedPaths, env }), /must not be a symlink/u);
    assert.throws(() => pinWriteRoots([cwd], cwd, { protectedPaths, env }), /task working directory/u);
    assert.throws(() => pinWriteRoots([cwdParent], cwd, { protectedPaths, env }), /task working directory/u);
    assert.throws(() => pinWriteRoots([insideCwd], cwd, { protectedPaths, env }), /task working directory/u);
    assert.throws(() => pinWriteRoots(["/"], cwd, { protectedPaths, env }), /shared system root/u);
    assert.throws(() => pinWriteRoots([tmpdir()], cwd, { protectedPaths, env }), /shared system root/u);
    assert.throws(() => pinWriteRoots([fakeHome], cwd, { protectedPaths, env }), /home directory/u);
    assert.throws(() => pinWriteRoots([fakeClaude], cwd, { protectedPaths, env }), /protected policy/u);
    assert.throws(() => pinWriteRoots([fakeSsh], cwd, { protectedPaths, env }), /protected policy/u);
    assert.throws(() => pinWriteRoots([fakeState], cwd, { protectedPaths, env }), /protected policy/u);
    assert.throws(() => pinWriteRoots([dirname(fakeHooks)], cwd, { protectedPaths, env }), /protected policy/u);
    assert.throws(() => pinWriteRoots([sibling, nestedInSibling], cwd, { protectedPaths, env }), /must not overlap each other/u);
    assert.throws(() => pinWriteRoots([homedir()], cwd, { protectedPaths }), /home directory/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pinWriteRoots rejects a root that contains a linked worktree's shared git-common-dir", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-wroots-git-"));
  const repo = join(base, "main-repo");
  const worktree = join(base, "linked-wt");
  try {
    await mkdir(repo, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.email", "t@example.invalid"], { cwd: repo, stdio: "ignore" }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "ignore" }).status, 0);
    await writeFile(join(repo, "a.txt"), "a\n");
    assert.equal(spawnSync("git", ["add", "a.txt"], { cwd: repo, stdio: "ignore" }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-qm", "init"], { cwd: repo, stdio: "ignore" }).status, 0);
    assert.equal(spawnSync("git", ["worktree", "add", "-q", "-b", "wt-branch", worktree], { cwd: repo, stdio: "ignore" }).status, 0);

    // Main repo contains the linked worktree's git common dir (main-repo/.git).
    assert.throws(() => pinWriteRoots([repo], worktree), /protected policy/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("verifyPinnedWriteRoot and reverifyPinnedWriteRoots fail closed on symlink swap and replace-in-place (dev/ino change)", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-wroots-pin-"));
  const cwd = join(base, "cwd");
  const sibling = join(base, "sibling");
  const outside = join(base, "outside");
  try {
    await Promise.all([mkdir(cwd), mkdir(sibling), mkdir(outside)]);
    const pinned = pinWriteRoots([sibling], cwd);
    assert.equal(verifyPinnedWriteRoot(pinned[0]!), pinned[0]!.canonical);
    assert.deepEqual(reverifyPinnedWriteRoots(pinned, cwd), pinned);

    // Replace-in-place: rm -rf + mkdir keeps the exact same path but changes inode.
    await rm(sibling, { recursive: true, force: true });
    await mkdir(sibling);
    // Guard against the theoretical case where a filesystem immediately reuses the exact inode.
    const replacedInfo = await stat(sibling);
    if (replacedInfo.ino !== pinned[0]!.ino || replacedInfo.dev !== pinned[0]!.dev) {
      assert.equal(verifyPinnedWriteRoot(pinned[0]!), undefined);
      assert.throws(() => reverifyPinnedWriteRoots(pinned, cwd), /changed identity/u);
    }

    // Swapping for a symlink always invalidates.
    await rm(sibling, { recursive: true, force: true });
    await symlink(outside, sibling);
    assert.equal(verifyPinnedWriteRoot(pinned[0]!), undefined);
    assert.throws(() => reverifyPinnedWriteRoots(pinned, cwd), /must not be a symlink/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("createTaskTempRoot creates a 0700 pinned temp root; recovery reuses, recreates on ENOENT, and fails closed on swap", async () => {
  const outside = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-troot-out-"));
  let root = await createTaskTempRoot("11111111-1111-4111-8111-111111111111");
  try {
    const info = await stat(root.canonical);
    assert.equal(info.mode & 0o777, 0o700);
    assert.equal(verifyPinnedWriteRoot(root), root.canonical);

    const reused = await reverifyOrRecreateTaskTempRoot(root, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(reused, root);

    // Cleanly vanished (e.g., tmpfs reboot) -> fresh random directory.
    await rm(root.canonical, { recursive: true, force: true });
    const recreated = await reverifyOrRecreateTaskTempRoot(root, "11111111-1111-4111-8111-111111111111");
    assert.notEqual(recreated.canonical, root.canonical);
    assert.equal(verifyPinnedWriteRoot(recreated), recreated.canonical);
    root = recreated;

    // Swapped with symlink -> fail closed (never reuses or deletes symlink target).
    await rm(root.canonical, { recursive: true, force: true });
    await symlink(outside, root.declared);
    await assert.rejects(() => reverifyOrRecreateTaskTempRoot(root, "11111111-1111-4111-8111-111111111111"), /changed identity/u);
    await cleanupTaskTempRoot(root);
    // Outside target must remain untouched.
    assert.ok((await stat(outside)).isDirectory());
  } finally {
    await rm(root.declared, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true });
  }
});
