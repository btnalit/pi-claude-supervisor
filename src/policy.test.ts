import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assertSafeWorkerCommand, evaluateCommand, evaluatePermission, isRoutinePermission } from "./policy.ts";

function bash(command: string) {
  return { command };
}

test("policy denies destructive commands", () => {
  assert.equal(evaluateCommand("rm -rf /").decision, "deny");
});

test("policy hard-denies Git alias redefinition", () => {
  assert.equal(evaluateCommand("git config alias.c checkout").decision, "deny");
  assert.equal(evaluateCommand("git -c alias.c=checkout c main").decision, "deny");
});

test("policy hard-denies publication and remote/integration writes", () => {
  assert.equal(evaluateCommand("git push origin main").decision, "deny");
  assert.equal(evaluateCommand("git -C /tmp/repo push origin main").decision, "deny");
  assert.equal(evaluateCommand("git merge main").decision, "deny");
  assert.equal(evaluateCommand("npm publish").decision, "deny");
  assert.equal(evaluateCommand("npm --prefix /tmp/pkg publish").decision, "deny");
  assert.equal(evaluateCommand("gh pr merge 25").decision, "deny");
  assert.equal(evaluateCommand("gh api -X POST repos/acme/project/releases").decision, "deny");
  assert.equal(evaluateCommand("git send-pack ssh://example.invalid/repo").decision, "deny");
  assert.equal(evaluateCommand("git reset --hard main").decision, "deny");
  assert.equal(evaluateCommand("git branch -D main").decision, "deny");
  assert.equal(evaluateCommand("git update-ref refs/heads/main HEAD~1").decision, "deny");
  assert.equal(evaluateCommand("git branch -f main").decision, "deny");
  assert.equal(evaluateCommand("git \"$ACTION\" \"$BRANCH\"").decision, "deny");
  assert.equal(evaluateCommand("g''it reset --hard main").decision, "deny");
  assert.equal(evaluateCommand("git \\\npush origin main").decision, "deny");
  assert.equal(evaluateCommand("echo ref > .git/refs/heads/main").decision, "deny");
  assert.equal(evaluateCommand("echo ref > refs/heads/main").decision, "deny");
  assert.equal(evaluateCommand("echo ref > .git/refs/heads/$BRANCH").decision, "deny");
  assert.equal(evaluateCommand("bash --noprofile -c 'git push'").decision, "deny");
  assert.equal(evaluateCommand("python -c \"subprocess.run(['git','push'])\"").decision, "deny");
});

test("policy allows read-only git merge lookups but still denies git merge", () => {
  assert.equal(evaluateCommand("git merge-base HEAD main").decision, "allow");
  assert.equal(evaluateCommand("git branch --merged").decision, "allow");
  assert.equal(evaluateCommand("git merge-tree a b").decision, "allow");
  assert.equal(evaluateCommand("git merge main").decision, "deny");
  assert.equal(evaluateCommand("git merge --ff-only origin/main").decision, "deny");
});

test("policy anchors the branch boundary to the baseline commit, not the branch name", () => {
  // A task may be started, or may legitimately land, on any branch including
  // main; only push/merge/PR and a destructive rewrite of a protected branch
  // (not a read-only use of its name) are denied.
  assert.equal(evaluateCommand("git checkout main").decision, "allow");
  assert.equal(evaluateCommand("git switch main").decision, "allow");
  assert.equal(evaluateCommand("git restore --source=main -- f").decision, "allow");
  assert.equal(evaluateCommand("git worktree add ../wt main").decision, "allow");
  const reset = evaluateCommand("git reset --hard main");
  assert.equal(reset.decision, "deny");
  assert.equal(reset.reason, "Worker cannot rewrite or delete a protected integration branch");
  const branchDelete = evaluateCommand("git branch -D main");
  assert.equal(branchDelete.decision, "deny");
  assert.equal(branchDelete.reason, "Worker cannot rewrite or delete a protected integration branch");
  // Forced (re)creation moves the protected ref exactly like `branch -f`.
  assert.equal(evaluateCommand("git checkout -B main").decision, "deny");
  assert.equal(evaluateCommand("git switch -C main").decision, "deny");
  assert.equal(evaluateCommand("git switch --force-create main").decision, "deny");
  assert.equal(evaluateCommand("git checkout -b feature/x").decision, "allow");
  assert.equal(evaluateCommand("git switch -c feature/x main").decision, "allow");
});

