import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import { resolveAgentDownloadDir, resolveSafeDownloadPath } from "./fileSafety";
import { computeSha256 } from "./checksum";
import type { TransferredFile } from "../domain/types";

export type ReceivedFileStatus = "partial" | "complete" | "duplicate";

export interface ReceivedFileResult {
  filename: string;
  receivedBytes: number;
  receivedChunks: number;
  status: ReceivedFileStatus;
  targetPath: string;
  totalChunks: number;
  transferId?: string;
}

interface TransferPartState {
  filename: string;
  nextChunkIndex: number;
  receivedBytes: number;
  totalChunks: number;
}

export async function saveTransferredFileChunk(
  file: TransferredFile,
  env: Record<string, string | undefined> = process.env,
): Promise<ReceivedFileResult> {
  const downloadsDir = resolveAgentDownloadDir(env);
  await mkdir(downloadsDir, { recursive: true });
  const targetPath = resolveSafeDownloadPath(downloadsDir, String(file.filename ?? ""));
  const buffer = Buffer.from(String(file.fileData ?? ""), "base64");

  if (typeof file.transferId !== "string" || !Number.isInteger(file.chunkIndex)) {
    verifyChunkChecksum(file, buffer);
    await writeFile(targetPath, buffer);
    return {
      filename: file.filename,
      receivedBytes: buffer.length,
      receivedChunks: 1,
      status: "complete",
      targetPath,
      totalChunks: 1,
    };
  }

  const transferId = sanitizeTransferId(file.transferId);
  const chunkIndex = Number(file.chunkIndex);
  const totalChunks = Math.max(1, Number(file.totalChunks ?? chunkIndex + 1));
  const partPath = `${targetPath}.${transferId}.part`;
  const statePath = `${partPath}.json`;

  try {
    verifyChunkChecksum(file, buffer);

    let nextState: TransferPartState;
    if (chunkIndex === 0) {
      await writeFile(partPath, buffer);
      nextState = {
        filename: file.filename,
        nextChunkIndex: 1,
        receivedBytes: buffer.length,
        totalChunks,
      };
    } else {
      const state = await readPartState(statePath, file.filename);
      if (chunkIndex < state.nextChunkIndex) {
        return {
          filename: file.filename,
          receivedBytes: state.receivedBytes,
          receivedChunks: state.nextChunkIndex,
          status: "duplicate",
          targetPath,
          totalChunks: state.totalChunks,
          transferId,
        };
      }
      if (chunkIndex > state.nextChunkIndex) {
        throw new Error(
          `Missing file chunk for ${file.filename}: expected ${state.nextChunkIndex}, got ${chunkIndex}`,
        );
      }

      await appendFile(partPath, buffer);
      nextState = {
        filename: state.filename,
        nextChunkIndex: state.nextChunkIndex + 1,
        receivedBytes: state.receivedBytes + buffer.length,
        totalChunks: state.totalChunks || totalChunks,
      };
    }

    const receivedChunks = nextState.nextChunkIndex;
    await writeFile(statePath, JSON.stringify(nextState, null, 2), "utf8");

    if (file.isLast) {
      if (receivedChunks < totalChunks) {
        throw new Error(`Incomplete file transfer for ${file.filename}: ${receivedChunks}/${totalChunks} chunks`);
      }
      if (typeof file.fileSha256 === "string" && file.fileSha256.trim()) {
        const actualSha256 = await hashFileSha256(partPath);
        if (actualSha256 !== file.fileSha256.trim().toLowerCase()) {
          throw new Error(`File checksum mismatch: ${file.filename}`);
        }
      }
      await rm(targetPath, { force: true });
      await rename(partPath, targetPath);
      await rm(statePath, { force: true });
      return {
        filename: file.filename,
        receivedBytes: nextState.receivedBytes,
        receivedChunks,
        status: "complete",
        targetPath,
        totalChunks,
        transferId,
      };
    }

    return {
      filename: file.filename,
      receivedBytes: nextState.receivedBytes,
      receivedChunks,
      status: "partial",
      targetPath,
      totalChunks,
      transferId,
    };
  } catch (error) {
    await discardTransferPart(partPath, statePath);
    throw error;
  }
}

