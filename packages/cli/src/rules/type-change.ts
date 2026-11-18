/**
 * Rules `type.changed`, `type.widened` and `type.narrowed`.
 *
 * A schema's type set is its `type` keyword (string or array), plus `null` when
 * the OpenAPI 3.0 `nullable: true` is set. `integer` is a subset of `number`.
 * A schema without `type` accepts every type.
 */
import type { Direction, Finding, Verdict } from "./finding.js";
import type { SchemaPair } from "./walk.js";

type TypeRule = "type.changed" | "type.widened" | "type.narrowed";

const VERDICTS: Record<TypeRule, Record<Direction, Verdict>> = {
  "type.changed": { request: "BREAKING", response: "BREAKING" },
  // Readers of a request (the producer) still accept everything they did; readers
  // of a response (consumers) may now receive a type they never handled.
  "type.widened": { request: "SAFE", response: "BREAKING" },
  "type.narrowed": { request: "BREAKING", response: "SAFE" },
};

/** Effective type set, or `undefined` when the schema does not constrain the type. */
export function effectiveTypes(schema: Record<string, unknown>): Set<string> | undefined {
  const raw = schema["type"];
  let types: Set<string>;
  if (typeof raw === "string") {
    types = new Set([raw]);
  } else if (Array.isArray(raw) && raw.length > 0 && raw.every((item) => typeof item === "string")) {
    types = new Set(raw as string[]);
  } else {
    return undefined;
  }
  if (schema["nullable"] === true) types.add("null");
  return types;
}

function covers(types: Set<string> | undefined, type: string): boolean {
  if (types === undefined) return true;
  return types.has(type) || (type === "integer" && types.has("number"));
}

/** True when every value of a type in `inner` is also accepted by `outer`. */
function isSubset(inner: Set<string> | undefined, outer: Set<string> | undefined): boolean {
  if (inner === undefined) return outer === undefined;
  return [...inner].every((type) => covers(outer, type));
}

function describe(types: Set<string> | undefined): string {
  return types === undefined ? "any type" : [...types].sort().join(" | ");
}

function asValue(types: Set<string> | undefined): string[] | null {
  return types === undefined ? null : [...types].sort();
}

export function typeChangeRule(pair: SchemaPair): Finding[] {
  const before = effectiveTypes(pair.oldSchema);
  const after = effectiveTypes(pair.newSchema);
  const widened = isSubset(before, after);
  const narrowed = isSubset(after, before);
  if (widened && narrowed) return [];

  const rule: TypeRule = widened ? "type.widened" : narrowed ? "type.narrowed" : "type.changed";
  const verb = widened ? "widened" : narrowed ? "narrowed" : "changed";
  return [
    {
      rule,
      verdict: VERDICTS[rule][pair.direction],
      direction: pair.direction,
      oldPointer: pair.oldPointer,
      newPointer: pair.newPointer,
      oldValue: asValue(before),
      newValue: asValue(after),
      message: `type ${verb} from ${describe(before)} to ${describe(after)}`,
    },
  ];
}
