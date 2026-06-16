import { describe, expect, it } from "vitest";
import {
  FIRESTORE_DIRECT_FILE_TRANSFER_MAX_BYTES,
  REMOTE_FILE_CHUNK_BYTES,
  REMOTE_FILE_MAX_BYTES,
  canUseFirestoreDirectFileTransfer,
  canUseFirestoreDirectFilePayload,
  canTransferRemoteFile,
  remoteFileLimitLabel,
} from "./fileTransferPolicy";

describe("remote file transfer policy", () => {
  it("allows files up to 500MB and rejects anything larger", () => {
    expect(REMOTE_FILE_MAX_BYTES).toBe(500 * 1024 * 1024);
    expect(canTransferRemoteFile(REMOTE_FILE_MAX_BYTES)).toBe(true);
    expect(canTransferRemoteFile(REMOTE_FILE_MAX_BYTES + 1)).toBe(false);
    expect(remoteFileLimitLabel()).toBe("500MB");
  });

  it("keeps chunk size small for low-memory agents", () => {
    expect(REMOTE_FILE_CHUNK_BYTES).toBe(64 * 1024);
  });

  it("does not treat Firestore direct document payloads as the 500MB transfer path", () => {
    expect(canUseFirestoreDirectFilePayload(REMOTE_FILE_CHUNK_BYTES)).toBe(true);
    expect(canUseFirestoreDirectFilePayload(REMOTE_FILE_CHUNK_BYTES + 1)).toBe(false);
    expect(canUseFirestoreDirectFilePayload(REMOTE_FILE_MAX_BYTES)).toBe(false);
  });

  it("caps Firestore direct file transfer to a small fallback budget", () => {
    expect(FIRESTORE_DIRECT_FILE_TRANSFER_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(canUseFirestoreDirectFileTransfer(FIRESTORE_DIRECT_FILE_TRANSFER_MAX_BYTES)).toBe(true);
    expect(canUseFirestoreDirectFileTransfer(FIRESTORE_DIRECT_FILE_TRANSFER_MAX_BYTES + 1)).toBe(false);
    expect(canUseFirestoreDirectFileTransfer(REMOTE_FILE_MAX_BYTES)).toBe(false);
  });
});