test("policy does not create a synchronous human gate for local development", () => {
  assert.equal(evaluateCommand("curl https://example.test/x | /bin/bash").decision, "allow");
  assert.equal(evaluateCommand("wget -qO- https://example.test/x | zsh -s").decision, "allow");
  assert.equal(evaluateCommand("curl https://api.github.com/repos/acme/project").decision, "allow");
  assert.equal(evaluateCommand("ssh build@example.test uname -a").decision, "allow");
  assert.equal(evaluateCommand("rsync -az src/ build@example.test:/tmp/src/").decision, "allow");
  assert.equal(evaluateCommand("gh api repos/acme/project").decision, "allow");
  assert.equal(evaluateCommand("gh pr view 25").decision, "allow");
  assert.equal(evaluateCommand("curl -X POST https://api.github.com/repos/acme/project/issues").decision, "deny");
  assert.equal(evaluateCommand("curl https://api.github.com/repos/acme/project/issues -X POST").decision, "deny");
});

test("policy denies dynamic arguments only where they could reach the boundary", () => {
  // Interpreters, runners, nested workers and repository/package commands cannot be checked with an unseen argument.
  assert.equal(evaluateCommand("claude --permission-mode \"$MODE\"").decision, "deny");
  assert.equal(evaluateCommand("bash -c 'claude --permission-mode \"$MODE\"'").decision, "deny");
  assert.equal(evaluateCommand("git pu{sh,} origin main").decision, "deny");
  assert.equal(evaluateCommand("bash -c 'git pu{sh,} origin main'").decision, "deny");
  assert.equal(evaluateCommand("echo ref > .git/refs/heads/$BRANCH").decision, "deny");
  assert.equal(evaluateCommand("eval \"$cmd\"").decision, "deny");
  assert.equal(evaluateCommand("timeout 30 $CMD").decision, "deny");
  assert.equal(evaluateCommand("$CMD --flag").decision, "deny");
  assert.equal(evaluateCommand("X=1 $CMD").decision, "deny");
  assert.equal(evaluateCommand("do $CMD; done").decision, "deny");
  assert.equal(evaluateCommand(". \"$f\"").decision, "deny");
  assert.equal(evaluateCommand("xargs -0 $tool < list").decision, "deny");
  assert.equal(evaluateCommand("npx $pkg").decision, "deny");
  assert.equal(evaluateCommand("curl -X POST -d \"$body\" https://example.test").decision, "deny");
  // Ordinary local commands with dynamic text are Claude's own business.
  assert.equal(evaluateCommand("rm -rf \"$TARGET\"").decision, "allow");
  assert.equal(evaluateCommand("rm -rf /tmp/*").decision, "allow");
  assert.equal(evaluateCommand("rm -rf ./dist /home/u/x/node_modules").decision, "allow");
  assert.equal(evaluateCommand("echo \"$VALUE\" > \"$TARGET\"").decision, "allow");
  assert.equal(evaluateCommand("if [ -d .git ]; then git status; fi").decision, "allow");
  assert.equal(evaluateCommand("if [ -n \"$x\" ]; then echo hi; fi").decision, "allow");
  assert.equal(evaluateCommand("find . -name '*.o' -exec rm {} \\;").decision, "allow");
  assert.equal(evaluateCommand("ls *.ts").decision, "allow");
  assert.equal(evaluateCommand("python3 -c 'import sys' \"$f\"").decision, "allow");
  // The catastrophe guard covers the filesystem root itself, not every absolute path.
  assert.equal(evaluateCommand("rm -rf /").decision, "deny");
  assert.equal(evaluateCommand("rm -rf /*").decision, "deny");
  assert.equal(evaluateCommand("rm -rf --no-preserve-root /").decision, "deny");
});

