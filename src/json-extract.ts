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
      offset = start + 1;
      continue;
    }
    const candidate = text.slice(start, end + 1);
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) objects.push(value);
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
