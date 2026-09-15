import { readdir, readFile, readlink } from "node:fs/promises";

export interface ProcessTreeEntry {
  pid: number;
  ppid: number;
  startTime: string;
  command: string;
  executable: string;
  argv0: string;
  commandLine: string;
  /** Raw argv when read from Linux /proc; test fixtures may omit it. */
  argv?: string[];
}

export async function linuxCgroupProcesses(cgroupPath: string): Promise<ProcessTreeEntry[]> {
  if (process.platform !== "linux") return [];
  const contents = await readFile(`${cgroupPath}/cgroup.procs`, "utf8");
  const pids = [...new Set(contents.split(/\s+/u).filter(Boolean).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const entries = await Promise.all(pids.map((pid) => readProcess(pid)));
  if (entries.some((entry) => !entry)) throw new Error("cgroup process identity could not be inspected");
  return entries as ProcessTreeEntry[];
}

export async function linuxProcessTree(rootPid: number): Promise<ProcessTreeEntry[]> {
  if (process.platform !== "linux" || !Number.isInteger(rootPid) || rootPid <= 0) return [];
  let names: string[];
  try { names = await readdir("/proc"); }
  catch (error) { throw new Error(`Linux process inspection is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const entries = (await Promise.all(names.filter((name) => /^\d+$/u.test(name)).map((name) => readProcess(Number(name))))).filter((entry): entry is ProcessTreeEntry => Boolean(entry));
  if (!entries.some((entry) => entry.pid === rootPid)) throw new Error(`Linux worker process ${rootPid} could not be inspected`);
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  return entries.filter((entry) => entry.pid === rootPid || isDescendant(entry, rootPid, byPid));
}

export function isClaudeProcess(entry: ProcessTreeEntry, expectedCommand?: string): boolean {
  if (expectedCommand && expectedCommandInvocation(entry, expectedCommand)) return true;
  const executableName = basename(entry.executable);
  const commandName = basename(entry.command);
  const isClaudeNamed = executableName === "claude" || executableName === "claude.exe" || commandName === "claude" || commandName === "claude.exe";
  if (!isClaudeNamed) return false;
  const argv0 = basename(entry.argv0);
  return argv0 === "claude" || argv0 === "claude.exe" || basename(entry.commandLine.split(/\s+/u)[0] ?? "") === "claude" || basename(entry.commandLine.split(/\s+/u)[0] ?? "") === "claude.exe";
}

export function isClaudeLauncherProcess(entry: ProcessTreeEntry): boolean {
  if (isClaudeProcess(entry)) return true;
  return commandInvocationCandidates(entry.commandLine, entry.argv).some((value) => {
    const name = basename(value);
    return name === "claude" || name === "claude.exe";
  });
}

export function unexpectedReviewerProcess(entries: readonly ProcessTreeEntry[]): ProcessTreeEntry | undefined {
  const pattern = /(?:^|[\\/_ .-])(?:review(?:er)?|code[-_ ]?review|read[-_ ]?only[-_ ]?review|independent[-_ ]?review|codex|cursor(?:-agent)?|aider|opencode|gemini)(?:$|[\\/_. -])/iu;
  return entries.find((entry) => {
    const tokens = entry.commandLine.split(/\s+/u).map((token) => token.replace(/^['"]|['"]$/gu, ""));
    const candidates: Array<string | undefined> = [entry.argv0, entry.executable, entry.command, tokens[0], tokens[1]];
    if (tokens[1] === "-c" || tokens[1] === "--command") candidates.push(tokens[2]);
    if (basename(tokens[0] ?? "") === "env") candidates.push(tokens.find((token) => !token.startsWith("-") && !token.includes("=") && token !== tokens[0]));
    return candidates.some((value) => typeof value === "string" && pattern.test(value));
  });
}

export function sameProcessIdentity(expected: ProcessTreeEntry, current: ProcessTreeEntry): boolean {
  return expected.pid === current.pid
    && expected.startTime === current.startTime
    && expected.executable === current.executable
    && expected.argv0 === current.argv0;
}

export function unexpectedClaudeProcess(entries: readonly ProcessTreeEntry[], trusted: ReadonlyMap<number, ProcessTreeEntry>, expectedCommand?: string): ProcessTreeEntry | undefined {
  for (const entry of entries) {
    if (!isClaudeProcess(entry, expectedCommand)) continue;
    const original = trusted.get(entry.pid);
    if (!original || !sameProcessIdentity(original, entry)) return entry;
  }
  return undefined;
}

export async function readProcess(pid: number): Promise<ProcessTreeEntry | undefined> {
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = statText.slice(closeParen + 2).trim().split(/\s+/u);
    const ppid = Number(fields[1]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(ppid) || !startTime) return undefined;
    const command = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
    const rawCommandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const argv = rawCommandLine.split("\u0000").filter((argument) => argument.length > 0);
    const argv0 = argv[0] ?? "";
    const commandLine = argv.join(" ").trim();
    let executable = command;
    try { executable = await readlink(`/proc/${pid}/exe`); }
    catch { /* exited or permission-restricted processes fall back to comm */ }
    return { pid, ppid, startTime, command, executable, argv0, commandLine, argv };
  } catch {
    return undefined;
  }
}

function basename(value: string): string {
  return value.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
}

function expectedCommandInvocation(entry: ProcessTreeEntry, expectedCommand: string): boolean {
  const expected = expectedCommand.trim();
  if (!expected) return false;
  const expectedBase = basename(expected);
  const expectedAbsolute = expected.includes("/") || expected.includes("\\");
  const argv0 = entry.argv0.trim();
  if (argv0 === expected || (!expectedAbsolute && basename(argv0) === expectedBase)) return true;
  return commandInvocationCandidates(entry.commandLine, entry.argv).some((value) => expectedAbsolute ? value === expected : basename(value) === expectedBase);
}

function commandInvocationCandidates(commandLine: string, argv?: readonly string[]): string[] {
  const tokens = (argv && argv.length > 0 ? [...argv] : commandLine.split(/\s+/u)).map((token) => token.replace(/^['"]|['"]$/gu, ""));
  if (tokens.length === 0) return [];
  const candidates = [tokens[0]!];
  let index = 0;
  let launcher = basename(tokens[0]!);
  if (launcher === "env") {
    index = envCommandIndex(tokens, 1);
    if (index >= tokens.length) return candidates;
    launcher = basename(tokens[index]!);
    candidates.push(tokens[index]!);
  }
  const shells = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh", "mksh", "csh", "tcsh"]);
  const wrappers = new Set(["node", "nodejs", "deno", "bun", ...shells]);
  if (!wrappers.has(launcher)) return candidates;
  let argument = index + 1;
  if (shells.has(launcher)) {
    argument = shellCommandIndex(tokens, argument);
  } else {
    argument = nodeScriptIndex(tokens, argument);
  }
  if (argument < tokens.length) {
    candidates.push(tokens[argument]!);
    const commandWords = tokens[argument]!.trim().split(/\s+/u);
    if (commandWords.length > 1 && (commandWords[0] === "exec" || commandWords[0] === "command")) candidates.push(commandWords[1]!);
  }
  return candidates;
}

function envCommandIndex(tokens: readonly string[], start: number): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") return index + 1;
    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir" || token === "-S" || token === "--split-string") {
      index += 2;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--chdir=")) {
      index += 1;
      continue;
    }
    if (token.startsWith("-") || token.includes("=")) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

function shellCommandIndex(tokens: readonly string[], start: number): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "-c" || token === "--command") return index + 1;
    if (token === "-O" || token === "--rcfile" || token === "--init-file") {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

function nodeScriptIndex(tokens: readonly string[], start: number): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") return index + 1;
    if (token === "-e" || token === "--eval" || token === "-p" || token === "--print") return tokens.length;
    if (token === "-r" || token === "--require" || token === "--loader" || token === "--experimental-loader" || token === "--import" || token === "--conditions" || token === "--title" || token === "--watch-path" || token === "--test-name-pattern" || token === "--test-reporter" || token === "--test-reporter-destination" || token === "--env-file") {
      index += 2;
      continue;
    }
    if (token.startsWith("--require=") || token.startsWith("--loader=") || token.startsWith("--experimental-loader=") || token.startsWith("--import=") || token.startsWith("--conditions=") || token.startsWith("--title=") || token.startsWith("--watch-path=") || token.startsWith("--test-name-pattern=") || token.startsWith("--test-reporter=") || token.startsWith("--test-reporter-destination=") || token.startsWith("--env-file=")) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

function isDescendant(entry: ProcessTreeEntry, rootPid: number, byPid: ReadonlyMap<number, ProcessTreeEntry>): boolean {
  let parent = entry.ppid;
  for (let depth = 0; depth < 64 && parent > 0; depth += 1) {
    if (parent === rootPid) return true;
    const ancestor = byPid.get(parent);
    if (!ancestor || ancestor.ppid === parent) return false;
    parent = ancestor.ppid;
  }
  return false;
}
