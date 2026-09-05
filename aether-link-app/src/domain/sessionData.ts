import type { ChatMessage, ClipboardData, FileTransferReceipt, TransferredFile } from "./types";

export interface SessionData {
  messages: ChatMessage[];
  clipboards: ClipboardData[];
  files: TransferredFile[];
  receipts: FileTransferReceipt[];
}

export interface SessionDataOptions {
  clipboard?: boolean;
  receiptIds?: string[];
  queues?: boolean;
}

export const emptySessionData = (): SessionData => ({ messages: [], clipboards: [], files: [], receipts: [] });
