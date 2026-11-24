import { createHash, randomBytes } from "node:crypto";

/** Tokens are stored only as this hash; the plain token is shown once. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): string {
  return `cp_${randomBytes(24).toString("base64url")}`;
}
