import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, type Output } from "../src/cli.js";
import { parseContract } from "../src/contract.js";
import { describeLocation, formatDiff, formatValue, MAX_VALUE_LENGTH } from "../src/report/text.js";
import { compareContracts } from "../src/rules/compare.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

function capture(): Output & { out: string; err: string } {
  const sink = {
    out: "",
    err: "",
    stdout(text: string) {
      sink.out += text;
    },
    stderr(text: string) {
      sink.err += text;
    },
  };
  return sink;
}

const api = (version: string, request: unknown, response: unknown) =>
  parseContract(
    `orders-api.${version}.json`,
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Orders", version },
      paths: {
        "/orders/{id}": {
          put: {
            requestBody: { content: { "application/json": { schema: request } } },
            responses: { "200": { description: "ok", content: { "application/json": { schema: response } } } },
          },
        },
      },
    }),
  );

describe("describeLocation", () => {
  it("names the operation and part of an OpenAPI pointer", () => {
    expect(describeLocation("/paths/~1orders~1{id}/put/requestBody/content/application~1json/schema")).toBe(
      "PUT /orders/{id} request body",
    );
    expect(describeLocation("/paths/~1orders/get/responses/404/content/application~1json/schema/properties/x")).toBe(
      "GET /orders response 404",
    );
    expect(describeLocation("/paths/~1orders/get/parameters/0/schema")).toBe("GET /orders parameter");
  });

  it("leaves event and component pointers alone", () => {
    expect(describeLocation("/properties/orderId")).toBeUndefined();
    expect(describeLocation("/components/schemas/Order/properties/id")).toBeUndefined();
    expect(describeLocation("")).toBeUndefined();
  });
});

describe("formatValue", () => {
  it("shows absent values and compact JSON", () => {
    expect(formatValue(null)).toBe("(absent)");
    expect(formatValue({ type: "string", format: "uuid" })).toBe('{"format":"uuid","type":"string"}');
  });

  it("cuts long values", () => {
    const text = formatValue({ enum: Array.from({ length: 50 }, (_, index) => `value-${index}`) });
    expect(text).toHaveLength(MAX_VALUE_LENGTH);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("formatDiff", () => {
  it("puts BREAKING first and labels each finding's direction", () => {
    const previous = api("1.0.0", { type: "object", properties: { qty: { type: "integer" } } }, {
      type: "object",
      properties: { total: { type: "integer" } },
    });
    const next = api("1.1.0", { type: "object", properties: { qty: { type: "number" }, note: { type: "string" } } }, {
      type: "object",
      properties: { total: { type: "number" } },
    });
    const text = formatDiff(previous, next, compareContracts(previous, next));

    expect(text).toContain("old: orders-api.1.0.0.json (openapi 3.1.0, version 1.0.0)");
    expect(text).toContain("new: orders-api.1.1.0.json (openapi 3.1.0, version 1.1.0)");
    const breaking = text.indexOf("BREAKING  type.widened");
    const safe = text.indexOf("SAFE      type.widened");
    expect(breaking).toBeGreaterThan(0);
    expect(safe).toBeGreaterThan(breaking);
    expect(text.indexOf("SAFE      field.added.optional")).toBeGreaterThan(breaking);

    const responseBlock = text.slice(breaking, text.indexOf("\n\n", breaking));
    expect(responseBlock).toContain("direction: response (producer writes, consumers read)");
    expect(responseBlock).toContain("where:     PUT /orders/{id} response 200");
    expect(responseBlock).toContain('- ["integer"]');
    expect(responseBlock).toContain('+ ["number"]');

    const requestBlock = text.slice(safe, text.indexOf("\n\n", safe));
    expect(requestBlock).toContain("direction: request (consumers write, producer reads)");
    expect(requestBlock).toContain("where:     PUT /orders/{id} request body");

    expect(text.endsWith("Verdict: BREAKING (3 findings: 1 breaking, 0 unknown, 2 safe)\n")).toBe(true);
  });

  it("says when equivalent contracts have nothing to report", () => {
    const contract = api("1.0.0", { type: "string" }, { type: "string" });
    expect(formatDiff(contract, contract, [])).toContain("No differences found (the contracts are equivalent).\nVerdict: SAFE\n");
  });

  it("says when contracts differ but no rule matched", () => {
    const previous = api("1.0.0", { type: "string" }, { type: "string" });
    const next = api("1.0.1", { type: "string" }, { type: "string" });
    expect(formatDiff(previous, next, compareContracts(previous, next))).toContain("no rule matched a change");
  });
});

describe("contractpulse diff", () => {
  it("explains the orders.created demo change", async () => {
    const io = capture();
    const code = await run(
      ["diff", fixture("contracts/orders.created.v1.schema.json"), fixture("changes/orders.created.v2.schema.json")],
      io,
    );
    expect(code).toBe(0);
    expect(io.err).toBe("");
    expect(io.out).toContain("(json-schema https://json-schema.org/draft/2020-12/schema, version 1.0.0)");
    expect(io.out).toContain("BREAKING  field.removed\n          property customerId removed;");
    expect(io.out).toContain("at:        /properties/customerId");
    expect(io.out).toContain("BREAKING  type.changed");
    expect(io.out).toContain("UNKNOWN   schema.unsupported");
    expect(io.out.indexOf("UNKNOWN")).toBeGreaterThan(io.out.lastIndexOf("BREAKING  "));
    expect(io.out).toContain("Verdict: BREAKING (4 findings: 3 breaking, 1 unknown, 0 safe)");
  });

  it("reports no differences for reordered but equivalent files", async () => {
    const io = capture();
    const code = await run(
      ["diff", fixture("contracts/orders-api.v1.openapi.json"), fixture("equivalent/orders-api.v1.reordered.openapi.json")],
      io,
    );
    expect(code).toBe(0);
    expect(io.out).toContain("No differences found (the contracts are equivalent).");
  });

  it("exits 1 when a file is not a valid contract", async () => {
    const io = capture();
    const code = await run(["diff", fixture("contracts/orders-api.v1.openapi.json"), fixture("invalid/swagger-2.json")], io);
    expect(code).toBe(1);
    expect(io.out).toBe("");
    expect(io.err).toContain("[UNSUPPORTED_VERSION]");
  });

  it("exits 1 when the two contracts are of different kinds", async () => {
    const io = capture();
    const code = await run(
      ["diff", fixture("contracts/orders-api.v1.openapi.json"), fixture("contracts/orders.created.v1.schema.json")],
      io,
    );
    expect(code).toBe(1);
    expect(io.err).toContain("cannot compare");
  });

  it("exits 2 without exactly two files", async () => {
    for (const args of [["diff"], ["diff", "a.json"], ["diff", "a.json", "b.json", "c.json"]]) {
      const io = capture();
      expect(await run(args, io)).toBe(2);
      expect(io.err).toContain("diff needs exactly two files");
    }
  });

  it("reports both files when neither can be loaded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contractpulse-diff-"));
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{");
    const io = capture();
    expect(await run(["diff", join(dir, "missing.json"), broken], io)).toBe(1);
    expect(io.err).toContain("[NOT_FOUND]");
    expect(io.err).toContain("[INVALID_JSON]");
  });
});
