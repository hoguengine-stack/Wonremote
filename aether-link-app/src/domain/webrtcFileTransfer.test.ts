import { describe, expect, it } from "vitest";
import {
  parseWebRtcFileAck,
  parseWebRtcFileChunk,
  serializeWebRtcFileAck,
  serializeWebRtcFileChunk,
  WEBRTC_FILE_CHUNK_BYTES,
  WEBRTC_FILE_MAX_CHUNKS,
} from "./webrtcFileTransfer";
import { REMOTE_FILE_MAX_BYTES } from "./fileTransferPolicy";

const checksum = "a".repeat(64);

describe("WebRTC file transfer protocol", () => {
  it("round-trips bounded file chunks and acknowledgements", () => {
    const chunk = {
      type: "file-chunk" as const,
      transferId: "transfer-1",
      filename: "folder/example.bin",
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: 3,
      isLast: true,
      fileData: "AQID",
      chunkSha256: checksum,
      fileSha256: checksum,
    };
    expect(parseWebRtcFileChunk(serializeWebRtcFileChunk(chunk))).toEqual(chunk);

    const ack = {
      type: "file-ack" as const,
      transferId: "transfer-1",
      receivedBytes: 3,
      receivedChunks: 1,
      status: "complete" as const,
    };
    expect(parseWebRtcFileAck(serializeWebRtcFileAck(ack))).toEqual(ack);
  });

  it("round-trips an optional clipboard-image purpose with strict PNG MIME", () => {
    const chunk = {
      type: "file-chunk" as const,
      transferId: "clipboard-1",
      filename: "clipboard.png",
      purpose: "clipboard-image" as const,
      mimeType: "image/png" as const,
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: 3,
      isLast: true,
      fileData: "AQID",
      chunkSha256: checksum,
      fileSha256: checksum,
    };
    expect(parseWebRtcFileChunk(serializeWebRtcFileChunk(chunk))).toEqual(chunk);
    expect(parseWebRtcFileChunk(JSON.stringify({ ...chunk, mimeType: "image/jpeg" }))).toBeNull();
    expect(parseWebRtcFileChunk(JSON.stringify({ ...chunk, mimeType: undefined }))).toBeNull();
  });

  it("rejects inconsistent or oversized chunks", () => {
    expect(parseWebRtcFileChunk(JSON.stringify({ type: "file-chunk" }))).toBeNull();
    expect(() => serializeWebRtcFileChunk({
      type: "file-chunk",
      transferId: "transfer-1",
      filename: "example.bin",
      chunkIndex: 0,
      totalChunks: 2,
      totalBytes: WEBRTC_FILE_CHUNK_BYTES + 1,
      isLast: true,
      fileData: "A".repeat(WEBRTC_FILE_CHUNK_BYTES * 2),
      chunkSha256: checksum,
    })).toThrow("invalid");
  });

  it.each(["../transfer", "transfer/name", "transfer:name", "transfer?name", ".."])(
    "rejects collision-prone transfer ID %s",
    (transferId) => {
      expect(parseWebRtcFileChunk(JSON.stringify({
        type: "file-chunk",
        transferId,
        filename: "example.bin",
        chunkIndex: 0,
        totalChunks: 1,
        totalBytes: 0,
        isLast: true,
        fileData: "",
        chunkSha256: checksum,
        fileSha256: checksum,
      }))).toBeNull();
    },
  );

  it("rejects unsafe acknowledgement payloads", () => {
    expect(parseWebRtcFileAck(JSON.stringify({
      type: "file-ack",
      transferId: "transfer-1",
      receivedBytes: -1,
      receivedChunks: 0,
      status: "partial",
    }))).toBeNull();
  });

  it("accepts the 500 MB boundary and rejects larger byte or chunk declarations", () => {
    const boundary = {
      type: "file-chunk" as const,
      transferId: "transfer-boundary",
      filename: "boundary.bin",
      chunkIndex: WEBRTC_FILE_MAX_CHUNKS - 1,
      totalChunks: WEBRTC_FILE_MAX_CHUNKS,
      totalBytes: REMOTE_FILE_MAX_BYTES,
      isLast: true,
      fileData: "",
      chunkSha256: checksum,
      fileSha256: checksum,
    };

    expect(parseWebRtcFileChunk(serializeWebRtcFileChunk(boundary))).toEqual(boundary);
    expect(() => serializeWebRtcFileChunk({
      ...boundary,
      totalBytes: REMOTE_FILE_MAX_BYTES + 1,
    })).toThrow("invalid");
    expect(() => serializeWebRtcFileChunk({
      ...boundary,
      chunkIndex: WEBRTC_FILE_MAX_CHUNKS,
      totalChunks: WEBRTC_FILE_MAX_CHUNKS + 1,
    })).toThrow("invalid");
  });
});
