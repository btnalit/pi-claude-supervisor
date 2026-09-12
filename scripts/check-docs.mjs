import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const required = ["README.md", "README.cn.md", "CHANGELOG.md", "LICENSE", "docs/architecture.md", "docs/testing.md", "docs/releasing.md"];
for (const path of required) assert.ok(existsSync(path), `missing documentation file: ${path}`);
for (const path of ["README.md", "README.cn.md", "docs/architecture.md", "docs/testing.md", "docs/releasing.md", "docs/testing.md"]) {
  const markdown = readFileSync(path, "utf8");
  for (const match of markdown.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/gu)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z][a-z\d+.-]*:/iu.test(target)) continue;
    const resolved = posix.normalize(posix.join(dirname(path).replaceAll("\\", "/"), decodeURIComponent(target)));
    assert.ok(existsSync(join(process.cwd(), resolved)), `${path} links to missing file: ${target}`);
  }
}
assert.match(packageJson.description, /supervisor/iu);
assert.equal(packageJson.repository.url, "https://github.com/btnalit/pi-claude-supervisor.git");
console.log("Documentation links and repository metadata valid");
