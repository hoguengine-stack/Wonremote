import { REMOTE_FILE_MAX_BYTES } from "./fileTransferPolicy";

export const WEBRTC_FILE_CHANNEL_LABEL = "wonremote-files";
export const WEBRTC_FILE_CHUNK_BYTES = 32 * 1024;
export const WEBRTC_FILE_WINDOW_CHUNKS = 8;
export const WEBRTC_FILE_ACK_TIMEOUT_MS = 20_000;
export const MAX_WEBRTC_FILE_MESSAGE_BYTES = 64 * 1024;
export const WEBRTC_FILE_MAX_CHUNKS = Math.ceil(REMOTE_FILE_MAX_BYTES / WEBRTC_FILE_CHUNK_BYTES);

export type WebRtcFileChunkMessage = {
  type: "file-chunk";
  transferId: string;
  filename: string;
  chunkIndex: number;
  totalChunks: number;
  totalBytes: number;
  isLast: boolean;
  fileData: string;
  chunkSha256: string;
  fileSha256?: string;
};

export type WebRtcFileAckMessage = {
  type: "file-ack";
  transferId: string;
  receivedBytes: number;
  receivedChunks: number;
  status: "complete" | "duplicate" | "error" | "partial";
  error?: string;
};

export function serializeWebRtcFileChunk(message: WebRtcFileChunkMessage): string {
  validateFileChunk(message);
  const payload = JSON.stringify(message);
  if (encodedBytes(payload) > MAX_WEBRTC_FILE_MESSAGE_BYTES) {
    throw new Error("WebRTC file chunk message is too large.");
  }
  return payload;
}

export function parseWebRtcFileChunk(payload: unknown): WebRtcFileChunkMessage | null {
  const parsed = parseJsonObject(payload);
  if (!parsed || parsed.type !== "file-chunk") {
    return null;
  }
  try {
    const message = parsed as unknown as WebRtcFileChunkMessage;
    validateFileChunk(message);
    return message;
  } catch {
    return null;
  }
}

export function serializeWebRtcFileAck(message: WebRtcFileAckMessage): string {
  validateFileAck(message);
  return JSON.stringify(message);
}

export function parseWebRtcFileAck(payload: unknown): WebRtcFileAckMessage | null {
  const parsed = parseJsonObject(payload);
  if (!parsed || parsed.type !== "file-ack") {
    return null;
  }
  try {
    const message = parsed as unknown as WebRtcFileAckMessage;
    validateFileAck(message);
    return message;
  } catch {
    return null;
  }
}

function validateFileChunk(message: WebRtcFileChunkMessage): void {
  if (
    message.type !== "file-chunk" ||
    !isSafeTransferId(message.transferId) ||
    !isSafeText(message.filename, 1_024) ||
    !Number.isInteger(message.chunkIndex) ||
    !Number.isInteger(message.totalChunks) ||
    !Number.isSafeInteger(message.totalBytes) ||
    message.chunkIndex < 0 ||
    message.totalChunks < 1 ||
    message.totalChunks > WEBRTC_FILE_MAX_CHUNKS ||
    message.chunkIndex >= message.totalChunks ||
    message.totalBytes < 0 ||
    message.totalBytes > REMOTE_FILE_MAX_BYTES ||
    message.isLast !== (message.chunkIndex === message.totalChunks - 1) ||
    typeof message.fileData !== "string" ||
    encodedBytes(message.fileData) > Math.ceil((WEBRTC_FILE_CHUNK_BYTES * 4) / 3) + 8 ||
    !isSha256(message.chunkSha256) ||
    (message.fileSha256 !== undefined && !isSha256(message.fileSha256))
  ) {
    throw new Error("WebRTC file chunk is invalid.");
  }
}

function validateFileAck(message: WebRtcFileAckMessage): void {
  if (
    message.type !== "file-ack" ||
    !isSafeText(message.transferId, 200) ||
    !Number.isSafeInteger(message.receivedBytes) ||
    !Number.isInteger(message.receivedChunks) ||
    message.receivedBytes < 0 ||
    message.receivedChunks < 0 ||
    !["complete", "duplicate", "error", "partial"].includes(message.status) ||
    (message.error !== undefined && !isSafeText(message.error, 1_000))
  ) {
    throw new Error("WebRTC file acknowledgement is invalid.");
  }
}

function parseJsonObject(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "string" || encodedBytes(payload) > MAX_WEBRTC_FILE_MESSAGE_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isSafeText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && encodedBytes(value) <= maxBytes;
}

function isSafeTransferId(value: unknown): value is string {
  return (
    isSafeText(value, 200) &&
    value !== "." &&
    value !== ".." &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
