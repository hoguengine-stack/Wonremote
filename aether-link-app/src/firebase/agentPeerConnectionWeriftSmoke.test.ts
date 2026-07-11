import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RTCDataChannel, RTCPeerConnection } from "werift";
import { computeSha256 } from "../agent/checksum";
import { processWebRtcFileChunk } from "../agent/webrtcFileReceiver";
import {
  parseWebRtcControlAction,
  serializeWebRtcControlAction,
  WEBRTC_CONTROL_CHANNEL_LABEL,
  WEBRTC_TILE_CHANNEL_LABEL,
} from "../domain/webrtcControl";
import {
  parseWebRtcFileAck,
  serializeWebRtcFileAck,
  serializeWebRtcFileChunk,
  WEBRTC_FILE_CHANNEL_LABEL,
} from "../domain/webrtcFileTransfer";
import {
  bindAgentFileMessages,
  createAgentPeerConnection,
  type AgentDataChannelLike,
} from "./agentPeerConnection";

const WEBRTC_TIMEOUT_MS = 10_000;

describe("installed x86 werift runtime smoke", () => {
  it("negotiates two peers and exchanges data-channel messages in both directions", async () => {
    const config = { iceServers: [], iceTransportPolicy: "all" as const };
    const offerer = await createAgentPeerConnection(config, { arch: "ia32" }) as unknown as RTCPeerConnection;
    const answerer = await createAgentPeerConnection(config, { arch: "ia32" }) as unknown as RTCPeerConnection;

    try {
      let resolveAnswerTile!: (channel: RTCDataChannel) => void;
      let resolveAnswerControl!: (channel: RTCDataChannel) => void;
      let resolveAnswerFile!: (channel: RTCDataChannel) => void;
      const answerTilePromise = withTimeout(new Promise<RTCDataChannel>((resolve) => {
        resolveAnswerTile = resolve;
      }));
      const answerControlPromise = withTimeout(new Promise<RTCDataChannel>((resolve) => {
        resolveAnswerControl = resolve;
      }));
      const answerFilePromise = withTimeout(new Promise<RTCDataChannel>((resolve) => {
        resolveAnswerFile = resolve;
      }));
      answerer.ondatachannel = (event) => {
        if (event.channel.label === WEBRTC_TILE_CHANNEL_LABEL) {
          resolveAnswerTile(event.channel);
        } else if (event.channel.label === WEBRTC_CONTROL_CHANNEL_LABEL) {
          resolveAnswerControl(event.channel);
        } else if (event.channel.label === WEBRTC_FILE_CHANNEL_LABEL) {
          resolveAnswerFile(event.channel);
        }
      };
      const offerTile = offerer.createDataChannel(WEBRTC_TILE_CHANNEL_LABEL, { ordered: false });
      const offerControl = offerer.createDataChannel(WEBRTC_CONTROL_CHANNEL_LABEL, { ordered: true });
      const offerFile = offerer.createDataChannel(WEBRTC_FILE_CHANNEL_LABEL, { ordered: true });

      await offerer.setLocalDescription(await offerer.createOffer());
      const offer = offerer.localDescription;
      expect(offer?.sdp).toContain("a=candidate:");
      await answerer.setRemoteDescription(offer!);

      await answerer.setLocalDescription(await answerer.createAnswer());
      const answer = answerer.localDescription;
      expect(answer?.sdp).toContain("a=candidate:");
      await offerer.setRemoteDescription(answer!);

      const [answerTile, answerControl, answerFile] = await Promise.all([
        answerTilePromise,
        answerControlPromise,
        answerFilePromise,
      ]);
      await Promise.all([
        waitForOpen(offerTile),
        waitForOpen(answerTile),
        waitForOpen(offerControl),
        waitForOpen(answerControl),
        waitForOpen(offerFile),
        waitForOpen(answerFile),
      ]);
      expect(offerTile.ordered).toBe(false);
      expect(offerControl.ordered).toBe(true);
      expect(answerControl.ordered).toBe(true);
      expect(offerFile.ordered).toBe(true);
      expect(answerFile.ordered).toBe(true);

      const ping = waitForMessage(answerTile);
      offerTile.send("ping");
      await expect(ping).resolves.toBe("ping");

      const pong = waitForMessage(offerTile);
      answerTile.send("pong");
      await expect(pong).resolves.toBe("pong");

      const controlPing = waitForMessage(answerControl);
      offerControl.send(serializeWebRtcControlAction("ping-color-change"));
      expect(parseWebRtcControlAction(await controlPing)).toBe("ping-color-change");

      const controlReply = waitForMessage(offerControl);
      answerControl.send(serializeWebRtcControlAction("clipboard-request"));
      expect(parseWebRtcControlAction(await controlReply)).toBe("clipboard-request");

      const downloadsDir = await mkdtemp(path.join(tmpdir(), "wonremote-werift-files-"));
      const fileBinding = bindAgentFileMessages(answerFile as unknown as AgentDataChannelLike, {
        onChunk: async (chunk) => {
          const acknowledgement = await processWebRtcFileChunk(chunk, {
            env: { WONREMOTE_AGENT_DOWNLOADS_DIR: downloadsDir },
          });
          if (acknowledgement) {
            answerFile.send(serializeWebRtcFileAck(acknowledgement));
          }
        },
      });
      const firstBytes = Buffer.from("werift file ");
      const secondBytes = Buffer.from("channel smoke");
      const fileBytes = Buffer.concat([firstBytes, secondBytes]);
      const fileAcks = waitForMessages(offerFile, 2);
      offerFile.send(serializeWebRtcFileChunk({
        type: "file-chunk",
        transferId: "werift-smoke",
        filename: "smoke/file.txt",
        chunkIndex: 0,
        totalChunks: 2,
        totalBytes: fileBytes.length,
        isLast: false,
        fileData: firstBytes.toString("base64"),
        chunkSha256: computeSha256(firstBytes),
      }));
      offerFile.send(serializeWebRtcFileChunk({
        type: "file-chunk",
        transferId: "werift-smoke",
        filename: "smoke/file.txt",
        chunkIndex: 1,
        totalChunks: 2,
        totalBytes: fileBytes.length,
        isLast: true,
        fileData: secondBytes.toString("base64"),
        chunkSha256: computeSha256(secondBytes),
        fileSha256: computeSha256(fileBytes),
      }));
      const acknowledgements = (await fileAcks).map(parseWebRtcFileAck);
      expect(acknowledgements).toEqual([
        expect.objectContaining({
          transferId: "werift-smoke",
          status: "partial",
          receivedBytes: firstBytes.length,
          receivedChunks: 1,
        }),
        expect.objectContaining({
          transferId: "werift-smoke",
          status: "complete",
          receivedBytes: fileBytes.length,
          receivedChunks: 2,
        }),
      ]);
      fileBinding.close();
      await expect(readFile(path.join(downloadsDir, "smoke", "file.txt"), "utf8"))
        .resolves.toBe(fileBytes.toString("utf8"));
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15_000);
});

function waitForOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }
  return withTimeout(new Promise<void>((resolve, reject) => {
    channel.onopen = () => resolve();
    channel.onerror = (event) => reject(event.error);
  }));
}

function waitForMessage(channel: RTCDataChannel): Promise<string> {
  return withTimeout(new Promise<string>((resolve, reject) => {
    channel.onmessage = (event) => resolve(String(event.data));
    channel.onerror = (event) => reject(event.error);
  }));
}

function waitForMessages(channel: RTCDataChannel, count: number): Promise<string[]> {
  return withTimeout(new Promise<string[]>((resolve, reject) => {
    const messages: string[] = [];
    channel.onmessage = (event) => {
      messages.push(String(event.data));
      if (messages.length === count) {
        resolve(messages);
      }
    };
    channel.onerror = (event) => reject(event.error);
  }));
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("werift smoke test timed out")), WEBRTC_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
