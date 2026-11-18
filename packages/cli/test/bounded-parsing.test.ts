import { describe, expect, it } from "vitest";
import { ContractError, parseContract } from "../src/contract.js";
import {
  DEFAULT_LIMITS,
  LimitExceededError,
  checkDocumentBounds,
  checkTextDepth,
  type ParseLimits,
} from "../src/engine/bounds.js";
import { collectReferences, getAtPointer, resolveRef } from "../src/engine/refs.js";

const limits = (overrides: Partial<ParseLimits>): ParseLimits => ({ ...DEFAULT_LIMITS, ...overrides });

function nested(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContractError) return error.code;
    throw error;
  }
  return undefined;
}

const schema = (body: Record<string, unknown>) =>
  JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", ...body });

describe("checkTextDepth", () => {
  it("accepts nesting up to the limit", () => {
    expect(() => checkTextDepth(nested(5), 5)).not.toThrow();
  });

  it("rejects nesting past the limit before parsing", () => {
    expect(() => checkTextDepth(nested(6), 5)).toThrow(LimitExceededError);
  });

  it("ignores brackets inside strings, including escaped quotes", () => {
    expect(() => checkTextDepth(JSON.stringify({ a: '[[[[[[\\"{{{{' }), 2)).not.toThrow();
  });
});

describe("checkDocumentBounds", () => {
  it("counts every value", () => {
    expect(checkDocumentBounds({ a: [1, 2], b: "x" })).toBe(5);
  });

  it("rejects too many nodes", () => {
    const error = (() => {
      try {
        checkDocumentBounds({ items: Array.from({ length: 20 }, (_, i) => i) }, limits({ maxNodes: 10 }));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(LimitExceededError);
    expect((error as LimitExceededError).limit).toBe("nodes");
  });

  it("rejects long strings and reports their pointer", () => {
    expect(() => checkDocumentBounds({ "a/b": { c: "x".repeat(11) } }, limits({ maxStringLength: 10 }))).toThrow(
      /string-length limit of 10 exceeded at \/a~1b\/c/,
    );
  });

  it("rejects long object keys", () => {
    expect(() => checkDocumentBounds({ ["k".repeat(11)]: 1 }, limits({ maxStringLength: 10 }))).toThrow(
      LimitExceededError,
    );
  });
});

describe("$ref resolution", () => {
  const doc = {
    components: {
      schemas: {
        Order: { type: "object" },
        Alias: { $ref: "#/components/schemas/Order" },
        "a/b~c": { type: "string" },
        LoopA: { $ref: "#/components/schemas/LoopB" },
        LoopB: { $ref: "#/components/schemas/LoopA" },
      },
    },
  };

  it("reads JSON Pointers with escaped tokens", () => {
    expect(getAtPointer(doc, "/components/schemas/a~1b~0c")).toEqual({ type: "string" });
    expect(getAtPointer(doc, "/components/nope")).toBeUndefined();
    expect(getAtPointer({ list: [1, 2] }, "/list/01")).toBeUndefined();
  });

  it("follows chains of local refs to the final target", () => {
    expect(resolveRef(doc, "#/components/schemas/Alias")).toEqual({
      status: "local",
      target: "/components/schemas/Order",
    });
  });

  it("decodes percent-encoded fragments", () => {
    expect(resolveRef(doc, "#/components/schemas/a~1b~0c").status).toBe("local");
    expect(resolveRef({ "x y": {} }, "#/x%20y").status).toBe("local");
  });

  it("marks cycles, missing targets and remote refs without fetching", () => {
    expect(resolveRef(doc, "#/components/schemas/LoopA").status).toBe("cycle");
    expect(resolveRef(doc, "#/components/schemas/Missing").status).toBe("missing");
    expect(resolveRef(doc, "https://example.test/order.json").status).toBe("remote");
    expect(resolveRef(doc, "common.json#/Order").status).toBe("remote");
  });

  it("stops after maxRefHops", () => {
    expect(resolveRef(doc, "#/components/schemas/Alias", 0).status).toBe("too-deep");
    expect(resolveRef(doc, "#/components/schemas/Alias", 1).status).toBe("local");
  });

  it("collects refs in document order with their location", () => {
    const refs = collectReferences({
      first: { $ref: "#/defs/A" },
      second: [{ $ref: "other.json" }],
      defs: { A: {} },
    });
    expect(refs).toEqual([
      { at: "/first", ref: "#/defs/A", status: "local", target: "/defs/A" },
      { at: "/second/0", ref: "other.json", status: "remote" },
    ]);
  });
});

describe("parseContract with bounds", () => {
  it("maps limit errors to LIMIT_EXCEEDED", () => {
    const deep = schema({ properties: { a: JSON.parse(nested(70)) } });
    expect(errorCode(() => parseContract("deep.json", deep))).toBe("LIMIT_EXCEEDED");
    expect(errorCode(() => parseContract("small.json", schema({}), limits({ maxNodes: 2 })))).toBe("LIMIT_EXCEEDED");
  });

  it("rejects dangling local refs with BROKEN_REF", () => {
    const text = schema({ properties: { id: { $ref: "#/$defs/Id" } } });
    expect(errorCode(() => parseContract("broken.json", text))).toBe("BROKEN_REF");
  });

  it("keeps remote and cyclic refs as references instead of failing", () => {
    const text = schema({
      properties: { customer: { $ref: "https://example.test/customer.json" }, loop: { $ref: "#/$defs/A" } },
      $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } },
    });
    const contract = parseContract("refs.json", text);
    expect(contract.references.map((reference) => reference.status).sort()).toEqual([
      "cycle",
      "cycle",
      "cycle",
      "remote",
    ]);
  });
});
