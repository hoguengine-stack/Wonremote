import { formatNodeDataChannelUnavailableError } from "./agentWebRtcStatus";
import {
  parseWebRtcControlAction,
  WEBRTC_CONTROL_CHANNEL_LABEL,
  WEBRTC_TILE_CHANNEL_LABEL,
} from "../domain/webrtcControl";
import {
  parseWebRtcFileChunk,
  WEBRTC_FILE_CHANNEL_LABEL,
  type WebRtcFileChunkMessage,
} from "../domain/webrtcFileTransfer";

export const X86_WEBRTC_RUNTIME_MARKER = "wonremote-webrtc-runtime:werift";
export const DEFAULT_WEBRTC_MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024;
export const DEFAULT_WEBRTC_MAX_MESSAGE_BYTES = 56 * 1024;

export type AgentFrameSendResult = "backpressure" | "sent" | "unavailable";

export interface AgentIceServer {
  credential?: string;
  urls: string | string[];
  username?: string;
}

export interface AgentPeerConnectionConfig {
  iceServers: AgentIceServer[];
  iceTransportPolicy: "all" | "relay";
}

export interface AgentIceCandidateLike {
  toJSON?: () => unknown;
}

export interface AgentDataChannelLike {
  bufferedAmount?: number;
  close?: () => void;
  label?: string;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data?: unknown }) => void;
  onopen?: () => void;
  readyState?: string;
  send?: (data: string) => void;
}

export type AgentDataChannelKind = "control" | "files" | "tiles" | "unknown";

export interface AgentDataChannelRoutes {
  onControl: (channel: AgentDataChannelLike) => void;
  onFiles: (channel: AgentDataChannelLike) => void;
  onTiles: (channel: AgentDataChannelLike) => void;
  onUnknown?: (channel: AgentDataChannelLike) => void;
}

export interface AgentDataChannelTaskQueue {
  close: () => void;
  drain: () => Promise<void>;
}

export interface AgentPeerConnectionLike {
  addIceCandidate: (candidate: unknown) => Promise<void>;
  close: () => Promise<void> | void;
  connectionState?: string;
  createAnswer: () => Promise<{ sdp: string; type: string }>;
  onconnectionstatechange?: () => void;
  ondatachannel?: (event: { channel: AgentDataChannelLike }) => void;
  onicecandidate?: (event: { candidate?: AgentIceCandidateLike | null }) => void;
  setLocalDescription: (description: { sdp: string; type: string }) => Promise<unknown>;
  setRemoteDescription: (description: { sdp: string; type: "offer" }) => Promise<unknown>;
}

type PeerConnectionConstructor = new (config: unknown) => AgentPeerConnectionLike;
type PeerConnectionModule = { RTCPeerConnection?: PeerConnectionConstructor };

export interface AgentPeerConnectionFactoryOptions {
  arch?: string;
  importNative?: () => Promise<PeerConnectionModule>;
  importWerift?: () => Promise<PeerConnectionModule>;
}

export async function createAgentPeerConnection(
  config: AgentPeerConnectionConfig,
  options: AgentPeerConnectionFactoryOptions = {},
): Promise<AgentPeerConnectionLike> {
  const arch = options.arch ?? process.arch;
  if (arch === "ia32" || arch === "x86") {
    try {
      const rtcModule = await (options.importWerift ?? importWerift)();
      const PeerConnection = requirePeerConnectionConstructor(rtcModule, "werift");
      console.log(`[WebRTC] ${X86_WEBRTC_RUNTIME_MARKER}`);
      return new PeerConnection(normalizeWeriftConfig(config));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`32-bit pure-JS WebRTC runtime unavailable; realtime tile channel cannot start: ${detail}`);
    }
  }

  try {
    const rtcModule = await (options.importNative ?? importNative)();
    const PeerConnection = requirePeerConnectionConstructor(rtcModule, "node-datachannel/polyfill");
    return new PeerConnection(config);
  } catch (error) {
    throw new Error(formatNodeDataChannelUnavailableError(error, arch));
  }
}