test("a quoted heredoc body means what its consumer makes of it", () => {
  // Fed to a shell it is a command and is evaluated as one.
  assert.equal(evaluateCommand("bash <<'EOF'\ngit push origin main\nEOF").decision, "deny");
  assert.equal(evaluateCommand("cat <<'EOF' | sh\ngit push origin main\nEOF").decision, "deny");
  assert.equal(evaluateCommand("cat <<'EOF' | tee x | bash\ngit push origin main\nEOF").decision, "deny");
  assert.equal(evaluateCommand("eval \"$(cat <<'EOF'\ngit push origin main\nEOF\n)\"").decision, "deny");
  assert.equal(evaluateCommand("bash -c \"$(cat <<'EOF'\ngit push origin main\nEOF\n)\"").decision, "deny");
  // Fed to anything else it stays visible to the pattern checks.
  assert.equal(evaluateCommand("python3 - <<'PY'\nimport subprocess; subprocess.run([\"git\",\"push\",\"origin\",\"main\"])\nPY").decision, "deny");
  assert.equal(evaluateCommand("node - <<'EOF'\nrequire('child_process').execSync('git push origin main')\nEOF").decision, "deny");
  assert.equal(evaluateCommand("node - <<'EOF'\nconsole.log(1)\nEOF").decision, "allow");
  // An unquoted delimiter expands: a substitution in the body runs.
  assert.equal(evaluateCommand("cat <<EOF\n$(git push origin main)\nEOF").decision, "deny");
  // Fed to a data sink it is text the boundary never sees.
  assert.equal(evaluateCommand("cat > notes.md <<'EOF'\nrun git push origin main later\nEOF").decision, "allow");
  assert.equal(evaluateCommand("cat <<'EOF' | grep push\ngit push origin main\nEOF").decision, "allow");
  assert.equal(evaluateCommand("git commit -m \"$(cat <<'EOF'\nfix: merge two loops, reset main and push them\nEOF\n)\"").decision, "allow");
  assert.equal(evaluateCommand("git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\" && git push origin main").decision, "deny");
  // A ref write through a heredoc is still a ref write.
  assert.equal(evaluateCommand("cat > .git/refs/heads/main <<'EOF'\nabc\nEOF").decision, "deny");
});

test("a dynamic argument counts only in the statement that holds the sensitive command", () => {
  // Shapes a fix Worker actually ran: the exit-status echo is a separate statement from `npm`.
  assert.equal(evaluateCommand("npm run typecheck >/dev/null 2>&1; echo \"typecheck exit $?\"").decision, "allow");
  assert.equal(evaluateCommand("npm test && echo \"$?\" && python3 - <<'EOF'\nprint(1)\nEOF").decision, "allow");
  assert.equal(evaluateCommand("git status; echo \"$x\"").decision, "allow");
  assert.equal(evaluateCommand("x=$(ls); git status").decision, "allow");
  assert.equal(evaluateCommand("echo \"$x\" | git apply --check").decision, "allow");
  // An environment prefix's value never reaches the argv.
  assert.equal(evaluateCommand("npm_config_cache=$TMPDIR/npm-cache npm run check 2>&1 | grep -E \"^ℹ\" | head -20; echo \"check exit: ${PIPESTATUS[0]}\"").decision, "allow");
  assert.equal(evaluateCommand("GIT_DIR=$X git status").decision, "allow");
  // A redirection target names a file, not an argument.
  assert.equal(evaluateCommand("git show f2fb900^:src/memory/retriever.ts > $OLD/memory/retriever.ts").decision, "allow");
  assert.equal(evaluateCommand("git diff --stat >> \"$LOG\" 2>&1").decision, "allow");
  assert.equal(evaluateCommand("git show HEAD:x > .git/refs/heads/main").decision, "deny");
  assert.equal(evaluateCommand("git apply < \"$patch\"").decision, "allow");
  assert.equal(evaluateCommand("git apply \"$patch\"").decision, "deny");
  assert.equal(evaluateCommand("X=1 npm run $script").decision, "deny");
  assert.equal(evaluateCommand("x=$(ls) git add \"$x\"").decision, "deny");
  // The same statement still cannot be checked.
  assert.equal(evaluateCommand("git status; git add \"$x\"").decision, "deny");
  assert.equal(evaluateCommand("echo ok && npm run $script").decision, "deny");
  assert.equal(evaluateCommand("cd x; $CMD").decision, "deny");
  assert.equal(evaluateCommand("ls | xargs $tool").decision, "deny");
});

