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
const RESPONSE = "/paths/~1items/post/responses/200/content/application~1json/schema";

const summary = (findings: readonly Finding[]) =>
  findings.map(({ rule, verdict, direction, oldPointer }) => ({ rule, verdict, direction, oldPointer }));

describe("field.removed on event schemas (response direction)", () => {
  it("reports a removed property as BREAKING with the old schema as value", () => {
    const findings = compareContracts(
      event({ id: { type: "string" }, note: { type: "string" } }),
      event({ id: { type: "string" } }),
    );
    expect(findings).toEqual([
      {
        rule: "field.removed",
        verdict: "BREAKING",
        direction: "response",
        oldPointer: "/properties/note",
        newPointer: "/properties/note",
        oldValue: { type: "string" },
        newValue: null,
        message: "property note removed; consumers may still read it",
      },
    ]);
    expect(overallVerdict(findings)).toBe("BREAKING");
  });

  it("reports every removed property, in name order", () => {
    const findings = compareContracts(event({ zeta: { type: "string" }, alpha: { type: "integer" } }), event({}));
    expect(summary(findings)).toEqual([
      { rule: "field.removed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/alpha" },
      { rule: "field.removed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/zeta" },
    ]);
  });

  it("finds removals in nested objects and array items", () => {
    const findings = compareContracts(
      event({
        customer: { type: "object", properties: { id: { type: "string" }, email: { type: "string" } } },
        lines: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" } } } },
      }),
      event({
        customer: { type: "object", properties: { id: { type: "string" } } },
        lines: { type: "array", items: { type: "object", properties: { sku: { type: "string" } } } },
      }),
    );
    expect(summary(findings)).toEqual([
      { rule: "field.removed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/customer/properties/email" },
      { rule: "field.removed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/lines/items/properties/qty" },
    ]);
  });

  it("does not report properties that are only reordered", () => {
    const findings = compareContracts(
      event({ a: { type: "string" }, b: { type: "string" } }),
      event({ b: { type: "string" }, a: { type: "string" } }),
    );
    expect(findings).toEqual([]);
  });

  it("leaves an object turned into a scalar to the type rules", () => {
    const findings = compareContracts(
      event({ customer: { type: "object", properties: { id: { type: "string" } } } }),
      event({ customer: { type: "string" } }),
    );
    expect(summary(findings)).toEqual([
      { rule: "type.changed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/customer" },
    ]);
  });

  it("reports a removal inside a referenced component at the component's pointer", () => {
    const defs = (properties: Record<string, unknown>) => ({ $defs: { Customer: { type: "object", properties } } });
    const findings = compareContracts(
      event({ customer: { $ref: "#/$defs/Customer" } }, defs({ id: { type: "string" }, tier: { type: "string" } })),
      event({ customer: { $ref: "#/$defs/Customer" } }, defs({ id: { type: "string" } })),
    );
    expect(summary(findings)).toEqual([
      { rule: "field.removed", verdict: "BREAKING", direction: "response", oldPointer: "/$defs/Customer/properties/tier" },
    ]);
  });
});

describe("field.removed on OpenAPI request bodies", () => {
  const body = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "object",
    properties,
    ...extra,
  });

  it("is SAFE when the producer still accepts unknown properties", () => {
    const before = api(postItems(body({ name: { type: "string" }, legacyCode: { type: "string" } }), { type: "object" }));
    const after = api(postItems(body({ name: { type: "string" } }), { type: "object" }));
    const findings = compareContracts(before, after);
    expect(summary(findings)).toEqual([
      { rule: "field.removed", verdict: "SAFE", direction: "request", oldPointer: `${REQUEST}/properties/legacyCode` },
    ]);
    expect(findings[0]?.message).toBe("property legacyCode removed; the producer ignores it if clients still send it");
    expect(overallVerdict(findings)).toBe("SAFE");
  });

  it("is BREAKING when the new schema sets additionalProperties to false", () => {
    const before = api(postItems(body({ name: { type: "string" }, legacyCode: { type: "string" } }), { type: "object" }));
    const after = api(
      postItems(body({ name: { type: "string" } }, { additionalProperties: false }), { type: "object" }),
    );
    expect(summary(compareContracts(before, after))).toEqual([
      { rule: "field.removed", verdict: "BREAKING", direction: "request", oldPointer: `${REQUEST}/properties/legacyCode` },
    ]);
  });

  it("is UNKNOWN when leftover values are checked against a schema-valued additionalProperties", () => {
    const extra = { additionalProperties: { type: "integer" } };
    const before = api(postItems(body({ name: { type: "string" }, legacyCode: { type: "string" } }, extra), { type: "object" }));
    const after = api(postItems(body({ name: { type: "string" } }, extra), { type: "object" }));
    expect(summary(compareContracts(before, after))).toEqual([
      { rule: "field.removed", verdict: "UNKNOWN", direction: "request", oldPointer: `${REQUEST}/properties/legacyCode` },
    ]);
  });

  it("treats additionalProperties true or {} like an open schema", () => {
    for (const additionalProperties of [true, {}]) {
      const before = api(postItems(body({ a: { type: "string" }, b: { type: "string" } }), { type: "object" }));
      const after = api(postItems(body({ a: { type: "string" } }, { additionalProperties }), { type: "object" }));
      expect(compareContracts(before, after)).toMatchObject([{ rule: "field.removed", verdict: "SAFE" }]);
    }
  });
});

describe("field.removed on OpenAPI responses", () => {
  it("is BREAKING for a response body, and SAFE for the same shared schema in the request", () => {
    const ref = { $ref: "#/components/schemas/Item" };
    const item = (properties: Record<string, unknown>) => ({ Item: { type: "object", properties } });
    const before = api(postItems(ref, ref), item({ id: { type: "string" }, price: { type: "integer" } }));
    const after = api(postItems(ref, ref), item({ id: { type: "string" } }));
    expect(summary(compareContracts(before, after))).toEqual([
      { rule: "field.removed", verdict: "SAFE", direction: "request", oldPointer: "/components/schemas/Item/properties/price" },
      { rule: "field.removed", verdict: "BREAKING", direction: "response", oldPointer: "/components/schemas/Item/properties/price" },
    ]);
  });

  it("points at the response body when the schema is inline", () => {
    const before = api(postItems({ type: "object" }, { type: "object", properties: { id: { type: "string" }, etag: { type: "string" } } }));
    const after = api(postItems({ type: "object" }, { type: "object", properties: { id: { type: "string" } } }));
    expect(compareContracts(before, after)).toMatchObject([
      {
        rule: "field.removed",
        verdict: "BREAKING",
        direction: "response",
        oldPointer: `${RESPONSE}/properties/etag`,
        newPointer: `${RESPONSE}/properties/etag`,
      },
    ]);
  });
});
