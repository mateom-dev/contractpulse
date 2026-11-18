import { describe, expect, it } from "vitest";
import { parseContract, type LoadedContract } from "../src/contract.js";
import { compareContracts } from "../src/rules/compare.js";
import { overallVerdict, type Finding } from "../src/rules/finding.js";

const event = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}): LoadedContract =>
  parseContract(
    "event.json",
    JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, ...extra }),
  );

const api = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}): LoadedContract =>
  parseContract(
    "api.json",
    JSON.stringify({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths, components: { schemas } }),
  );

/** POST /items with the given request and 200 response body schemas. */
const postItems = (request: unknown, response: unknown) => ({
  "/items": {
    post: {
      requestBody: { content: { "application/json": { schema: request } } },
      responses: { "200": { description: "ok", content: { "application/json": { schema: response } } } },
    },
  },
});

const REQUEST = "/paths/~1items/post/requestBody/content/application~1json/schema";

const summary = (findings: readonly Finding[]) =>
  findings.map(({ rule, verdict, direction, oldPointer }) => ({ rule, verdict, direction, oldPointer }));

const id = { type: "string" };
const note = { type: "string" };

describe("requiredness rules on event schemas (response direction)", () => {
  it("reports a new optional property as SAFE with its schema as value", () => {
    const findings = compareContracts(event({ id }), event({ id, note }));
    expect(findings).toEqual([
      {
        rule: "field.added.optional",
        verdict: "SAFE",
        direction: "response",
        oldPointer: "/properties/note",
        newPointer: "/properties/note",
        oldValue: null,
        newValue: { type: "string" },
        message: "optional property note added; consumers that ignore unknown properties are unaffected",
      },
    ]);
    expect(overallVerdict(findings)).toBe("SAFE");
  });

  it("keeps an optional addition SAFE but notes a closed old schema", () => {
    const findings = compareContracts(
      event({ id }, { additionalProperties: false }),
      event({ id, note }, { additionalProperties: false }),
    );
    expect(findings).toMatchObject([{ rule: "field.added.optional", verdict: "SAFE" }]);
    expect(findings[0]?.message).toContain("additionalProperties to false");
  });

  it("reports a new required property as SAFE", () => {
    const findings = compareContracts(event({ id }), event({ id, note }, { required: ["note"] }));
    expect(summary(findings)).toEqual([
      { rule: "field.added.required", verdict: "SAFE", direction: "response", oldPointer: "/properties/note" },
    ]);
  });

  it("reports an existing property becoming required as SAFE, with booleans as values", () => {
    const findings = compareContracts(event({ id, note }), event({ id, note }, { required: ["note"] }));
    expect(findings).toEqual([
      {
        rule: "required.added",
        verdict: "SAFE",
        direction: "response",
        oldPointer: "/properties/note",
        newPointer: "/properties/note",
        oldValue: false,
        newValue: true,
        message: "property note is now required; consumers always receive it",
      },
    ]);
  });

  it("reports a required property becoming optional as BREAKING", () => {
    const findings = compareContracts(event({ id, note }, { required: ["id", "note"] }), event({ id, note }, { required: ["id"] }));
    expect(summary(findings)).toEqual([
      { rule: "required.removed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/note" },
    ]);
    expect(overallVerdict(findings)).toBe("BREAKING");
  });

  it("reports a removed required property as both field.removed and required.removed", () => {
    const findings = compareContracts(event({ id, note }, { required: ["id", "note"] }), event({ id }, { required: ["id"] }));
    expect(findings).toMatchObject([
      { rule: "field.removed", verdict: "BREAKING", oldPointer: "/properties/note", newPointer: "/properties/note" },
      { rule: "required.removed", verdict: "BREAKING", oldPointer: "/properties/note", newPointer: "/properties/note" },
    ]);
  });

  it("treats required as a set and ignores reordering", () => {
    const findings = compareContracts(
      event({ id, note }, { required: ["id", "note"] }),
      event({ note, id }, { required: ["note", "id"], description: "reordered" }),
    );
    expect(findings).toEqual([]);
  });

  it("points at the required keyword for names without a property definition", () => {
    const findings = compareContracts(event({ id }), event({ id }, { required: ["legacy"] }));
    expect(summary(findings)).toEqual([
      { rule: "required.added", verdict: "SAFE", direction: "response", oldPointer: "/required" },
    ]);
  });

  it("finds requiredness changes in nested objects and array items", () => {
    const findings = compareContracts(
      event({
        customer: { type: "object", properties: { id }, required: ["id"] },
        lines: { type: "array", items: { type: "object", properties: { sku: id } } },
      }),
      event({
        customer: { type: "object", properties: { id } },
        lines: { type: "array", items: { type: "object", properties: { sku: id, qty: { type: "integer" } } } },
      }),
    );
    expect(summary(findings)).toEqual([
      { rule: "required.removed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/customer/properties/id" },
      { rule: "field.added.optional", verdict: "SAFE", direction: "response", oldPointer: "/properties/lines/items/properties/qty" },
    ]);
  });

  it("leaves an object turned into a scalar to the type rules", () => {
    const findings = compareContracts(
      event({ customer: { type: "object", properties: { id }, required: ["id"] } }),
      event({ customer: { type: "string" } }),
    );
    expect(summary(findings)).toEqual([
      { rule: "type.changed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/customer" },
    ]);
  });
});

