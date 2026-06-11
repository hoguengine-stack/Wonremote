import { createHash } from "node:crypto";

/**
 * Computes the SHA-256 checksum of a given buffer.
 */
export function computeSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
