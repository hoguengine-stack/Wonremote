import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sendLocalFile } from "../agent/webrtcFileSender";
import { parseWebRtcFileChunk, type WebRtcFileAckMessage } from "./webrtcFileTransfer";
import { WEBRTC_FILE_CHUNK_BYTES } from "./webrtcFileTransfer";

let browser: Browser;
let bundle: string;
const bytes = Buffer.alloc(WEBRTC_FILE_CHUNK_BYTES * 2 + 7, 66);
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const chunks = Array.from({ length: 3 }, (_, index) => {
  const part = bytes.subarray(index * WEBRTC_FILE_CHUNK_BYTES, (index + 1) * WEBRTC_FILE_CHUNK_BYTES);
  return { type: "file-chunk", transferId: "resume-file", filename: "report.bin", chunkIndex: index, totalChunks: 3,
    totalBytes: bytes.length, isLast: index === 2, fileData: part.toString("base64"), chunkSha256: hash(part), ...(index === 2 ? { fileSha256: hash(bytes) } : {}) };
});
beforeAll(async () => {
  bundle = (await build({ entryPoints: ["src/domain/persistentFileReceiver.ts"], bundle: true, write: false, format: "iife", globalName: "Receiver", platform: "browser" })).outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });
async function page() {
  const tab = await browser.newPage();
  await tab.route("http://receiver.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>File receiver test</title>" }));
  await tab.goto("http://receiver.test/");
  await tab.addScriptTag({ content: bundle });
  return tab;
}

