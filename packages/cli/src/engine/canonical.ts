/**
 * Canonical form and content hash of a contract document.
 *
 * Two files that describe the same contract hash the same, whatever their
 * whitespace, key order or the order of set-like keyword arrays. Anything that
 * could change meaning (array order of `allOf`, `parameters`, examples, …) is kept.
 */
import { createHash } from "node:crypto";

/**
 * Schema keywords whose array value is a set: order and duplicates carry no
 * meaning. Only arrays of strings are treated this way, so the OpenAPI boolean
 * `required` on parameters is untouched.
 */
const STRING_SET_KEYWORDS = new Set(["required", "type"]);

/** Keywords whose value is a set of JSON literals, sorted by canonical text. */
const LITERAL_SET_KEYWORDS = new Set(["enum"]);

/**
 * Keywords whose value is example or literal data, not schema. Their contents
 * are canonicalized (key order only) but never re-ordered as sets.
 */
const LITERAL_KEYWORDS = new Set(["example", "examples", "default", "const", "enum"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compare by UTF-16 code units, the order JCS (RFC 8785) uses for object keys. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Return a canonical copy of `value`: object keys sorted, set-like keyword
 * arrays sorted and de-duplicated. Inside example/default/const/enum values and
 * `x-` extensions only key order is normalized. Depth is already bounded by
 * `checkDocumentBounds`, so plain recursion is safe here.
 */
export function canonicalize(value: unknown, literal = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, literal));
  }
  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const item = value[key];
    const childLiteral = literal || LITERAL_KEYWORDS.has(key) || key.startsWith("x-");

    if (!literal && STRING_SET_KEYWORDS.has(key) && isStringArray(item)) {
      result[key] = [...new Set(item)].sort(compareCodeUnits);
    } else if (!literal && LITERAL_SET_KEYWORDS.has(key) && Array.isArray(item)) {
      result[key] = sortedUniqueLiterals(item);
    } else {
      result[key] = canonicalize(item, childLiteral);
    }
  }
  return result;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sortedUniqueLiterals(items: readonly unknown[]): unknown[] {
  const byText = new Map<string, unknown>();
  for (const item of items) {
    const canonical = canonicalize(item, true);
    byText.set(JSON.stringify(canonical), canonical);
  }
  return [...byText.keys()].sort(compareCodeUnits).map((text) => byText.get(text));
}

/**
 * Serialize the canonical form with no insignificant whitespace. Numbers and
 * strings use the ECMAScript serialization, which matches RFC 8785 for the
 * values `JSON.parse` can produce.
 */
export function canonicalJson(document: unknown): string {
  return JSON.stringify(canonicalize(document));
}

/** Content hash of a contract: `sha256:` followed by 64 lowercase hex digits. */
export function contractHash(document: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(document), "utf8").digest("hex")}`;
}
