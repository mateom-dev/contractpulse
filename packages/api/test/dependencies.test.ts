import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryRegistryStore } from "../src/memory-store.js";

const fixture = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url)), "utf8");

const ORDERS_V1 = fixture("contracts/orders.created.v1.schema.json");
const ORDERS_V2 = fixture("changes/orders.created.v2.schema.json");

const ACME_TOKEN = "cp_test_acme_token_000000000001";
const GLOBEX_TOKEN = "cp_test_globex_token_00000000001";

const WS = "/v1/workspaces/acme";
const SHIPPING_DEPENDENCY = `${WS}/services/shipping/dependencies/orders/orders.created`;
const ORDERS_CONSUMERS = `${WS}/services/orders/contracts/orders.created/consumers`;

let app: FastifyInstance;
let tick: number;

beforeEach(async () => {
  tick = 0;
  const store = new MemoryRegistryStore({ clock: () => new Date(Date.UTC(2026, 10, 27, 9, 0, tick++)) });
  const acme = store.addWorkspace("acme", "Acme");
  const globex = store.addWorkspace("globex", "Globex");
  store.addToken(acme.id, ACME_TOKEN, "acme-ci");
  store.addToken(globex.id, GLOBEX_TOKEN, "globex-ci");
  app = buildApp({ store });
  await app.ready();

  for (const [slug, name] of [
    ["orders", "Orders"],
    ["shipping", "Shipping"],
    ["billing", "Billing"],
  ]) {
    expect((await call("POST", `${WS}/services`, { slug, name })).statusCode).toBe(201);
  }
  for (const content of [ORDERS_V1, ORDERS_V2]) {
    const response = await call("POST", `${WS}/services/orders/contracts/orders.created/versions`, {
      content,
      source: { path: "contracts/orders.created.schema.json" },
    });
    expect(response.statusCode).toBe(201);
  }
});

afterEach(async () => {
  await app.close();
});

