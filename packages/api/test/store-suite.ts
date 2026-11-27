/**
 * Behaviour every RegistryStore must have: version history and workspace
 * isolation. Run against the in-memory store always and against PostgreSQL when
 * a test database is configured, so both implementations keep the same rules.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseContract } from "@contractpulse/cli";
import type { DependencyKey, NewDependency, NewVersion, Workspace } from "../src/domain.js";
import {
  KindMismatchError,
  NotFoundError,
  SelfDependencyError,
  SlugTakenError,
  UnknownVersionError,
} from "../src/errors.js";
import type { RegistryStore } from "../src/store.js";
import { hashToken } from "../src/tokens.js";

export interface StoreHarness {
  store: RegistryStore;
  /** Slugs are global, so harnesses for shared databases may add a suffix; use the returned slug. */
  addWorkspace(slug: string, name: string): Promise<Workspace>;
  addToken(workspaceId: string, token: string, label: string, options?: { revoked?: boolean }): Promise<void>;
  close(): Promise<void>;
}

const fixture = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url)), "utf8");

export const ORDERS_V1 = fixture("contracts/orders.created.v1.schema.json");
const ORDERS_V1_REORDERED = fixture("equivalent/orders.created.v1.reordered.schema.json");
const ORDERS_V2 = fixture("changes/orders.created.v2.schema.json");
const ORDERS_API = fixture("contracts/orders-api.v1.openapi.json");

export function version(content: string, overrides: Partial<NewVersion> = {}): NewVersion {
  const path = overrides.source?.path ?? "contracts/orders.created.schema.json";
  const parsed = parseContract(path, content);
  return {
    kind: parsed.kind,
    declaredVersion: parsed.contractVersion ?? null,
    specVersion: parsed.specVersion,
    hash: parsed.hash,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    content,
    source: { path, repository: "acme/orders", ref: "main" },
    importedBy: "store-tests",
    ...overrides,
  };
}

/** A JSON Schema with one property per name, for imports that must all differ. */
export function schemaWith(...fields: string[]): string {
  const properties = Object.fromEntries(fields.map((field) => [field, { type: "string" }]));
  return JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties });
}

export function dependency(overrides: Partial<NewDependency> = {}): NewDependency {
  return { versionSequence: 1, uses: [], note: null, recordedBy: "store-tests", ...overrides };
}

const SHIPPING_ON_ORDERS: DependencyKey = {
  consumerSlug: "shipping",
  providerSlug: "orders",
  contractName: "orders.created",
};

let tokenCounter = 0;
const newToken = () => `cp_store_test_token_${process.pid}_${Date.now()}_${tokenCounter++}`;

