import { parseWebRtcFileChunk, WEBRTC_FILE_CHUNK_BYTES, type WebRtcFileChunkMessage, type WebRtcFileAckMessage } from "./webrtcFileTransfer";
import { sha256BlobHex } from "./blobHash";

type State = { id: string; filename: string; totalBytes: number; totalChunks: number; receivedChunks: number; receivedBytes: number; fileHash?: string; complete: boolean };
type StoredChunk = { blob: Blob; hash: string };
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error);
});
const committed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error("File storage transaction aborted."));
  tx.onerror = () => reject(tx.error ?? new Error("File storage transaction failed."));
});

export class PersistentFileReceiver {
  private db: Promise<IDBDatabase>;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(databaseName: string, private onComplete: (file: { transferId: string; filename: string; blob: Blob }) => Promise<void>) {
    this.db = new Promise((resolve, reject) => {
      const opening = indexedDB.open(databaseName, 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore("state");
        opening.result.createObjectStore("chunks");
      };
      opening.onsuccess = () => {
        const db = opening.result;
        db.onversionchange = () => { this.closed = true; db.close(); };
        resolve(db);
      };
      opening.onerror = () => reject(opening.error);
    });
    void this.db.catch(() => {});
  }

  close(): void { this.closed = true; void this.db.then(db => db.close(), () => {}); }

  restore() {
    return this.enqueue(async () => {
      const db = await this.db;
      const tx = db.transaction("state", "readonly");
      const state = await request<State | undefined>(tx.objectStore("state").get("current"));
      if (!state || this.closed) return null;
      let blob: Blob | null = null;
      if (state.complete) {
        const read = db.transaction("chunks", "readonly");
        const parts = await request<StoredChunk[]>(read.objectStore("chunks").getAll());
        blob = new Blob(parts.map(part => part.blob));
        if (blob.size !== state.totalBytes || await sha256BlobHex(blob) !== state.fileHash) throw new Error("Stored file failed verification.");
      }
      if (this.closed) return null;
      return { transferId: state.id, filename: state.filename, receivedBytes: state.receivedBytes, totalBytes: state.totalBytes, blob };
    });
  }

  discard(): Promise<void> {
    return this.enqueue(async () => {
      const db = await this.db;
      const tx = db.transaction(["state", "chunks"], "readwrite");
      const done = committed(tx);
      tx.objectStore("state").clear(); tx.objectStore("chunks").clear();
      await done;
    });
  }

  accept(chunk: WebRtcFileChunkMessage, isCurrent: () => boolean = () => true): Promise<WebRtcFileAckMessage | null> {
    return this.enqueue(async () => {
      const current = () => !this.closed && isCurrent();
      if (!current()) return null;
      if (!parseWebRtcFileChunk(JSON.stringify(chunk)) || chunk.purpose === "clipboard-image") throw new Error("Invalid incoming file.");
      const bytes = Uint8Array.from(atob(chunk.fileData), char => char.charCodeAt(0));
      const expected = Math.min(WEBRTC_FILE_CHUNK_BYTES, chunk.totalBytes - chunk.chunkIndex * WEBRTC_FILE_CHUNK_BYTES);
      if (bytes.length !== expected || chunk.totalChunks !== Math.max(1, Math.ceil(chunk.totalBytes / WEBRTC_FILE_CHUNK_BYTES))) throw new Error("Invalid incoming file length.");
      const blob = new Blob([bytes]);
      const hash = await sha256BlobHex(blob);
      if (hash !== chunk.chunkSha256.toLowerCase() || (chunk.isLast && !chunk.fileSha256)) throw new Error("Invalid incoming file checksum.");
      if (!current()) return null;
      const db = await this.db;
      const tx = db.transaction(["state", "chunks"], "readwrite");
      const done = committed(tx);
      // Attach rejection before request callbacks so aborted writes never escape unobserved.
      void done.catch(() => {});
      let state: State;
      try {
        const states = tx.objectStore("state"), chunks = tx.objectStore("chunks");
        const previous = await request<State | undefined>(states.get("current"));
        if (!previous) {
          if (chunk.chunkIndex !== 0) throw new Error("File must start with its first chunk.");
          chunks.clear();
          state = { id: chunk.transferId, filename: chunk.filename, totalBytes: chunk.totalBytes, totalChunks: chunk.totalChunks, receivedChunks: 0, receivedBytes: 0, complete: false };
        } else state = previous;
        if (state.id !== chunk.transferId || state.filename !== chunk.filename || state.totalBytes !== chunk.totalBytes || state.totalChunks !== chunk.totalChunks) throw new Error("Another or different file is already stored.");
        if (chunk.chunkIndex < state.receivedChunks) {
          const stored = await request<StoredChunk | undefined>(chunks.get(chunk.chunkIndex));
          if (!stored || stored.hash !== hash || (chunk.isLast && state.fileHash !== chunk.fileSha256?.toLowerCase())) throw new Error("Duplicate file chunk changed.");
        } else {
          if (chunk.chunkIndex !== state.receivedChunks) throw new Error("File chunk is out of order.");
          chunks.put({ blob, hash } satisfies StoredChunk, chunk.chunkIndex);
          state.receivedChunks++; state.receivedBytes += blob.size;
          if (chunk.isLast) state.fileHash = chunk.fileSha256!.toLowerCase();
          states.put(state, "current");
        }
      } catch (error) {
        tx.abort(); await done.catch(() => {}); throw error;
      }
      await done;
      if (!current()) return null;
      if (!state.complete && state.receivedChunks === state.totalChunks) {
        const read = db.transaction("chunks", "readonly");
        const parts = await request<StoredChunk[]>(read.objectStore("chunks").getAll());
        const file = new Blob(parts.map(part => part.blob));
        if (file.size !== state.totalBytes || await sha256BlobHex(file) !== state.fileHash) throw new Error("Incoming file failed final verification.");
        if (!current()) return null;
        await this.onComplete({ transferId: state.id, filename: state.filename, blob: file });
        if (!current()) return null;
        state.complete = true;
        const save = db.transaction("state", "readwrite");
        const saved = committed(save);
        save.objectStore("state").put(state, "current");
        await saved;
      }
      return { type: "file-ack", transferId: state.id, receivedBytes: state.receivedBytes, receivedChunks: state.receivedChunks, status: state.complete ? "complete" : "partial" };
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => { if (this.closed) throw new Error("File receiver closed."); return task(); });
    this.tail = result.catch(() => {});
    return result;
  }
}