export function resolveWebRtcMaxBufferedAmount(
  env: Partial<Record<"WONREMOTE_WEBRTC_MAX_BUFFERED_BYTES", string>> = process.env,
): number {
  const parsed = Number(env.WONREMOTE_WEBRTC_MAX_BUFFERED_BYTES);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WEBRTC_MAX_BUFFERED_AMOUNT;
  }
  return Math.min(16 * 1024 * 1024, Math.max(64 * 1024, Math.trunc(parsed)));
}

export function resolveWebRtcMaxMessageBytes(
  env: Partial<Record<"WONREMOTE_WEBRTC_MAX_MESSAGE_BYTES", string>> = process.env,
): number {
  const parsed = Number(env.WONREMOTE_WEBRTC_MAX_MESSAGE_BYTES);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WEBRTC_MAX_MESSAGE_BYTES;
  }
  return Math.min(60 * 1024, Math.max(16 * 1024, Math.trunc(parsed)));
}

export function dataChannelBufferedAmount(channel: AgentDataChannelLike | null): number {
  const value = Number(channel?.bufferedAmount ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function classifyAgentDataChannel(channel: AgentDataChannelLike): AgentDataChannelKind {
  if (channel.label === WEBRTC_TILE_CHANNEL_LABEL) {
    return "tiles";
  }
  if (channel.label === WEBRTC_CONTROL_CHANNEL_LABEL) {
    return "control";
  }
  if (channel.label === WEBRTC_FILE_CHANNEL_LABEL) {
    return "files";
  }
  return "unknown";
}

export function routeAgentDataChannel(
  channel: AgentDataChannelLike,
  routes: AgentDataChannelRoutes,
): AgentDataChannelKind {
  const kind = classifyAgentDataChannel(channel);
  if (kind === "tiles") {
    routes.onTiles(channel);
  } else if (kind === "control") {
    routes.onControl(channel);
  } else if (kind === "files") {
    routes.onFiles(channel);
  } else {
    routes.onUnknown?.(channel);
  }
  return kind;
}

export function bindAgentControlMessages(
  channel: AgentDataChannelLike,
  handlers: {
    onControl: (action: string) => void;
    onInvalidMessage?: (payload: unknown) => void;
  },
): void {
  channel.onmessage = (event) => {
    const action = parseWebRtcControlAction(event.data);
    if (!action) {
      handlers.onInvalidMessage?.(event.data);
      return;
    }
    handlers.onControl(action);
  };
}

export function bindAgentFileMessages(
  channel: AgentDataChannelLike,
  handlers: {
    onChunk: (chunk: WebRtcFileChunkMessage) => Promise<void> | void;
    onError?: (error: unknown) => void;
    onInvalidMessage?: (payload: unknown) => void;
  },
): AgentDataChannelTaskQueue {
  let closed = false;
  let tail: Promise<void> = Promise.resolve();

  channel.onmessage = (event) => {
    const chunk = parseWebRtcFileChunk(event.data);
    if (!chunk) {
      handlers.onInvalidMessage?.(event.data);
      return;
    }

    const task = tail.then(async () => {
      if (!closed) {
        await handlers.onChunk(chunk);
      }
    });
    tail = task.catch((error) => {
      try {
        handlers.onError?.(error);
      } catch {
        // Keep later file chunks processable even if diagnostics fail.
      }
    });
  };

  return {
    close: () => {
      closed = true;
      channel.onmessage = undefined;
    },
    drain: () => tail,
  };
}

export function isDataChannelBackpressured(
  channel: AgentDataChannelLike | null,
  payloadBytes: number,
  maxBufferedAmount: number,
): boolean {
  return dataChannelBufferedAmount(channel) + Math.max(0, payloadBytes) > maxBufferedAmount;
}

export function serializeFrameChunks(
  frame: { tiles: unknown[]; width: number; height: number; sequence: number; keyframe: boolean },
  maxMessageBytes: number,
): string[] {
  const metadataReserveBytes = 192;
  const fixedBytes = metadataReserveBytes + Buffer.byteLength(JSON.stringify({
    width: frame.width,
    height: frame.height,
    sequence: frame.sequence,
    keyframe: frame.keyframe,
  }));
  const chunkTiles: unknown[][] = [];
  let serializedTiles: string[] = [];
  let chunkBytes = fixedBytes;

  for (const tile of frame.tiles) {
    const serializedTile = JSON.stringify(tile);
    if (serializedTile === undefined) {
      continue;
    }
    const tileBytes = Buffer.byteLength(serializedTile);
    const separatorBytes = serializedTiles.length > 0 ? 1 : 0;
    if (fixedBytes + tileBytes > maxMessageBytes) {
      throw new RangeError("A WebRTC frame tile exceeds the configured data-channel message limit.");
    }
    if (serializedTiles.length > 0 && chunkBytes + separatorBytes + tileBytes > maxMessageBytes) {
      chunkTiles.push(serializedTiles.map((value) => JSON.parse(value)));
      serializedTiles = [];
      chunkBytes = fixedBytes;
    }
    serializedTiles.push(serializedTile);
    chunkBytes += (serializedTiles.length > 1 ? 1 : 0) + tileBytes;
  }

  if (serializedTiles.length > 0 || frame.tiles.length === 0) {
    chunkTiles.push(serializedTiles.map((value) => JSON.parse(value)));
  }
  const frameChunkCount = chunkTiles.length;
  return chunkTiles.map((tiles, frameChunkIndex) => {
    const payload = JSON.stringify({
      tiles,
      width: frame.width,
      height: frame.height,
      sequence: frame.sequence,
      keyframe: frame.keyframe,
      frameChunkIndex,
      frameChunkCount,
    });
    if (Buffer.byteLength(payload) > maxMessageBytes) {
      throw new RangeError("A WebRTC frame chunk exceeds the configured data-channel message limit.");
    }
    return payload;
  });
}

export function sendFrameWithBackpressure(
  channel: AgentDataChannelLike | null,
  frame: { tiles: unknown[]; width: number; height: number; sequence: number; keyframe: boolean },
  options: { maxBufferedAmount: number; maxMessageBytes: number },
): AgentFrameSendResult {
  if (channel?.readyState !== "open" || !channel.send) {
    return "unavailable";
  }

  let payloads: string[];
  try {
    payloads = serializeFrameChunks(frame, options.maxMessageBytes);
  } catch {
    return "unavailable";
  }
  const totalPayloadBytes = payloads.reduce((total, payload) => total + Buffer.byteLength(payload), 0);
  const queuedBytes = dataChannelBufferedAmount(channel);
  const oversizedFrame = totalPayloadBytes > options.maxBufferedAmount;
  if (
    queuedBytes >= options.maxBufferedAmount ||
    (!oversizedFrame && queuedBytes + totalPayloadBytes > options.maxBufferedAmount)
  ) {
    return "backpressure";
  }

  try {
    // A chunked frame must be sent in full; a partial frame cannot be rendered.
    for (const payload of payloads) {
      channel.send(payload);
    }
    return "sent";
  } catch {
    return "unavailable";
  }
}

export function normalizeWeriftConfig(config: AgentPeerConnectionConfig): AgentPeerConnectionConfig {
  return {
    ...config,
    iceServers: config.iceServers.flatMap((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.map((url) => ({
        ...server,
        urls: url,
      }));
    }),
  };
}

function requirePeerConnectionConstructor(
  rtcModule: PeerConnectionModule,
  moduleName: string,
): PeerConnectionConstructor {
  if (typeof rtcModule.RTCPeerConnection !== "function") {
    throw new Error(`${moduleName} did not export RTCPeerConnection.`);
  }
  return rtcModule.RTCPeerConnection;
}

async function importNative(): Promise<PeerConnectionModule> {
  return import("node-datachannel/polyfill") as unknown as Promise<PeerConnectionModule>;
}

async function importWerift(): Promise<PeerConnectionModule> {
  return import("werift") as unknown as Promise<PeerConnectionModule>;
}