test("a name bound to literal text is not an unseen argument", () => {
  // Shapes a Worker actually ran.
  assert.equal(evaluateCommand("for c in 5dae138 feff500 6098949; do echo \"=== $c\"; git show --stat --format='%s' $c | tail -n +1; done").decision, "allow");
  assert.equal(evaluateCommand("S=/tmp/claude/scratchpad && (npm run test:pi > $S/test-pi.log 2>&1; echo \"exit=$?\" >> $S/test-pi.log) && (npm_config_cache=$S/npm-cache npm run test:install > $S/test-install.log 2>&1)").decision, "allow");
  assert.equal(evaluateCommand("FILE=src/policy.ts; git diff -- \"$FILE\"; git log --oneline -3 -- ${FILE}").decision, "allow");
  // Every bound value is substituted, so a loop that would push is still a push.
  assert.equal(evaluateCommand("for c in status push; do git $c origin main; done").decision, "deny");
  assert.equal(evaluateCommand("ACTION=push; git $ACTION origin main").decision, "deny");
  // A binding to dynamic text, or an unbound name, is still unseen.
  assert.equal(evaluateCommand("for c in $(git rev-list HEAD~3..HEAD); do git show $c; done").decision, "deny");
  assert.equal(evaluateCommand("C=$(git rev-parse HEAD); git show $C").decision, "deny");
  assert.equal(evaluateCommand("git show $c").decision, "deny");
  assert.equal(evaluateCommand("X=literal; X=$Y; git show $X").decision, "deny");
});

test("newlines separate statements and comments are ignored", () => {
  assert.equal(evaluateCommand("echo start\n$CMD --flag").decision, "deny");
  assert.equal(evaluateCommand("cd x\n$CMD").decision, "deny");
  assert.equal(evaluateCommand("( $CMD )").decision, "deny");
  assert.equal(evaluateCommand("($CMD)").decision, "deny");
  assert.equal(evaluateCommand("find . -exec $CMD {} \\;").decision, "deny");
  assert.equal(evaluateCommand("setsid $CMD").decision, "deny");
  assert.equal(evaluateCommand("echo hi # don't").decision, "allow");
  assert.equal(evaluateCommand("npm test &&\n  npm run lint").decision, "allow");
  assert.equal(evaluateCommand("{ echo \"$x\"; }").decision, "allow");
  assert.equal(evaluateCommand("( echo hi )").decision, "allow");
  assert.equal(evaluateCommand("echo '#not a comment' # but this is\nls").decision, "allow");
});

test("the Bash tool path and direct command evaluation agree", () => {
  const matrix = [
    "git push origin main", "git pu{sh,} origin main", "$CMD --flag", "timeout 30 $CMD", "claude --permission-mode \"$MODE\"",
    "sh -c \"$x\"", "bash -lc 'git push origin main'", "npm publish", "gh pr create --title \"$title\"",
    "for f in a b; do echo \"$f\"; done", "rm -rf /tmp/*", "rm -rf /", "cat > notes.md <<'EOF'\ngit push origin main\nEOF",
    "bash <<'EOF'\ngit push origin main\nEOF", "git commit -m \"$(cat <<'EOF'\nfix: merge\nEOF\n)\"", "echo hi # don't",
    "if [ -d .git ]; then git status; fi", "echo start\n$CMD", "c'l'a'u'de --print review",
  ];
  for (const command of matrix) {
    assert.equal(evaluatePermission("Bash", { command }).decision, evaluateCommand(command).decision, command);
  }
});

test("policy allows ordinary read-only commands and literal argv values", () => {
  assert.equal(evaluateCommand("git diff --check").decision, "allow");
  assert.equal(evaluateCommand("node", ["-e", "console.log({ value: 1 })"]).decision, "allow");
});

test("permission policy allows the full Claude tool and nested-worker surface", () => {
  assert.equal(evaluatePermission("Bash", { command: "claude --print review" }).decision, "allow");
  assert.equal(evaluatePermission("Bash", { command: "c'l'a'u'de --print review" }).decision, "allow");
  assert.equal(evaluatePermission("Bash", { command: "/usr/local/bin/claude --print review" }).decision, "allow");
  assert.equal(evaluatePermission("Bash", { command: "env CLAUDE_ENV=1 /usr/local/bin/claude --print review" }).decision, "allow");
  assert.equal(evaluatePermission("Bash", { command: "python3 -c 'import os; os.execv(\"/opt/Claude Code/bin/claude\", [\"claude\"])'" }).decision, "allow");
  assert.equal(evaluatePermission("Bash", { command: "npm test" }).decision, "allow");
  assert.equal(evaluatePermission("Task", {}).decision, "allow");
  assert.equal(evaluatePermission("Agent", {}).decision, "allow");
  assert.equal(evaluatePermission("McpTool", {}).decision, "allow");
  assert.equal(evaluatePermission("UnknownTool", {}).decision, "allow");
  assert.equal(evaluatePermission("AskUserQuestion", {}).decision, "deny");
});