describe("browser persistent incoming file", () => {
  it.each([false,true])("recovers lost final ACK against reopened browser storage (changed=%s)",async changed=>{
    const tab=await page(); const root=await mkdtemp(path.join(tmpdir(),'final-ack-'));
    try {
      const original=Buffer.alloc(WEBRTC_FILE_CHUNK_BYTES*18+7,71);
      const sourcePath=path.join(root,'report.bin'); await writeFile(sourcePath,original);
      await tab.evaluate(()=>{
        const w=window as any; w.savedCount=0;
        w.receiver=new w.Receiver.PersistentFileReceiver('final-ack',async()=>{w.savedCount++;});
      });
      let queue:Promise<WebRtcFileAckMessage|null>=Promise.resolve(null);
      const sent:number[]=[];
      const send=(payload:string)=>{
        const chunk=parseWebRtcFileChunk(payload)!; sent.push(chunk.chunkIndex);
        queue=queue.then(()=>tab.evaluate(chunk=>(window as any).receiver.accept(chunk),chunk));
        void queue.catch(()=>{});
      };
      await expect(sendLocalFile({sourcePath,transferId:'lost-final',send,waitForAck:async()=>{
        const ack=await queue; if(ack?.status==='complete') throw Error('Final ACK lost'); return ack!;
      }})).rejects.toThrow('Final ACK lost');
      await tab.evaluate(()=>{
        const w=window as any; w.receiver.close();
        w.receiver=new w.Receiver.PersistentFileReceiver('final-ack',async()=>{w.savedCount++;});
      });
      sent.length=0;
      if(changed){const different=Buffer.from(original); different[WEBRTC_FILE_CHUNK_BYTES*9]^=255; await writeFile(sourcePath,different);}
      const retry=sendLocalFile({sourcePath,transferId:'lost-final',send,waitForAck:async()=> (await queue)!});
      if(changed) await expect(retry).rejects.toThrow(); else await retry;
      expect(sent).toEqual([0,1,2,3,4,5,6,7,18]);
      const result=await tab.evaluate(async()=>{
        const w=window as any; const stored=await w.receiver.restore();
        const exact=new Uint8Array(await stored.blob.arrayBuffer()).every(byte=>byte===71);
        w.receiver.close(); return {exact,count:w.savedCount};
      });
      expect(result).toEqual({exact:true,count:1});
    } finally { await tab.close(); await rm(root,{recursive:true,force:true}); }
  });
  it("resumes persisted chunks after reopening and completes exactly once", async () => {
    const tab = await page();
    try {
      await tab.evaluate(async chunks => {
        const C = (window as any).Receiver.PersistentFileReceiver;
        const first = new C("resume", async () => { throw new Error("Premature completion"); });
        await first.accept(chunks[0]); await first.accept(chunks[1]); first.close();
      }, chunks);
      await tab.reload();
      await tab.addScriptTag({ content: bundle });
      const result = await tab.evaluate(async chunks => {
        const C = (window as any).Receiver.PersistentFileReceiver;
        let saved = 0, size = 0, contentCorrect = false;
        const finish = async ({ blob }: { blob: Blob }) => { saved++; size = blob.size; contentCorrect = new Uint8Array(await blob.arrayBuffer()).every(byte => byte === 66); };
        const second = new C("resume", finish);
        const resumed = await second.accept(chunks[0]);
        const complete = await second.accept(chunks[2]);
        second.close();
        const third = new C("resume", finish);
        const restored = await third.restore();
        let replacement = "";
        try { await third.accept({ ...chunks[0], transferId: "replace-unsaved" }); } catch (error) { replacement = String(error); }
        const duplicate = await third.accept(chunks[0]);
        third.close();
        const other = new C("other-owner", finish);
        const isolated = await other.restore(); other.close();
        return { resumed, complete, duplicate, saved, size, contentCorrect, restoredSize: restored?.blob?.size, isolated, replacement };
      }, chunks);
      expect(result.resumed).toMatchObject({ status: "partial", receivedChunks: 2, receivedBytes: WEBRTC_FILE_CHUNK_BYTES * 2 });
      expect(result.complete).toMatchObject({ status: "complete", receivedChunks: 3, receivedBytes: bytes.length });
      expect(result.duplicate.status).toBe("complete");
      expect(result).toMatchObject({ saved: 1, size: bytes.length, contentCorrect: true });
      expect(result.restoredSize).toBe(bytes.length); expect(result.isolated).toBeNull();
      expect(result.replacement).toContain("already stored");
    } finally { await tab.close(); }
  });

  it("keeps failed destination saving resumable and does not mark corrupt input complete", async () => {
    const tab = await page();
    try {
      const result = await tab.evaluate(async chunks => {
        const C = (window as any).Receiver.PersistentFileReceiver;
        let attempts = 0;
        const receiver = new C("failure", async () => { if (++attempts === 1) throw new Error("destination unavailable"); });
        let corrupt = "", failure = "";
        try { await receiver.accept({ ...chunks[0], chunkSha256: "0".repeat(64) }); } catch (error) { corrupt = String(error); }
        await receiver.accept(chunks[0]); await receiver.accept(chunks[1]);
        try { await receiver.accept(chunks[2]); } catch (error) { failure = String(error); }
        const result = await receiver.accept(chunks[2]);
        await receiver.discard();
        const restarted = await receiver.accept({ ...chunks[0], transferId: "next" });
        receiver.close();
        return { corrupt, failure, result, attempts, restarted };
      }, chunks);
      expect(result.corrupt).toContain("checksum");
      expect(result.failure).toContain("destination unavailable");
      expect(result.result.status).toBe("complete");
      expect(result.attempts).toBe(2);
      expect(result.restarted).toMatchObject({ status: "partial", receivedChunks: 1 });
    } finally { await tab.close(); }
  });

  it("aborts an interrupted storage transaction without advancing the resume offset", async () => {
    const tab = await page();
    try {
      const result = await tab.evaluate(async chunks => {
        const C = (window as any).Receiver.PersistentFileReceiver;
        const receiver = new C("quota", async () => {});
        await receiver.accept(chunks[0]);
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args: [any, IDBValidKey?]) {
          if (this.name === "state") throw new DOMException("quota", "QuotaExceededError");
          return original.apply(this, args);
        };
        let failure = "";
        try { await receiver.accept(chunks[1]); } catch (error) { failure = String(error); }
        finally { IDBObjectStore.prototype.put = original; }
        const resumed = await receiver.accept(chunks[0]);
        const interrupted = await receiver.restore();
        const retry = await receiver.accept(chunks[1]);
        receiver.close();
        return { failure, resumed, retry, interrupted };
      }, chunks);
      expect(result.failure).toContain("QuotaExceededError");
      expect(result.resumed.receivedChunks).toBe(1);
      expect(result.retry.receivedChunks).toBe(2);
      expect(result.interrupted).toMatchObject({ receivedBytes: WEBRTC_FILE_CHUNK_BYTES, blob: null });
    } finally { await tab.close(); }
  });
});
