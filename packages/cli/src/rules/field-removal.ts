/**
 * Rule `field.removed`: a property listed under `properties` in the old schema
 * is gone from the new one.
 *
 * Response / event: BREAKING, consumers may still read the field.
 * Request: the producer no longer reads the field, so clients that keep sending
 * it are only affected if the new schema stops accepting unknown properties:
 * `additionalProperties: false` is BREAKING, a schema-valued
 * `additionalProperties` (the field's values are now checked against it) is
 * UNKNOWN, anything else is SAFE.
 */
import { child, type SchemaPair } from "./walk.js";
import type { Finding, Verdict } from "./finding.js";
import { effectiveTypes } from "./type-change.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the schema may describe an object (no `type`, or a type set containing `object`). */
function allowsObject(schema: Record<string, unknown>): boolean {
  const types = effectiveTypes(schema);
  return types === undefined || types.has("object");
}

/** Verdict and reason for a property removed from a request schema. */
function requestVerdict(newSchema: Record<string, unknown>): { verdict: Verdict; reason: string } {
  const additional = newSchema["additionalProperties"];
  if (additional === false) {
    return { verdict: "BREAKING", reason: "additionalProperties is false, so clients that still send it are rejected" };
  }
  if (isRecord(additional) && Object.keys(additional).length > 0) {
    return {
      verdict: "UNKNOWN",
      reason: "values clients still send are now checked against additionalProperties",
    };
  }
  return { verdict: "SAFE", reason: "the producer ignores it if clients still send it" };
}

export function fieldRemovalRule(pair: SchemaPair): Finding[] {
  const oldProperties = pair.oldSchema["properties"];
  if (!isRecord(oldProperties)) return [];
  // A type change away from `object` is already reported by the type rules.
  if (!allowsObject(pair.oldSchema) || !allowsObject(pair.newSchema)) return [];

  const newProperties = pair.newSchema["properties"];
  const removed = Object.keys(oldProperties)
    .filter((name) => !(isRecord(newProperties) && Object.hasOwn(newProperties, name)))
    .sort();
  if (removed.length === 0) return [];

  const { verdict, reason } =
    pair.direction === "request"
      ? requestVerdict(pair.newSchema)
      : { verdict: "BREAKING" as const, reason: "consumers may still read it" };

  return removed.map((name): Finding => ({
    rule: "field.removed",
    verdict,
    direction: pair.direction,
    oldPointer: child(pair.oldPointer, "properties", name),
    newPointer: child(pair.newPointer, "properties", name),
    oldValue: oldProperties[name] ?? null,
    newValue: null,
    message: `property ${name} removed; ${reason}`,
  }));
}
