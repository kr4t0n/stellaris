import { createHash, randomBytes } from "node:crypto";

/** Bearer tokens are minted once, shown once, and stored only as hashes. */
export function mintToken(): string {
  return `stl_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
