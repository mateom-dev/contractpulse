import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, type Output } from "../src/cli.js";
import { loadContract, parseContract } from "../src/contract.js";
import { canonicalJson, canonicalize, contractHash } from "../src/engine/canonical.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

const schema = (body: Record<string, unknown>) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  ...body,
});

describe("canonicalize", () => {
  it("sorts object keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: null } })).toBe('{"a":{"c":null,"d":true},"b":1}');
  });

  it("treats required and type arrays as sets", () => {
    expect(canonicalize({ required: ["b", "a", "b"], type: ["string", "null"] })).toEqual({
      required: ["a", "b"],
      type: ["null", "string"],
    });
  });

  it("treats enum values as a set of literals", () => {
    expect(canonicalJson({ enum: ["web", 1, { b: 2, a: 1 }, "web"] })).toBe(
      canonicalJson({ enum: [{ a: 1, b: 2 }, 1, "web"] }),
    );
  });

  it("leaves the OpenAPI boolean required alone", () => {
    expect(canonicalize({ name: "id", in: "path", required: true })).toEqual({ in: "path", name: "id", required: true });
  });

  it("keeps array order where it carries meaning", () => {
    const parameters = { parameters: [{ name: "b" }, { name: "a" }] };
    expect(canonicalJson(parameters)).toBe('{"parameters":[{"name":"b"},{"name":"a"}]}');
    expect(canonicalJson({ allOf: [{ type: "string" }, { minLength: 1 }] })).not.toBe(
      canonicalJson({ allOf: [{ minLength: 1 }, { type: "string" }] }),
    );
  });

  it("does not reorder arrays inside examples, defaults and x- extensions", () => {
    const value = {
      example: { required: ["b", "a"] },
      default: ["b", "a"],
      "x-owners": { type: ["z", "y"] },
    };
    expect(canonicalize(value)).toEqual({
      default: ["b", "a"],
      example: { required: ["b", "a"] },
      "x-owners": { type: ["z", "y"] },
    });
  });

  it("does not modify its input", () => {
    const input = { required: ["b", "a"], z: 1, a: 2 };
    canonicalize(input);
    expect(input).toEqual({ required: ["b", "a"], z: 1, a: 2 });
    expect(Object.keys(input)).toEqual(["required", "z", "a"]);
  });
});

describe("contractHash", () => {
  it("is a sha256 digest", () => {
    expect(contractHash({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("ignores whitespace, key order and required order", () => {
    const a = parseContract("a.json", JSON.stringify(schema({ properties: { id: { type: "string" } }, required: ["id", "n"] })));
    const b = parseContract(
      "b.json",
      JSON.stringify(schema({ required: ["n", "id"], properties: { id: { type: "string" } } }), null, 2),
    );
    expect(a.hash).toBe(b.hash);
  });

  it("changes when the contract changes", () => {
    const base = schema({ properties: { id: { type: "string" } } });
    const changed = schema({ properties: { id: { type: "integer" } } });
    expect(contractHash(base)).not.toBe(contractHash(changed));
  });

  it("changes when a documentation field changes", () => {
    expect(contractHash(schema({ description: "a" }))).not.toBe(contractHash(schema({ description: "b" })));
  });
});

describe("equivalent fixtures", () => {
  it.each([
    ["contracts/orders.created.v1.schema.json", "equivalent/orders.created.v1.reordered.schema.json"],
    ["contracts/orders-api.v1.openapi.json", "equivalent/orders-api.v1.reordered.openapi.json"],
  ])("%s and %s hash the same", async (original, reordered) => {
    const [a, b] = await Promise.all([loadContract(fixture(original)), loadContract(fixture(reordered))]);
    expect(a.hash).toBe(b.hash);
  });

  it("the event and the API contract hash differently", async () => {
    const [event, api] = await Promise.all([
      loadContract(fixture("contracts/orders.created.v1.schema.json")),
      loadContract(fixture("contracts/orders-api.v1.openapi.json")),
    ]);
    expect(event.hash).not.toBe(api.hash);
  });
});

describe("validate prints hashes", () => {
  it("prints the same hash for equivalent files", async () => {
    let out = "";
    const io: Output = {
      stdout: (text) => {
        out += text;
      },
      stderr: () => {},
    };
    const code = await run(
      [
        "validate",
        fixture("contracts/orders.created.v1.schema.json"),
        fixture("equivalent/orders.created.v1.reordered.schema.json"),
      ],
      io,
    );
    expect(code).toBe(0);
    const hashes = out.match(/sha256:[0-9a-f]{64}/g);
    expect(hashes).toHaveLength(2);
    expect(hashes![0]).toBe(hashes![1]);
  });
});
