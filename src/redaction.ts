const sensitiveKeyPattern = /(password|secret|token|api[-_]?key|authorization|credential)/iu;
const MAX_REDACTION_DEPTH = 64;
const MAX_REDACTION_ENTRIES = 4_096;

/** Recursively redact credential-shaped values before persistence or model prompts. */
export function redactSensitive(value: unknown, key?: string, depth = 0): unknown {
  // A credential is a string; a number or boolean under a sensitive-looking
  // key (`totalTokens`, `contextTokens`, `maxTokens`) is a count, not a secret.
  if (key && sensitiveKeyPattern.test(key) && typeof value === "string") return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/\b(sk-ant-[A-Za-z0-9_-]+)\b/gu, "[REDACTED]")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{20,})\b/gu, "[REDACTED]")
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, "[REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
      .replace(/\b(Bearer\s+)[^\s]+/giu, "$1[REDACTED]")
      .replace(/\b((?:authorization)\s*:\s*(?:[A-Za-z]+\s+)?)[^\s,;)}\]]+/giu, "$1[REDACTED]")
      .replace(/\b((?:x-api-key|api[-_]?key|token|secret|password|credential)\s*[:=]\s*)(?:"[^"\n]{8,}"|'[^'\n]{8,}'|(?=[A-Za-z_.]*[0-9\-/+=]|[^\s]{20}|[A-Za-z_]{8,}(?![A-Za-z0-9_\-./+=]))[A-Za-z0-9_\-./+=]{8,})/giu, "$1[REDACTED]")
      .replace(/\b((?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|WEBHOOK(?:_URL)?)))=([^\s]+)/gu, "$1=[REDACTED]")
      .replace(/([?&](?:key|api[-_]?key|token|secret|password|authorization|credential)=)[^&#\s]+/giu, "$1[REDACTED]")
      .replace(/((?:["'])(?:password|secret|token|api[-_]?key|authorization|credential)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/giu, "$1\"[REDACTED]\"")
      .replace(/((?:https?|ssh|git):\/\/[^\s\/:@]+:)[^\s@\/]+@/giu, "$1[REDACTED]@")
      .replace(/((?:-u|--?(?:token|api[-_]?key|secret|password|authorization|user|username))(?:=|\s+))[^\s]+/giu, "$1[REDACTED]")
      .replace(/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[^-]*-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[^-]*-----/gu, "[REDACTED]");
  }
  if (depth >= MAX_REDACTION_DEPTH) return "[REDACTED_DEPTH]";
  if (Array.isArray(value)) {
    const entries = value.slice(0, MAX_REDACTION_ENTRIES).map((item) => redactSensitive(item, key, depth + 1));
    if (value.length > MAX_REDACTION_ENTRIES) entries.push("[REDACTED_ENTRIES]");
    return entries;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const bounded = entries.slice(0, MAX_REDACTION_ENTRIES).map(([childKey, childValue]) => [childKey, redactSensitive(childValue, childKey, depth + 1)] as const);
    if (entries.length > MAX_REDACTION_ENTRIES) bounded.push(["[REDACTED_ENTRIES]", "[REDACTED_ENTRIES]"]);
    return Object.fromEntries(bounded);
  }
  return value;
}
