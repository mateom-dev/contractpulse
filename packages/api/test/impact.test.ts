import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseContract } from "@contractpulse/cli";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Dependency } from "../src/domain.js";
import { computeImpact, consumerImpact, resolvePointerPath } from "../src/impact.js";
import { MemoryRegistryStore } from "../src/memory-store.js";

const fixture = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url)), "utf8");

const ORDERS_V1 = fixture("contracts/orders.created.v1.schema.json");
const ORDERS_V2 = fixture("changes/orders.created.v2.schema.json");
const ORDERS_API = fixture("contracts/orders-api.v1.openapi.json");

const ACME_TOKEN = "cp_test_acme_token_000000000001";
const GLOBEX_TOKEN = "cp_test_globex_token_00000000001";

const WS = "/v1/workspaces/acme";
const CONTRACT = `${WS}/services/orders/contracts/orders.created`;
const IMPACT = `${CONTRACT}/impact`;
const SOURCE = { path: "contracts/orders.created.schema.json" };

/** The v1 event with one optional field added: a SAFE change for every consumer. */
const ORDERS_V1_PLUS_NOTE = JSON.stringify({
  ...JSON.parse(ORDERS_V1),
  properties: { ...JSON.parse(ORDERS_V1).properties, note: { type: "string" } },
});

interface ImpactBody {
  target: { stored: boolean; version?: { sequence: number }; candidate?: { hash: string; matchesLatest: number | null } };
  summary: { consumers: number; breaking: number; review: number; safe: number };
  consumers: Array<{
    consumer: { slug: string };
    pinned: { sequence: number };
    status: string;
    upToDate: boolean;
    findings: Array<{ rule: string; verdict: string; oldPointer: string }>;
    unrelatedFindings: number;
    missingPointers: string[];
  }>;
  coverage: string;
}

let app: FastifyInstance;

