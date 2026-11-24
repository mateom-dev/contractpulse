/**
 * PrismaRegistryStore against a real PostgreSQL database with the migrations
 * applied. Skipped unless CONTRACTPULSE_TEST_DATABASE_URL is set; CI sets it in
 * the registry-database job. Each run creates its own workspaces (random slug
 * suffix) and deletes them afterwards, so it can share a database with the seed.
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaRegistryStore } from "../src/prisma-store.js";
import { hashToken } from "../src/tokens.js";
import { describeRegistryStore, ORDERS_V1, version } from "./store-suite.js";

const databaseUrl = process.env["CONTRACTPULSE_TEST_DATABASE_URL"];
const runId = randomUUID().slice(0, 8);

function connect(): PrismaClient {
  if (!databaseUrl) throw new Error("CONTRACTPULSE_TEST_DATABASE_URL is not set");
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

async function deleteRunWorkspaces(prisma: PrismaClient): Promise<void> {
  await prisma.workspace.deleteMany({ where: { slug: { endsWith: `-${runId}` } } });
}

describe.skipIf(!databaseUrl)("PostgreSQL registry", () => {
  describeRegistryStore("PrismaRegistryStore", async () => {
    const prisma = connect();
    return {
      store: new PrismaRegistryStore(prisma),
      addWorkspace: async (slug, name) => {
        const row = await prisma.workspace.create({ data: { slug: `${slug}-${runId}`, name } });
        return { id: row.id, slug: row.slug, name: row.name };
      },
      addToken: async (workspaceId, token, label, options) => {
        await prisma.apiToken.create({
          data: { workspaceId, label, tokenHash: hashToken(token), revokedAt: options?.revoked ? new Date() : null },
        });
      },
      close: async () => {
        await deleteRunWorkspaces(prisma);
        await prisma.$disconnect();
      },
    };
  });

  describe("database constraints", () => {
    let prisma: PrismaClient;
    let store: PrismaRegistryStore;

    beforeAll(() => {
      prisma = connect();
      store = new PrismaRegistryStore(prisma);
    });

    afterAll(async () => {
      await deleteRunWorkspaces(prisma);
      await prisma.$disconnect();
    });

    async function workspaceWithVersion(label: string) {
      const workspace = await prisma.workspace.create({ data: { slug: `${label}-${runId}`, name: label } });
      await store.createService(workspace.id, { slug: "orders", name: "Orders", description: null });
      await store.addVersion(workspace.id, "orders", "orders.created", version(ORDERS_V1));
      const contract = await prisma.contract.findFirstOrThrow({ where: { workspaceId: workspace.id } });
      return { workspace, contract };
    }

    it("rejects updates to an imported version", async () => {
      const { contract } = await workspaceWithVersion("immutable");
      await expect(
        prisma.contractVersion.updateMany({ where: { contractId: contract.id }, data: { content: "{}" } }),
      ).rejects.toThrow(/immutable/);
      const stored = await prisma.contractVersion.findFirstOrThrow({ where: { contractId: contract.id } });
      expect(stored.content).toBe(ORDERS_V1);
    });

    it("refuses a version row pointing at another workspace's contract", async () => {
      const { contract } = await workspaceWithVersion("owner");
      const intruder = await prisma.workspace.create({ data: { slug: `intruder-${runId}`, name: "Intruder" } });
      const input = version(ORDERS_V1);
      await expect(
        prisma.contractVersion.create({
          data: {
            workspaceId: intruder.id,
            contractId: contract.id,
            sequence: 2,
            kind: input.kind,
            specVersion: input.specVersion,
            hash: input.hash,
            sizeBytes: input.sizeBytes,
            content: input.content,
            sourcePath: input.source.path,
            importedBy: "intruder",
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(await prisma.contractVersion.count({ where: { contractId: contract.id } })).toBe(1);
    });

    it("refuses duplicate sequence numbers for one contract", async () => {
      const { workspace, contract } = await workspaceWithVersion("sequence");
      const input = version(ORDERS_V1);
      await expect(
        prisma.contractVersion.create({
          data: {
            workspaceId: workspace.id,
            contractId: contract.id,
            sequence: 1,
            kind: input.kind,
            specVersion: input.specVersion,
            hash: input.hash,
            sizeBytes: input.sizeBytes,
            content: input.content,
            sourcePath: input.source.path,
            importedBy: "duplicate",
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });
});
