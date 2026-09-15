import { sha256BlobHex } from "./blobHash";

export class AndroidFileExporter {
  private port: MessagePort | null = null;
  private pending: { resolve: (value: any) => void; reject: (error: Error) => void } | null = null;
  private saving = false;
  attach(port: MessagePort) {
    this.pending?.reject(new Error("저장 연결이 변경되었습니다."));
    this.port?.close();
    this.port = port;
    port.onmessage = event => {
      if (this.port !== port || typeof event.data !== "string" || event.data.length > 1024) return;
      try { this.pending?.resolve(JSON.parse(event.data)); }
      catch { this.pending?.reject(new Error("저장 응답이 올바르지 않습니다.")); }
    };
    port.onmessageerror = () => this.pending?.reject(new Error("저장 연결 오류"));
    port.start();
  }
  available() { return this.port !== null; }
  async save(file: { id: string; filename: string; blob: Blob }, signal: AbortSignal): Promise<boolean> {
    if (this.saving || !this.port) throw new Error("파일 저장을 사용할 수 없습니다.");
    this.saving = true;
    const port = this.port;
    const request = (message: unknown, timeout = 20000) => new Promise<any>((resolve, reject) => {
      if (signal.aborted || this.port !== port) { reject(new Error("저장이 취소되었습니다.")); return; }
      const finish = (error: Error | null, value?: any) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        this.pending = null;
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new Error("저장이 취소되었습니다."));
      const timer = setTimeout(() => finish(new Error("저장 응답 시간이 초과되었습니다.")), timeout);
      this.pending = { resolve: value => finish(null, value), reject: error => finish(error) };
      signal.addEventListener("abort", abort, { once: true });
      try { port.postMessage(JSON.stringify(message)); } catch { finish(new Error("저장 연결 오류")); }
    });
    try {
      const hash = await sha256BlobHex(file.blob);
      const ready = await request({ type: "begin", file: { id: file.id, filename: file.filename, totalBytes: file.blob.size, sha256: hash } }, 120000);
      if (ready?.type === "cancelled") return false;
      if (ready?.type !== "ready" || ready.id !== file.id) throw new Error("파일 저장 위치를 열지 못했습니다.");
      for (let offset = 0, index = 0; offset < file.blob.size; offset += 32768, index++) {
        const bytes = new Uint8Array(await file.blob.slice(offset, offset + 32768).arrayBuffer());
        const data = btoa(String.fromCharCode(...bytes));
        const ack = await request({ type: "chunk", id: file.id, index, data });
        if (ack?.type !== "ack" || ack.id !== file.id || ack.index !== index || ack.receivedBytes !== offset + bytes.length) throw new Error("파일 저장 확인에 실패했습니다.");
      }
      const saved = await request({ type: "finish", id: file.id });
      if (saved?.type !== "saved" || saved.id !== file.id || saved.receivedBytes !== file.blob.size) throw new Error("파일 저장을 완료하지 못했습니다.");
      return true;
    } catch (error) {
      try { port.postMessage(JSON.stringify({ type: "cancel", id: file.id })); } catch { /* Already closed. */ }
      throw error;
    } finally { this.saving = false; }
  }
}

export const androidFileExporter = new AndroidFileExporter();
if (typeof window !== "undefined") {
  window.addEventListener("message", event => {
    if (window.location.origin !== "https://wonremote-a7fd3.web.app" || event.source !== null) return;
    if (event.origin !== "" || event.data !== "wonremote:file-export:1" || event.ports.length !== 1) return;
    androidFileExporter.attach(event.ports[0]);
  });
}
