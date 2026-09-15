import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendLocalFile } from "./webrtcFileSender";
import { processWebRtcFileChunk } from "./webrtcFileReceiver";
import { parseWebRtcFileChunk, WEBRTC_FILE_CHUNK_BYTES, type WebRtcFileAckMessage } from "../domain/webrtcFileTransfer";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function source(bytes: Buffer) {
  const root = await mkdtemp(path.join(tmpdir(), "wonremote-sender-"));
  roots.push(root);
  const sourcePath = path.join(root, "report.bin");
  await writeFile(sourcePath, bytes);
  return { root, sourcePath };
}

describe("Agent disk-streaming file sender", () => {
  it.each([false, true])("resumes a committed partial prefix and verifies skipped source bytes (changed=%s)", async changed => {
    const bytes = Buffer.alloc(WEBRTC_FILE_CHUNK_BYTES * 18 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(i / WEBRTC_FILE_CHUNK_BYTES) + 1;
    const { root, sourcePath } = await source(bytes);
    const destination = path.join(root, "resumed");
    let queue: Promise<WebRtcFileAckMessage | null> = Promise.resolve(null);
    const sent: number[] = [];
    const send = (payload: string) => {
      const chunk = parseWebRtcFileChunk(payload)!;
      sent.push(chunk.chunkIndex);
      queue = queue.then(() => processWebRtcFileChunk(chunk, { env: { WONREMOTE_AGENT_DOWNLOADS_DIR: destination } }));
    };
    await expect(sendLocalFile({ sourcePath, transferId: "resume", send, waitForAck: async (_id, count) => {
      const ack = await queue;
      if (count === 16) throw new Error("Interrupted after commit");
      return ack!;
    } })).rejects.toThrow("Interrupted after commit");
    sent.length = 0;
    if (changed) {
      bytes[WEBRTC_FILE_CHUNK_BYTES * 9] ^= 255;
      await writeFile(sourcePath, bytes);
    }
    const retry = sendLocalFile({ sourcePath, transferId: "resume", send, waitForAck: async () => (await queue)! });
    if (changed) await expect(retry).rejects.toThrow("Receiver rejected");
    else await retry;
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18]);
    if (changed) await expect(readFile(path.join(destination, "report.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(path.join(destination, "report.bin"))).toEqual(bytes);
  });

  it.each([
    { receivedChunks: 7, receivedBytes: WEBRTC_FILE_CHUNK_BYTES * 7 },
    { receivedChunks: 8.5, receivedBytes: WEBRTC_FILE_CHUNK_BYTES * 8.5 },
    { receivedChunks: 19, receivedBytes: WEBRTC_FILE_CHUNK_BYTES * 18 + 7 },
    { receivedChunks: 16, receivedBytes: 1 },
    { receivedChunks: 16, status: "complete" },
    { receivedChunks: 16, transferId: "another" },
  ])("rejects invalid partial resume negotiation %j", async change => {
    const { sourcePath } = await source(Buffer.alloc(WEBRTC_FILE_CHUNK_BYTES * 18 + 7));
    const send = vi.fn(), onProgress = vi.fn();
    await expect(sendLocalFile({ sourcePath, transferId: "resume-invalid", send, onProgress,
      waitForAck: async () => ({ type: "file-ack", transferId: "resume-invalid", status: "partial",
        receivedBytes: WEBRTC_FILE_CHUNK_BYTES * 16, ...change } as WebRtcFileAckMessage),
    })).rejects.toThrow("Invalid file acknowledgement");
    expect(send).toHaveBeenCalledTimes(8);
    expect(onProgress).not.toHaveBeenCalled();
  });
  it.each([0, WEBRTC_FILE_CHUNK_BYTES * 17 + 7])("roundtrips %i bytes with window8 through the disk receiver", async size => {
    const bytes = Buffer.alloc(size, 71);
    const { root, sourcePath } = await source(bytes);
    const destination = path.join(root, "received");
    let queue: Promise<WebRtcFileAckMessage | null> = Promise.resolve(null);
    let outstanding = 0;
    let maximum = 0;
    const waits: number[] = [];
    const onProgress = vi.fn();
    await sendLocalFile({ sourcePath, transferId: "reverse-1", onProgress,
      send: payload => {
        const chunk = parseWebRtcFileChunk(payload)!;
        expect(chunk).not.toBeNull();
        maximum = Math.max(maximum, ++outstanding);
        queue = queue.then(() => processWebRtcFileChunk(chunk, { env: { WONREMOTE_AGENT_DOWNLOADS_DIR: destination } }));
      },
      waitForAck: async (_id, chunks) => {
        waits.push(chunks);
        const ack = await queue;
        outstanding = 0;
        return ack!;
      },
    });
    expect(await readFile(path.join(destination, "report.bin"))).toEqual(bytes);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(waits).toEqual(size === 0 ? [1] : [8, 16, 18]);
    expect(onProgress).toHaveBeenLastCalledWith(size, size);
  });

  it.each([
    { transferId: "other" }, { receivedBytes: 2 }, { receivedChunks: 2 }, { status: "partial" }, { status: "error" },
  ])("rejects incorrect completion %j without reporting success", async change => {
    const { sourcePath } = await source(Buffer.from("one"));
    const onProgress = vi.fn();
    await expect(sendLocalFile({ sourcePath, transferId: "test", send: () => {}, onProgress,
      waitForAck: async () => ({ type: "file-ack", transferId: "test", receivedBytes: 3, receivedChunks: 1, status: "complete", ...change } as WebRtcFileAckMessage),
    })).rejects.toThrow();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("cancels an outstanding ACK and closes the source handle", async () => {
    const { sourcePath } = await source(Buffer.alloc(WEBRTC_FILE_CHUNK_BYTES * 9));
    const controller = new AbortController();
    let wake!: () => void;
    const waiting = new Promise<void>(resolve => { wake = resolve; });
    let childSignal: AbortSignal | undefined;
    const send = vi.fn();
    const transfer = sendLocalFile({ sourcePath, transferId: "cancel", signal: controller.signal, send,
      waitForAck: (_id, _count, signal) => { childSignal = signal; wake(); return new Promise(() => {}); },
    });
    const assertion = expect(transfer).rejects.toMatchObject({ name: "AbortError" });
    await waiting;
    controller.abort();
    await assertion;
    expect(childSignal?.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(8);
    await rm(sourcePath);
  });

  it("times out a silent receiver and clears the wait", async () => {
    const { sourcePath } = await source(Buffer.from("one"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let wake!: () => void;
    const waiting = new Promise<void>(resolve => { wake = resolve; });
    let signal: AbortSignal | undefined;
    const transfer = sendLocalFile({ sourcePath, transferId: "timeout", send: () => {},
      waitForAck: (_id, _count, child) => { signal = child; wake(); return new Promise(() => {}); },
    });
    const assertion = expect(transfer).rejects.toThrow("timed out");
    await waiting;
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish a final chunk after the selected source changes", async () => {
    const { sourcePath } = await source(Buffer.alloc(WEBRTC_FILE_CHUNK_BYTES * 9));
    const send = vi.fn();
    await expect(sendLocalFile({ sourcePath, transferId: "changed", send,
      waitForAck: async () => {
        await appendFile(sourcePath, "changed");
        return { type: "file-ack", transferId: "changed", receivedBytes: WEBRTC_FILE_CHUNK_BYTES * 8, receivedChunks: 8, status: "partial" };
      },
    })).rejects.toThrow("Source file changed");
    expect(send).toHaveBeenCalledTimes(8);
  });
});
