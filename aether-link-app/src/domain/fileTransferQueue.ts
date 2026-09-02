export type FileTransferStatus =
  | "queued"
  | "transferring"
  | "completed"
  | "failed"
  | "cancelled";

export interface FileTransferQueueItem {
  id: string;
  fileName: string;
  totalBytes: number;
  sentBytes: number;
  status: FileTransferStatus;
  speedBytesPerSecond: number;
  error?: string;
}

export interface CreateFileTransferQueueItemInput {
  id: string;
  fileName: string;
  totalBytes: number;
  speedBytesPerSecond?: number;
}

export function appendFileTransferQueueItems(
  current: readonly FileTransferQueueItem[],
  additions: readonly FileTransferQueueItem[],
  maxVisible = 12,
): FileTransferQueueItem[] {
  const combined = [...current, ...additions];
  const active = combined.filter((item) => !isTerminal(item.status));
  const terminal = combined.filter((item) => isTerminal(item.status));
  const terminalLimit = Math.max(0, Math.trunc(maxVisible) - active.length);
  return [...(terminalLimit > 0 ? terminal.slice(-terminalLimit) : []), ...active];
}

export function createFileTransferQueueItem(
  input: CreateFileTransferQueueItemInput,
): FileTransferQueueItem {
  return {
    id: input.id.trim(),
    fileName: input.fileName.trim(),
    totalBytes: normalizeBytes(input.totalBytes),
    sentBytes: 0,
    status: "queued",
    speedBytesPerSecond: isValidSpeed(input.speedBytesPerSecond) ? input.speedBytesPerSecond : 0,
  };
}

export function markFileTransferTransferring(
  item: FileTransferQueueItem,
  speedBytesPerSecond?: number,
): FileTransferQueueItem {
  if (isTerminal(item.status)) {
    return item;
  }
  return {
    ...item,
    status: "transferring",
    error: undefined,
    ...(isValidSpeed(speedBytesPerSecond)
      ? { speedBytesPerSecond }
      : {}),
  };
}

export function updateFileTransferProgress(
  item: FileTransferQueueItem,
  sentBytes: number,
  speedBytesPerSecond?: number,
): FileTransferQueueItem {
  if (isTerminal(item.status)) {
    return item;
  }
  const nextSpeed = isValidSpeed(speedBytesPerSecond)
    ? speedBytesPerSecond
    : item.speedBytesPerSecond;
  return {
    ...item,
    sentBytes: clampBytes(sentBytes, item.totalBytes),
    status: "transferring",
    error: undefined,
    speedBytesPerSecond: nextSpeed,
  };
}

export function completeFileTransfer(item: FileTransferQueueItem): FileTransferQueueItem {
  if (isTerminal(item.status) && item.status !== "transferring") {
    return item;
  }
  return {
    ...item,
    sentBytes: item.totalBytes,
    status: "completed",
    error: undefined,
  };
}

export function failFileTransfer(item: FileTransferQueueItem, error: string): FileTransferQueueItem {
  if (isTerminal(item.status)) {
    return item;
  }
  return {
    ...item,
    status: "failed",
    error: error.trim() || "File transfer failed.",
  };
}

export function cancelFileTransfer(item: FileTransferQueueItem): FileTransferQueueItem {
  if (isTerminal(item.status)) {
    return item;
  }
  return {
    ...item,
    status: "cancelled",
    error: undefined,
  };
}

export function getFileTransferPercent(item: FileTransferQueueItem): number {
  if (item.totalBytes <= 0) {
    return item.status === "completed" ? 100 : 0;
  }
  return Math.round((clampBytes(item.sentBytes, item.totalBytes) / item.totalBytes) * 100);
}

export function getFileTransferEtaSeconds(item: FileTransferQueueItem): number | null {
  const remainingBytes = Math.max(0, item.totalBytes - clampBytes(item.sentBytes, item.totalBytes));
  if (remainingBytes === 0) {
    return 0;
  }
  if (!isValidSpeed(item.speedBytesPerSecond) || item.speedBytesPerSecond <= 0) {
    return null;
  }
  return Math.ceil(remainingBytes / item.speedBytesPerSecond);
}

function isTerminal(status: FileTransferStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function normalizeBytes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function clampBytes(value: number, totalBytes: number): number {
  return Math.min(totalBytes, normalizeBytes(value));
}

function isValidSpeed(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}
