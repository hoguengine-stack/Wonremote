import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { REMOTE_FILE_MAX_BYTES } from "../domain/fileTransferPolicy";
import {
  WEBRTC_FILE_ACK_TIMEOUT_MS, WEBRTC_FILE_CHUNK_BYTES, WEBRTC_FILE_WINDOW_CHUNKS,
  serializeWebRtcFileChunk, type WebRtcFileAckMessage,
} from "../domain/webrtcFileTransfer";

export interface LocalFileSendOptions {
  // A trusted local file selection supplies this path, never a remote command argument.
  sourcePath: string;
  transferId: string;
  send: (payload: string) => void;
  waitForAck: (transferId: string, receivedChunks: number, signal: AbortSignal) => Promise<WebRtcFileAckMessage>;
  signal?: AbortSignal;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

export async function sendLocalFile(options: LocalFileSendOptions): Promise<void> {
  checkCancelled(options.signal);
  const file = await open(options.sourcePath, "r");
  try {
    const original = await file.stat();
    if (!original.isFile() || original.size > REMOTE_FILE_MAX_BYTES) throw new Error("Unsupported file size or type.");
    const totalChunks = Math.max(1, Math.ceil(original.size / WEBRTC_FILE_CHUNK_BYTES));
    const hash = createHash("sha256");
    let resumedChunks = 0;
    for (let index = 0; index < totalChunks; index += 1) {
      checkCancelled(options.signal);
      const offset = index * WEBRTC_FILE_CHUNK_BYTES;
      const bytes = Buffer.alloc(Math.min(WEBRTC_FILE_CHUNK_BYTES, original.size - offset));
      let read = 0;
      while (read < bytes.length) {
        checkCancelled(options.signal);
        const result = await file.read(bytes, read, bytes.length - read, offset + read);
        if (!result.bytesRead) throw new Error("Source file changed during transfer.");
        read += result.bytesRead;
      }
      hash.update(bytes);
      const isLast = index === totalChunks - 1;
      if (isLast) {
        const current = await file.stat();
        if (current.size !== original.size || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs) {
          throw new Error("Source file changed during transfer.");
        }
      }
      checkCancelled(options.signal);
      // Skipped payload still participates in the complete source checksum.
      if (index < resumedChunks && !isLast) continue;
      options.send(serializeWebRtcFileChunk({
        type: "file-chunk", transferId: options.transferId, filename: path.basename(options.sourcePath),
        chunkIndex: index, totalChunks, totalBytes: original.size, isLast,
        fileData: bytes.toString("base64"), chunkSha256: createHash("sha256").update(bytes).digest("hex"),
        ...(isLast ? { fileSha256: hash.digest("hex") } : {}),
      }));
      const sentChunks = index + 1;
      if (sentChunks % WEBRTC_FILE_WINDOW_CHUNKS === 0 || isLast) {
        const ack = await boundedAck(options, sentChunks);
        checkCancelled(options.signal);
        if (ack.status === "error") throw new Error("Receiver rejected the file transfer.");
        const negotiatingResume = sentChunks === WEBRTC_FILE_WINDOW_CHUNKS && !isLast;
        const acceptedChunks = negotiatingResume ? ack.receivedChunks : sentChunks;
        const completedResume = negotiatingResume && acceptedChunks === totalChunks && ack.status === "complete";
        const expectedBytes = Math.min(original.size, acceptedChunks * WEBRTC_FILE_CHUNK_BYTES);
        if (ack.type !== "file-ack" || ack.transferId !== options.transferId ||
          !Number.isSafeInteger(acceptedChunks) || acceptedChunks < sentChunks ||
          (negotiatingResume && (acceptedChunks > totalChunks || (acceptedChunks === totalChunks && !completedResume))) ||
          ack.receivedChunks !== acceptedChunks || ack.receivedBytes !== expectedBytes ||
          (isLast ? ack.status !== "complete" : !completedResume && !["partial", "duplicate"].includes(ack.status))) {
          throw new Error("Invalid file acknowledgement.");
        }
        if (negotiatingResume) resumedChunks = acceptedChunks;
        // A completed-prefix ACK is not final proof: rehash skipped bytes and resend the last chunk.
        if (!completedResume) options.onProgress?.(ack.receivedBytes, original.size);
      }
    }
  } finally {
    await file.close();
  }
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("File transfer cancelled.", "AbortError");
}

async function boundedAck(options: LocalFileSendOptions, chunks: number): Promise<WebRtcFileAckMessage> {
  checkCancelled(options.signal);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("File transfer cancelled.", "AbortError"));
    options.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => reject(new Error("File acknowledgement timed out.")), WEBRTC_FILE_ACK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([options.waitForAck(options.transferId, chunks, controller.signal), cancelled]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
