import { Readable } from "node:stream";
import { REMOTE_FILE_MAX_BYTES } from "../domain/fileTransferPolicy";
import type { TransferredFile } from "../domain/types";
import {
  discardTransferredFileDownload,
  inspectTransferredFileDownload,
  saveTransferredFileDownloadStream,
  type ReceivedFileResult,
} from "./fileTransferReceiver";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FirebaseStorageDownloadOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  maxAttempts?: number;
}

export async function downloadFirebaseStorageFile(
  file: TransferredFile,
  downloadUrl: string,
  options: FirebaseStorageDownloadOptions = {},
): Promise<ReceivedFileResult> {
  validateStorageIntegrityMetadata(file);
  const maxAttempts = Math.min(5, Math.max(1, Math.trunc(options.maxAttempts ?? 3)));
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await downloadFirebaseStorageFileAttempt(file, downloadUrl, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function downloadFirebaseStorageFileAttempt(
  file: TransferredFile,
  downloadUrl: string,
  options: FirebaseStorageDownloadOptions,
): Promise<ReceivedFileResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  let state = await inspectTransferredFileDownload(file, env);
  const expectedBytes = Number(file.totalBytes);

  if (state.receivedBytes > expectedBytes) {
    await discardTransferredFileDownload(file, env);
    state = await inspectTransferredFileDownload(file, env);
  }
  if (state.receivedBytes === expectedBytes) {
    return saveTransferredFileDownloadStream(file, Readable.from([]), env, {
      appendFromBytes: state.receivedBytes,
    });
  }

  const resumeOffset = state.receivedBytes;
  const response = await fetchImpl(
    downloadUrl,
    resumeOffset > 0 ? { headers: { Range: `bytes=${resumeOffset}-` } } : undefined,
  );
  if (!response.ok || !response.body) {
    throw new Error(`Firebase Storage download failed: HTTP ${response.status}`);
  }

  let appendFromBytes = 0;
  if (response.status === 206) {
    if (!contentRangeMatches(response.headers.get("content-range"), resumeOffset, expectedBytes)) {
      await discardTransferredFileDownload(file, env);
      throw new Error(`Firebase Storage returned an invalid Content-Range for ${file.filename}.`);
    }
    appendFromBytes = resumeOffset;
  } else if (response.status !== 200) {
    throw new Error(`Firebase Storage returned unsupported HTTP ${response.status}.`);
  }

  return saveTransferredFileDownloadStream(file, response.body, env, { appendFromBytes });
}

function validateStorageIntegrityMetadata(file: TransferredFile): void {
  if (
    !Number.isSafeInteger(file.totalBytes) ||
    Number(file.totalBytes) < 0 ||
    Number(file.totalBytes) > REMOTE_FILE_MAX_BYTES
  ) {
    throw new Error(`Firebase Storage file has invalid totalBytes: ${file.filename}`);
  }
  if (typeof file.fileSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.fileSha256)) {
    throw new Error(`Firebase Storage file has invalid SHA-256 metadata: ${file.filename}`);
  }
}

function contentRangeMatches(header: string | null, expectedStart: number, expectedTotal: number): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(header?.trim() ?? "");
  if (!match) {
    return false;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  return (
    start === expectedStart &&
    Number.isSafeInteger(end) &&
    end >= start &&
    total === expectedTotal
  );
}
