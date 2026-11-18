import { createSocket } from "node:dgram";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isIPv4 } from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Message, classes, methods, parseMessage, type RTCDataChannel, type RTCPeerConnection } from "werift";
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
  publishAnswerDuringGathering,
  type AgentPeerConnectionLike,
  type AgentDataChannelLike,
} from "./agentPeerConnection";

const WEBRTC_TIMEOUT_MS = 10_000;

describe("installed x86 werift runtime smoke", () => {
  it("gathers only TURN and reaps a real allocation delivered after relay-only peer close", async () => {
    const relay = createSocket("udp4");
    const ready = new Promise<void>((resolve, reject) => { relay.once("error", reject); relay.bind(0, "127.0.0.1", resolve); });
    const direct = { iceServers: [], iceTransportPolicy: "all" as const };
    let offerer: RTCPeerConnection | undefined;
    let answerer: RTCPeerConnection | undefined;
    let gathering: Promise<unknown> | undefined;
    let respond: (() => void) | undefined;
    try {
      await ready;
      const turnPort = relay.address().port;
      relay.on("message", (packet, source) => {
        const request = parseMessage(packet);
        if (!request || request.messageClass !== classes.REQUEST) return;
        const response = new Message(request.messageMethod, classes.RESPONSE, request.transactionId).setAttribute("LIFETIME", 1);
        if (request.messageMethod === methods.ALLOCATE) {
          response.setAttribute("XOR-RELAYED-ADDRESS", ["127.0.0.1", turnPort]);
          response.setAttribute("XOR-MAPPED-ADDRESS", [source.address, source.port]);
          respond = () => { relay.send(response.bytes, source.port, source.address); respond = undefined; };
        } else if (request.messageMethod === methods.REFRESH) relay.send(response.bytes, source.port, source.address);
      });
      offerer = await createAgentPeerConnection(direct, { arch: "ia32" }) as unknown as RTCPeerConnection;
      answerer = await createAgentPeerConnection({ iceTransportPolicy: "relay", iceServers: [
        { urls: `turn:127.0.0.1:${turnPort}`, username: "loopback", credential: "test-only" },
      ] }, { arch: "ia32" }) as unknown as RTCPeerConnection;
      offerer.createDataChannel("relay-close");
      await answerer.setRemoteDescription(await offerer.createOffer());
      const [{ connection }] = answerer.iceTransports;
      connection.stunServer = undefined;
      const getCandidates = vi.spyOn(connection as unknown as { getCandidatePromises: (hosts: string[], timeout: number) => unknown[] }, "getCandidatePromises");
      const observed: string[] = [];
      connection.onIceCandidate.subscribe(candidate => { observed.push(candidate.type); });
      const protocols = connection as unknown as { protocols: unknown[] };
      gathering = answerer.setLocalDescription(await answerer.createAnswer());
      await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
      await withTimeout(answerer.close());
      respond!();
      await gathering;
      await vi.waitFor(() => expect(protocols.protocols).toHaveLength(0));
      expect(getCandidates.mock.calls[0][0]).toEqual([]);
      expect(observed).toEqual(["relay"]);
    } finally {
      respond?.();
      await gathering?.catch(() => undefined);
      await Promise.allSettled([answerer?.close(), offerer?.close()]);
      await Promise.allSettled(answerer?.iceTransports.map(ice => ice.connection.close()) ?? []);
      await new Promise<void>(resolve => relay.close(() => resolve()));
    }
  }, WEBRTC_TIMEOUT_MS);

  it("cleans up a real ICE socket registered after the peer closes during gathering", async () => {
    const config = { iceServers: [], iceTransportPolicy: "all" as const };
    const offerer = await createAgentPeerConnection(config, { arch: "ia32" }) as unknown as RTCPeerConnection;
    const answerer = await createAgentPeerConnection(config, { arch: "ia32" }) as unknown as RTCPeerConnection;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let gathering: Promise<unknown> | undefined;
    try {
      offerer.createDataChannel("late-gather");
      await answerer.setRemoteDescription(await offerer.createOffer());
      const [ice] = answerer.iceTransports;
      ice.connection.stunServer = undefined;
      const gather = ice.gather.bind(ice);
      // Hold the real gather before it opens the host UDP sockets.
      const delayed = vi.spyOn(ice, "gather").mockImplementationOnce(async () => { await held; await gather(); });
      const protocols = ice.connection as unknown as { protocols: unknown[] };
      gathering = answerer.setLocalDescription(await answerer.createAnswer());
      await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce());
      await withTimeout(answerer.close());
      expect(protocols.protocols).toHaveLength(0);
      release();
      await gathering;
      await vi.waitFor(() => expect(protocols.protocols).toHaveLength(0));
    } finally {
      release();
      await gathering?.catch(() => undefined);
      await Promise.allSettled([answerer.close(), offerer.close()]);
      await Promise.allSettled(answerer.iceTransports.map(ice => ice.connection.close()));
    }
  }, WEBRTC_TIMEOUT_MS);

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

      for (const ice of offerer.iceTransports) ice.connection.stunServer = undefined;
      await offerer.setLocalDescription(await offerer.createOffer());
      const offer = offerer.localDescription;
      expect(offer?.sdp).toContain("a=candidate:");
      const offeredHost = offerer.iceTransports[0].connection.localCandidates.find(candidate =>
        candidate.type === "host" && candidate.transport === "udp" && isIPv4(candidate.host));
      expect(offeredHost).toBeDefined();
      await answerer.setRemoteDescription(offer!);
      await vi.waitFor(() => expect(answerer.iceTransports[0].connection.remoteCandidates).toContainEqual(expect.objectContaining({
        host: offeredHost!.host, port: offeredHost!.port, transport: "udp", type: "host",
      })));
      for (const ice of answerer.iceTransports) ice.connection.stunServer = undefined;

      let publications = 0;
      let answerApplied = false;
      const pendingCandidates: unknown[] = [];
      answerer.onicecandidate = event => {
        if (!event.candidate) return;
        const candidate = event.candidate.toJSON();
        if (answerApplied) void offerer.addIceCandidate(candidate);
        else pendingCandidates.push(candidate);
      };
      await publishAnswerDuringGathering(answerer as unknown as AgentPeerConnectionLike,
        await answerer.createAnswer(), async answer => {
          publications++;
          // Werift exposes SDP before embedding candidates; production trickles them separately.
          expect(answer.sdp).toContain("a=ice-ufrag:");
          expect(answer.sdp).toContain("a=ice-options:trickle");
          await offerer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
          answerApplied = true;
          for (const candidate of pendingCandidates.splice(0)) await offerer.addIceCandidate(candidate as any);
        }, () => true);
      expect(publications).toBe(1);

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
