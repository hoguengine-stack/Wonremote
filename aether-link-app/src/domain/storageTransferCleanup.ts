export const STORAGE_TRANSFER_CLEANUP_KEY = "wonremote-storage-transfer-cleanup";

export type StorageTransferCleanupEntry = {
  path: string;
  received: boolean;
};

export function parseStorageTransferCleanup(value: string | null): Map<string, StorageTransferCleanupEntry> {
  if (!value) return new Map();
  try {
    const parsed = JSON.parse(value) as Record<string, Partial<StorageTransferCleanupEntry>>;
    return new Map(
      Object.entries(parsed).flatMap(([transferId, entry]) =>
        transferId.trim() && typeof entry.path === "string" && entry.path.startsWith("sessions/")
          ? [[transferId, { path: entry.path, received: entry.received === true }] as const]
          : [],
      ),
    );
  } catch {
    return new Map();
  }
}

export function serializeStorageTransferCleanup(entries: Map<string, StorageTransferCleanupEntry>): string {
  return JSON.stringify(Object.fromEntries(entries));
}
