/**
 * Create the demo workspace and an API token for it. Safe to run repeatedly.
 * The token comes from CONTRACTPULSE_DEMO_TOKEN, or is generated and printed once.
 */
import { PrismaClient } from "@prisma/client";
import { generateToken, hashToken } from "./tokens.js";

const DEMO_WORKSPACE = { slug: "demo", name: "Demo workspace (synthetic data)" };
const TOKEN_LABEL = "demo-seed";

const prisma = new PrismaClient();
try {
  const workspace = await prisma.workspace.upsert({
    where: { slug: DEMO_WORKSPACE.slug },
    create: DEMO_WORKSPACE,
    update: { name: DEMO_WORKSPACE.name },
  });

  const fromEnv = process.env["CONTRACTPULSE_DEMO_TOKEN"];
  if (fromEnv !== undefined && fromEnv.length < 24) {
    throw new Error("CONTRACTPULSE_DEMO_TOKEN must be at least 24 characters");
  }
  const token = fromEnv ?? generateToken();
  const tokenHash = hashToken(token);
  await prisma.apiToken.upsert({
    where: { tokenHash },
    create: { workspaceId: workspace.id, label: TOKEN_LABEL, tokenHash },
    update: {},
  });

  console.log(`workspace: ${workspace.slug}`);
  console.log(fromEnv ? "token: from CONTRACTPULSE_DEMO_TOKEN" : `token (shown once): ${token}`);
} finally {
  await prisma.$disconnect();
}
