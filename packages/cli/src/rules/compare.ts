/**
 * Compare two versions of a contract and return the findings of every rule.
 *
 * JSON Schema contracts are event payloads: one root, checked as `response`.
 * OpenAPI contracts are paired per operation present in both versions:
 * parameters and the `application/json` request body as `request`, each
 * `application/json` response body as `response`.
 */
import type { LoadedContract } from "../contract.js";
import { getAtPointer } from "../engine/refs.js";
import type { Finding } from "./finding.js";
import { typeChangeRule } from "./type-change.js";
import { child, resolveAt, walkSchemas, type SchemaRoot, type SchemaRule } from "./walk.js";

export const DEFAULT_RULES: readonly SchemaRule[] = [typeChangeRule];

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const JSON_MEDIA_TYPE = "application/json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the object at `pointer` (following a local `$ref`); `undefined` if it is not an object. */
function objectAt(document: unknown, pointer: string): { pointer: string; value: Record<string, unknown> } | undefined {
  const resolved = resolveAt(document, pointer);
  if (resolved.unresolved !== undefined || !isRecord(resolved.value)) return undefined;
  return { pointer: resolved.pointer, value: resolved.value };
}

/** Parameters of an operation keyed by `in:name`; operation-level ones override path-level ones. */
function parameters(document: unknown, pathItem: string, operation: string): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const owner of [pathItem, operation]) {
    const list = getAtPointer(document, child(owner, "parameters"));
    if (!Array.isArray(list)) continue;
    list.forEach((_, index) => {
      const parameter = objectAt(document, child(owner, "parameters", String(index)));
      if (parameter === undefined) return;
      const { in: location, name } = parameter.value;
      if (typeof location === "string" && typeof name === "string") {
        byKey.set(`${location}:${name}`, parameter.pointer);
      }
    });
  }
  return byKey;
}

/** Pointer of the `application/json` schema under a request body or response, if any. */
function jsonSchemaPointer(document: unknown, pointer: string): string | undefined {
  const holder = objectAt(document, pointer);
  if (holder === undefined) return undefined;
  const schema = child(holder.pointer, "content", JSON_MEDIA_TYPE, "schema");
  return getAtPointer(document, schema) === undefined ? undefined : schema;
}

function openApiRoots(oldDocument: unknown, newDocument: unknown): SchemaRoot[] {
  const roots: SchemaRoot[] = [];
  const oldPaths = getAtPointer(oldDocument, "/paths");
  const newPaths = getAtPointer(newDocument, "/paths");
  if (!isRecord(oldPaths) || !isRecord(newPaths)) return roots;

  for (const path of Object.keys(oldPaths).sort()) {
    if (!Object.hasOwn(newPaths, path)) continue;
    const oldItem = objectAt(oldDocument, child("/paths", path));
    const newItem = objectAt(newDocument, child("/paths", path));
    if (oldItem === undefined || newItem === undefined) continue;

    for (const method of HTTP_METHODS) {
      const oldOperation = objectAt(oldDocument, child(oldItem.pointer, method));
      const newOperation = objectAt(newDocument, child(newItem.pointer, method));
      if (oldOperation === undefined || newOperation === undefined) continue;

      const oldParameters = parameters(oldDocument, oldItem.pointer, oldOperation.pointer);
      const newParameters = parameters(newDocument, newItem.pointer, newOperation.pointer);
      for (const [key, oldParameter] of [...oldParameters].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const newParameter = newParameters.get(key);
        if (newParameter === undefined) continue;
        const oldSchema = child(oldParameter, "schema");
        const newSchema = child(newParameter, "schema");
        if (getAtPointer(oldDocument, oldSchema) !== undefined && getAtPointer(newDocument, newSchema) !== undefined) {
          roots.push({ direction: "request", oldPointer: oldSchema, newPointer: newSchema });
        }
      }

      const oldBody = jsonSchemaPointer(oldDocument, child(oldOperation.pointer, "requestBody"));
      const newBody = jsonSchemaPointer(newDocument, child(newOperation.pointer, "requestBody"));
      if (oldBody !== undefined && newBody !== undefined) {
        roots.push({ direction: "request", oldPointer: oldBody, newPointer: newBody });
      }

      const oldResponses = getAtPointer(oldDocument, child(oldOperation.pointer, "responses"));
      const newResponses = getAtPointer(newDocument, child(newOperation.pointer, "responses"));
      if (!isRecord(oldResponses) || !isRecord(newResponses)) continue;
      for (const status of Object.keys(oldResponses).sort()) {
        if (!Object.hasOwn(newResponses, status)) continue;
        const oldSchema = jsonSchemaPointer(oldDocument, child(oldOperation.pointer, "responses", status));
        const newSchema = jsonSchemaPointer(newDocument, child(newOperation.pointer, "responses", status));
        if (oldSchema !== undefined && newSchema !== undefined) {
          roots.push({ direction: "response", oldPointer: oldSchema, newPointer: newSchema });
        }
      }
    }
  }
  return roots;
}

export class CompareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompareError";
  }
}

/** Findings for `next` compared with `previous`, in a stable order. Empty when the hashes match. */
export function compareContracts(
  previous: LoadedContract,
  next: LoadedContract,
  rules: readonly SchemaRule[] = DEFAULT_RULES,
): Finding[] {
  if (previous.kind !== next.kind) {
    throw new CompareError(`cannot compare a ${previous.kind} contract with a ${next.kind} contract`);
  }
  if (previous.hash === next.hash) return [];

  const roots: SchemaRoot[] =
    previous.kind === "json-schema"
      ? [{ direction: "response", oldPointer: "", newPointer: "" }]
      : openApiRoots(previous.document, next.document);
  return walkSchemas(previous.document, next.document, roots, rules);
}