test("file tools cannot write Git metadata", () => {
  assert.equal(evaluatePermission("Write", { file_path: "src/index.ts", content: "ok" }).decision, "allow");
  assert.equal(evaluatePermission("Write", { file_path: ".git/config", content: "[alias]" }).decision, "deny");
  assert.equal(evaluatePermission("Edit", { file_path: ".git/refs/heads/main", old_string: "a", new_string: "b" }).decision, "deny");
  assert.equal(evaluatePermission("NotebookEdit", { notebook_path: "work/../.git/objects/x" }).decision, "deny");
  assert.equal(evaluatePermission("Write", { content: "missing path" }).decision, "deny");
});

test("file tools reject outside-cwd and hard-link Git aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-policy-hardlink-"));
  try {
    await mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
    const ref = join(root, ".git", "refs", "heads", "main");
    const alias = join(root, "main-alias");
    await writeFile(ref, "base\n");
    await link(ref, alias);
    assert.equal(evaluatePermission("Write", { file_path: "main-alias", content: "moved\n" }, root).decision, "deny");
    const outside = evaluatePermission("Write", { file_path: "../outside.txt", content: "outside\n" }, root);
    assert.equal(outside.decision, "deny");
    assert.equal(outside.reason, "Worker cannot write outside the task working directory: ../outside.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file tools cannot follow a symlink into Git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-policy-"));
  try {
    await mkdir(join(root, ".git"));
    await symlink(join(root, ".git"), join(root, "safe-link"), "dir");
    assert.equal(evaluatePermission("Write", { file_path: "safe-link/config", content: "[core]" }, root).decision, "deny");
    assert.equal(evaluatePermission("Write", { file_path: "safe-link/../outside", content: "escape" }, root).decision, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy denies unsafe worker permission flags even when passed as arguments", () => {
  assert.equal(evaluateCommand("claude", ["--dangerously-skip-permissions"]).decision, "deny");
  assert.equal(evaluateCommand("claude", ["--allow-dangerously-skip-permissions"]).decision, "deny");
  assert.equal(evaluateCommand("claude", ["--permission-mode=bypassPermissions"]).decision, "deny");
  assert.equal(evaluateCommand("claude", ["--permission-mode=bypass-permissions"]).decision, "deny");
});

