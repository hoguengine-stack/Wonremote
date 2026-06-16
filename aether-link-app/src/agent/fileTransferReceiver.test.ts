import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { computeSha256 } from "./checksum";
import { saveTransferredFileChunk, saveTransferredFileDownloadStream } from "./fileTransferReceiver";

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

describe("agent file transfer receiver", () => {
  it("stores chunked files as part files and atomically completes them", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-files-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };

    const first = await saveTransferredFileChunk(
      {
        id: "file-1",
        filename: "report.txt",
        fileData: base64("hello "),
        transferId: "transfer-1",
        chunkIndex: 0,
        totalChunks: 2,
        totalBytes: 11,
        isLast: false,
      },
      env,
    );
    expect(first).toMatchObject({ status: "partial", receivedChunks: 1, receivedBytes: 6 });

    const second = await saveTransferredFileChunk(
      {
        id: "file-2",
        filename: "report.txt",
        fileData: base64("world"),
        transferId: "transfer-1",
        chunkIndex: 1,
        totalChunks: 2,
        totalBytes: 11,
        isLast: true,
        fileSha256: computeSha256(Buffer.from("hello world")),
      },
      env,
    );

    expect(second).toMatchObject({ status: "complete", receivedChunks: 2, receivedBytes: 11 });
    await expect(readFile(path.join(downloadsDir, "report.txt"), "utf8")).resolves.toBe("hello world");
  });

  it("rejects out-of-order chunks instead of silently corrupting the file", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-files-"));

    await expect(
      saveTransferredFileChunk(
        {
          id: "file-2",
          filename: "report.txt",
          fileData: base64("world"),
          transferId: "transfer-1",
          chunkIndex: 1,
          totalChunks: 2,
          totalBytes: 11,
          isLast: true,
        },
        { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir },
      ),
    ).rejects.toThrow("Missing first file chunk");
  });

  it("ignores duplicate already-written chunks", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-files-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };
    const firstChunk = {
      id: "file-1",
      filename: "report.txt",
      fileData: base64("hello "),
      transferId: "transfer-1",
      chunkIndex: 0,
      totalChunks: 2,
      totalBytes: 11,
      isLast: false,
    };

    await saveTransferredFileChunk(firstChunk, env);
    const duplicate = await saveTransferredFileChunk(firstChunk, env);
    expect(duplicate).toMatchObject({ status: "partial", receivedChunks: 1 });

    const partStat = await stat(path.join(downloadsDir, "report.txt.transfer-1.part"));
    expect(partStat.size).toBe(6);
  });

  it("removes part files when final checksum verification fails", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-files-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };

    await saveTransferredFileChunk(
      {
        id: "file-1",
        filename: "report.txt",
        fileData: base64("hello "),
        transferId: "transfer-1",
        chunkIndex: 0,
        totalChunks: 2,
        isLast: false,
      },
      env,
    );

    await expect(
      saveTransferredFileChunk(
        {
          id: "file-2",
          filename: "report.txt",
          fileData: base64("world"),
          transferId: "transfer-1",
          chunkIndex: 1,
          totalChunks: 2,
          isLast: true,
          fileSha256: "0".repeat(64),
        },
        env,
      ),
    ).rejects.toThrow("File checksum mismatch");

    await expectPathMissing(path.join(downloadsDir, "report.txt.transfer-1.part"));
    await expectPathMissing(path.join(downloadsDir, "report.txt.transfer-1.part.json"));
  });

  it("streams Firebase Storage downloads to disk without base64 chunk buffering", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-storage-files-"));
    const body = Readable.from([Buffer.from("storage "), Buffer.from("payload")]);

    const result = await saveTransferredFileDownloadStream(
      {
        id: "file-storage-1",
        filename: "storage.txt",
        fileData: "",
        transferId: "transfer-storage",
        totalBytes: 15,
        storagePath: "sessions/session-1/files/transfer-storage/storage.txt",
        delivery: "firebase-storage",
        fileSha256: computeSha256(Buffer.from("storage payload")),
      },
      body,
      { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir },
    );

    expect(result).toMatchObject({
      filename: "storage.txt",
      receivedBytes: 15,
      receivedChunks: 1,
      status: "complete",
      totalChunks: 1,
      transferId: "transfer-storage",
    });
    await expect(readFile(path.join(downloadsDir, "storage.txt"), "utf8")).resolves.toBe("storage payload");
  });
});

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toThrow();
}
