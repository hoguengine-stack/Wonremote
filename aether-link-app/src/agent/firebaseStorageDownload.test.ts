import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeSha256 } from "./checksum";
import { REMOTE_FILE_MAX_BYTES } from "../domain/fileTransferPolicy";
import { downloadFirebaseStorageFile } from "./firebaseStorageDownload";
import { inspectTransferredFileDownload } from "./fileTransferReceiver";

const completePayload = Buffer.from("hello world");

function storageFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-storage",
    filename: "folder/resume.txt",
    fileData: "",
    transferId: "transfer-storage",
    totalBytes: completePayload.length,
    fileSha256: computeSha256(completePayload),
    delivery: "firebase-storage" as const,
    ...overrides,
  };
}

describe("Firebase Storage resumable download", () => {
  it("requests the remaining bytes and appends a matching 206 response", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-range-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };
    const file = storageFile();
    const state = await inspectTransferredFileDownload(file, env);
    await writeFile(state.tmpPath, "hello ");
    const fetchImpl = vi.fn(async () => new Response("world", {
      status: 206,
      headers: { "content-range": "bytes 6-10/11" },
    }));

    const result = await downloadFirebaseStorageFile(file, "https://storage.example/file", { env, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith("https://storage.example/file", {
      headers: { Range: "bytes=6-" },
    });
    await expect(readFile(result.targetPath, "utf8")).resolves.toBe("hello world");
  });

  it("restarts from zero when the server ignores Range with HTTP 200", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-range-ignore-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };
    const file = storageFile();
    const state = await inspectTransferredFileDownload(file, env);
    await writeFile(state.tmpPath, "hello ");
    const fetchImpl = vi.fn(async () => new Response(completePayload, { status: 200 }));

    const result = await downloadFirebaseStorageFile(file, "https://storage.example/file", { env, fetchImpl });

    await expect(readFile(result.targetPath)).resolves.toEqual(completePayload);
  });

  it("retries an interrupted response using the newly written temp size", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-range-retry-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };
    const file = storageFile();
    let responseIndex = 0;
    const fetchImpl = vi.fn(async () => {
      responseIndex += 1;
      if (responseIndex === 1) {
        let pullCount = 0;
        const interruptedBody = new ReadableStream<Uint8Array>({
          async pull(controller) {
            pullCount += 1;
            if (pullCount === 1) {
              controller.enqueue(new TextEncoder().encode("hello "));
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
            controller.error(new Error("connection reset"));
          },
        });
        return new Response(interruptedBody, { status: 200 });
      }
      return new Response("world", {
        status: 206,
        headers: { "content-range": "bytes 6-10/11" },
      });
    });

    const result = await downloadFirebaseStorageFile(file, "https://storage.example/file", {
      env,
      fetchImpl,
      maxAttempts: 2,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://storage.example/file", undefined);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://storage.example/file", {
      headers: { Range: "bytes=6-" },
    });
    await expect(readFile(result.targetPath, "utf8")).resolves.toBe("hello world");
  });

  it("preserves a partial temp file after an HTTP failure", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-range-http-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };
    const file = storageFile();
    const state = await inspectTransferredFileDownload(file, env);
    await writeFile(state.tmpPath, "hello ");

    await expect(
      downloadFirebaseStorageFile(file, "https://storage.example/file", {
        env,
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("HTTP 503");
    await expect(readFile(state.tmpPath, "utf8")).resolves.toBe("hello ");
  });

  it("discards a partial temp file when Content-Range does not match", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-range-invalid-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };
    const file = storageFile();
    const state = await inspectTransferredFileDownload(file, env);
    await writeFile(state.tmpPath, "hello ");

    await expect(
      downloadFirebaseStorageFile(file, "https://storage.example/file", {
        env,
        fetchImpl: async () => new Response("hello world", {
          status: 206,
          headers: { "content-range": "bytes 5-10/11" },
        }),
      }),
    ).rejects.toThrow("invalid Content-Range");
    await expect(access(state.tmpPath)).rejects.toThrow();
  });

  it("aborts and discards a response as soon as it exceeds declared totalBytes", async () => {
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-range-overflow-"));
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir };
    const file = storageFile({ totalBytes: 3, fileSha256: computeSha256(Buffer.from("abc")) });
    const state = await inspectTransferredFileDownload(file, env);

    await expect(downloadFirebaseStorageFile(file, "https://storage.example/file", {
      env,
      fetchImpl: async () => new Response("oversized", { status: 200 }),
      maxAttempts: 1,
    })).rejects.toThrow("exceeds the declared size");
    await expect(access(state.tmpPath)).rejects.toThrow();
  });

  it.each([
    { overrides: { totalBytes: undefined }, error: "invalid totalBytes" },
    { overrides: { totalBytes: REMOTE_FILE_MAX_BYTES + 1 }, error: "invalid totalBytes" },
    { overrides: { fileSha256: undefined }, error: "invalid SHA-256" },
    { overrides: { fileSha256: "not-a-checksum" }, error: "invalid SHA-256" },
  ])("rejects missing or invalid Storage integrity metadata before fetch", async ({ overrides, error }) => {
    const fetchImpl = vi.fn();

    await expect(downloadFirebaseStorageFile(
      storageFile(overrides),
      "https://storage.example/file",
      { fetchImpl },
    )).rejects.toThrow(error);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts exactly 500 MB metadata without allocating the payload", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));

    await expect(downloadFirebaseStorageFile(
      storageFile({ totalBytes: REMOTE_FILE_MAX_BYTES }),
      "https://storage.example/file",
      { fetchImpl, maxAttempts: 1 },
    )).rejects.toThrow("HTTP 503");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