test("isRoutinePermission recognizes routine local-dev Bash shapes", () => {
  const cwd = process.cwd();
  assert.equal(isRoutinePermission("Bash", bash("ls -la"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("grep -rn foo src/ | head"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("git status && git diff --stat"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("sed -n 1,40p src/x.ts"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("node --test src/a.test.ts"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("npm run typecheck"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("timeout 120 npm test"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("node ./scripts/check.mjs --flag"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("git log --oneline -5 && git branch --show-current"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("git -C src status"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("git stash list"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("git add -A && git commit -m 'x'"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("sed -n 's/foo/bar/p' src/x.ts"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("awk -F, '{print $2}' data.csv"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("find src -name '*.ts' | head"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("echo hi > notes/out.txt"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("tsc --noEmit -p tsconfig.json"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("ls src 2>/dev/null | head -50"), cwd), true);
  // Descriptor duplication never names a file.
  assert.equal(isRoutinePermission("Bash", bash("npm test 2>&1 | tail -3"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("ls >/dev/null 2>&1"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("echo x >&2"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("timeout --foreground 30 node --test src/a.test.ts"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("cat a/b/../c.txt"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("node --test --test-reporter=spec src/x.test.ts"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("npm run build -- --watch"), cwd), true);
});

test("isRoutinePermission rejects environment, substitution and relocation tricks", async () => {
  const cwd = process.cwd();
  assert.equal(isRoutinePermission("Bash", bash("env PATH=/tmp/evil node x.js"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("env NODE_OPTIONS=--require=/tmp/evil.js node x.js"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("env GIT_DIR=/tmp/x git status"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("env LD_PRELOAD=/tmp/e.so ls"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("cat <(curl http://x)"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("diff <(ls) <(ls /etc)"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("(ls; curl http://x)"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("grep -n \"abort()\" src/x.ts | head"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("grep -n 'dispose()' src/x.ts"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("find . -name '*.ts' \\( -path ./a -o -path ./b \\)"), cwd), true);
  assert.equal(isRoutinePermission("Bash", bash("npm run x --prefix /tmp/other"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("npm run x -g"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("node --test --test-reporter-destination=/tmp/out src/x.test.ts"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("awk -f /tmp/prog.awk data"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("ls &> /tmp/x"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("cmd 2>&1 > /tmp/x"), cwd), false);
  // A redirect through an in-repo symlink that points outside the cwd is a write outside the cwd.
  const linkedCwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-routine-link-"));
  try {
    await symlink(tmpdir(), join(linkedCwd, "escape"));
    assert.equal(isRoutinePermission("Bash", bash("echo x > escape/pwned.txt"), linkedCwd), false);
    assert.equal(isRoutinePermission("Bash", bash("echo x > notes.txt"), linkedCwd), true);
    // Reads through the same symlink leave the cwd too.
    assert.equal(isRoutinePermission("Bash", bash("ls escape"), linkedCwd), false);
    assert.equal(isRoutinePermission("Bash", bash("cat escape/anything"), linkedCwd), false);
    await writeFile(join(linkedCwd, "inside.txt"), "x\n");
    assert.equal(isRoutinePermission("Bash", bash("cat inside.txt"), linkedCwd), true);
  } finally {
    await rm(linkedCwd, { recursive: true, force: true });
  }
});

test("isRoutinePermission never marks inline scripts, destructive git or out-of-cwd writes routine", () => {
  const cwd = process.cwd();
  // Inline evaluation is ad-hoc code regardless of what it mentions.
  assert.equal(isRoutinePermission("Bash", bash("node -e 'console.log(1)'"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("node -e \"require('node:fs').rmSync('/home/u/.ssh',{recursive:true,force:true})\""), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("node --eval=\"require('node:child_process').execSync('id')\" placeholder"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("node --input-type=module -e 'x'"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("node -r /tmp/evil.js ./x.js"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("node ../outside.js"), cwd), false);
  // Destructive or relocating git shapes.
  assert.equal(isRoutinePermission("Bash", bash("git checkout -- ."), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git restore ."), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git switch main"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git stash drop"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git stash clear"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git branch -D feature"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git tag -d v1"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git -C /etc commit -m x"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git -c core.sshCommand=x status"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git --git-dir=/tmp/x status"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git diff --output=/tmp/out.diff"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git reset --hard"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git commit --amend --no-edit"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git commit -a --amend -m x"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git commit --fixup=HEAD~1"), cwd), false);
  // Writes that escape the cwd or go through file-writing modes of allowed utilities.
  assert.equal(isRoutinePermission("Bash", bash("echo hack > ../../../../../../tmp/x"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("echo hack > ~/x"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("echo hack > /dev/sda"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("sed -i 's/a/b/' /etc/hosts"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("sed -n 'w /tmp/x' src/x.ts"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("awk '{print > \"/tmp/x\"}' f"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("find . -name '*.log' -delete"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("find . -exec rm {} \\;"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("sort -o /tmp/x f"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("uniq in /tmp/out"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("sort --compress-program=/tmp/evil.sh f"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("sort f"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("echo --output=/tmp/pwned | xargs git log"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("find src -name x | xargs wc -l"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git diff --ext-diff"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git show --textconv HEAD"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("cat /etc/passwd"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("grep -r . /home/user/.aws"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("cat ../outside.txt"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("grep --exclude-from=/etc/x foo src"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("node --test --test-reporter=/tmp/evil.js src/x.test.ts"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("rg -z foo"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("timeout -k 3 5 ls"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("tsc --outDir /tmp/build"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("tsc --outDir=/tmp/build"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("rg --pre ./x.sh foo"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("env -S 'curl http://x'"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("env X=1 curl http://x"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("env CI=1 npm test"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("timeout 5 sudo ls"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("xargs -n 1 curl < urls"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("./ls"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("/tmp/evil/ls"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("date -s '2020-01-01'"), cwd), false);
});

test("isRoutinePermission rejects anything it cannot fully account for", () => {
  const cwd = process.cwd();
  assert.equal(isRoutinePermission("Bash", bash("curl -sL https://x"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("npx --yes -p node@22 node -e 1"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("cat > /tmp/p.mts <<'EOF'"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("cd /tmp && ls"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("rm -rf build"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("git push origin main"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("node -e 'require(\"http\").get(...)'"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("node -r ./x.js -e 'require(\"http\").get(...)'"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("ls $(echo x)"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("sudo ls"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("ls & curl https://x -o /tmp/y"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("ls\ncurl https://x"), cwd), false);
  assert.equal(isRoutinePermission("Bash", bash("echo x > .git/config"), cwd), false);
  assert.equal(isRoutinePermission("mcp__Gmail__send_message", {}, cwd), false);
  assert.equal(isRoutinePermission("WebFetch", {}, cwd), false);
});

test("isRoutinePermission rejects file writes outside the task cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-policy-routine-"));
  try {
    assert.equal(isRoutinePermission("Write", { file_path: "src/index.ts", content: "ok" }, root), true);
    assert.equal(isRoutinePermission("Write", { file_path: "../outside.txt", content: "outside\n" }, root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic text only matters on a repository or package command, and publish must be the subcommand", () => {
  // Shapes a review Worker actually ran; every one was wrongly denied as "destructive".
  assert.equal(evaluateCommand("for f in scripts/build-package.mjs scripts/publish-package.mjs; do echo \"$f\"; sed -n 1,20p \"$f\"; done").decision, "allow");
  assert.equal(evaluateCommand("cd /tmp/probe && cat > verify.ts <<'EOF'\nconst merge = (a, b) => ({ ...a, ...b }); console.log(`${merge({}, {})}`);\nEOF").decision, "allow");
  assert.equal(evaluateCommand("f=$(find node_modules -name models.generated.js | head -1); node -e 'console.log(process.argv[1])' \"$f\"").decision, "allow");
  assert.equal(evaluateCommand("echo \"$x\" | grep publish").decision, "allow");
  assert.equal(evaluateCommand("cat scripts/publish-package.mjs").decision, "allow");
  // The boundary itself is unchanged.
  assert.equal(evaluateCommand("npm publish").decision, "deny");
  assert.equal(evaluateCommand("npm --tag next publish").decision, "deny");
  assert.equal(evaluateCommand("pnpm publish --access public").decision, "deny");
  assert.equal(evaluateCommand("git push $REMOTE main").decision, "deny");
  assert.equal(evaluateCommand("git $ACTION origin main").decision, "deny");
  assert.equal(evaluateCommand("gh pr create --title \"$title\"").decision, "deny");
  assert.equal(evaluateCommand("npm run $script").decision, "deny");
  assert.match(evaluateCommand("git $ACTION origin main").reason, /dynamic argument/u);
});

test("file tools may write inside an extra write root such as Claude's scratchpad, with the same metadata rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-policy-cwd-"));
  const scratchpad = await mkdtemp(join(tmpdir(), "pi-claude-supervisor-policy-scratch-"));
  try {
    const target = join(scratchpad, "probe.ts");
    assert.equal(evaluatePermission("Write", { file_path: target }, cwd).decision, "deny");
    assert.equal(evaluatePermission("Write", { file_path: target }, cwd, { writeRoots: [scratchpad] }).decision, "allow");
    assert.equal(evaluatePermission("Write", { file_path: join(scratchpad, ".git", "config") }, cwd, { writeRoots: [scratchpad] }).decision, "deny");
    assert.equal(evaluatePermission("Write", { file_path: join(tmpdir(), "elsewhere.txt") }, cwd, { writeRoots: [scratchpad] }).decision, "deny");
    assert.equal(isRoutinePermission("Write", { file_path: target }, cwd, { writeRoots: [scratchpad] }), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(scratchpad, { recursive: true, force: true });
  }
});

test("remote and destructive commands remain denied even with a legacy approval", () => {
  assert.throws(() => assertSafeWorkerCommand("git", ["push"], { actor: "human", reason: "release approved" }), /blocked by policy \(deny\)/u);
  assert.throws(() => assertSafeWorkerCommand("rm", ["-rf", "/"], { actor: "human", reason: "approved" }), /blocked by policy \(deny\)/u);
});
