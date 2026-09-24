const sensitiveKeyPattern = /(password|secret|token|api[-_]?key|authorization|credential)/iu;

/** Recursively redact credential-shaped values before persistence or model prompts. */
export function redactSensitive(value: unknown, key?: string): unknown {
  // A credential is a string; a number or boolean under a sensitive-looking
  // key (`totalTokens`, `contextTokens`, `maxTokens`) is a count, not a secret.
  if (key && sensitiveKeyPattern.test(key) && typeof value === "string") return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/\b(sk-ant-[A-Za-z0-9_-]+)\b/gu, "[REDACTED]")
      // sk- and Google API keys, matched by their real shapes so that names
      // merely starting with "sk-" (a branch sk-1234_fix_login, a path
      // .../sk-dataset_2024_v2, a CSS class) stay intact: session records and
      // transcript paths are rejected when redaction changes them.
      // OpenAI keys (legacy, proj, svcacct, admin) all carry T3BlbkFJ, base64
      // for "OpenAI"; their base64url bodies may contain - and _.
      .replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]*T3BlbkFJ[A-Za-z0-9_-]*/gu, "[REDACTED]")
      // OpenRouter: sk-or-v1- and 64 hex digits.
      .replace(/(?<![A-Za-z0-9_-])sk-or-v1-[0-9a-f]{64}(?![A-Za-z0-9_-])/gu, "[REDACTED]")
      // Other sk- providers (DeepSeek, Moonshot, …): 32+ letters and digits,
      // with both. Accepted cost: a name that is exactly sk- and such a run
      // (sk-<git sha>) cannot be told from a DeepSeek key and is redacted.
      .replace(/(?<![A-Za-z0-9_-])sk-(?=[A-Za-z]*[0-9])(?=[0-9]*[A-Za-z])[A-Za-z0-9]{32,}(?![A-Za-z0-9_-])/gu, "[REDACTED]")
      .replace(/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/gu, "[REDACTED]")
      .replace(/(?<![A-Za-z0-9_-])AQ\.[A-Za-z0-9_-]{40,}/gu, "[REDACTED]")
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
