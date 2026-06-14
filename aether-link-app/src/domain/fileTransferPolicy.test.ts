import { describe, expect, it } from "vitest";
import {
  REMOTE_FILE_CHUNK_BYTES,
  REMOTE_FILE_MAX_BYTES,
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
});
