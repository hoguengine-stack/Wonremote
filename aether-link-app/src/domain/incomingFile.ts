import type { TransferredFile } from "./types";
import { FIRESTORE_DIRECT_FILE_TRANSFER_MAX_BYTES, REMOTE_FILE_CHUNK_BYTES } from "./fileTransferPolicy";
import { sha256BlobHex } from "./blobHash";

type PartialFile = { filename: string; totalBytes: number; totalChunks: number; chunks: Map<number, Uint8Array>; hashes: Map<number,string>; fileHash?: string; received: number };
const hash = (bytes: Uint8Array) => sha256BlobHex(new Blob([bytes as BlobPart]));

export class IncomingFileAssembler {
  private files = new Map<string, PartialFile>();
  private completed = new Set<string>();
  private buffered = 0;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();

  clear() { this.generation++; this.files.clear(); this.completed.clear(); this.buffered = 0; }

  accept(file: TransferredFile): Promise<{filename:string; blob:Blob} | null> {
    const generation = this.generation;
    const next = this.tail.then(() => generation === this.generation ? this.receive(file, generation) : null).catch(error => {
      if (generation === this.generation) {
        const id = file.transferId ?? file.id;
        const partial = this.files.get(id);
        if (partial) { this.buffered -= partial.received; this.files.delete(id); }
      }
      throw error;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async receive(file: TransferredFile, generation: number) {
    const id = file.transferId ?? file.id;
    if (this.completed.has(id)) return null;
    if (file.delivery === "firebase-storage") throw new Error("원격 Storage 파일 수신은 아직 지원하지 않습니다.");
    const segmented = file.transferId !== undefined;
    const index = file.chunkIndex ?? 0;
    const count = file.totalChunks ?? 1;
    const fail = () => new Error("원격 파일 조각 또는 검증 정보가 올바르지 않습니다.");
    if (!id || id.length > 256 || file.fileData.length > Math.ceil(REMOTE_FILE_CHUNK_BYTES / 3) * 4 ||
      !Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 80 || index < 0 || index >= count) throw fail();
    const bytes = Uint8Array.from(atob(file.fileData), value => value.charCodeAt(0));
    const total = file.totalBytes ?? bytes.length;
    if (!Number.isSafeInteger(total) || total < 0 || total > FIRESTORE_DIRECT_FILE_TRANSFER_MAX_BYTES ||
      bytes.length > REMOTE_FILE_CHUNK_BYTES || (segmented && (!file.chunkSha256 || file.isLast !== (index === count - 1)))) throw fail();
    const chunkHash = await hash(bytes);
    if (generation !== this.generation) return null;
    if (file.chunkSha256 && chunkHash !== file.chunkSha256.toLowerCase()) throw fail();
    let partial = this.files.get(id);
    if (!partial) {
      if (this.files.size >= 4) throw new Error("수신 중인 파일이 너무 많습니다.");
      partial = {filename:file.filename,totalBytes:total,totalChunks:count,chunks:new Map(),hashes:new Map(),received:0};
      this.files.set(id,partial);
    }
    if (partial.filename !== file.filename || partial.totalBytes !== total || partial.totalChunks !== count) throw fail();
    if (partial.hashes.has(index)) {
      if (partial.hashes.get(index) !== chunkHash) throw fail();
      return null;
    }
    if (partial.received + bytes.length > total || this.buffered + bytes.length > 2 * FIRESTORE_DIRECT_FILE_TRANSFER_MAX_BYTES) throw fail();
    if (index === count - 1) {
      if (segmented && !/^[a-f0-9]{64}$/i.test(file.fileSha256 ?? "")) throw fail();
      partial.fileHash = file.fileSha256?.toLowerCase();
    }
    partial.chunks.set(index,bytes); partial.hashes.set(index,chunkHash);
    partial.received += bytes.length; this.buffered += bytes.length;
    if (partial.chunks.size !== count) return null;
    const blob = new Blob(Array.from({length:count},(_,i) => partial!.chunks.get(i)! as BlobPart));
    const valid = blob.size === total && (!partial.fileHash || await sha256BlobHex(blob) === partial.fileHash);
    if (generation !== this.generation) return null;
    this.files.delete(id); this.buffered -= partial.received;
    if (!valid) throw fail();
    this.completed.add(id);
    if (this.completed.size > 200) this.completed.delete(this.completed.values().next().value!);
    return {filename:file.filename,blob};
  }
}
