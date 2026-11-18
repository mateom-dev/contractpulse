import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContract, parseContract, type LoadedContract } from "../src/contract.js";
import { CompareError, compareContracts } from "../src/rules/compare.js";
import { overallVerdict, type Finding } from "../src/rules/finding.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

const event = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}): LoadedContract =>
  parseContract(
    "event.json",
    JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, ...extra }),
  );

const api = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}, openapi = "3.1.0"): LoadedContract =>
  parseContract(
    "api.json",
    JSON.stringify({ openapi, info: { title: "t", version: "1" }, paths, components: { schemas } }),
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

const summary = (findings: readonly Finding[]) =>
  findings.map(({ rule, verdict, direction, oldPointer }) => ({ rule, verdict, direction, oldPointer }));

describe("type rules on event schemas (response direction)", () => {
  it("reports an unrelated type as type.changed BREAKING", () => {
    const findings = compareContracts(event({ id: { type: "string" } }), event({ id: { type: "number" } }));
    expect(findings).toEqual([
      {
        rule: "type.changed",
        verdict: "BREAKING",
        direction: "response",
        oldPointer: "/properties/id",
        newPointer: "/properties/id",
        oldValue: ["string"],
        newValue: ["number"],
        message: "type changed from string to number",
      },
    ]);
  });

  it("treats integer → number and adding null as widening, BREAKING for consumers", () => {
    const findings = compareContracts(
      event({ total: { type: "integer" }, note: { type: "string" } }),
      event({ total: { type: "number" }, note: { type: ["string", "null"] } }),
    );
    expect(summary(findings)).toEqual([
      { rule: "type.widened", verdict: "BREAKING", direction: "response", oldPointer: "/properties/note" },
      { rule: "type.widened", verdict: "BREAKING", direction: "response", oldPointer: "/properties/total" },
    ]);
  });

  it("treats number → integer as narrowing, SAFE for consumers", () => {
    const findings = compareContracts(event({ total: { type: "number" } }), event({ total: { type: "integer" } }));
    expect(summary(findings)).toEqual([
      { rule: "type.narrowed", verdict: "SAFE", direction: "response", oldPointer: "/properties/total" },
    ]);
  });

  it("treats a dropped type keyword as widening to any type", () => {
    const [finding] = compareContracts(event({ id: { type: "string" } }), event({ id: { description: "any id" } }));
    expect(finding).toMatchObject({ rule: "type.widened", oldValue: ["string"], newValue: null });
    expect(finding?.message).toBe("type widened from string to any type");
  });

  it("does not report equivalent type sets", () => {
    const findings = compareContracts(
      event({ total: { type: ["number", "integer"] }, flag: { type: ["boolean", "null"] } }, { $comment: "v1" }),
      event({ total: { type: "number" }, flag: { type: ["null", "boolean"] } }, { $comment: "v2" }),
    );
    expect(findings).toEqual([]);
  });

  it("descends into nested objects, array items and additionalProperties", () => {
    const findings = compareContracts(
      event({
        lines: { type: "array", items: { type: "object", properties: { sku: { type: "string" } } } },
        meta: { type: "object", additionalProperties: { type: "string" } },
      }),
      event({
        lines: { type: "array", items: { type: "object", properties: { sku: { type: "integer" } } } },
        meta: { type: "object", additionalProperties: { type: "boolean" } },
      }),
    );
    expect(summary(findings)).toEqual([
      { rule: "type.changed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/lines/items/properties/sku" },
      { rule: "type.changed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/meta/additionalProperties" },
    ]);
  });

  it("follows local $refs and stops on recursive schemas", () => {
    const node = (valueType: string) => ({
      $defs: {
        Node: {
          type: "object",
          properties: { value: { type: valueType }, children: { type: "array", items: { $ref: "#/$defs/Node" } } },
        },
      },
    });
    const findings = compareContracts(
      event({ root: { $ref: "#/$defs/Node" } }, node("string")),
      event({ root: { $ref: "#/$defs/Node" } }, node("integer")),
    );
    expect(summary(findings)).toEqual([
      { rule: "type.changed", verdict: "BREAKING", direction: "response", oldPointer: "/$defs/Node/properties/value" },
    ]);
  });
});

describe("type rules on OpenAPI operations", () => {
  it("applies the request direction to bodies and parameters", () => {
    const before = api({
      ...postItems({ type: "object", properties: { qty: { type: "number" }, code: { type: "integer" } } }, { type: "object" }),
      "/items/{id}": { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], get: { responses: {} } },
    });
    const after = api({
      ...postItems({ type: "object", properties: { qty: { type: "integer" }, code: { type: "number" } } }, { type: "object" }),
      "/items/{id}": { parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }], get: { responses: {} } },
    });
    expect(summary(compareContracts(before, after))).toEqual([
      { rule: "type.widened", verdict: "SAFE", direction: "request", oldPointer: "/paths/~1items/post/requestBody/content/application~1json/schema/properties/code" },
      { rule: "type.narrowed", verdict: "BREAKING", direction: "request", oldPointer: "/paths/~1items/post/requestBody/content/application~1json/schema/properties/qty" },
      { rule: "type.changed", verdict: "BREAKING", direction: "request", oldPointer: "/paths/~1items~1{id}/parameters/0/schema" },
    ]);
  });

  it("checks a shared component once per direction", () => {
    const ref = { $ref: "#/components/schemas/Item" };
    const before = api(postItems(ref, ref), { Item: { type: "object", properties: { price: { type: "integer" } } } });
    const after = api(postItems(ref, ref), { Item: { type: "object", properties: { price: { type: "number" } } } });
    expect(summary(compareContracts(before, after))).toEqual([
      { rule: "type.widened", verdict: "SAFE", direction: "request", oldPointer: "/components/schemas/Item/properties/price" },
      { rule: "type.widened", verdict: "BREAKING", direction: "response", oldPointer: "/components/schemas/Item/properties/price" },
    ]);
  });

  it("reads the OpenAPI 3.0 nullable flag as a null type", () => {
    const before = api(postItems({ type: "object" }, { type: "object", properties: { note: { type: "string" } } }), {}, "3.0.3");
    const after = api(
      postItems({ type: "object" }, { type: "object", properties: { note: { type: "string", nullable: true } } }),
      {},
      "3.0.3",
    );
    expect(compareContracts(before, after)).toMatchObject([
      { rule: "type.widened", verdict: "BREAKING", direction: "response", newValue: ["null", "string"] },
    ]);
  });
});