export async function saveTransferredFileDownloadStream(
  file: TransferredFile,
  body: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  env: Record<string, string | undefined> = process.env,
): Promise<ReceivedFileResult> {
  const downloadsDir = resolveAgentDownloadDir(env);
  await mkdir(downloadsDir, { recursive: true });
  const targetPath = resolveSafeDownloadPath(downloadsDir, String(file.filename ?? ""));
  const transferId = typeof file.transferId === "string" ? sanitizeTransferId(file.transferId) : "storage";
  const tmpPath = `${targetPath}.${transferId}.download`;
  const readable = toNodeReadable(body);
  const writeStream = createWriteStream(tmpPath, { flags: "w" });
  const hash = createHash("sha256");
  let receivedBytes = 0;

  try {
    for await (const chunk of readable as AsyncIterable<Buffer | Uint8Array | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      hash.update(buffer);
      if (!writeStream.write(buffer)) {
        await once(writeStream, "drain");
      }
    }
    writeStream.end();
    await once(writeStream, "finish");

    if (typeof file.totalBytes === "number" && file.totalBytes >= 0 && receivedBytes !== file.totalBytes) {
      throw new Error(`Downloaded file size mismatch: ${file.filename}`);
    }
    if (typeof file.fileSha256 === "string" && file.fileSha256.trim()) {
      const actualSha256 = hash.digest("hex");
      if (actualSha256 !== file.fileSha256.trim().toLowerCase()) {
        throw new Error(`File checksum mismatch: ${file.filename}`);
      }
    }

    await rm(targetPath, { force: true });
    await rename(tmpPath, targetPath);
    return {
      filename: file.filename,
      receivedBytes,
      receivedChunks: 1,
      status: "complete",
      targetPath,
      totalChunks: 1,
      transferId: typeof file.transferId === "string" ? file.transferId : undefined,
    };
  } catch (error) {
    writeStream.destroy();
    await rm(tmpPath, { force: true });
    throw error;
  }
}

function verifyChunkChecksum(file: TransferredFile, buffer: Buffer): void {
  if (typeof file.chunkSha256 !== "string" || !file.chunkSha256.trim()) {
    return;
  }
  const computedChunkSha256 = computeSha256(buffer);
  if (computedChunkSha256 !== file.chunkSha256.trim().toLowerCase()) {
    throw new Error(`File chunk checksum mismatch: ${file.filename} #${file.chunkIndex ?? 0}`);
  }
}

async function readPartState(statePath: string, filename: string): Promise<TransferPartState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<TransferPartState>;
    if (
      typeof parsed.filename === "string" &&
      Number.isInteger(parsed.nextChunkIndex) &&
      Number.isFinite(parsed.receivedBytes)
    ) {
      return {
        filename: parsed.filename,
        nextChunkIndex: Number(parsed.nextChunkIndex),
        receivedBytes: Number(parsed.receivedBytes),
        totalChunks: Number(parsed.totalChunks ?? 0),
      };
    }
  } catch {
    // Fall through to a clear transfer-order error below.
  }
  throw new Error(`Missing first file chunk for ${filename}`);
}

function sanitizeTransferId(transferId: string): string {
  return transferId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "transfer";
}

function toNodeReadable(body: NodeJS.ReadableStream | ReadableStream<Uint8Array>): NodeJS.ReadableStream {
  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    return Readable.fromWeb(body as any);
  }
  return body as NodeJS.ReadableStream;
}

async function discardTransferPart(partPath: string, statePath: string): Promise<void> {
  await Promise.all([
    rm(partPath, { force: true }),
    rm(statePath, { force: true }),
  ]);
}

function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
