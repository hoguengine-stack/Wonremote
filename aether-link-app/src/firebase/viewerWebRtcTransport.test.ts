import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWebRtcControlAction } from "../domain/webrtcControl";
import { parseWebRtcFileChunk, serializeWebRtcFileAck } from "../domain/webrtcFileTransfer";

const firestoreMocks = vi.hoisted(() => ({
  safeAddDoc: vi.fn(async () => ({ id: "candidate-1" })),
  safeSetDoc: vi.fn(async () => undefined),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ kind: "collection", path: segments.join("/") })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ kind: "doc", path: segments.join("/") })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  limit: vi.fn(),
  onSnapshot: vi.fn(() => () => undefined),
  orderBy: vi.fn(),
  query: vi.fn(),
  serverTimestamp: vi.fn(() => "server-time"),
  where: vi.fn(),
  writeBatch: vi.fn(),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => ({ auth: { currentUser: { uid: "owner-1" } }, db: {}, functions: {}, storage: {} })),
}));

vi.mock("./firestoreWrite", () => ({
  safeAddDoc: firestoreMocks.safeAddDoc,
  safeBatchUpdate: vi.fn(),
  safeSetDoc: firestoreMocks.safeSetDoc,
  safeUpdateDoc: vi.fn(),
}));

class FakeDataChannel {
  bufferedAmount = 0;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = "connecting";
  send = vi.fn();

  constructor(public readonly label: string, public readonly options: RTCDataChannelInit) {}

  close() {
    this.readyState = "closed";
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection;
  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  readonly channels = new Map<string, FakeDataChannel>();

  constructor() {
    FakePeerConnection.latest = this;
  }

  close = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer" as RTCSdpType, sdp: "viewer-offer" }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
  addIceCandidate = vi.fn(async () => undefined);

  createDataChannel(label: string, options: RTCDataChannelInit) {
    const channel = new FakeDataChannel(label, options);
    this.channels.set(label, channel);
    return channel;
  }
}

describe("Viewer WebRTC transport", () => {
  beforeEach(() => {
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses separate unordered tile and ordered control channels with a safe fallback signal", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-1",
      { onError, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );

    const tileChannel = FakePeerConnection.latest.channels.get("wonremote-tiles");
    const controlChannel = FakePeerConnection.latest.channels.get("wonremote-control");
    const fileChannel = FakePeerConnection.latest.channels.get("wonremote-files");
    expect(tileChannel?.options).toMatchObject({ ordered: false });
    expect(controlChannel?.options).toMatchObject({ ordered: true });
    expect(fileChannel?.options).toMatchObject({ ordered: true });
    expect(transport.sendControl("key-down Ctrl")).toBe(false);

    controlChannel!.readyState = "open";
    controlChannel!.onopen?.();
    expect(transport.sendControl("key-down Ctrl")).toBe(true);
    expect(parseWebRtcControlAction(controlChannel!.send.mock.calls[0][0])).toBe("key-down Ctrl");

    fileChannel!.readyState = "open";
    fileChannel!.onopen?.();
    const onProgress = vi.fn();
    const filePromise = transport.sendFile({
      file: new Blob([new Uint8Array([1, 2, 3])]),
      filename: "folder/example.bin",
      fileSha256: "a".repeat(64),
      transferId: "transfer-1",
      onProgress,
    });
    await vi.waitFor(() => expect(fileChannel!.send).toHaveBeenCalledOnce());
    expect(parseWebRtcFileChunk(fileChannel!.send.mock.calls[0][0])).toMatchObject({
      filename: "folder/example.bin",
      transferId: "transfer-1",
    });
    fileChannel!.onmessage?.({
      data: serializeWebRtcFileAck({
        type: "file-ack",
        transferId: "transfer-1",
        receivedBytes: 3,
        receivedChunks: 1,
        status: "complete",
      }),
    });
    await expect(filePromise).resolves.toBe(true);
    expect(onProgress).toHaveBeenCalledWith(3, 3);

    const clipboardPromise = transport.sendFile({
      file: new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }),
      filename: "wonremote-clipboard.png",
      fileSha256: "b".repeat(64),
      transferId: "clipboard-1",
      purpose: "clipboard-image",
      mimeType: "image/png",
    });
    await vi.waitFor(() => expect(fileChannel!.send).toHaveBeenCalledTimes(2));
    expect(parseWebRtcFileChunk(fileChannel!.send.mock.calls[1][0])).toMatchObject({
      transferId: "clipboard-1",
      purpose: "clipboard-image",
      mimeType: "image/png",
    });
    fileChannel!.onmessage?.({
      data: serializeWebRtcFileAck({
        type: "file-ack",
        transferId: "clipboard-1",
        receivedBytes: 3,
        receivedChunks: 1,
        status: "complete",
      }),
    });
    await expect(clipboardPromise).resolves.toBe(true);

    tileChannel!.readyState = "open";
    tileChannel!.onopen?.();
    tileChannel!.onclose?.();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("data-channel-closed") }));

    transport.close();
    expect(FakePeerConnection.latest.close).toHaveBeenCalledOnce();
  });
});
