import { describe, expect, it, vi } from "vitest";
import {
  MAX_WEBRTC_CONTROL_ACTION_BYTES,
  serializeWebRtcControlAction,
  WEBRTC_CONTROL_CHANNEL_LABEL,
  WEBRTC_TILE_CHANNEL_LABEL,
} from "../domain/webrtcControl";
import {
  MAX_WEBRTC_FILE_MESSAGE_BYTES,
  serializeWebRtcFileChunk,
  WEBRTC_FILE_CHANNEL_LABEL,
} from "../domain/webrtcFileTransfer";
import {
  DEFAULT_WEBRTC_MAX_BUFFERED_AMOUNT,
  bindAgentControlMessages,
  bindAgentFileMessages,
  createAgentPeerConnection,
  isDataChannelBackpressured,
  normalizeWeriftConfig,
  resolveAgentLocalDescription,
  resolveWebRtcMaxBufferedAmount,
  routeAgentDataChannel,
  sendFrameWithBackpressure,
  serializeFrameChunks,
} from "./agentPeerConnection";

class FakePeerConnection {
  config: unknown;

  constructor(config: unknown) {
    this.config = config;
  }

  async addIceCandidate() {}
  close() {}
  async createAnswer() {
    return { type: "answer", sdp: "answer-sdp" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
}

const config = {
  iceServers: [
    {
      urls: ["stun:one.example:3478", "turn:two.example:3478"],
      username: "user",
      credential: "secret",
    },
  ],
  iceTransportPolicy: "relay" as const,
};

describe("Agent PeerConnection architecture adapter", () => {
  it("keeps x64 on node-datachannel/polyfill without importing werift", async () => {
    const importNative = vi.fn(async () => ({ RTCPeerConnection: FakePeerConnection }));
    const importWerift = vi.fn(async () => {
      throw new Error("werift must not load on x64");
    });

    const peer = await createAgentPeerConnection(config, {
      arch: "x64",
      importNative,
      importWerift,
    });

    expect(importNative).toHaveBeenCalledOnce();
    expect(importWerift).not.toHaveBeenCalled();
    expect((peer as FakePeerConnection).config).toEqual(config);
  });

  it("uses werift only on x86 and normalizes URL arrays for its constructor", async () => {
    const importNative = vi.fn(async () => {
      throw new Error("native runtime must not load on x86");
    });
    const importWerift = vi.fn(async () => ({ RTCPeerConnection: FakePeerConnection }));

    const peer = await createAgentPeerConnection(config, {
      arch: "ia32",
      importNative,
      importWerift,
    });

    expect(importWerift).toHaveBeenCalledOnce();
    expect(importNative).not.toHaveBeenCalled();
    expect((peer as FakePeerConnection).config).toEqual(normalizeWeriftConfig(config));
    expect(normalizeWeriftConfig(config).iceServers).toHaveLength(2);
  });

  it("constructs the installed werift RTCPeerConnection through the x86 path", async () => {
    const peer = await createAgentPeerConnection(
      { iceServers: [], iceTransportPolicy: "all" },
      { arch: "ia32" },
    );

    expect(typeof peer.createAnswer).toBe("function");
    expect(typeof peer.addIceCandidate).toBe("function");
    await peer.close();
  });

  it("publishes the gathered local SDP instead of the pre-gather answer", () => {
    const localDescription = {
      type: "answer",
      sdp: "v=0\r\na=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r\n",
    };
    const peer = { localDescription } as unknown as FakePeerConnection;

    expect(resolveAgentLocalDescription(peer, { type: "answer", sdp: "v=0\r\n" }))
      .toEqual(localDescription);
  });
});

describe("Agent data-channel backpressure", () => {
  it("routes control, file, and tile labels separately without replacing tile sending", () => {
    const tileSend = vi.fn();
    const tileChannel = {
      label: WEBRTC_TILE_CHANNEL_LABEL,
      readyState: "open",
      bufferedAmount: 0,
      send: tileSend,
    };
    const controlChannel = { label: WEBRTC_CONTROL_CHANNEL_LABEL };
    const fileChannel = { label: WEBRTC_FILE_CHANNEL_LABEL };
    let selectedTile: typeof tileChannel | null = null;
    const controls: unknown[] = [];
    const files: unknown[] = [];
    const routes = {
      onTiles: (channel: any) => {
        selectedTile = channel;
      },
      onControl: (channel: any) => {
        controls.push(channel);
      },
      onFiles: (channel: any) => {
        files.push(channel);
      },
    };

    expect(routeAgentDataChannel(tileChannel, routes)).toBe("tiles");
    expect(routeAgentDataChannel(controlChannel, routes)).toBe("control");
    expect(routeAgentDataChannel(fileChannel, routes)).toBe("files");
    expect(selectedTile).toBe(tileChannel);
    expect(controls).toEqual([controlChannel]);
    expect(files).toEqual([fileChannel]);
    expect(
      sendFrameWithBackpressure(
        selectedTile,
        { tiles: [{ image: "tile" }], width: 10, height: 10, sequence: 1, keyframe: false },
        { maxBufferedAmount: 64 * 1024, maxMessageBytes: 16 * 1024 },
      ),
    ).toBe("sent");
    expect(tileSend).toHaveBeenCalledOnce();
  });

  it("parses valid control messages and ignores malformed, oversized, and binary payloads", () => {
    const channel: { onmessage?: (event: { data?: unknown }) => void } = {};
    const onControl = vi.fn();
    const onInvalidMessage = vi.fn();
    bindAgentControlMessages(channel, { onControl, onInvalidMessage });

    channel.onmessage?.({ data: serializeWebRtcControlAction("key-down A") });
    channel.onmessage?.({ data: "{not-json" });
    channel.onmessage?.({ data: JSON.stringify({ type: "control", action: "x".repeat(MAX_WEBRTC_CONTROL_ACTION_BYTES) }) });
    channel.onmessage?.({ data: Buffer.from("binary") });

    expect(onControl).toHaveBeenCalledOnce();
    expect(onControl).toHaveBeenCalledWith("key-down A");
    expect(onInvalidMessage).toHaveBeenCalledTimes(3);
  });

  it("parses file chunks only and processes each file channel in order", async () => {
    const channel: { onmessage?: (event: { data?: unknown }) => void } = {};
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const binding = bindAgentFileMessages(channel, {
      onChunk: async (chunk) => {
        order.push(`${chunk.chunkIndex}:start`);
        if (chunk.chunkIndex === 0) {
          await firstBlocked;
        }
        order.push(`${chunk.chunkIndex}:end`);
      },
    });
    const checksum = "a".repeat(64);

    channel.onmessage?.({ data: serializeWebRtcFileChunk({
      type: "file-chunk",
      transferId: "transfer-1",
      filename: "folder/file.bin",
      chunkIndex: 0,
      totalChunks: 2,
      totalBytes: 2,
      isLast: false,
      fileData: "YQ==",
      chunkSha256: checksum,
    }) });
    channel.onmessage?.({ data: serializeWebRtcFileChunk({
      type: "file-chunk",
      transferId: "transfer-1",
      filename: "folder/file.bin",
      chunkIndex: 1,
      totalChunks: 2,
      totalBytes: 2,
      isLast: true,
      fileData: "Yg==",
      chunkSha256: checksum,
      fileSha256: checksum,
    }) });

    await Promise.resolve();
    expect(order).toEqual(["0:start"]);
    releaseFirst();
    await binding.drain();
    expect(order).toEqual(["0:start", "0:end", "1:start", "1:end"]);
  });

  it("ignores malformed, oversized, and binary file messages and drops queued work after close", async () => {
    const channel: { onmessage?: (event: { data?: unknown }) => void } = {};
    const onInvalidMessage = vi.fn();
    const processed: number[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const binding = bindAgentFileMessages(channel, {
      onChunk: async (chunk) => {
        processed.push(chunk.chunkIndex);
        if (chunk.chunkIndex === 0) {
          await firstBlocked;
        }
      },
      onInvalidMessage,
    });
    const checksum = "b".repeat(64);
    const chunk = (chunkIndex: number) => serializeWebRtcFileChunk({
      type: "file-chunk",
      transferId: "transfer-close",
      filename: "file.bin",
      chunkIndex,
      totalChunks: 2,
      totalBytes: 2,
      isLast: chunkIndex === 1,
      fileData: chunkIndex === 0 ? "YQ==" : "Yg==",
      chunkSha256: checksum,
      fileSha256: chunkIndex === 1 ? checksum : undefined,
    });

    channel.onmessage?.({ data: "{not-json" });
    channel.onmessage?.({ data: "x".repeat(MAX_WEBRTC_FILE_MESSAGE_BYTES + 1) });
    channel.onmessage?.({ data: Buffer.from("binary") });
    channel.onmessage?.({ data: chunk(0) });
    channel.onmessage?.({ data: chunk(1) });
    await Promise.resolve();
    binding.close();
    releaseFirst();
    await binding.drain();

    expect(onInvalidMessage).toHaveBeenCalledTimes(3);
    expect(processed).toEqual([0]);
  });

  it("uses a bounded configurable buffered amount", () => {
    expect(resolveWebRtcMaxBufferedAmount({})).toBe(DEFAULT_WEBRTC_MAX_BUFFERED_AMOUNT);
    expect(resolveWebRtcMaxBufferedAmount({ WONREMOTE_WEBRTC_MAX_BUFFERED_BYTES: "1" })).toBe(64 * 1024);
    expect(resolveWebRtcMaxBufferedAmount({ WONREMOTE_WEBRTC_MAX_BUFFERED_BYTES: "999999999" })).toBe(16 * 1024 * 1024);
  });

  it("drops a new frame before it would cross the buffered amount limit", () => {
    expect(isDataChannelBackpressured({ bufferedAmount: 900 }, 200, 1_000)).toBe(true);
    expect(isDataChannelBackpressured({ bufferedAmount: 700 }, 200, 1_000)).toBe(false);
  });

  it("splits a large frame into bounded messages with one monotonic sequence", () => {
    const tiles = Array.from({ length: 8 }, (_, index) => ({ index, image: "a".repeat(9_000) }));
    const payloads = serializeFrameChunks({ tiles, width: 1280, height: 720, sequence: 42, keyframe: true }, 30_000);

    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.every((payload) => Buffer.byteLength(payload) <= 30_000)).toBe(true);
    const parsed = payloads.map((payload) => JSON.parse(payload));
    expect(parsed.every((frame, index) =>
      frame.sequence === 42 &&
      frame.width === 1280 &&
      frame.height === 720 &&
      frame.keyframe === true &&
      frame.frameChunkIndex === index &&
      frame.frameChunkCount === parsed.length
    )).toBe(true);
    expect(parsed.flatMap((frame) => frame.tiles)).toEqual(tiles);
  });

  it("drops a frame only when queued data would exceed the limit and never sends partial frames", () => {
    const frame = {
      tiles: Array.from({ length: 4 }, (_, index) => ({ index, image: "b".repeat(8_000) })),
      width: 800,
      height: 600,
      sequence: 7,
      keyframe: false,
    };
    const preflightSend = vi.fn();
    expect(
      sendFrameWithBackpressure(
        { readyState: "open", bufferedAmount: 70_000, send: preflightSend },
        frame,
        { maxBufferedAmount: 90_000, maxMessageBytes: 20_000 },
      ),
    ).toBe("backpressure");
    expect(preflightSend).not.toHaveBeenCalled();

    let bufferedAmount = 0;
    const chunkSend = vi.fn(() => {
      bufferedAmount = 85_000;
    });
    const channel = {
      readyState: "open",
      get bufferedAmount() {
        return bufferedAmount;
      },
      send: chunkSend,
    };
    expect(
      sendFrameWithBackpressure(channel, frame, {
        maxBufferedAmount: 90_000,
        maxMessageBytes: 20_000,
      }),
    ).toBe("sent");
    expect(chunkSend.mock.calls.length).toBeGreaterThan(1);

    const oversizedSend = vi.fn();
    expect(
      sendFrameWithBackpressure(
        { readyState: "open", bufferedAmount: 1_024, send: oversizedSend },
        frame,
        { maxBufferedAmount: 20_000, maxMessageBytes: 20_000 },
      ),
    ).toBe("sent");
    expect(oversizedSend.mock.calls.length).toBeGreaterThan(1);
  });
});
