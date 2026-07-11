import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const BLOB_HASH_CHUNK_BYTES = 1024 * 1024;

export async function sha256BlobHex(
  blob: Blob,
  chunkBytes: number = BLOB_HASH_CHUNK_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError("Blob hash chunk size must be a positive safe integer.");
  }

  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer());
    hash.update(bytes);
  }
  return bytesToHex(hash.digest());
}