function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown, token: string | null = ACME_TOKEN) {
  return app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

const statuses = (body: ImpactBody) =>
  body.consumers.map((entry) => [entry.consumer.slug, entry.status, entry.findings.map((finding) => finding.rule)]);

beforeEach(async () => {
  let tick = 0;
  const store = new MemoryRegistryStore({ clock: () => new Date(Date.UTC(2026, 10, 27, 12, 0, tick++)) });
  const acme = store.addWorkspace("acme", "Acme");
  const globex = store.addWorkspace("globex", "Globex");
  store.addToken(acme.id, ACME_TOKEN, "acme-ci");
  store.addToken(globex.id, GLOBEX_TOKEN, "globex-ci");
  app = buildApp({ store });
  await app.ready();

  for (const slug of ["orders", "shipping", "billing", "analytics", "audit", "reporting"]) {
    expect((await call("POST", `${WS}/services`, { slug, name: slug })).statusCode).toBe(201);
  }
  for (const content of [ORDERS_V1, ORDERS_V2]) {
    expect((await call("POST", `${CONTRACT}/versions`, { content, source: SOURCE })).statusCode).toBe(201);
  }
  // The spec's demo: v2 retypes orderId and drops customerId.
  const register = async (consumer: string, body: unknown) =>
    expect((await call("PUT", `${WS}/services/${consumer}/dependencies/orders/orders.created`, body)).statusCode).toBe(201);
  await register("shipping", { version: 1, uses: ["/properties/orderId"] });
  await register("billing", { version: 1, uses: ["/properties/customerId", "/properties/totalCents"] });
  await register("analytics", { version: 1, uses: ["/properties/channel"] });
  await register("audit", { version: 1, uses: ["/properties/eventId", "/properties/occurredAt"] });
  await register("reporting", { version: 2 });
});

afterEach(async () => {
  await app.close();
});

describe("impact of a stored version", () => {
  it("names the consumers the latest version breaks and the rule behind each", async () => {
    const response = await call("GET", IMPACT);
    expect(response.statusCode).toBe(200);
    const body = response.json<ImpactBody>();

    expect(body.target).toMatchObject({ stored: true, version: { sequence: 2 } });
    expect(body.target.version).not.toHaveProperty("content");
    expect(body.summary).toEqual({ consumers: 5, breaking: 2, review: 1, safe: 2 });
    expect(statuses(body)).toEqual([
      ["billing", "breaking", ["field.removed", "required.removed"]],
      ["shipping", "breaking", ["type.changed"]],
      ["analytics", "review", ["schema.unsupported"]],
      ["audit", "safe", []],
      ["reporting", "safe", []],
    ]);
    expect(body.coverage).toMatch(/only consumers registered/i);

    const shipping = body.consumers.find((entry) => entry.consumer.slug === "shipping")!;
    expect(shipping).toMatchObject({ pinned: { sequence: 1 }, upToDate: false, unrelatedFindings: 3 });
    expect(shipping.findings[0]).toMatchObject({ verdict: "BREAKING", oldPointer: "/properties/orderId" });

    const billing = body.consumers.find((entry) => entry.consumer.slug === "billing")!;
    expect(billing.missingPointers).toEqual(["/properties/customerId"]);

    const reporting = body.consumers.find((entry) => entry.consumer.slug === "reporting")!;
    expect(reporting).toMatchObject({ pinned: { sequence: 2 }, upToDate: true, unrelatedFindings: 0 });
  });

  it("compares with an earlier version when asked", async () => {
    const body = (await call("GET", `${IMPACT}?version=1`)).json<ImpactBody>();
    expect(body.target).toMatchObject({ stored: true, version: { sequence: 1 } });
    // Going back to v1 restores customerId and orderId's type for the v1 consumers,
    // and is judged on its own for reporting, which is pinned to v2.
    expect(body.summary).toEqual({ consumers: 5, breaking: 1, review: 0, safe: 4 });
    expect(body.consumers[0]).toMatchObject({ consumer: { slug: "reporting" }, status: "breaking", upToDate: false });
  });

  it("reports an empty list, with the coverage note, for a contract nobody registered", async () => {
    await call("POST", `${WS}/services/billing/contracts/invoices.issued/versions`, { content: ORDERS_V1, source: SOURCE });
    const body = (await call("GET", `${WS}/services/billing/contracts/invoices.issued/impact`)).json<ImpactBody>();
    expect(body.summary).toEqual({ consumers: 0, breaking: 0, review: 0, safe: 0 });
    expect(body.consumers).toEqual([]);
    expect(body.coverage).toMatch(/unregistered clients/);
  });

  it("rejects unknown contracts, versions and bad queries", async () => {
    for (const [url, status] of [
      [`${WS}/services/orders/contracts/orders.shipped/impact`, 404],
      [`${WS}/services/payments/contracts/orders.created/impact`, 404],
      [`${IMPACT}?version=3`, 404],
      [`${IMPACT}?version=0`, 400],
      [`${IMPACT}?version=abc`, 400],
      [`${IMPACT}?from=1`, 400],
    ] as const) {
      expect((await call("GET", url)).statusCode, url).toBe(status);
    }
  });
});

describe("impact of a candidate file", () => {
  it("checks a file that isn't imported, without storing it", async () => {
    const response = await call("POST", IMPACT, {
      content: ORDERS_V1_PLUS_NOTE,
      source: { ...SOURCE, repository: "acme/orders", ref: "feature/order-note" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ImpactBody>();
    expect(body.target).toMatchObject({ stored: false, candidate: { matchesLatest: null } });
    // Adding an optional field is SAFE for the v1 consumers; reporting (pinned to v2)
    // sees the candidate as v2 reverted: orderId retyped back, channel's enum shrunk,
    // customerId and note added.
    expect(statuses(body)).toEqual([
      ["reporting", "breaking", ["type.changed", "schema.unsupported", "field.added.required", "field.added.optional"]],
      ["analytics", "safe", []],
      ["audit", "safe", []],
      ["billing", "safe", []],
      ["shipping", "safe", []],
    ]);
    expect(body.consumers.find((entry) => entry.consumer.slug === "shipping")!.unrelatedFindings).toBe(1);

    const versions = (await call("GET", `${CONTRACT}/versions`)).json().versions;
    expect(versions).toHaveLength(2);
  });

  it("says when the candidate equals the latest version", async () => {
    const body = (await call("POST", IMPACT, { content: ORDERS_V2, source: SOURCE })).json<ImpactBody>();
    expect(body.target.candidate).toMatchObject({ matchesLatest: 2 });
    expect(body.summary).toMatchObject({ breaking: 2, review: 1, safe: 2 });
  });

  it("refuses files that can't be compared", async () => {
    const invalid = await call("POST", IMPACT, { content: "{", source: SOURCE });
    expect([invalid.statusCode, invalid.json().error.code]).toEqual([422, "INVALID_CONTRACT"]);

    const openapi = await call("POST", IMPACT, { content: ORDERS_API, source: { path: "openapi.json" } });
    expect([openapi.statusCode, openapi.json().error.code]).toEqual([409, "KIND_MISMATCH"]);

    const unknown = await call("POST", `${WS}/services/orders/contracts/orders.shipped/impact`, {
      content: ORDERS_V1,
      source: SOURCE,
    });
    expect(unknown.statusCode).toBe(404);

    expect((await call("POST", IMPACT, { content: ORDERS_V1 })).statusCode).toBe(400);
  });
});

describe("workspace isolation", () => {
  it("hides impact from other workspaces and needs a token", async () => {
    expect((await call("GET", IMPACT, undefined, GLOBEX_TOKEN)).statusCode).toBe(404);
    expect((await call("POST", IMPACT, { content: ORDERS_V1, source: SOURCE }, GLOBEX_TOKEN)).statusCode).toBe(404);
    expect((await call("GET", IMPACT, undefined, null)).statusCode).toBe(401);
  });
});

describe("matching findings to what a consumer uses", () => {
  const consumer = (uses: string[]): Dependency => ({
    consumer: { slug: "c", name: "C" },
    provider: { slug: "p", name: "P" },
    contract: { name: "x", kind: "json-schema", latestSequence: 2 },
    version: { sequence: 1, hash: "h", declaredVersion: null },
    uses,
    note: null,
    recordedBy: "test",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const schema = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseContract(
      "x.schema.json",
      JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, ...extra }),
    );

  const customerRef = { $ref: "#/$defs/Customer" };
  const defs = (idType: string) => ({
    $defs: { Customer: { type: "object", properties: { id: { type: idType }, name: { type: "string" } } } },
  });
  const before = schema({ customer: customerRef, total: { type: "integer" } }, defs("string"));
  const after = schema({ customer: customerRef, total: { type: "integer" } }, defs("integer"));

  it("follows $refs in used pointers", () => {
    expect(resolvePointerPath(before.document, "/properties/customer/properties/id")).toBe(
      "/$defs/Customer/properties/id",
    );
    expect(resolvePointerPath(before.document, "/properties/nope")).toBeUndefined();

    const impact = consumerImpact(after, { dependency: consumer(["/properties/customer/properties/id"]), pinned: before });
    expect(impact).toMatchObject({ status: "breaking", findings: [{ rule: "type.changed" }] });
  });

  it("counts changes above and below a used pointer, but not beside it", () => {
    const above = consumerImpact(after, { dependency: consumer(["/$defs/Customer"]), pinned: before });
    const below = consumerImpact(after, { dependency: consumer(["/$defs/Customer/properties/id/type"]), pinned: before });
    const beside = consumerImpact(after, { dependency: consumer(["/$defs/Customer/properties/name"]), pinned: before });
    const sibling = consumerImpact(after, { dependency: consumer(["/properties/total"]), pinned: before });
    expect([above.status, below.status, beside.status, sibling.status]).toEqual(["breaking", "breaking", "safe", "safe"]);
    expect(beside.unrelatedFindings).toBe(1);
  });

  it("treats a consumer without uses as relying on the whole contract", () => {
    expect(consumerImpact(after, { dependency: consumer([]), pinned: before }).status).toBe("breaking");
  });

  it("matches requiredness changes to the parent's required list", () => {
    const optional = schema({ id: { type: "string" } });
    const required = schema({ id: { type: "string" } }, { required: ["id"] });
    const impact = consumerImpact(optional, { dependency: consumer(["/required"]), pinned: required });
    expect(impact).toMatchObject({ status: "breaking", findings: [{ rule: "required.removed" }] });
  });

  it("asks for a review when a used pointer is gone even if no rule fired", () => {
    const withTitle = schema({ id: { type: "string" } }, { title: "Order" });
    const withoutTitle = schema({ id: { type: "string" } });
    const impact = consumerImpact(withoutTitle, { dependency: consumer(["/title"]), pinned: withTitle });
    expect(impact).toMatchObject({ status: "review", findings: [], missingPointers: ["/title"] });
  });

  it("sorts by status, then slug", () => {
    const named = (slug: string, uses: string[]) => ({ ...consumer(uses), consumer: { slug, name: slug } });
    const result = computeImpact(after, [
      { dependency: named("b", ["/properties/total"]), pinned: before },
      { dependency: named("a", ["/properties/total"]), pinned: before },
      { dependency: named("z", []), pinned: before },
    ]);
    expect(result.consumers.map((entry) => entry.consumer.slug)).toEqual(["z", "a", "b"]);
    expect(result.summary).toEqual({ consumers: 3, breaking: 1, review: 0, safe: 2 });
  });
});
