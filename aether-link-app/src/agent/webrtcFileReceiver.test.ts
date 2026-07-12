import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeSha256 } from "./checksum";
import { processWebRtcFileChunk } from "./webrtcFileReceiver";
import type { WebRtcFileChunkMessage } from "../domain/webrtcFileTransfer";

describe("Agent WebRTC file receiver", () => {
  it("routes a completed clipboard image to the dedicated callback", async () => {
    const clipboardRoot = await mkdtemp(path.join(tmpdir(), "wonremote-clipboard-"));
    const onClipboardImageComplete = vi.fn(async () => undefined);
    const bytes = Buffer.from("png");
    const chunk = createChunk({
      transferId: "clipboard-1",
      filename: "clipboard.png",
      purpose: "clipboard-image",
      mimeType: "image/png",
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: bytes.length,
      isLast: true,
      bytes,
      fileSha256: computeSha256(bytes),
    });

    await expect(processWebRtcFileChunk(chunk, {
      clipboardImageRoot: clipboardRoot,
      onClipboardImageComplete,
    })).resolves.toMatchObject({ status: "complete" });
    expect(onClipboardImageComplete).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: "image/png",
      targetPath: expect.stringContaining(clipboardRoot),
    }));
  });

  it("returns ACK error when clipboard image completion fails", async () => {
    const clipboardRoot = await mkdtemp(path.join(tmpdir(), "wonremote-clipboard-"));
    const chunk = createChunk({
      transferId: "clipboard-failure",
      filename: "clipboard.png",
      purpose: "clipboard-image",
      mimeType: "image/png",
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: 3,
      isLast: true,
      bytes: Buffer.from("png"),
    });

    const result = await processWebRtcFileChunk(chunk, {
      clipboardImageRoot: clipboardRoot,
      onClipboardImageComplete: async () => { throw new Error("clipboard unavailable"); },
    });
    expect(result).toMatchObject({ status: "error", error: "clipboard unavailable" });
    await expect(access(path.join(clipboardRoot, "clipboard-failure.png"))).rejects.toThrow();
  });
  it("stores ordered chunks in nested folders and acknowledges partial and complete states", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-webrtc-files-"));
    const postReceipt = vi.fn(async () => undefined);
    const chunks = createTwoChunks("transfer-1", "Store/reports/report.txt", "hello ", "world");

    await expect(processWebRtcFileChunk(chunks[0], {
      env: { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir },
      postReceipt,
    })).resolves.toMatchObject({
      status: "partial",
      receivedBytes: 6,
      receivedChunks: 1,
    });
    await expect(processWebRtcFileChunk(chunks[1], {
      env: { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir },
      postReceipt,
    })).resolves.toMatchObject({
      status: "complete",
      receivedBytes: 11,
      receivedChunks: 2,
    });

    await expect(readFile(path.join(downloadsDir, "Store", "reports", "report.txt"), "utf8"))
      .resolves.toBe("hello world");
    expect(postReceipt).toHaveBeenCalledOnce();
    expect(postReceipt).toHaveBeenCalledWith(expect.objectContaining({
      transferId: "transfer-1",
      status: "received",
      receivedChunks: 2,
      receivedBytes: 11,
    }));
  });

  it("acknowledges a duplicate first chunk without writing it twice", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-webrtc-files-"));
    const [first] = createTwoChunks("transfer-duplicate", "duplicate.bin", "first", "second");
    const options = { env: { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir } };

    await processWebRtcFileChunk(first, options);
    await expect(processWebRtcFileChunk(first, options)).resolves.toMatchObject({
      status: "duplicate",
      receivedBytes: 5,
      receivedChunks: 1,
    });
  });

  it("stores and acknowledges a zero-byte file", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-webrtc-zero-"));
    const empty = Buffer.alloc(0);
    const chunk = createChunk({
      transferId: "transfer-zero",
      filename: "empty/zero.bin",
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: 0,
      isLast: true,
      bytes: empty,
      fileSha256: computeSha256(empty),
    });

    await expect(processWebRtcFileChunk(chunk, {
      env: { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir },
    })).resolves.toMatchObject({
      status: "complete",
      receivedBytes: 0,
      receivedChunks: 1,
    });
    await expect(readFile(path.join(downloadsDir, "empty", "zero.bin"))).resolves.toEqual(empty);
  });

  it("returns an error acknowledgement and failed receipt on checksum failure", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-webrtc-files-"));
    const postReceipt = vi.fn(async () => undefined);
    const chunks = createTwoChunks("transfer-bad", "bad.bin", "first", "second");
    chunks[1] = { ...chunks[1], fileSha256: "0".repeat(64) };

    await processWebRtcFileChunk(chunks[0], {
      env: { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir },
      postReceipt,
    });
    await expect(processWebRtcFileChunk(chunks[1], {
      env: { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir },
      postReceipt,
    })).resolves.toMatchObject({
      status: "error",
      receivedBytes: 0,
      receivedChunks: 0,
      error: expect.stringContaining("checksum mismatch"),
    });
    expect(postReceipt).toHaveBeenCalledWith(expect.objectContaining({
      transferId: "transfer-bad",
      status: "failed",
    }));
  });

  it("discards out-of-order temp state and permits a clean restart from chunk zero", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-webrtc-order-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };
    const firstBytes = Buffer.from("first");
    const lastBytes = Buffer.from("last");
    const first = createChunk({
      transferId: "transfer-order",
      filename: "order.bin",
      chunkIndex: 0,
      totalChunks: 3,
      totalBytes: 15,
      isLast: false,
      bytes: firstBytes,
    });
    const skipped = createChunk({
      transferId: "transfer-order",
      filename: "order.bin",
      chunkIndex: 2,
      totalChunks: 3,
      totalBytes: 15,
      isLast: true,
      bytes: lastBytes,
      fileSha256: "a".repeat(64),
    });

    await expect(processWebRtcFileChunk(first, { env })).resolves.toMatchObject({ status: "partial" });
    await expect(processWebRtcFileChunk(skipped, { env })).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("expected 1, got 2"),
    });
    await expect(processWebRtcFileChunk(first, { env })).resolves.toMatchObject({
      status: "partial",
      receivedBytes: firstBytes.length,
      receivedChunks: 1,
    });
  });

  it("still returns a complete acknowledgement when its Firestore receipt fails", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-webrtc-files-"));
    const onReceiptError = vi.fn();
    const bytes = Buffer.from("ack survives");
    const chunk = createChunk({
      transferId: "transfer-receipt",
      filename: "receipt.txt",
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: bytes.length,
      isLast: true,
      bytes,
      fileSha256: computeSha256(bytes),
    });

    await expect(processWebRtcFileChunk(chunk, {
      env: { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir },
      postReceipt: async () => {
        throw new Error("Firestore unavailable");
      },
      onReceiptError,
    })).resolves.toMatchObject({ status: "complete" });
    await vi.waitFor(() => expect(onReceiptError).toHaveBeenCalledOnce());
  });

  it("ignores chunks when their session generation is no longer current", async () => {
    const saveChunk = vi.fn();
    const chunk = createChunk({
      transferId: "transfer-stale",
      filename: "stale.bin",
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: 0,
      isLast: true,
      bytes: Buffer.alloc(0),
      fileSha256: computeSha256(Buffer.alloc(0)),
    });

    await expect(processWebRtcFileChunk(chunk, {
      isCurrent: () => false,
      saveChunk,
    })).resolves.toBeNull();
    expect(saveChunk).not.toHaveBeenCalled();
  });

  it("suppresses acknowledgement and receipt when the channel closes during a disk write", async () => {
    let current = true;
    const postReceipt = vi.fn(async () => undefined);
    const chunk = createChunk({
      transferId: "transfer-closed",
      filename: "closed.bin",
      chunkIndex: 0,
      totalChunks: 1,
      totalBytes: 1,
      isLast: true,
      bytes: Buffer.from("x"),
      fileSha256: computeSha256(Buffer.from("x")),
    });

    await expect(processWebRtcFileChunk(chunk, {
      isCurrent: () => current,
      postReceipt,
      saveChunk: async () => {
        current = false;
        return {
          filename: chunk.filename,
          receivedBytes: 1,
          receivedChunks: 1,
          status: "complete",
          targetPath: "closed.bin",
          totalChunks: 1,
          transferId: chunk.transferId,
        };
      },
    })).resolves.toBeNull();
    expect(postReceipt).not.toHaveBeenCalled();
  });
});

