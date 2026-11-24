import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { PrismaRegistryStore } from "./prisma-store.js";

const prisma = new PrismaClient();
const app = buildApp({ store: new PrismaRegistryStore(prisma), logger: true });

const port = Number(process.env["PORT"] ?? 3001);
const host = process.env["HOST"] ?? "127.0.0.1";

async function shutdown(): Promise<void> {
  await app.close();
  await prisma.$disconnect();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ port, host });
