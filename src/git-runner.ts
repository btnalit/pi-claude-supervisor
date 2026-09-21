import { execFile } from "node:child_process";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";
import { trustedExecutablePath, workerEnvironment } from "./worker/environment.ts";

const execFileAsync = promisify(execFile);

const REPOSITORY_RELOCATING_GIT_VARIABLE = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG(?:_GLOBAL|_SYSTEM|_NOSYSTEM|_COUNT|_KEY_\d+|_VALUE_\d+|_PARAMETERS)?|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)$/u;
const UNSAFE_GIT_VARIABLE = /^(?:GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_TRACE(?:2)?(?:_EVENTS)?|GIT_TRACE_PERFORMANCE|GIT_TRACE_SETUP|GIT_TRACE_PACKET|GIT_TRACE_PACK_ACCESS|GIT_TRACE_CURL|GIT_TRACE_CURL_NO_DATA)$/u;
const UNSAFE_GIT_EXECUTION_VARIABLE = /^(?:GIT_SSH|GIT_SSH_COMMAND|GIT_SSH_VARIANT|GIT_ASKPASS|SSH_ASKPASS|GIT_PROXY_COMMAND|GIT_EDITOR|GIT_SEQUENCE_EDITOR)$/u;
// Supervisor-owned child helpers must not inherit a dynamic-loader or locale
// path that changes which code an absolute executable loads. The granted push
// clears the same names in its shell prefix; read-only Git/gh/ssh helpers do it
// in their child environment before spawn.
const UNSAFE_LOADER_VARIABLE = /^(?:LD_(?:PRELOAD|LIBRARY_PATH(?:_32|_64)?|AUDIT|DEBUG|DEBUG_OUTPUT|ORIGIN_PATH|PROFILE|USE_LOAD_BIAS|PREFER_MAP_32BIT_EXEC|ASSUME_KERNEL|HWCAP_MASK|SHOW_AUXV|DYNAMIC_WEAK|BIND_NOT|VERBOSE|WARN|PROFILE_OUTPUT)|LOCPATH|NLSPATH|GLIBC_TUNABLES|GCONV_PATH)$/u;

/**
 * Git configuration and environment controlled by the Supervisor, not by the
 * repository being inspected. The local repository config is still read for
 * ordinary facts such as remotes, but every setting which can execute a
 * command, redirect the repository, or make an inspection incomplete is pinned
 * on the command line or disabled below.
 *
 * Network confirmation deliberately keeps the operator's normal global Git
 * config so URL rewrites already in force are observed. Repository-local
 * command settings remain bounded by the command-line pins and remote lookups
 * use an explicit upload-pack.
 */
export function supervisorGitEnvironment(network = false): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = network
    ? { ...process.env }
    : workerEnvironment(process.env);
  for (const name of Object.keys(result)) {
    if (REPOSITORY_RELOCATING_GIT_VARIABLE.test(name) || UNSAFE_GIT_VARIABLE.test(name) || UNSAFE_GIT_EXECUTION_VARIABLE.test(name) || UNSAFE_LOADER_VARIABLE.test(name)) delete result[name];
  }
  result.GIT_TERMINAL_PROMPT = "0";
  // System configuration is never needed for a task boundary. Network URL
  // discovery is the exception only for the operator's default global file:
  // its pre-existing url.*.insteadOf rewrite must be recorded and pinned.
  result.GIT_CONFIG_NOSYSTEM = "1";
  if (!network) {
    result.GIT_CONFIG_GLOBAL = "/dev/null";
    result.GIT_CONFIG_SYSTEM = "/dev/null";
  }
  result.GIT_ATTR_NOSYSTEM = "1";
  result.GIT_OPTIONAL_LOCKS = "0";
  return result;
}

const SAFE_CONFIG = [
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.sshCommand=",
  "-c", "core.gitProxy=",
  "-c", "core.autocrlf=false",
  "-c", "core.eol=lf",
  "-c", "core.safecrlf=false",
  "-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab",
  "-c", "credential.helper=",
  "-c", "diff.external=",
] as const;

interface SupervisorGitArgOptions {
  diff?: boolean;
  additionalConfig?: readonly string[];
}