function createTwoChunks(
  transferId: string,
  filename: string,
  first: string,
  second: string,
): [WebRtcFileChunkMessage, WebRtcFileChunkMessage] {
  const firstBytes = Buffer.from(first);
  const secondBytes = Buffer.from(second);
  const complete = Buffer.concat([firstBytes, secondBytes]);
  return [
    createChunk({
      transferId,
      filename,
      chunkIndex: 0,
      totalChunks: 2,
      totalBytes: complete.length,
      isLast: false,
      bytes: firstBytes,
    }),
    createChunk({
      transferId,
      filename,
      chunkIndex: 1,
      totalChunks: 2,
      totalBytes: complete.length,
      isLast: true,
      bytes: secondBytes,
      fileSha256: computeSha256(complete),
    }),
  ];
}

function createChunk(input: {
  transferId: string;
  filename: string;
  chunkIndex: number;
  totalChunks: number;
  totalBytes: number;
  isLast: boolean;
  bytes: Buffer;
  fileSha256?: string;
  purpose?: "file" | "clipboard-image";
  mimeType?: "image/png";
}): WebRtcFileChunkMessage {
  return {
    type: "file-chunk",
    transferId: input.transferId,
    filename: input.filename,
    chunkIndex: input.chunkIndex,
    totalChunks: input.totalChunks,
    totalBytes: input.totalBytes,
    isLast: input.isLast,
    fileData: input.bytes.toString("base64"),
    chunkSha256: computeSha256(input.bytes),
    fileSha256: input.fileSha256,
    purpose: input.purpose,
    mimeType: input.mimeType,
  };
}
