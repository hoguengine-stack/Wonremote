import { saveTransferredFileChunk } from "./fileTransferReceiver";
import { resolveClipboardImageRoot } from "./clipboardImage";
import { rm } from "node:fs/promises";
import type { FileTransferReceipt, TransferredFile } from "../domain/types";
import type {
  WebRtcFileAckMessage,
  WebRtcFileChunkMessage,
} from "../domain/webrtcFileTransfer";

type FileReceiptInput = Omit<FileTransferReceipt, "updatedAt">;

export interface ProcessWebRtcFileChunkOptions {
  env?: Record<string, string | undefined>;
  isCurrent?: () => boolean;
  onReceiptError?: (error: unknown) => void;
  postReceipt?: (receipt: FileReceiptInput) => Promise<void>;
  saveChunk?: typeof saveTransferredFileChunk;
  onClipboardImageComplete?: (input: { targetPath: string; mimeType: "image/png" }) => Promise<void> | void;
  clipboardImageRoot?: string;
}

export async function processWebRtcFileChunk(
  chunk: WebRtcFileChunkMessage,
  options: ProcessWebRtcFileChunkOptions = {},
): Promise<WebRtcFileAckMessage | null> {
  const isCurrent = options.isCurrent ?? (() => true);
  if (!isCurrent()) {
    return null;
  }

  try {
    const isClipboardImage = chunk.purpose === "clipboard-image";
    if (isClipboardImage && !options.onClipboardImageComplete) {
      throw new Error("Clipboard image completion handler is unavailable.");
    }
    const saveChunk = options.saveChunk ?? saveTransferredFileChunk;
    const saveChunkInput = isClipboardImage
      ? { ...toTransferredFile(chunk), filename: `${chunk.transferId}.png` }
      : toTransferredFile(chunk);
    const saveEnv = isClipboardImage
      ? {
        ...(options.env ?? process.env),
        WONREMOTE_AGENT_DOWNLOADS_DIR: options.clipboardImageRoot ?? resolveClipboardImageRoot(options.env ?? process.env),
      }
      : options.env ?? process.env;
    const result = await saveChunk(saveChunkInput, saveEnv);
    if (!isCurrent()) {
      return null;
    }

    if (result.status === "complete") {
      if (isClipboardImage) {
        try {
          await options.onClipboardImageComplete!({ targetPath: result.targetPath, mimeType: "image/png" });
        } catch (error) {
          await rm(result.targetPath, { force: true });
          throw error;
        }
      }
      postReceiptWithoutBreakingChannel(options, {
        transferId: chunk.transferId,
        filename: chunk.filename,
        status: "received",
        receivedChunks: result.receivedChunks,
        totalChunks: result.totalChunks,
        receivedBytes: result.receivedBytes,
        savedPath: result.targetPath,
      });
    }

    return {
      type: "file-ack",
      transferId: chunk.transferId,
      receivedBytes: result.receivedBytes,
      receivedChunks: result.receivedChunks,
      status: result.status,
    };
  } catch (error) {
    if (!isCurrent()) {
      return null;
    }
    const message = protocolSafeError(error);
    postReceiptWithoutBreakingChannel(options, {
      transferId: chunk.transferId,
      filename: chunk.filename,
      status: "failed",
      receivedChunks: 0,
      totalChunks: chunk.totalChunks,
      receivedBytes: 0,
      error: message,
    });
    return {
      type: "file-ack",
      transferId: chunk.transferId,
      receivedBytes: 0,
      receivedChunks: 0,
      status: "error",
      error: message,
    };
  }
}

function toTransferredFile(chunk: WebRtcFileChunkMessage): TransferredFile {
  return {
    id: `webrtc-${chunk.transferId}-${chunk.chunkIndex}`,
    filename: chunk.filename,
    fileData: chunk.fileData,
    transferId: chunk.transferId,
    chunkIndex: chunk.chunkIndex,
    totalChunks: chunk.totalChunks,
    totalBytes: chunk.totalBytes,
    isLast: chunk.isLast,
    chunkSha256: chunk.chunkSha256,
    fileSha256: chunk.fileSha256,
    purpose: chunk.purpose,
    mimeType: chunk.mimeType,
    delivery: "firestore-direct",
  };
}

function postReceiptWithoutBreakingChannel(
  options: ProcessWebRtcFileChunkOptions,
  receipt: FileReceiptInput,
): void {
  if (!options.postReceipt) {
    return;
  }
  try {
    void options.postReceipt(receipt).catch((error) => {
      reportReceiptError(options, error);
    });
  } catch (error) {
    reportReceiptError(options, error);
  }
}

function reportReceiptError(options: ProcessWebRtcFileChunkOptions, error: unknown): void {
  try {
    options.onReceiptError?.(error);
  } catch {
    // Receipt diagnostics must not interrupt file-channel acknowledgement.
  }
}

function protocolSafeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message || "WebRTC file transfer failed.").slice(0, 200).join("");
}
