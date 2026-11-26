import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { claudeConfigDir } from "./worker/environment.ts";

/**
 * A validated, startup-pinned extra write root. Every permission check
 * re-verifies `lstat(declared)` (real non-symlink directory, matching `dev`
 * and `ino`) and `realpath(declared) === canonical`, failing closed if the
 * directory is deleted, replaced in place, or swapped for a symlink.
 */
export interface PinnedWriteRoot {
  declared: string;
  canonical: string;
  dev: number;
  ino: number;
}

export interface PinWriteRootsOptions {
  /** Supervisor-owned runtime paths (stateDir, hookDir, leaseDir, decisionDir) that a Worker must never be granted. */
  protectedPaths?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

const MAX_WRITE_ROOT_PATH_LENGTH = 4_096;
const MAX_GIT_POINTER_BYTES = 16 * 1024;
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/** Explicit path safety validation for persisted write root paths (no credential-redaction equality heuristics). */
export function assertSafeWriteRootPath(path: string): void {
  if (typeof path !== "string" || !path || !isAbsolute(path) || path.length > MAX_WRITE_ROOT_PATH_LENGTH || path.includes("\0")) {
    throw new Error("write root path must be a safe absolute path");
  }
}

export function isPinnedWriteRoot(value: unknown): value is PinnedWriteRoot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PinnedWriteRoot>;
  return typeof candidate.declared === "string" && isAbsolute(candidate.declared) && candidate.declared.length <= MAX_WRITE_ROOT_PATH_LENGTH && !candidate.declared.includes("\0")
    && typeof candidate.canonical === "string" && isAbsolute(candidate.canonical) && candidate.canonical.length <= MAX_WRITE_ROOT_PATH_LENGTH && !candidate.canonical.includes("\0")
    && typeof candidate.dev === "number" && Number.isFinite(candidate.dev) && candidate.dev >= 0
    && typeof candidate.ino === "number" && Number.isFinite(candidate.ino) && candidate.ino >= 0;
}

