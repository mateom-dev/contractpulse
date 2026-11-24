import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, type Output } from "../src/cli.js";
import { parseContract } from "../src/contract.js";
import { buildJsonReport, failsPolicy, type JsonDiffReport, type JsonErrorReport } from "../src/report/json.js";
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

const demo = [fixture("contracts/orders.created.v1.schema.json"), fixture("changes/orders.created.v2.schema.json")];
const equivalent = [
  fixture("contracts/orders-api.v1.openapi.json"),
  fixture("equivalent/orders-api.v1.reordered.openapi.json"),
];

const eventText = (version: string, properties: Record<string, unknown>) =>
  JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.test/event",
    version,
    type: "object",
    properties,
  });

const event = (version: string, properties: Record<string, unknown>) =>
  parseContract(`event.${version}.json`, eventText(version, properties));

describe("failsPolicy", () => {
  it("applies each threshold", () => {
    expect(failsPolicy("BREAKING", "breaking")).toBe(true);
    expect(failsPolicy("UNKNOWN", "breaking")).toBe(false);
    expect(failsPolicy("UNKNOWN", "unknown")).toBe(true);
    expect(failsPolicy("SAFE", "unknown")).toBe(false);
    expect(failsPolicy("BREAKING", "never")).toBe(false);
  });
});

describe("buildJsonReport", () => {
  it("orders findings by verdict and adds the OpenAPI location", () => {
    const api = (version: string, type: string, extra: Record<string, unknown>) =>
      parseContract(
        `orders-api.${version}.json`,
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Orders", version },
          paths: {
            "/orders": {
              post: {
                requestBody: {
                  content: { "application/json": { schema: { type: "object", properties: { note: { type: "string" }, ...extra } } } },
                },
                responses: {
                  "201": { description: "ok", content: { "application/json": { schema: { type } } } },
                },
              },
            },
          },
        }),
      );
    const previous = api("1.0.0", "integer", {});
    const next = api("1.1.0", "number", { tag: { type: "string" } });
    const report = buildJsonReport(previous, next, compareContracts(previous, next), "breaking");

    expect(report.verdict).toBe("BREAKING");
    expect(report.failed).toBe(true);
    expect(report.equivalent).toBe(false);
    expect(report.summary).toEqual({ total: 2, breaking: 1, unknown: 0, safe: 1 });
    expect(report.findings.map((entry) => entry.verdict)).toEqual(["BREAKING", "SAFE"]);
    expect(report.findings[0]).toMatchObject({
      rule: "type.widened",
      direction: "response",
      location: "POST /orders response 201",
      oldValue: ["integer"],
      newValue: ["number"],
    });
    expect(report.findings[1]).toMatchObject({
      rule: "field.added.optional",
      direction: "request",
      location: "POST /orders request body",
      oldValue: null,
    });
  });

  it("uses null for missing locations and versions", () => {
    const previous = event("1.0.0", { id: { type: "string" } });
    const next = parseContract(
      "event.json",
      JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} }),
    );
    const report = buildJsonReport(previous, next, compareContracts(previous, next), "never");
    expect(report.new.contractVersion).toBeNull();
    expect(report.findings[0]?.location).toBeNull();
    expect(report.findings[0]?.newValue).toBeNull();
    expect(report.failed).toBe(false);
  });
});

describe("contractpulse diff --format json", () => {
  it("prints a parseable report for the demo change and exits 1", async () => {
    const io = capture();
    const code = await run(["diff", "--format", "json", ...demo], io);
    expect(code).toBe(1);
    expect(io.err).toBe("");

    const report = JSON.parse(io.out) as JsonDiffReport;
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "ok",
      verdict: "BREAKING",
      failOn: "breaking",
      failed: true,
      equivalent: false,
      summary: { total: 4, breaking: 3, unknown: 1, safe: 0 },
    });
    expect(report.old.contractVersion).toBe("1.0.0");
    expect(report.old.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.findings.map((entry) => entry.rule)).toContain("field.removed");
    expect(report.findings.at(-1)?.verdict).toBe("UNKNOWN");
    const removed = report.findings.find((entry) => entry.rule === "field.removed");
    expect(removed?.oldPointer).toBe("/properties/customerId");
  });

  it("is byte-identical across runs", async () => {
    const first = capture();
    const second = capture();
    await run(["diff", "--format=json", ...demo], first);
    await run(["diff", ...demo, "--format", "json"], second);
    expect(first.out).toBe(second.out);
  });

  it("reports equivalent contracts with no findings and exits 0", async () => {
    const io = capture();
    expect(await run(["diff", "--format", "json", ...equivalent], io)).toBe(0);
    const report = JSON.parse(io.out) as JsonDiffReport;
    expect(report).toMatchObject({ verdict: "SAFE", failed: false, equivalent: true, findings: [] });
  });

  it("prints an error report and exits 3 for invalid input", async () => {
    const io = capture();
    const code = await run(
      ["diff", "--format", "json", fixture("contracts/orders-api.v1.openapi.json"), fixture("invalid/swagger-2.json")],
      io,
    );
    expect(code).toBe(3);
    const report = JSON.parse(io.out) as JsonErrorReport;
    expect(report.status).toBe("error");
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ code: "UNSUPPORTED_VERSION", file: fixture("invalid/swagger-2.json") });
    expect(io.err).toContain("[UNSUPPORTED_VERSION]");
  });

  it("reports a kind mismatch without a file", async () => {
    const io = capture();
    const code = await run(
      [
        "diff",
        "--format",
        "json",
        fixture("contracts/orders-api.v1.openapi.json"),
        fixture("contracts/orders.created.v1.schema.json"),
      ],
      io,
    );
    expect(code).toBe(3);
    const report = JSON.parse(io.out) as JsonErrorReport;
    expect(report.errors).toEqual([expect.objectContaining({ code: "KIND_MISMATCH" })]);
    expect(report.errors[0]).not.toHaveProperty("file");
  });
});

describe("contractpulse diff --fail-on", () => {
  it("passes BREAKING changes with --fail-on never", async () => {
    const io = capture();
    expect(await run(["diff", "--fail-on", "never", ...demo], io)).toBe(0);
    expect(io.out).toContain("Verdict: BREAKING");
  });

  it("fails UNKNOWN-only changes with --fail-on unknown but not by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contractpulse-fail-on-"));
    const write = async (name: string, id: Record<string, unknown>) => {
      const file = join(dir, name);
      await writeFile(file, eventText("1.0.0", { id }));
      return file;
    };
    const files = [await write("old.json", { type: "string" }), await write("new.json", { type: "string", pattern: "^o_" })];

    const byDefault = capture();
    expect(await run(["diff", "--format", "json", ...files], byDefault)).toBe(0);
    const report = JSON.parse(byDefault.out) as JsonDiffReport;
    expect(report.verdict).toBe("UNKNOWN");
    expect(report.failed).toBe(false);

    const strict = capture();
    expect(await run(["diff", "--fail-on", "unknown", ...files], strict)).toBe(1);
    expect(strict.out).toContain("Verdict: UNKNOWN");
  });

  it("rejects unknown option values and flags with exit 2", async () => {
    for (const args of [
      ["diff", "--format", "yaml", ...demo],
      ["diff", "--fail-on", "safe", ...demo],
      ["diff", "--verbose", ...demo],
      ["diff", "--format"],
    ]) {
      const io = capture();
      expect(await run(args, io)).toBe(2);
      expect(io.out).toBe("");
      expect(io.err).toContain("Usage: contractpulse");
    }
  });
});
