/**
 * Behaviour every RegistryStore must have: version history and workspace
 * isolation. Run against the in-memory store always and against PostgreSQL when
 * a test database is configured, so both implementations keep the same rules.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseContract } from "@contractpulse/cli";
import type { NewVersion, Workspace } from "../src/domain.js";
import { KindMismatchError, NotFoundError, SlugTakenError } from "../src/errors.js";
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
