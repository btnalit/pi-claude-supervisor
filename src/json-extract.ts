/**
 * Claude occasionally wraps its answer in a fence, a sentence, or repeats
 * the same JSON object. Extract one bounded object while rejecting conflicting
 * objects: prose is harmless, but ambiguity must remain non-publishable.
 */
export function extractJsonObjects(text: string): unknown[] {
  return extractJsonObjectSpans(text).map((span) => span.value);
}

/** The same objects, each with the exact source text it was parsed from. */
export function extractJsonObjectSpans(text: string): Array<{ value: unknown; source: string }> {
  const objects: Array<{ value: unknown; source: string }> = [];
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf("{", offset);
    if (start < 0) break;
    const end = balancedObjectEnd(text, start);
    if (end < 0) {
      offset = start + 1;
      continue;
    }
    const candidate = text.slice(start, end + 1);
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) objects.push({ value, source: candidate });
      offset = end + 1;
    } catch {
      offset = start + 1;
    }
  }
  return objects;
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

/**
 * True when any object in this (already valid) JSON text names a key twice.
 * `JSON.parse` silently keeps the last value, so a duplicate is how text
 * spliced into a string can override a field it was never meant to touch.
 * Keys are compared decoded, so `"\u0076erdict"` duplicates `"verdict"`.
 */
export function jsonHasDuplicateKeys(json: string): boolean {
  const scopes: Array<Set<string> | undefined> = [];
  let index = 0;
  while (index < json.length) {
    const character = json[index];
    if (character === '"') {
      let end = index + 1;
      while (end < json.length && json[end] !== '"') end += json[end] === "\\" ? 2 : 1;
      const token = json.slice(index, end + 1);
      index = end + 1;
      let next = index;
      while (next < json.length && /\s/u.test(json[next]!)) next += 1;
      const scope = scopes.at(-1);
      if (json[next] === ":" && scope) {
        const key = JSON.parse(token) as string;
        if (scope.has(key)) return true;
        scope.add(key);
      }
      continue;
    }
    if (character === "{") scopes.push(new Set());
    else if (character === "[") scopes.push(undefined);
    else if (character === "}" || character === "]") scopes.pop();
    index += 1;
  }
  return false;
}