describe("requiredness rules on OpenAPI request bodies", () => {
  const body = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
  const response = { type: "object" };

  it("is BREAKING when a new required property is added", () => {
    const findings = compareContracts(api(postItems(body({ id }), response)), api(postItems(body({ id, note }, ["note"]), response)));
    expect(summary(findings)).toEqual([
      { rule: "field.added.required", verdict: "BREAKING", direction: "request", oldPointer: `${REQUEST}/properties/note` },
    ]);
    expect(findings[0]?.message).toBe("required property note added; requests without it are now rejected");
  });

  it("is SAFE when a new optional property is added", () => {
    const findings = compareContracts(api(postItems(body({ id }), response)), api(postItems(body({ id, note }), response)));
    expect(summary(findings)).toEqual([
      { rule: "field.added.optional", verdict: "SAFE", direction: "request", oldPointer: `${REQUEST}/properties/note` },
    ]);
  });

  it("is BREAKING when an existing property becomes required", () => {
    const findings = compareContracts(
      api(postItems(body({ id, note }), response)),
      api(postItems(body({ id, note }, ["note"]), response)),
    );
    expect(summary(findings)).toEqual([
      { rule: "required.added", verdict: "BREAKING", direction: "request", oldPointer: `${REQUEST}/properties/note` },
    ]);
  });

  it("is SAFE when a required property becomes optional", () => {
    const findings = compareContracts(
      api(postItems(body({ id, note }, ["note"]), response)),
      api(postItems(body({ id, note }), response)),
    );
    expect(summary(findings)).toEqual([
      { rule: "required.removed", verdict: "SAFE", direction: "request", oldPointer: `${REQUEST}/properties/note` },
    ]);
  });

  it("checks a shared component once per direction", () => {
    const ref = { $ref: "#/components/schemas/Item" };
    const item = (required: string[]) => ({ Item: { type: "object", properties: { id, note }, required } });
    const findings = compareContracts(api(postItems(ref, ref), item(["id"])), api(postItems(ref, ref), item(["id", "note"])));
    expect(summary(findings)).toEqual([
      { rule: "required.added", verdict: "BREAKING", direction: "request", oldPointer: "/components/schemas/Item/properties/note" },
      { rule: "required.added", verdict: "SAFE", direction: "response", oldPointer: "/components/schemas/Item/properties/note" },
    ]);
  });
});
