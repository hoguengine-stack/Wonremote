export const REMOTE_FILE_CHUNK_BYTES = 64 * 1024;
export const REMOTE_FILE_MAX_BYTES = 500 * 1024 * 1024;

export function canTransferRemoteFile(sizeBytes: number): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes >= 0 && sizeBytes <= REMOTE_FILE_MAX_BYTES;
}

export function remoteFileLimitLabel(): string {
  return "500MB";
}
