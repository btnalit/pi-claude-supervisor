const sensitiveKeyPattern = /(password|secret|token|api[-_]?key|authorization|credential)/iu;

/** Recursively redact credential-shaped values before persistence or model prompts. */
export function redactSensitive(value: unknown, key?: string): unknown {
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
      .replace(/\b((?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)))=([^\s]+)/gu, "$1=[REDACTED]")
      .replace(/(--?(?:token|api[-_]?key|secret|password|authorization)(?:=|\s+))[^\s]+/giu, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactSensitive(childValue, childKey)]));
  return value;
}
