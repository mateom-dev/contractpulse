import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, type Output } from "../src/cli.js";
import { ContractError, loadContract, parseContract } from "../src/contract.js";

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

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(ContractError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("loadContract", () => {
  it("loads the OpenAPI fixture", async () => {
    const contract = await loadContract(fixture("contracts/orders-api.v1.openapi.json"));
    expect(contract.kind).toBe("openapi");
    expect(contract.specVersion).toBe("3.1.0");
    expect(contract.contractVersion).toBe("1.0.0");
  });

  it("loads the JSON Schema event fixture", async () => {
    const contract = await loadContract(fixture("contracts/orders.created.v1.schema.json"));
    expect(contract.kind).toBe("json-schema");
    expect(contract.specVersion).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(contract.contractVersion).toBe("1.0.0");
  });

  it("rejects truncated JSON", async () => {
    await expectCode(loadContract(fixture("invalid/truncated.openapi.json")), "INVALID_JSON");
  });

  it("rejects documents that are neither OpenAPI nor JSON Schema", async () => {
    await expectCode(loadContract(fixture("invalid/unknown-format.json")), "UNKNOWN_FORMAT");
  });

  it("rejects unsupported OpenAPI versions", async () => {
    await expectCode(loadContract(fixture("invalid/swagger-2.json")), "UNSUPPORTED_VERSION");
  });

  it("reports missing files", async () => {
    await expectCode(loadContract(fixture("contracts/does-not-exist.json")), "NOT_FOUND");
  });
});

describe("parseContract", () => {
  it.each([
    ["[]", "NOT_AN_OBJECT"],
    ["null", "NOT_AN_OBJECT"],
    ['{"openapi":"3.1.0","paths":{}}', "MISSING_FIELD"],
    ['{"openapi":"3.0.3","info":{"version":"1"}}', "MISSING_FIELD"],
    ['{"$schema":"https://example.test/custom"}', "UNSUPPORTED_VERSION"],
    ['{"$schema":"https://json-schema.org/draft/2020-12/schema"}', "MISSING_FIELD"],
  ])("rejects %s with %s", (text, code) => {
    expect(() => parseContract("inline.json", text)).toThrow(ContractError);
    try {
      parseContract("inline.json", text);
    } catch (error) {
      expect((error as ContractError).code).toBe(code);
    }
  });
});

describe("contractpulse validate", () => {
  it("exits 0 when every file is valid", async () => {
    const io = capture();
    const code = await run(
      [
        "validate",
        fixture("contracts/orders-api.v1.openapi.json"),
        fixture("contracts/orders.created.v1.schema.json"),
      ],
      io,
    );
    expect(code).toBe(0);
    expect(io.out.match(/^ok /gm)).toHaveLength(2);
    expect(io.err).toBe("");
  });

  it("exits 1 and names the error when a file is malformed", async () => {
    const io = capture();
    const code = await run(
      ["validate", fixture("contracts/orders-api.v1.openapi.json"), fixture("invalid/truncated.openapi.json")],
      io,
    );
    expect(code).toBe(1);
    expect(io.err).toContain("[INVALID_JSON]");
  });

  it("exits 2 without files", async () => {
    const io = capture();
    expect(await run(["validate"], io)).toBe(2);
  });

  it("exits 2 for unknown commands", async () => {
    const io = capture();
    expect(await run(["diff"], io)).toBe(2);
    expect(io.err).toContain("Unknown command: diff");
  });
});