export function describeRegistryStore(name: string, createHarness: () => Promise<StoreHarness>): void {
  describe(`${name}: version history and isolation`, () => {
    let harness: StoreHarness;
    let store: RegistryStore;
    let run = 0;

    beforeAll(async () => {
      harness = await createHarness();
      store = harness.store;
    });

    afterAll(async () => {
      await harness?.close();
    });

    /** A fresh workspace with an `orders` service, so tests never share rows. */
    async function freshWorkspace(label = "ws"): Promise<Workspace> {
      const workspace = await harness.addWorkspace(`${label}-${run++}`, `Store test ${label}`);
      await store.createService(workspace.id, { slug: "orders", name: "Orders", description: null });
      return workspace;
    }

    describe("tokens", () => {
      it("resolves a token hash to its workspace and label", async () => {
        const workspace = await freshWorkspace();
        const token = newToken();
        await harness.addToken(workspace.id, token, "ci");
        expect(await store.findCaller(hashToken(token))).toEqual({ workspace, tokenLabel: "ci" });
      });

      it("ignores unknown and revoked tokens", async () => {
        const workspace = await freshWorkspace();
        const revoked = newToken();
        await harness.addToken(workspace.id, revoked, "old-ci", { revoked: true });
        expect(await store.findCaller(hashToken(revoked))).toBeNull();
        expect(await store.findCaller(hashToken(newToken()))).toBeNull();
      });
    });

    describe("version history", () => {
      it("numbers versions from 1 and lists them newest first", async () => {
        const { id } = await freshWorkspace();
        const first = await store.addVersion(id, "orders", "orders.created", version(ORDERS_V1));
        const second = await store.addVersion(id, "orders", "orders.created", version(ORDERS_V2, { importedBy: "ci-2" }));
        expect([first.created, second.created]).toEqual([true, true]);
        expect([first.version.sequence, second.version.sequence]).toEqual([1, 2]);

        const history = await store.listVersions(id, "orders", "orders.created");
        expect(history?.map((item) => [item.sequence, item.importedBy])).toEqual([
          [2, "ci-2"],
          [1, "store-tests"],
        ]);
        expect(history?.[0]?.hash).toBe(version(ORDERS_V2).hash);
        expect(history?.[1]?.importedAt.getTime()).toBeLessThanOrEqual(history?.[0]?.importedAt.getTime() ?? 0);
      });

      it("returns the latest version for equivalent content instead of adding one", async () => {
        const { id } = await freshWorkspace();
        await store.addVersion(id, "orders", "orders.created", version(ORDERS_V1));
        const again = await store.addVersion(id, "orders", "orders.created", version(ORDERS_V1_REORDERED));
        expect(again.created).toBe(false);
        expect(again.version.sequence).toBe(1);
        expect(await store.listVersions(id, "orders", "orders.created")).toHaveLength(1);

        // The stored file is the first import, not the reordered one.
        const stored = await store.findVersion(id, "orders", "orders.created", 1);
        expect(stored?.content).toBe(ORDERS_V1);
      });

      it("records a revert to older content as a new version", async () => {
        const { id } = await freshWorkspace();
        for (const content of [ORDERS_V1, ORDERS_V2, ORDERS_V1]) {
          await store.addVersion(id, "orders", "orders.created", version(content));
        }
        const history = await store.listVersions(id, "orders", "orders.created");
        expect(history?.map((item) => item.sequence)).toEqual([3, 2, 1]);
        expect(history?.[0]?.hash).toBe(history?.[2]?.hash);
      });

      it("keeps each version's content and source exactly as imported", async () => {
        const { id } = await freshWorkspace();
        const content = `${ORDERS_V1}\n\n`;
        await store.addVersion(
          id,
          "orders",
          "orders.created",
          version(content, { source: { path: "schemas/orders.json", repository: null, ref: "a1b2c3d" } }),
        );
        await store.addVersion(id, "orders", "orders.created", version(ORDERS_V2));

        const first = await store.findVersion(id, "orders", "orders.created", 1);
        expect(first?.content).toBe(content);
        expect(first?.source).toEqual({ path: "schemas/orders.json", repository: null, ref: "a1b2c3d" });
        expect(first?.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
        expect(await store.findVersion(id, "orders", "orders.created", 3)).toBeNull();
      });

      it("numbers each contract separately and summarises them on the service", async () => {
        const { id } = await freshWorkspace();
        await store.addVersion(id, "orders", "orders.created", version(ORDERS_V1));
        await store.addVersion(id, "orders", "orders.created", version(ORDERS_V2));
        const api = await store.addVersion(
          id,
          "orders",
          "orders-api",
          version(ORDERS_API, { source: { path: "openapi.json", repository: null, ref: null } }),
        );
        expect(api.version.sequence).toBe(1);

        const service = await store.findService(id, "orders");
        expect(service?.contracts.map((contract) => [contract.name, contract.kind, contract.versionCount])).toEqual([
          ["orders-api", "openapi", 1],
          ["orders.created", "json-schema", 2],
        ]);
        expect(service?.contracts[1]?.latest?.sequence).toBe(2);
        expect((await store.listServices(id))[0]?.contractCount).toBe(2);
      });

      it("keeps a contract's kind and leaves history unchanged on a mismatch", async () => {
        const { id } = await freshWorkspace();
        await store.addVersion(id, "orders", "orders.created", version(ORDERS_V1));
        await expect(
          store.addVersion(id, "orders", "orders.created", version(ORDERS_API, { source: { path: "openapi.json", repository: null, ref: null } })),
        ).rejects.toBeInstanceOf(KindMismatchError);
        expect(await store.listVersions(id, "orders", "orders.created")).toHaveLength(1);
      });

      it("refuses imports into an unknown service and creates nothing", async () => {
        const { id } = await freshWorkspace();
        await expect(store.addVersion(id, "billing", "invoice.paid", version(ORDERS_V1))).rejects.toBeInstanceOf(
          NotFoundError,
        );
        expect(await store.findService(id, "billing")).toBeNull();
        expect(await store.listVersions(id, "billing", "invoice.paid")).toBeNull();
      });

      it("gives concurrent imports distinct consecutive numbers", async () => {
        const { id } = await freshWorkspace();
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            store.addVersion(id, "orders", "concurrent.event", version(schemaWith(`field${index}`))),
          ),
        );
        expect(results.every((result) => result.created)).toBe(true);
        expect(results.map((result) => result.version.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(await store.listVersions(id, "orders", "concurrent.event")).toHaveLength(8);
      });
    });

    describe("consumer dependencies", () => {
      /** `orders` publishes orders.created v1 and v2; `shipping` and `billing` can consume it. */
      async function ordersWithConsumers(label = "deps"): Promise<Workspace> {
        const workspace = await freshWorkspace(label);
        for (const slug of ["shipping", "billing"]) {
          await store.createService(workspace.id, { slug, name: slug[0]!.toUpperCase() + slug.slice(1), description: null });
        }
        await store.addVersion(workspace.id, "orders", "orders.created", version(ORDERS_V1));
        await store.addVersion(workspace.id, "orders", "orders.created", version(ORDERS_V2));
        return workspace;
      }

      it("records a consumer and shows it from both sides", async () => {
        const { id } = await ordersWithConsumers();
        const result = await store.putDependency(
          id,
          SHIPPING_ON_ORDERS,
          dependency({ uses: ["/properties/orderId", "/required"], note: "Label printing" }),
        );
        expect(result.created).toBe(true);
        expect(result.dependency).toMatchObject({
          consumer: { slug: "shipping", name: "Shipping" },
          provider: { slug: "orders", name: "Orders" },
          contract: { name: "orders.created", kind: "json-schema", latestSequence: 2 },
          version: { sequence: 1, hash: version(ORDERS_V1).hash },
          uses: ["/properties/orderId", "/required"],
          note: "Label printing",
          recordedBy: "store-tests",
        });

        expect(await store.listDependencies(id, "shipping")).toEqual([result.dependency]);
        expect(await store.listConsumers(id, "orders", "orders.created")).toEqual([result.dependency]);
        expect(await store.listDependencies(id, "billing")).toEqual([]);
      });

      it("replaces the record for the same consumer and contract", async () => {
        const { id } = await ordersWithConsumers();
        const first = await store.putDependency(id, SHIPPING_ON_ORDERS, dependency({ uses: ["/properties/orderId"] }));
        const second = await store.putDependency(
          id,
          SHIPPING_ON_ORDERS,
          dependency({ versionSequence: 2, uses: [], recordedBy: "shipping-ci" }),
        );
        expect(second.created).toBe(false);
        expect(second.dependency).toMatchObject({ version: { sequence: 2 }, uses: [], note: null, recordedBy: "shipping-ci" });
        expect(second.dependency.createdAt).toEqual(first.dependency.createdAt);
        expect(second.dependency.updatedAt.getTime()).toBeGreaterThanOrEqual(first.dependency.updatedAt.getTime());
        expect(await store.listConsumers(id, "orders", "orders.created")).toHaveLength(1);
      });

      it("keeps the pinned version when the provider imports a new one", async () => {
        const { id } = await ordersWithConsumers();
        await store.putDependency(id, SHIPPING_ON_ORDERS, dependency());
        await store.addVersion(id, "orders", "orders.created", version(schemaWith("orderId", "total", "currency")));
        const [consumer] = (await store.listConsumers(id, "orders", "orders.created")) ?? [];
        expect(consumer?.version.sequence).toBe(1);
        expect(consumer?.contract.latestSequence).toBe(3);
      });

      it("lists a service's dependencies by provider, then contract", async () => {
        const { id } = await ordersWithConsumers();
        await store.addVersion(id, "billing", "invoice.paid", version(schemaWith("invoiceId")));
        await store.addVersion(id, "orders", "order.cancelled", version(schemaWith("orderId")));
        await store.putDependency(id, SHIPPING_ON_ORDERS, dependency());
        await store.putDependency(id, { ...SHIPPING_ON_ORDERS, contractName: "order.cancelled" }, dependency());
        await store.putDependency(
          id,
          { consumerSlug: "shipping", providerSlug: "billing", contractName: "invoice.paid" },
          dependency(),
        );
        await store.putDependency(id, { ...SHIPPING_ON_ORDERS, consumerSlug: "billing" }, dependency({ versionSequence: 2 }));

        expect((await store.listDependencies(id, "shipping"))?.map((item) => `${item.provider.slug}/${item.contract.name}`)).toEqual([
          "billing/invoice.paid",
          "orders/order.cancelled",
          "orders/orders.created",
        ]);
        expect((await store.listConsumers(id, "orders", "orders.created"))?.map((item) => item.consumer.slug)).toEqual([
          "billing",
          "shipping",
        ]);
      });

      it("rejects unknown services, contracts and versions and self-dependencies without storing anything", async () => {
        const { id } = await ordersWithConsumers();
        await expect(
          store.putDependency(id, { ...SHIPPING_ON_ORDERS, consumerSlug: "warehouse" }, dependency()),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          store.putDependency(id, { ...SHIPPING_ON_ORDERS, providerSlug: "payments" }, dependency()),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          store.putDependency(id, { ...SHIPPING_ON_ORDERS, contractName: "orders.shipped" }, dependency()),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          store.putDependency(id, SHIPPING_ON_ORDERS, dependency({ versionSequence: 3 })),
        ).rejects.toBeInstanceOf(UnknownVersionError);
        await expect(
          store.putDependency(id, { ...SHIPPING_ON_ORDERS, consumerSlug: "orders" }, dependency()),
        ).rejects.toBeInstanceOf(SelfDependencyError);

        expect(await store.listConsumers(id, "orders", "orders.created")).toEqual([]);
        expect(await store.listDependencies(id, "warehouse")).toBeNull();
        expect(await store.listConsumers(id, "orders", "orders.shipped")).toBeNull();
      });

      it("removes a dependency once", async () => {
        const { id } = await ordersWithConsumers();
        await store.putDependency(id, SHIPPING_ON_ORDERS, dependency());
        expect(await store.removeDependency(id, SHIPPING_ON_ORDERS)).toBe(true);
        expect(await store.removeDependency(id, SHIPPING_ON_ORDERS)).toBe(false);
        expect(await store.removeDependency(id, { ...SHIPPING_ON_ORDERS, providerSlug: "payments" })).toBe(false);
        expect(await store.listDependencies(id, "shipping")).toEqual([]);
      });

      it("creates one record when the same consumer registers concurrently", async () => {
        const { id } = await ordersWithConsumers();
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            store.putDependency(id, SHIPPING_ON_ORDERS, dependency({ versionSequence: (index % 2) + 1 })),
          ),
        );
        expect(results.filter((result) => result.created)).toHaveLength(1);
        expect(await store.listConsumers(id, "orders", "orders.created")).toHaveLength(1);
      });

      it("never links or shows services across workspaces", async () => {
        const acme = await ordersWithConsumers("acme");
        const globex = await ordersWithConsumers("globex");
        await store.putDependency(acme.id, SHIPPING_ON_ORDERS, dependency());

        expect(await store.listConsumers(globex.id, "orders", "orders.created")).toEqual([]);
        expect(await store.listDependencies(globex.id, "shipping")).toEqual([]);
        expect(await store.removeDependency(globex.id, SHIPPING_ON_ORDERS)).toBe(false);
        expect(await store.listConsumers(acme.id, "orders", "orders.created")).toHaveLength(1);

        // A consumer that exists only in another workspace is unknown here.
        const initech = await freshWorkspace("initech");
        await store.addVersion(initech.id, "orders", "orders.created", version(ORDERS_V1));
        await expect(store.putDependency(initech.id, SHIPPING_ON_ORDERS, dependency())).rejects.toBeInstanceOf(
          NotFoundError,
        );
      });
    });

    describe("workspace isolation", () => {
      it("keeps same-named services and contracts apart", async () => {
        const acme = await freshWorkspace("acme");
        const globex = await freshWorkspace("globex");

        await store.addVersion(acme.id, "orders", "orders.created", version(ORDERS_V1));
        await store.addVersion(acme.id, "orders", "orders.created", version(ORDERS_V2));
        const globexFirst = await store.addVersion(globex.id, "orders", "orders.created", version(ORDERS_V2));

        // Same content in another workspace is that workspace's first version, not a duplicate.
        expect(globexFirst).toMatchObject({ created: true, version: { sequence: 1 } });
        expect((await store.listVersions(acme.id, "orders", "orders.created"))?.map((item) => item.sequence)).toEqual([
          2, 1,
        ]);
        expect((await store.listVersions(globex.id, "orders", "orders.created"))?.map((item) => item.sequence)).toEqual(
          [1],
        );
        expect((await store.findVersion(globex.id, "orders", "orders.created", 2))).toBeNull();
        expect((await store.findService(globex.id, "orders"))?.contracts[0]?.versionCount).toBe(1);
      });

      it("never returns another workspace's services or versions", async () => {
        const acme = await freshWorkspace("acme");
        const initech = await harness.addWorkspace(`initech-${run++}`, "Initech");
        await store.createService(acme.id, { slug: "billing", name: "Billing", description: "Invoices" });
        await store.addVersion(acme.id, "billing", "invoice.paid", version(ORDERS_V1));

        expect(await store.listServices(initech.id)).toEqual([]);
        expect(await store.findService(initech.id, "billing")).toBeNull();
        expect(await store.listVersions(initech.id, "billing", "invoice.paid")).toBeNull();
        expect(await store.findVersion(initech.id, "billing", "invoice.paid", 1)).toBeNull();
        await expect(
          store.addVersion(initech.id, "billing", "invoice.paid", version(ORDERS_V2)),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(await store.listVersions(acme.id, "billing", "invoice.paid")).toHaveLength(1);
      });

      it("allows the same service slug in two workspaces but not twice in one", async () => {
        const acme = await freshWorkspace("acme");
        const globex = await freshWorkspace("globex");
        await expect(
          store.createService(acme.id, { slug: "orders", name: "Orders again", description: null }),
        ).rejects.toBeInstanceOf(SlugTakenError);
        expect((await store.listServices(globex.id)).map((service) => service.slug)).toEqual(["orders"]);
      });

      it("binds tokens to their own workspace", async () => {
        const acme = await freshWorkspace("acme");
        const globex = await freshWorkspace("globex");
        const acmeToken = newToken();
        const globexToken = newToken();
        await harness.addToken(acme.id, acmeToken, "acme-ci");
        await harness.addToken(globex.id, globexToken, "globex-ci");
        expect((await store.findCaller(hashToken(acmeToken)))?.workspace.id).toBe(acme.id);
        expect((await store.findCaller(hashToken(globexToken)))?.workspace.id).toBe(globex.id);
      });
    });
  });
}