describe("constructs outside the rule table are UNKNOWN", () => {
  it("reports changed composition keywords without descending", () => {
    const findings = compareContracts(
      event({ id: { oneOf: [{ type: "string" }, { type: "integer" }] } }),
      event({ id: { oneOf: [{ type: "string" }, { type: "boolean" }] } }),
    );
    expect(findings).toMatchObject([{ rule: "schema.unsupported", verdict: "UNKNOWN", oldPointer: "/properties/id" }]);
    expect(findings[0]?.message).toContain("oneOf");
  });

  it("reports changed remote $refs", () => {
    const findings = compareContracts(
      event({ id: { $ref: "https://example.test/id-v1.json" } }),
      event({ id: { $ref: "https://example.test/id-v2.json" } }),
    );
    expect(findings).toMatchObject([{ rule: "schema.unsupported", verdict: "UNKNOWN", oldPointer: "/properties/id" }]);
  });

  it("reports changed value constraints such as enum", () => {
    const findings = compareContracts(
      event({ channel: { type: "string", enum: ["web"] } }),
      event({ channel: { type: "string", enum: ["web", "store"] } }),
    );
    expect(findings).toMatchObject([
      { rule: "schema.unsupported", verdict: "UNKNOWN", oldPointer: "/properties/channel/enum", oldValue: ["web"] },
    ]);
  });
});

describe("compareContracts", () => {
  it("finds the orders.created demo changes", async () => {
    const before = await loadContract(fixture("contracts/orders.created.v1.schema.json"));
    const after = await loadContract(fixture("changes/orders.created.v2.schema.json"));
    const findings = compareContracts(before, after);
    expect(summary(findings)).toEqual([
      { rule: "field.removed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/customerId" },
      { rule: "required.removed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/customerId" },
      { rule: "schema.unsupported", verdict: "UNKNOWN", direction: "response", oldPointer: "/properties/channel/enum" },
      { rule: "type.changed", verdict: "BREAKING", direction: "response", oldPointer: "/properties/orderId" },
    ]);
    expect(overallVerdict(findings)).toBe("BREAKING");
  });

  it("returns nothing for equivalent files", async () => {
    for (const [original, reordered] of [
      ["contracts/orders-api.v1.openapi.json", "equivalent/orders-api.v1.reordered.openapi.json"],
      ["contracts/orders.created.v1.schema.json", "equivalent/orders.created.v1.reordered.schema.json"],
    ] as const) {
      const findings = compareContracts(await loadContract(fixture(original)), await loadContract(fixture(reordered)));
      expect(findings).toEqual([]);
    }
  });

  it("refuses to compare an OpenAPI document with a JSON Schema", () => {
    expect(() => compareContracts(api({}), event({}))).toThrow(CompareError);
  });

  it("gives SAFE as the overall verdict when there are no findings", () => {
    expect(overallVerdict([])).toBe("SAFE");
  });
});