/** Arguments common to every Supervisor-owned, read-only Git invocation. */
export function supervisorGitArgs(args: readonly string[], options: SupervisorGitArgOptions = {}): string[] {
  const prefix = ["--no-pager", "--no-optional-locks", "--no-replace-objects", ...SAFE_CONFIG];
  for (const setting of options.additionalConfig ?? []) prefix.push("-c", setting);
  const command = args[0];
  if (!options.diff || command === undefined) return [...prefix, ...args];
  return [...prefix, command, "--no-ext-diff", "--no-textconv", "--text", ...args.slice(1)];
}

export interface SupervisorGitOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxBuffer?: number;
  network?: boolean;
  diff?: boolean;
  additionalConfig?: readonly string[];
  /** Ignore operator/Worker global Git config when a resolved URL is confirmed outside the repository. */
  isolateGlobalConfig?: boolean;
}

export async function supervisorGitCommandArgs(cwd: string, args: readonly string[], options: Pick<SupervisorGitOptions, "signal" | "timeout" | "diff" | "additionalConfig"> = {}): Promise<string[]> {
  const timeout = options.timeout ?? 30_000;
  const filterSettings = options.diff ? await localFilterSettings(cwd, options.signal, timeout) : [];
  return supervisorGitArgs(args, {
    diff: options.diff,
    additionalConfig: [...filterSettings, ...(options.additionalConfig ?? [])],
  });
}

export async function runSupervisorGit(cwd: string, args: readonly string[], options: SupervisorGitOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const timeout = options.timeout ?? 30_000;
  const maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
  const gitCommand = await trustedExecutablePath("git");
  const result = await execFileAsync(gitCommand, await supervisorGitCommandArgs(cwd, args, options), {
    cwd,
    timeout,
    maxBuffer,
    signal: options.signal,
    env: (() => {
      const environment = supervisorGitEnvironment(options.network === true);
      if (options.isolateGlobalConfig) {
        environment.GIT_CONFIG_GLOBAL = "/dev/null";
        environment.GIT_CONFIG_SYSTEM = "/dev/null";
      }
      return environment;
    })(),
    encoding: "buffer",
  });
  return { stdout: decodeUtf8(result.stdout), stderr: decodeUtf8(result.stderr) };
}

/**
 * A repository can attach a clean/smudge/process filter through .gitattributes.
 * `--no-textconv` does not disable those filters, so enumerate only the local
 * filter drivers and override every executable entry for the diff invocation.
 * The config query reads values; it never runs a filter.
 */
async function localFilterSettings(cwd: string, signal: AbortSignal | undefined, timeout: number): Promise<string[]> {
  let stdout = "";
  try {
    const gitCommand = await trustedExecutablePath("git");
    const result = await execFileAsync(gitCommand, [
      "--no-pager", "--no-optional-locks", "--no-replace-objects",
      "-c", "core.hooksPath=/dev/null",
      "config", "--local", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$",
    ], {
      cwd,
      timeout,
      maxBuffer: 256 * 1024,
      signal,
      env: supervisorGitEnvironment(false),
      encoding: "buffer",
    });
    stdout = decodeUtf8(result.stdout);
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: Buffer | string };
    // git config exits 1 when no key matches. Any other failure is an
    // inconclusive repository read and must not silently skip filter pins.
    if (failure.code !== 1) throw error;
    stdout = decodeUtf8(failure.stdout ?? Buffer.alloc(0));
  }
  const drivers = new Set<string>();
  for (const line of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const match = line.match(/^filter\.([A-Za-z0-9][A-Za-z0-9._-]*)\.(?:clean|smudge|process|required)$/u);
    if (!match) throw new Error("repository filter configuration could not be safely bounded");
    drivers.add(match[1]!);
  }
  if (drivers.size > 128) throw new Error("repository defines too many Git filter drivers to inspect safely");
  return [...drivers].flatMap((driver) => [
    `filter.${driver}.clean=`,
    `filter.${driver}.smudge=`,
    `filter.${driver}.process=`,
    `filter.${driver}.required=false`,
  ]);
}

function decodeUtf8(value: Buffer | string): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