function call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown, token: string | null = ACME_TOKEN) {
  return app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

describe("registering consumers", () => {
  it("creates, then replaces, a dependency pinned to a version", async () => {
    const created = await call("PUT", SHIPPING_DEPENDENCY, {
      version: 1,
      uses: ["/required", "/properties/orderId", "/required"],
      note: " Prints labels ",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      created: true,
      dependency: {
        consumer: { slug: "shipping", name: "Shipping" },
        provider: { slug: "orders", name: "Orders" },
        contract: { name: "orders.created", kind: "json-schema", latestSequence: 2 },
        version: { sequence: 1 },
        uses: ["/properties/orderId", "/required"],
        note: "Prints labels",
        recordedBy: "acme-ci",
      },
    });

    const replaced = await call("PUT", SHIPPING_DEPENDENCY, { version: 2 });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({ created: false, dependency: { version: { sequence: 2 }, uses: [], note: null } });
  });

  it("lists dependencies of a consumer and consumers of a contract, saying coverage is limited", async () => {
    await call("PUT", SHIPPING_DEPENDENCY, { version: 1 });
    await call("PUT", `${WS}/services/billing/dependencies/orders/orders.created`, { version: 2, uses: ["/properties"] });

    const consumers = await call("GET", ORDERS_CONSUMERS);
    expect(consumers.statusCode).toBe(200);
    const body = consumers.json();
    expect(body.consumers.map((item: { consumer: { slug: string }; version: { sequence: number } }) => [
      item.consumer.slug,
      item.version.sequence,
    ])).toEqual([
      ["billing", 2],
      ["shipping", 1],
    ]);
    expect(body.coverage).toMatch(/only consumers registered/i);

    const dependencies = await call("GET", `${WS}/services/shipping/dependencies`);
    expect(dependencies.statusCode).toBe(200);
    expect(dependencies.json().dependencies).toHaveLength(1);
    expect((await call("GET", `${WS}/services/orders/dependencies`)).json()).toEqual({ dependencies: [] });
  });

  it("rejects pointers that don't exist in the pinned version", async () => {
    // `/properties/customerId` exists in v1; v2 removes it.
    expect((await call("PUT", SHIPPING_DEPENDENCY, { version: 1, uses: ["/properties/customerId"] })).statusCode).toBe(201);

    const response = await call("PUT", SHIPPING_DEPENDENCY, {
      version: 2,
      uses: ["/properties/customerId", "/properties/orderId", "/properties/nope~1x"],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({
      code: "UNKNOWN_POINTER",
      details: { pointers: ["/properties/customerId", "/properties/nope~1x"] },
    });
    // The earlier registration is unchanged.
    const [consumer] = (await call("GET", ORDERS_CONSUMERS)).json().consumers;
    expect(consumer).toMatchObject({ version: { sequence: 1 }, uses: ["/properties/customerId"] });
  });

  it("validates the body", async () => {
    for (const body of [
      {},
      { version: 0 },
      { version: 1.5 },
      { version: "1" },
      { version: 1, uses: ["properties/orderId"] },
      { version: 1, uses: [""] },
      { version: 1, uses: ["/bad~2escape"] },
      { version: 1, uses: Array.from({ length: 201 }, (_, index) => `/p${index}`) },
      { version: 1, note: "x".repeat(501) },
      { version: 1, extra: true },
    ]) {
      const response = await call("PUT", SHIPPING_DEPENDENCY, body);
      expect(response.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  it("reports what is missing", async () => {
    const cases: Array<[string, unknown, number, string]> = [
      [`${WS}/services/warehouse/dependencies/orders/orders.created`, { version: 1 }, 404, "NOT_FOUND"],
      [`${WS}/services/shipping/dependencies/payments/orders.created`, { version: 1 }, 404, "NOT_FOUND"],
      [`${WS}/services/shipping/dependencies/orders/orders.shipped`, { version: 1 }, 404, "NOT_FOUND"],
      [SHIPPING_DEPENDENCY, { version: 3 }, 422, "UNKNOWN_VERSION"],
      [`${WS}/services/orders/dependencies/orders/orders.created`, { version: 1 }, 422, "SELF_DEPENDENCY"],
    ];
    for (const [url, body, status, code] of cases) {
      const response = await call("PUT", url, body);
      expect([response.statusCode, response.json().error.code], url).toEqual([status, code]);
    }
    expect((await call("GET", ORDERS_CONSUMERS)).json().consumers).toEqual([]);
    expect((await call("GET", `${WS}/services/warehouse/dependencies`)).statusCode).toBe(404);
    expect((await call("GET", `${WS}/services/orders/contracts/orders.shipped/consumers`)).statusCode).toBe(404);
  });
});

describe("removing consumers", () => {
  it("deletes a dependency and then reports it missing", async () => {
    await call("PUT", SHIPPING_DEPENDENCY, { version: 1 });
    expect((await call("DELETE", SHIPPING_DEPENDENCY)).statusCode).toBe(204);
    const again = await call("DELETE", SHIPPING_DEPENDENCY);
    expect([again.statusCode, again.json().error.code]).toEqual([404, "NOT_FOUND"]);
    expect((await call("GET", ORDERS_CONSUMERS)).json().consumers).toEqual([]);
  });
});

describe("workspace isolation", () => {
  it("hides dependencies from other workspaces' tokens", async () => {
    await call("PUT", SHIPPING_DEPENDENCY, { version: 1 });
    for (const [method, url, body] of [
      ["GET", ORDERS_CONSUMERS, undefined],
      ["GET", `${WS}/services/shipping/dependencies`, undefined],
      ["PUT", SHIPPING_DEPENDENCY, { version: 1 }],
      ["DELETE", SHIPPING_DEPENDENCY, undefined],
    ] as const) {
      const response = await call(method, url, body, GLOBEX_TOKEN);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await call("GET", ORDERS_CONSUMERS)).json().consumers).toHaveLength(1);
  });

  it("needs a token", async () => {
    expect((await call("PUT", SHIPPING_DEPENDENCY, { version: 1 }, null)).statusCode).toBe(401);
    expect((await call("GET", ORDERS_CONSUMERS, undefined, null)).statusCode).toBe(401);
  });
});
