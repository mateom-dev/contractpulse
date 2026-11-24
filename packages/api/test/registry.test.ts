import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseContract } from "@contractpulse/cli";
import { buildApp } from "../src/app.js";
import { MemoryRegistryStore } from "../src/memory-store.js";

const fixture = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url)), "utf8");

const ORDERS_V1 = fixture("contracts/orders.created.v1.schema.json");
const ORDERS_V1_REORDERED = fixture("equivalent/orders.created.v1.reordered.schema.json");
const ORDERS_V2 = fixture("changes/orders.created.v2.schema.json");
const ORDERS_API = fixture("contracts/orders-api.v1.openapi.json");

const ACME_TOKEN = "cp_test_acme_token_000000000001";
const GLOBEX_TOKEN = "cp_test_globex_token_00000000001";

const VERSIONS = "/v1/workspaces/acme/services/orders/contracts/orders.created/versions";

let app: FastifyInstance;
let tick: number;

beforeEach(async () => {
  tick = 0;
  const store = new MemoryRegistryStore({ clock: () => new Date(Date.UTC(2026, 10, 24, 9, 0, tick++)) });
  const acme = store.addWorkspace("acme", "Acme");
  const globex = store.addWorkspace("globex", "Globex");
  store.addToken(acme.id, ACME_TOKEN, "acme-ci");
  store.addToken(globex.id, GLOBEX_TOKEN, "globex-ci");
  app = buildApp({ store });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function call(method: "GET" | "POST", url: string, body?: unknown, token: string | null = ACME_TOKEN) {
  return app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

async function createOrdersService() {
  const response = await call("POST", "/v1/workspaces/acme/services", { slug: "orders", name: "Orders" });
  expect(response.statusCode).toBe(201);
}

function importBody(content: string, path = "contracts/orders.created.schema.json", ref = "main") {
  return { content, source: { path, repository: "acme/orders", ref } };
}

describe("authentication", () => {
  it("serves health without a token", async () => {
    const response = await call("GET", "/health", undefined, null);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("rejects missing and unknown tokens with 401", async () => {
    const missing = await call("GET", "/v1/workspaces/acme", undefined, null);
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("UNAUTHENTICATED");

    const unknown = await call("GET", "/v1/workspaces/acme", undefined, "cp_not_a_real_token");
    expect(unknown.statusCode).toBe(401);
  });

  it("returns the token's workspace", async () => {
    const response = await call("GET", "/v1/workspaces/acme");
    expect(response.statusCode).toBe(200);
    expect(response.json().workspace).toMatchObject({ slug: "acme", name: "Acme" });
  });

  it("answers 404 for another workspace's slug", async () => {
    const response = await call("GET", "/v1/workspaces/globex/services");
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});

describe("services", () => {
  it("creates and lists services", async () => {
    await createOrdersService();
    await call("POST", "/v1/workspaces/acme/services", { slug: "billing", name: "Billing", description: "Invoices" });

    const response = await call("GET", "/v1/workspaces/acme/services");
    expect(response.json().services.map((s: { slug: string }) => s.slug)).toEqual(["billing", "orders"]);
    expect(response.json().services[0]).toMatchObject({ description: "Invoices", contractCount: 0 });
  });

  it("rejects a duplicate slug with 409", async () => {
    await createOrdersService();
    const response = await call("POST", "/v1/workspaces/acme/services", { slug: "orders", name: "Again" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SLUG_TAKEN");
  });

  it("validates the body", async () => {
    const response = await call("POST", "/v1/workspaces/acme/services", { slug: "Not A Slug", name: "" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 for an unknown service", async () => {
    const response = await call("GET", "/v1/workspaces/acme/services/nope");
    expect(response.statusCode).toBe(404);
  });
});

describe("contract versions", () => {
  beforeEach(createOrdersService);

  it("imports a contract file with its hash and source metadata", async () => {
    const response = await call("POST", VERSIONS, importBody(ORDERS_V1));
    expect(response.statusCode).toBe(201);
    const { version, created } = response.json();
    expect(created).toBe(true);
    expect(version).toMatchObject({
      sequence: 1,
      kind: "json-schema",
      hash: parseContract("v1", ORDERS_V1).hash,
      sizeBytes: Buffer.byteLength(ORDERS_V1),
      source: { path: "contracts/orders.created.schema.json", repository: "acme/orders", ref: "main" },
      importedBy: "acme-ci",
      // clock ticks: service created, contract created, version imported
      importedAt: "2026-11-24T09:00:02.000Z",
    });
    expect(version).not.toHaveProperty("content");
  });

  it("returns the latest version instead of duplicating equivalent content", async () => {
    await call("POST", VERSIONS, importBody(ORDERS_V1));
    const again = await call("POST", VERSIONS, importBody(ORDERS_V1_REORDERED, "other/path.json", "feature"));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, version: { sequence: 1, source: { ref: "main" } } });
  });

  it("appends changed content as the next version and lists history newest first", async () => {
    await call("POST", VERSIONS, importBody(ORDERS_V1));
    const second = await call("POST", VERSIONS, importBody(ORDERS_V2, undefined, "a1b2c3d"));
    expect(second.statusCode).toBe(201);
    expect(second.json().version.sequence).toBe(2);

    const history = await call("GET", VERSIONS);
    expect(history.statusCode).toBe(200);
    expect(history.json().versions.map((v: { sequence: number; source: { ref: string } }) => [v.sequence, v.source.ref]))
      .toEqual([
        [2, "a1b2c3d"],
        [1, "main"],
      ]);
  });

  it("returns one version with the file exactly as imported", async () => {
    await call("POST", VERSIONS, importBody(ORDERS_V1));
    const response = await call("GET", `${VERSIONS}/1`);
    expect(response.statusCode).toBe(200);
    expect(response.json().version.content).toBe(ORDERS_V1);

    expect((await call("GET", `${VERSIONS}/2`)).statusCode).toBe(404);
    expect((await call("GET", `${VERSIONS}/zero`)).statusCode).toBe(400);
  });

  it("shows contracts with their latest version on the service", async () => {
    await call("POST", VERSIONS, importBody(ORDERS_V1));
    await call("POST", VERSIONS, importBody(ORDERS_V2));
    await call(
      "POST",
      "/v1/workspaces/acme/services/orders/contracts/orders-api/versions",
      importBody(ORDERS_API, "openapi/orders.json"),
    );

    const response = await call("GET", "/v1/workspaces/acme/services/orders");
    const { contracts } = response.json().service;
    expect(contracts.map((c: { name: string; kind: string; versionCount: number }) => [c.name, c.kind, c.versionCount]))
      .toEqual([
        ["orders-api", "openapi", 1],
        ["orders.created", "json-schema", 2],
      ]);
    expect(contracts[1].latest.sequence).toBe(2);
  });

  it("rejects invalid contract files with the parser's reason", async () => {
    const response = await call("POST", VERSIONS, importBody(fixture("invalid/broken-ref.openapi.json")));
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "INVALID_CONTRACT", details: { reason: "BROKEN_REF" } });

    const truncated = await call("POST", VERSIONS, importBody('{"openapi": "3.1.0", '));
    expect(truncated.json().error.details.reason).toBe("INVALID_JSON");
    expect((await call("GET", VERSIONS)).statusCode).toBe(404);
  });

  it("refuses a file of the other kind for an existing contract", async () => {
    await call("POST", VERSIONS, importBody(ORDERS_V1));
    const response = await call("POST", VERSIONS, importBody(ORDERS_API));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "KIND_MISMATCH",
      details: { expected: "json-schema", actual: "openapi" },
    });
  });

  it("rejects files over the size limit", async () => {
    const response = await call("POST", VERSIONS, importBody(`{"$schema": "x", "pad": "${"a".repeat(1024 * 1024)}"}`));
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("TOO_LARGE");
  });

  it("returns 404 when importing into an unknown service", async () => {
    const response = await call(
      "POST",
      "/v1/workspaces/acme/services/nope/contracts/orders.created/versions",
      importBody(ORDERS_V1),
    );
    expect(response.statusCode).toBe(404);
  });

  it("keeps each workspace's registry separate", async () => {
    await call("POST", VERSIONS, importBody(ORDERS_V1));
    await call("POST", "/v1/workspaces/globex/services", { slug: "orders", name: "Globex orders" }, GLOBEX_TOKEN);

    const globexHistory = await call(
      "GET",
      "/v1/workspaces/globex/services/orders/contracts/orders.created/versions",
      undefined,
      GLOBEX_TOKEN,
    );
    expect(globexHistory.statusCode).toBe(404);
    expect((await call("GET", `${VERSIONS}/1`, undefined, GLOBEX_TOKEN)).statusCode).toBe(404);
  });
});
