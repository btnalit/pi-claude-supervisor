/**
 * Claude occasionally wraps its answer in a fence, a sentence, or repeats
 * the same JSON object. Extract one bounded object while rejecting conflicting
 * objects: prose is harmless, but ambiguity must remain non-publishable.
 */
export function extractJsonObjects(text: string): unknown[] {
  const objects: unknown[] = [];
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf("{", offset);
    if (start < 0) break;
    const end = balancedObjectEnd(text, start);
    if (end < 0) {
      // No later opening brace can be promoted safely without first resolving
      // this unbalanced candidate; stop rather than rescanning the suffix for
      // every `{` (which made malformed input quadratic).
      break;
    }
    const candidate = text.slice(start, end + 1);
    const value = parseJsonObjectStrict(candidate);
    if (value !== undefined && value && typeof value === "object" && !Array.isArray(value)) objects.push(value);
    // Whether parsing succeeded or failed, this balanced range is one
    // candidate. Never rescan its interior: a malformed outer object must not
    // promote an attacker-controlled nested pass/allow object into a verdict.
    offset = end + 1;
  }
  return objects;
}

function parseJsonObjectStrict(text: string): unknown | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    let offset = 0;
    scanValue(0);
    if (offset !== text.length) return undefined;
    return value;

    function scanValue(depth: number): void {
      if (depth > 100) throw new Error("JSON nesting limit exceeded");
      skipWhitespace();
      const character = text[offset];
      if (character === '"') { scanString(); return; }
      if (character === "{") { scanObject(depth + 1); return; }
      if (character === "[") { scanArray(depth + 1); return; }
      const start = offset;
      while (offset < text.length && !/[,}\]\s]/u.test(text[offset]!)) offset += 1;
      if (start === offset) throw new Error("invalid JSON value");
    }

    function scanObject(depth: number): void {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") { offset += 1; return; }
      while (offset < text.length) {
        skipWhitespace();
        const key = scanString();
        if (keys.has(key)) throw new Error("duplicate JSON object key");
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") throw new Error("missing JSON object colon");
        offset += 1;
        scanValue(depth);
        skipWhitespace();
        if (text[offset] === "}") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("missing JSON object comma");
        offset += 1;
      }
      throw new Error("unterminated JSON object");
    }

    function scanArray(depth: number): void {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") { offset += 1; return; }
      while (offset < text.length) {
        scanValue(depth);
        skipWhitespace();
        if (text[offset] === "]") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("missing JSON array comma");
        offset += 1;
      }
      throw new Error("unterminated JSON array");
    }

    function scanString(): string {
      const start = offset;
      if (text[offset] !== '"') throw new Error("expected JSON string");
      offset += 1;
      let escaped = false;
      while (offset < text.length) {
        const character = text[offset]!;
        offset += 1;
        if (escaped) { escaped = false; continue; }
        if (character === "\\") { escaped = true; continue; }
        if (character === '"') return JSON.parse(text.slice(start, offset)) as string;
      }
      throw new Error("unterminated JSON string");
    }

    function skipWhitespace(): void {
      while (offset < text.length && /\s/u.test(text[offset]!)) offset += 1;
    }
  } catch {
    return undefined;
  }
}

export function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}
