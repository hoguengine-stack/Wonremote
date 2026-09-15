import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileChannelSender } from "./fileChannelSender";
import { processWebRtcFileChunk } from "./webrtcFileReceiver";
import { bindAgentFileMessages, type AgentDataChannelLike } from "../firebase/agentPeerConnection";
import { parseWebRtcFileChunk, serializeWebRtcFileAck, WEBRTC_FILE_CHUNK_BYTES } from "../domain/webrtcFileTransfer";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "wonremote-channel-send-")); roots.push(root);
  const sourcePath = path.join(root, "data.bin");
  const bytes = Buffer.alloc(WEBRTC_FILE_CHUNK_BYTES * 9 + 3, 87);
  await writeFile(sourcePath, bytes);
  return { root, sourcePath, bytes };
}

describe("Agent reverse file channel", () => {
  it("routes ACKs through the real message binder and receives the original file", async () => {
    const { root, sourcePath, bytes } = await fixture();
    let receiving = Promise.resolve();
    const channel: AgentDataChannelLike = { readyState: "open", send: payload => {
      receiving = receiving.then(async () => {
        const ack = await processWebRtcFileChunk(parseWebRtcFileChunk(payload)!, {
          env: { WONREMOTE_AGENT_DOWNLOADS_DIR: path.join(root, "received") },
        });
        channel.onmessage?.({ data: serializeWebRtcFileAck(ack!) });
      });
    } };
    const sender = createFileChannelSender(channel);
    const onChunk = vi.fn();
    const binding = bindAgentFileMessages(channel, { onChunk, onAck: sender.acknowledge });
    try {
      await sender.sendFile({ sourcePath, transferId: "reverse" });
      expect(await readFile(path.join(root, "received", "data.bin"))).toEqual(bytes);
      expect(onChunk).not.toHaveBeenCalled();
    } finally { sender.close(); binding.close(); }
  });

  it("rejects concurrent sends, ignores unrelated ACKs and cancels on channel close", async () => {
    const { sourcePath } = await fixture();
    let wake!: () => void;
    const firstWindow = new Promise<void>(resolve => { wake = resolve; });
    let sends = 0;
    const channel: AgentDataChannelLike = { readyState: "open", send: () => { if (++sends === 8) wake(); } };
    const sender = createFileChannelSender(channel);
    const transfer = sender.sendFile({ sourcePath, transferId: "first" });
    const assertion = expect(transfer).rejects.toMatchObject({ name: "AbortError" });
    await firstWindow;
    await expect(sender.sendFile({ sourcePath, transferId: "second" })).rejects.toThrow("already active");
    sender.acknowledge({ type: "file-ack", transferId: "second", status: "complete", receivedChunks: 10, receivedBytes: WEBRTC_FILE_CHUNK_BYTES * 9 + 3 });
    expect(sends).toBe(8);
    sender.close();
    await assertion;
    await expect(sender.sendFile({ sourcePath, transferId: "third" })).rejects.toThrow("unavailable");
  });

  it("does not block reverse ACKs behind an inbound file write", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const channel: AgentDataChannelLike = {};
    const onAck = vi.fn();
    const binding = bindAgentFileMessages(channel, { onChunk: () => blocked, onAck });
    channel.onmessage?.({ data: JSON.stringify({ type: "file-chunk", transferId: "incoming", filename: "a", chunkIndex: 0, totalChunks: 1, totalBytes: 0, isLast: true, fileData: "", chunkSha256: "a".repeat(64) }) });
    await Promise.resolve();
    const ack = { type: "file-ack" as const, transferId: "outgoing", status: "partial" as const, receivedBytes: 8, receivedChunks: 1 };
    const handler = channel.onmessage!;
    handler({ data: serializeWebRtcFileAck(ack) });
    expect(onAck).toHaveBeenCalledExactlyOnceWith(ack);
    binding.close();
    handler({ data: serializeWebRtcFileAck(ack) });
    expect(onAck).toHaveBeenCalledTimes(1);
    release();
    await binding.drain();
  });
});
