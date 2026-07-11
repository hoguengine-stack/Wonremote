import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveAgentDownloadDir, resolveSafeDownloadPath } from "./fileSafety";
import { computeSha256 } from "./checksum";
import { REMOTE_FILE_MAX_BYTES } from "../domain/fileTransferPolicy";
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
  totalBytes?: number;
  totalChunks: number;
}

export interface TransferredFileDownloadState {
  receivedBytes: number;
  targetPath: string;
  tmpPath: string;
}

export interface TransferredFileDownloadOptions {
  appendFromBytes?: number;
}

class DownloadIntegrityError extends Error {}

export async function saveTransferredFileChunk(
  file: TransferredFile,
  env: Record<string, string | undefined> = process.env,
): Promise<ReceivedFileResult> {
  const targetPath = await resolveTransferredFileTargetPath(file, env);
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
  const totalChunks = Number(file.totalChunks ?? chunkIndex + 1);
  if (
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    !Number.isInteger(totalChunks) ||
    totalChunks < 1 ||
    chunkIndex >= totalChunks
  ) {
    throw new Error(`Invalid file chunk metadata for ${file.filename}`);
  }
  if (file.isLast !== undefined && file.isLast !== (chunkIndex === totalChunks - 1)) {
    throw new Error(`Invalid final file chunk marker for ${file.filename}`);
  }
  const declaredTotalBytes = resolveDeclaredTotalBytes(file.totalBytes, file.filename);
  const partPath = `${targetPath}.${transferId}.part`;
  const statePath = `${partPath}.json`;

  try {
    verifyChunkChecksum(file, buffer);

    const state = await readPartStateIfExists(statePath, file.filename);
    let nextState: TransferPartState;
    if (!state) {
      if (chunkIndex !== 0) {
        throw new Error(`Missing first file chunk for ${file.filename}`);
      }
      enforceReceivedByteLimit(buffer.length, declaredTotalBytes, file.filename);
      await writeFile(partPath, buffer);
      nextState = {
        filename: file.filename,
        nextChunkIndex: 1,
        receivedBytes: buffer.length,
        totalBytes: declaredTotalBytes,
        totalChunks,
      };
    } else {
      validatePartStateMetadata(state, file, totalChunks, declaredTotalBytes);
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

      const expectedTotalBytes = state.totalBytes ?? declaredTotalBytes;
      enforceReceivedByteLimit(state.receivedBytes + buffer.length, expectedTotalBytes, file.filename);
      await appendFile(partPath, buffer);
      nextState = {
        filename: state.filename,
        nextChunkIndex: state.nextChunkIndex + 1,
        receivedBytes: state.receivedBytes + buffer.length,
        totalBytes: expectedTotalBytes,
        totalChunks: state.totalChunks,
      };
    }

    const receivedChunks = nextState.nextChunkIndex;
    await writeFile(statePath, JSON.stringify(nextState, null, 2), "utf8");

    if (file.isLast) {
      if (receivedChunks < totalChunks) {
        throw new Error(`Incomplete file transfer for ${file.filename}: ${receivedChunks}/${totalChunks} chunks`);
      }
      if (nextState.totalBytes !== undefined && nextState.receivedBytes !== nextState.totalBytes) {
        throw new Error(
          `File size mismatch for ${file.filename}: expected ${nextState.totalBytes}, got ${nextState.receivedBytes}`,
        );
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
  options: TransferredFileDownloadOptions = {},
): Promise<ReceivedFileResult> {
  const downloadState = await inspectTransferredFileDownload(file, env);
  const { targetPath, tmpPath } = downloadState;
  const rawAppendFromBytes = options.appendFromBytes ?? 0;
  if (!Number.isSafeInteger(rawAppendFromBytes) || rawAppendFromBytes < 0) {
    throw new DownloadIntegrityError(`Invalid download resume offset for ${file.filename}`);
  }
  const appendFromBytes = Number(rawAppendFromBytes);
  const expectedTotalBytes = resolveDeclaredTotalBytes(file.totalBytes, file.filename);
  if (appendFromBytes > 0 && downloadState.receivedBytes !== appendFromBytes) {
    throw new Error(
      `Download resume offset changed for ${file.filename}: expected ${appendFromBytes}, found ${downloadState.receivedBytes}`,
    );
  }
  if (
    appendFromBytes > REMOTE_FILE_MAX_BYTES ||
    (expectedTotalBytes !== undefined && appendFromBytes > expectedTotalBytes)
  ) {
    await rm(tmpPath, { force: true });
    throw new DownloadIntegrityError(`Download resume offset exceeds the declared limit: ${file.filename}`);
  }
  const readable = toNodeReadable(body);
  const writeStream = createWriteStream(tmpPath, { flags: appendFromBytes > 0 ? "a" : "w" });
  // A response stream can fail while an asynchronous filesystem write is still completing.
  let writeError: Error | null = null;
  writeStream.on("error", (error) => {
    writeError = error;
  });

  try {
    let streamedBytes = appendFromBytes;
    for await (const chunk of readable as AsyncIterable<Buffer | Uint8Array | string>) {
      if (writeError) {
        throw writeError;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextStreamedBytes = streamedBytes + buffer.length;
      if (
        nextStreamedBytes > REMOTE_FILE_MAX_BYTES ||
        (expectedTotalBytes !== undefined && nextStreamedBytes > expectedTotalBytes)
      ) {
        throw new DownloadIntegrityError(`Downloaded file exceeds the declared size: ${file.filename}`);
      }
      if (!writeStream.write(buffer)) {
        await once(writeStream, "drain");
      }
      streamedBytes = nextStreamedBytes;
    }
    if (writeError) {
      throw writeError;
    }
    writeStream.end();
    if (writeError) {
      throw writeError;
    }
    await once(writeStream, "finish");

    const receivedBytes = (await stat(tmpPath)).size;
    if (expectedTotalBytes !== undefined && receivedBytes !== expectedTotalBytes) {
      throw new DownloadIntegrityError(`Downloaded file size mismatch: ${file.filename}`);
    }
    if (typeof file.fileSha256 === "string" && file.fileSha256.trim()) {
      const actualSha256 = await hashFileSha256(tmpPath);
      if (actualSha256 !== file.fileSha256.trim().toLowerCase()) {
        throw new DownloadIntegrityError(`File checksum mismatch: ${file.filename}`);
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
    if (error instanceof DownloadIntegrityError) {
      await rm(tmpPath, { force: true });
    }
    throw error;
  }
}

export async function inspectTransferredFileDownload(
  file: TransferredFile,
  env: Record<string, string | undefined> = process.env,
): Promise<TransferredFileDownloadState> {
  const targetPath = await resolveTransferredFileTargetPath(file, env);
  const transferId = typeof file.transferId === "string" ? sanitizeTransferId(file.transferId) : "storage";
  const tmpPath = `${targetPath}.${transferId}.download`;
  let receivedBytes = 0;
  try {
    receivedBytes = (await stat(tmpPath)).size;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return { receivedBytes, targetPath, tmpPath };
}

export async function discardTransferredFileDownload(
  file: TransferredFile,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const { tmpPath } = await inspectTransferredFileDownload(file, env);
  await rm(tmpPath, { force: true });
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

async function readPartStateIfExists(
  statePath: string,
  filename: string,
): Promise<TransferPartState | null> {
  let serialized: string;
  try {
    serialized = await readFile(statePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(serialized) as Partial<TransferPartState>;
    if (
      typeof parsed.filename === "string" &&
      Number.isInteger(parsed.nextChunkIndex) &&
      Number.isSafeInteger(parsed.receivedBytes) &&
      Number.isInteger(parsed.totalChunks) &&
      (parsed.totalBytes === undefined || Number.isSafeInteger(parsed.totalBytes))
    ) {
      return {
        filename: parsed.filename,
        nextChunkIndex: Number(parsed.nextChunkIndex),
        receivedBytes: Number(parsed.receivedBytes),
        totalBytes: parsed.totalBytes === undefined ? undefined : Number(parsed.totalBytes),
        totalChunks: Number(parsed.totalChunks),
      };
    }
  } catch {
    // Fall through to a clear corrupt-state error below.
  }
  throw new Error(`Invalid file transfer state for ${filename}`);
}

function resolveDeclaredTotalBytes(totalBytes: unknown, filename: string): number | undefined {
  if (totalBytes === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(totalBytes) ||
    Number(totalBytes) < 0 ||
    Number(totalBytes) > REMOTE_FILE_MAX_BYTES
  ) {
    throw new Error(`Invalid total file size for ${filename}`);
  }
  return Number(totalBytes);
}

function enforceReceivedByteLimit(
  receivedBytes: number,
  totalBytes: number | undefined,
  filename: string,
): void {
  if (receivedBytes > REMOTE_FILE_MAX_BYTES || (totalBytes !== undefined && receivedBytes > totalBytes)) {
    throw new Error(`File size exceeds the declared limit for ${filename}`);
  }
}

function validatePartStateMetadata(
  state: TransferPartState,
  file: TransferredFile,
  totalChunks: number,
  declaredTotalBytes: number | undefined,
): void {
  if (state.filename !== file.filename || state.totalChunks !== totalChunks) {
    throw new Error(`File transfer metadata changed for ${file.filename}`);
  }
  if (
    state.totalBytes !== undefined &&
    declaredTotalBytes !== undefined &&
    state.totalBytes !== declaredTotalBytes
  ) {
    throw new Error(`File transfer size changed for ${file.filename}`);
  }
}

function sanitizeTransferId(transferId: string): string {
  return transferId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "transfer";
}

async function resolveTransferredFileTargetPath(
  file: TransferredFile,
  env: Record<string, string | undefined>,
): Promise<string> {
  const downloadsDir = resolveAgentDownloadDir(env);
  const webkitRelativePath = (file as TransferredFile & { webkitRelativePath?: unknown }).webkitRelativePath;
  const targetPath = resolveSafeDownloadPath(
    downloadsDir,
    String(file.filename ?? ""),
    typeof webkitRelativePath === "string" ? webkitRelativePath : undefined,
  );
  await mkdir(path.dirname(targetPath), { recursive: true });
  return targetPath;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
