import { describe, expect, it } from "vitest";
import { parseStorageTransferCleanup, serializeStorageTransferCleanup } from "./storageTransferCleanup";

describe("Firebase Storage transfer cleanup persistence", () => {
  it("round-trips pending and received cleanup entries", () => {
    const entries = new Map([
      ["transfer-1", { path: "sessions/s-1/files/t-1/file.bin", received: false }],
      ["transfer-2", { path: "sessions/s-1/files/t-2/file.bin", received: true }],
    ]);
    expect(parseStorageTransferCleanup(serializeStorageTransferCleanup(entries))).toEqual(entries);
  });

  it("rejects malformed and out-of-scope paths", () => {
    expect(parseStorageTransferCleanup("broken").size).toBe(0);
    expect(parseStorageTransferCleanup(JSON.stringify({ bad: { path: "other/file", received: true } })).size).toBe(0);
  });
});
