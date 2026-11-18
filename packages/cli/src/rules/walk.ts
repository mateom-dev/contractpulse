/**
 * Pairs up the schemas of two contract versions and runs the schema rules on
 * every pair, descending through `properties`, `items` and schema-valued
 * `additionalProperties`. Local `$ref`s are followed; anything the engine cannot
 * decide yet is reported as a `schema.unsupported` UNKNOWN finding.
 */
import { escapePointerToken } from "../engine/bounds.js";
import { canonicalJson } from "../engine/canonical.js";
import { getAtPointer, resolveRef } from "../engine/refs.js";
import type { Direction, Finding } from "./finding.js";

export interface SchemaPair {
  readonly direction: Direction;
  readonly oldPointer: string;
  readonly newPointer: string;
  readonly oldSchema: Record<string, unknown>;
  readonly newSchema: Record<string, unknown>;
}

export type SchemaRule = (pair: SchemaPair) => Finding[];

/** Where to start walking: a schema position present in both versions. */
export interface SchemaRoot {
  readonly direction: Direction;
  readonly oldPointer: string;
  readonly newPointer: string;
}

/** Keywords whose meaning the rules do not model yet (docs/rule-scope.md). */
const UNSUPPORTED_KEYWORDS = [
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "discriminator",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
  "prefixItems",
  "contains",
] as const;

/** Value constraints that are reported as UNKNOWN when they change. */
const CONSTRAINT_KEYWORDS = [
  "enum",
  "const",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
] as const;

/** Siblings of `$ref` that do not change what the schema accepts. */
const ANNOTATION_KEYWORDS = new Set(["$ref", "description", "summary", "title", "$comment"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function containsRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRef);
  if (!isRecord(value)) return false;
  return typeof value["$ref"] === "string" || Object.values(value).some(containsRef);
}

export const child = (pointer: string, ...tokens: string[]): string =>
  tokens.reduce((current, token) => `${current}/${escapePointerToken(token)}`, pointer);

interface ResolvedSchema {
  readonly pointer: string;
  readonly value: unknown;
  /** Set when the value is a `$ref` the walker will not follow. */
  readonly unresolved?: string;
}

/** Follow a local `$ref` at `pointer`, if there is one. */
export function resolveAt(document: unknown, pointer: string): ResolvedSchema {
  const value = getAtPointer(document, pointer);
  if (!isRecord(value) || typeof value["$ref"] !== "string") return { pointer, value };

  const ref = value["$ref"];
  if (Object.keys(value).some((key) => !ANNOTATION_KEYWORDS.has(key))) {
    return { pointer, value, unresolved: `$ref ${ref} has sibling keywords` };
  }
  const resolved = resolveRef(document, ref);
  if (resolved.status !== "local" || resolved.target === undefined) {
    return { pointer, value, unresolved: `$ref ${ref} is ${resolved.status}` };
  }
  return { pointer: resolved.target, value: getAtPointer(document, resolved.target) };
}

interface WalkContext {
  readonly oldDocument: unknown;
  readonly newDocument: unknown;
  readonly rules: readonly SchemaRule[];
  readonly findings: Finding[];
  /** `direction|old|new` of pairs already walked; stops recursive schemas. */
  readonly visited: Set<string>;
}

function unknown(
  context: WalkContext,
  direction: Direction,
  oldPointer: string,
  newPointer: string,
  oldValue: unknown,
  newValue: unknown,
  message: string,
): void {
  context.findings.push({
    rule: "schema.unsupported",
    verdict: "UNKNOWN",
    direction,
    oldPointer,
    newPointer,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    message,
  });
}

function walkPair(context: WalkContext, direction: Direction, oldAt: string, newAt: string): void {
  const before = resolveAt(context.oldDocument, oldAt);
  const after = resolveAt(context.newDocument, newAt);

  if (before.unresolved !== undefined || after.unresolved !== undefined) {
    if (!same(before.value, after.value)) {
      const reason = before.unresolved ?? after.unresolved;
      unknown(context, direction, before.pointer, after.pointer, before.value, after.value, `cannot compare: ${reason}`);
    }
    return;
  }

  const key = `${direction}|${before.pointer}|${after.pointer}`;
  if (context.visited.has(key)) return;
  context.visited.add(key);

  const oldSchema = before.value;
  const newSchema = after.value;
  if (!isRecord(oldSchema) || !isRecord(newSchema)) {
    if (!same(oldSchema, newSchema)) {
      unknown(context, direction, before.pointer, after.pointer, oldSchema, newSchema, "boolean or non-object schema changed");
    }
    return;
  }

  const composite = UNSUPPORTED_KEYWORDS.filter((keyword) => keyword in oldSchema || keyword in newSchema);
  if (composite.length > 0) {
    // Identical text is only trusted when it cannot hide a change behind a `$ref`.
    if (!same(oldSchema, newSchema) || containsRef(oldSchema)) {
      unknown(
        context,
        direction,
        before.pointer,
        after.pointer,
        oldSchema,
        newSchema,
        `uses ${composite.join(", ")}, which the rules do not cover yet`,
      );
    }
    return;
  }

  for (const keyword of CONSTRAINT_KEYWORDS) {
    if (!same(oldSchema[keyword], newSchema[keyword])) {
      unknown(
        context,
        direction,
        child(before.pointer, keyword),
        child(after.pointer, keyword),
        oldSchema[keyword],
        newSchema[keyword],
        `${keyword} changed; value constraints are not classified yet`,
      );
    }
  }

  const pair: SchemaPair = { direction, oldPointer: before.pointer, newPointer: after.pointer, oldSchema, newSchema };
  for (const rule of context.rules) context.findings.push(...rule(pair));

  const oldProperties = oldSchema["properties"];
  const newProperties = newSchema["properties"];
  if (isRecord(oldProperties) && isRecord(newProperties)) {
    for (const name of Object.keys(oldProperties).sort()) {
      if (Object.hasOwn(newProperties, name)) {
        walkPair(context, direction, child(before.pointer, "properties", name), child(after.pointer, "properties", name));
      }
    }
  }

  for (const keyword of ["items", "additionalProperties"]) {
    const oldChild = oldSchema[keyword];
    const newChild = newSchema[keyword];
    if (isRecord(oldChild) && isRecord(newChild)) {
      walkPair(context, direction, child(before.pointer, keyword), child(after.pointer, keyword));
    } else if (keyword === "items" && !same(oldChild, newChild)) {
      unknown(
        context,
        direction,
        child(before.pointer, keyword),
        child(after.pointer, keyword),
        oldChild,
        newChild,
        "items changed shape (tuple, boolean or added/removed)",
      );
    }
  }
}

/** Run `rules` over every schema pair reachable from `roots`, in a stable order. */
export function walkSchemas(
  oldDocument: unknown,
  newDocument: unknown,
  roots: readonly SchemaRoot[],
  rules: readonly SchemaRule[],
): Finding[] {
  const context: WalkContext = { oldDocument, newDocument, rules, findings: [], visited: new Set() };
  for (const root of roots) walkPair(context, root.direction, root.oldPointer, root.newPointer);
  return context.findings;
}
