/**
 * Rules `field.added.optional`, `field.added.required`, `required.added` and
 * `required.removed`, read from each object schema's `properties` and
 * `required` keywords.
 *
 * A property is "added" when its name is in the new `properties` but neither in
 * the old `properties` nor in the old `required`. Any other name whose
 * membership in `required` changed is a requiredness change, including names
 * whose property was removed (reported next to `field.removed`).
 */
import type { Direction, Finding, Verdict } from "./finding.js";
import { allowsObject } from "./field-removal.js";
import { child, type SchemaPair } from "./walk.js";

type RequirednessRule = "field.added.optional" | "field.added.required" | "required.added" | "required.removed";

const VERDICTS: Record<RequirednessRule, Record<Direction, Verdict>> = {
  "field.added.optional": { request: "SAFE", response: "SAFE" },
  // The producer now rejects requests without it; consumers always receive it.
  "field.added.required": { request: "BREAKING", response: "SAFE" },
  "required.added": { request: "BREAKING", response: "SAFE" },
  // The producer accepts more requests; consumers may stop receiving it.
  "required.removed": { request: "SAFE", response: "BREAKING" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNames(schema: Record<string, unknown>): Set<string> {
  const raw = schema["required"];
  return new Set(Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : []);
}

function propertyNames(schema: Record<string, unknown>): Set<string> {
  const raw = schema["properties"];
  return new Set(isRecord(raw) ? Object.keys(raw) : []);
}

/** Pointer of the property if the schema defines it, otherwise of the schema's `required` keyword. */
function pointerFor(base: string, properties: Set<string>, name: string): string {
  return properties.has(name) ? child(base, "properties", name) : child(base, "required");
}

function addedMessage(rule: RequirednessRule, name: string, pair: SchemaPair): string {
  if (rule === "field.added.required") {
    return pair.direction === "request"
      ? `required property ${name} added; requests without it are now rejected`
      : `required property ${name} added; consumers always receive it`;
  }
  if (pair.direction === "response" && pair.oldSchema["additionalProperties"] === false) {
    return `optional property ${name} added; the old schema set additionalProperties to false, so consumers that validate strictly may reject it`;
  }
  return pair.direction === "request"
    ? `optional property ${name} added; existing requests are unaffected`
    : `optional property ${name} added; consumers that ignore unknown properties are unaffected`;
}

const REQUIREDNESS_MESSAGES: Record<"required.added" | "required.removed", Record<Direction, string>> = {
  "required.added": {
    request: "is now required; requests without it are rejected",
    response: "is now required; consumers always receive it",
  },
  "required.removed": {
    request: "is no longer required; the producer accepts requests without it",
    response: "is no longer required; consumers may stop receiving it",
  },
};

export function requirednessRule(pair: SchemaPair): Finding[] {
  // A type change away from `object` is already reported by the type rules.
  if (!allowsObject(pair.oldSchema) || !allowsObject(pair.newSchema)) return [];

  const oldProperties = propertyNames(pair.oldSchema);
  const newProperties = propertyNames(pair.newSchema);
  const oldRequired = requiredNames(pair.oldSchema);
  const newRequired = requiredNames(pair.newSchema);
  const newPropertySchemas = pair.newSchema["properties"];

  const names = [...new Set([...oldProperties, ...newProperties, ...oldRequired, ...newRequired])].sort();
  const findings: Finding[] = [];
  for (const name of names) {
    const oldPointer = pointerFor(pair.oldPointer, oldProperties, name);
    const newPointer = pointerFor(pair.newPointer, newProperties, name);

    if (newProperties.has(name) && !oldProperties.has(name) && !oldRequired.has(name)) {
      const rule: RequirednessRule = newRequired.has(name) ? "field.added.required" : "field.added.optional";
      findings.push({
        rule,
        verdict: VERDICTS[rule][pair.direction],
        direction: pair.direction,
        oldPointer: child(pair.oldPointer, "properties", name),
        newPointer,
        oldValue: null,
        newValue: isRecord(newPropertySchemas) ? (newPropertySchemas[name] ?? null) : null,
        message: addedMessage(rule, name, pair),
      });
      continue;
    }

    const wasRequired = oldRequired.has(name);
    const isRequired = newRequired.has(name);
    if (wasRequired === isRequired) continue;
    const rule = isRequired ? "required.added" : "required.removed";
    findings.push({
      rule,
      verdict: VERDICTS[rule][pair.direction],
      direction: pair.direction,
      oldPointer,
      // A removed property is reported at the same pointer as its `field.removed` finding.
      newPointer: oldProperties.has(name) && !newProperties.has(name) ? child(pair.newPointer, "properties", name) : newPointer,
      oldValue: wasRequired,
      newValue: isRequired,
      message: `property ${name} ${REQUIREDNESS_MESSAGES[rule][pair.direction]}`,
    });
  }
  return findings;
}
