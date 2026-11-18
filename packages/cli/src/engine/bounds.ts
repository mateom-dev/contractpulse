/**
 * Bounded parsing: structural limits checked before and after `JSON.parse`, so a
 * hostile or accidental contract cannot exhaust the stack or memory of the engine.
 */

export interface ParseLimits {
  /** Deepest allowed nesting of objects and arrays. */
  readonly maxDepth: number;
  /** Total number of JSON values (objects, arrays and scalars). */
  readonly maxNodes: number;
  /** Longest allowed string value or object key, in UTF-16 code units. */
  readonly maxStringLength: number;
  /** Longest chain of `$ref` → `$ref` hops followed when resolving one reference. */
  readonly maxRefHops: number;
}

export const DEFAULT_LIMITS: ParseLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxStringLength: 64 * 1024,
  maxRefHops: 32,
});

export type LimitName = "depth" | "nodes" | "string-length";

export class LimitExceededError extends Error {
  constructor(
    readonly limit: LimitName,
    readonly max: number,
    /** JSON Pointer of the offending value, or a character offset for the text pre-scan. */
    readonly at: string,
  ) {
    super(`${limit} limit of ${max} exceeded at ${at}`);
    this.name = "LimitExceededError";
  }
}

/**
 * Scan raw JSON text for nesting depth without building any values.
 * Runs before `JSON.parse` so deeply nested input is rejected cheaply.
 * Malformed text is left for `JSON.parse` to report.
 */
export function checkTextDepth(text: string, maxDepth: number): void {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c /* \ */) i += 1;
      else if (ch === 0x22 /* " */) inString = false;
      continue;
    }
    if (ch === 0x22) {
      inString = true;
    } else if (ch === 0x7b /* { */ || ch === 0x5b /* [ */) {
      depth += 1;
      if (depth > maxDepth) throw new LimitExceededError("depth", maxDepth, `offset ${i}`);
    } else if (ch === 0x7d /* } */ || ch === 0x5d /* ] */) {
      depth -= 1;
    }
  }
}

export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Walk a parsed document iteratively (no recursion) and enforce node-count,
 * depth and string-length limits. Returns the number of nodes visited.
 */
export function checkDocumentBounds(document: unknown, limits: ParseLimits = DEFAULT_LIMITS): number {
  const stack: Array<{ value: unknown; pointer: string; depth: number }> = [
    { value: document, pointer: "", depth: 0 },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const { value, pointer, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxNodes) throw new LimitExceededError("nodes", limits.maxNodes, pointer || "/");

    if (typeof value === "string") {
      if (value.length > limits.maxStringLength) {
        throw new LimitExceededError("string-length", limits.maxStringLength, pointer || "/");
      }
      continue;
    }
    if (typeof value !== "object" || value === null) continue;

    if (depth + 1 > limits.maxDepth) throw new LimitExceededError("depth", limits.maxDepth, pointer || "/");

    if (Array.isArray(value)) {
      value.forEach((item, index) => stack.push({ value: item, pointer: `${pointer}/${index}`, depth: depth + 1 }));
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      const childPointer = `${pointer}/${escapePointerToken(key)}`;
      if (key.length > limits.maxStringLength) {
        throw new LimitExceededError("string-length", limits.maxStringLength, childPointer);
      }
      stack.push({ value: item, pointer: childPointer, depth: depth + 1 });
    }
  }
  return nodes;
}
