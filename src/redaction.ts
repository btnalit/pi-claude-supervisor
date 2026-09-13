const sensitiveKeyPattern = /(password|secret|token|api[-_]?key|authorization|credential)/iu;

/** Recursively redact credential-shaped values before persistence or model prompts. */
export function redactSensitive(value: unknown, key?: string): unknown {
  if (key && sensitiveKeyPattern.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/\b(sk-ant-[A-Za-z0-9_-]+)\b/gu, "[REDACTED]")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{20,})\b/gu, "[REDACTED]")
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, "[REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
      .replace(/\b(Bearer\s+)[^\s]+/giu, "$1[REDACTED]")
      .replace(/\b((?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)))=([^\s]+)/gu, "$1=[REDACTED]")
      .replace(/\b((?:authorization|x-api-key|api-key)\s*:\s*)[^\s]+/giu, "$1[REDACTED]")
      .replace(/(--?(?:token|api[-_]?key|secret|password|authorization)(?:=|\s+))[^\s]+/giu, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactSensitive(childValue, childKey)]));
  return value;
}