/** True when `a` and `b` are the same path or one is an ancestor of the other. */
export function pathsOverlapCanonical(a: string, b: string): boolean {
  const left = normalizeForComparison(a);
  const right = normalizeForComparison(b);
  if (left === right) return true;
  if (left === "/" || right === "/") return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isSameOrAncestor(ancestor: string, descendant: string): boolean {
  const left = normalizeForComparison(ancestor);
  const right = normalizeForComparison(descendant);
  if (left === right) return true;
  if (left === "/") return true;
  return right.startsWith(`${left}/`);
}

function normalizeForComparison(path: string): string {
  const cleaned = resolve(path).replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  return CASE_INSENSITIVE_FS ? cleaned.toLowerCase() : cleaned;
}

function hasGitSegment(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").some((segment) => segment.toLowerCase() === ".git");
}

function canonicalOrResolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function readSmallRegularFile(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    fd = openSync(path, flags);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function resolveGitCommonDir(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    const dotGit = join(current, ".git");
    try {
      const info = statSync(dotGit);
      if (info.isDirectory()) return canonicalOrResolved(dotGit);
      if (info.isFile()) {
        const resolvedDotGit = canonicalOrResolved(dotGit);
        const text = readSmallRegularFile(resolvedDotGit, MAX_GIT_POINTER_BYTES);
        const match = text?.match(/^gitdir:\s*(.+?)\s*$/mu);
        if (!match?.[1]) return undefined;
        const gitDir = resolve(current, match[1]);
        const commonText = readSmallRegularFile(join(gitDir, "commondir"), MAX_GIT_POINTER_BYTES)?.trim();
        const commonDir = commonText ? resolve(gitDir, commonText) : gitDir;
        return canonicalOrResolved(commonDir);
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function sensitiveSystemRoots(cwd: string, options: PinWriteRootsOptions): { exactOnly: string[]; noOverlap: string[]; home: string } {
  const env = options.env ?? process.env;
  const effectiveHome = env.HOME?.trim() ? resolve(env.HOME) : homedir();
  const canonicalHome = canonicalOrResolved(effectiveHome);
  const configDir = canonicalOrResolved(claudeConfigDir(env));
  const defaultClaudeDir = canonicalOrResolved(join(canonicalHome, ".claude"));
  const noOverlap = new Set<string>([
    configDir,
    defaultClaudeDir,
    canonicalOrResolved(join(canonicalHome, ".ssh")),
    canonicalOrResolved(join(canonicalHome, ".gnupg")),
    canonicalOrResolved(join(canonicalHome, ".config", "git")),
  ]);
  for (const extra of options.protectedPaths ?? []) {
    if (extra && isAbsolute(extra)) noOverlap.add(canonicalOrResolved(extra));
  }
  const gitCommon = resolveGitCommonDir(cwd);
  if (gitCommon) noOverlap.add(gitCommon);

  const exactOnly = new Set<string>([
    "/",
    canonicalOrResolved(tmpdir()),
    canonicalOrResolved("/tmp"),
  ]);
  return { exactOnly: [...exactOnly], noOverlap: [...noOverlap], home: canonicalHome };
}

/**
 * Validate and pin every declared write root at startup.
 * Declared roots must already exist as real non-symlink directories, must not
 * overlap `cwd` or protected/policy-integrity directories, and are pinned by
 * `(declared, canonical, dev, ino)`.
 */
export function pinWriteRoots(rawRoots: readonly string[], cwd: string, options: PinWriteRootsOptions = {}): PinnedWriteRoot[] {
  if (rawRoots.length === 0) return [];
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync.native(cwd);
  } catch {
    throw new Error(`task working directory does not exist: ${cwd}`);
  }
  const sensitive = sensitiveSystemRoots(canonicalCwd, options);
  const pinned: PinnedWriteRoot[] = [];
  const seenCanonical = new Set<string>();

  for (const raw of rawRoots) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("writeRoot must be a non-empty absolute directory path");
    }
    if (!isAbsolute(raw) || raw.length > MAX_WRITE_ROOT_PATH_LENGTH || raw.includes("\0")) {
      throw new Error(`writeRoot must be a safe absolute path: ${raw}`);
    }
    const declared = resolve(raw);
    if (hasGitSegment(raw) || hasGitSegment(declared)) {
      throw new Error(`writeRoot must not name a .git path: ${raw}`);
    }
    let info;
    try {
      info = lstatSync(declared);
    } catch {
      throw new Error(`writeRoot must already exist as a directory: ${raw}`);
    }
    if (info.isSymbolicLink()) {
      throw new Error(`writeRoot must not be a symlink: ${raw}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`writeRoot must be a directory: ${raw}`);
    }
    let canonical: string;
    try {
      canonical = realpathSync.native(declared);
    } catch {
      throw new Error(`writeRoot could not be canonicalized: ${raw}`);
    }
    if (hasGitSegment(canonical)) {
      throw new Error(`writeRoot canonical path must not contain .git: ${raw}`);
    }
    if (sensitive.exactOnly.some((blocked) => normalizeForComparison(canonical) === normalizeForComparison(blocked))) {
      throw new Error(`writeRoot cannot be a shared system root: ${raw}`);
    }
    if (isSameOrAncestor(canonical, sensitive.home)) {
      throw new Error(`writeRoot cannot be or contain the user home directory: ${raw}`);
    }
    if (pathsOverlapCanonical(canonical, canonicalCwd)) {
      throw new Error(`writeRoot cannot equal, contain, or lie inside the task working directory: ${raw}`);
    }
    if (sensitive.noOverlap.some((blocked) => pathsOverlapCanonical(canonical, blocked))) {
      throw new Error(`writeRoot cannot overlap protected policy, runtime, or credential directories: ${raw}`);
    }
    const canonicalKey = normalizeForComparison(canonical);
    if (seenCanonical.has(canonicalKey)) continue;
    for (const existing of pinned) {
      if (pathsOverlapCanonical(existing.canonical, canonical)) {
        throw new Error(`declared writeRoots must not overlap each other: ${existing.declared} and ${declared}`);
      }
    }
    seenCanonical.add(canonicalKey);
    pinned.push({ declared, canonical, dev: info.dev, ino: info.ino });
  }
  return pinned;
}

/**
 * Re-verify previously persisted pinned write roots (for recovery): every root
 * must still pass startup validation AND match its persisted canonical path,
 * device, and inode. Any replacement or drift fails closed.
 */
export function reverifyPinnedWriteRoots(persisted: readonly PinnedWriteRoot[], cwd: string, options: PinWriteRootsOptions = {}): PinnedWriteRoot[] {
  if (persisted.length === 0) return [];
  const repinned = pinWriteRoots(persisted.map((root) => root.declared), cwd, options);
  if (repinned.length !== persisted.length) {
    throw new Error("persisted writeRoots changed before recovery");
  }
  for (let i = 0; i < persisted.length; i += 1) {
    const expected = persisted[i]!;
    const actual = repinned[i]!;
    if (actual.canonical !== expected.canonical || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error(`persisted writeRoot changed identity (path, dev, or ino) before recovery: ${expected.declared}`);
    }
  }
  return repinned;
}

/**
 * Fast fail-closed runtime check for a pinned write root. Returns the canonical
 * root path only when `declared` is still the exact same non-symlink directory
 * (`dev`, `ino`, `canonical` unchanged); otherwise returns `undefined`.
 */
export function verifyPinnedWriteRoot(root: PinnedWriteRoot): string | undefined {
  try {
    const info = lstatSync(root.declared);
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    if (info.dev !== root.dev || info.ino !== root.ino) return undefined;
    const canonical = realpathSync.native(root.declared);
    if (canonical !== root.canonical) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

/**
 * Create a private `0700` per-task scratch temp directory (D9a) pinned by
 * `(declared, canonical, dev, ino)`. The Worker receives `TMPDIR`/`TMP`/`TEMP`
 * pointing here instead of opening blanket writes to shared `/tmp`.
 */
export async function createTaskTempRoot(taskId: string): Promise<PinnedWriteRoot> {
  const prefix = join(tmpdir(), `pi-claude-task-${taskId.replace(/[^A-Za-z0-9-]/gu, "").slice(0, 12) || "tmp"}-`);
  const declared = await mkdtemp(prefix);
  await chmod(declared, 0o700);
  const info = lstatSync(declared);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await rm(declared, { recursive: true, force: true }).catch(() => {});
    throw new Error("created task temp directory is not a real directory");
  }
  const canonical = realpathSync.native(declared);
  return { declared, canonical, dev: info.dev, ino: info.ino };
}

/**
 * Re-verify a persisted task temp root on recovery. If it still matches its
 * pinned `(canonical, dev, ino)`, reuse it. If it vanished cleanly (`ENOENT`,
 * e.g. tmpfs reboot), allocate a fresh private `0700` temp directory under a
 * new random name. If the path still exists with a different identity (symlink
 * or replaced directory), fail closed.
 */
export async function reverifyOrRecreateTaskTempRoot(persisted: PinnedWriteRoot, taskId: string): Promise<PinnedWriteRoot> {
  if (verifyPinnedWriteRoot(persisted)) return persisted;
  try {
    lstatSync(persisted.declared);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return createTaskTempRoot(taskId);
    }
    throw error;
  }
  throw new Error(`persisted task temp directory changed identity (symlink or dev/ino mismatch): ${persisted.declared}`);
}

/** Remove a task temp root only if its pinned identity still matches. */
export async function cleanupTaskTempRoot(root: PinnedWriteRoot | undefined): Promise<void> {
  if (!root) return;
  const verified = verifyPinnedWriteRoot(root);
  if (!verified) return;
  await rm(verified, { recursive: true, force: true });
}
