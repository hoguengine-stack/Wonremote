import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWebRtcControlAction } from "../domain/webrtcControl";
import { WEBRTC_FILE_CHUNK_BYTES, parseWebRtcFileChunk, serializeWebRtcFileAck } from "../domain/webrtcFileTransfer";

const firestoreMocks = vi.hoisted(() => ({
  onSnapshot: vi.fn((
    _target: { path?: string },
    _next?: (snapshot: {
      data?: () => Record<string, unknown> | undefined;
      docs?: Array<{ id: string; data: () => Record<string, unknown> }>;
    }) => void,
    _error?: (error: Error) => void,
  ) => () => undefined),
  safeAddDoc: vi.fn(async () => ({ id: "candidate-1" })),
  safeSetDoc: vi.fn(async () => undefined),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ kind: "collection", path: segments.join("/") })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ kind: "doc", path: segments.join("/") })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  limit: vi.fn(),
  onSnapshot: firestoreMocks.onSnapshot,
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
  safeBatchSet: vi.fn(),
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
  setRemoteDescription = vi.fn(async (_description?: RTCSessionDescriptionInit): Promise<void> => undefined);
  addIceCandidate = vi.fn(async (_candidate?: RTCIceCandidateInit): Promise<void> => undefined);

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
    firestoreMocks.safeAddDoc.mockResolvedValue({ id: "candidate-1" });
    firestoreMocks.safeSetDoc.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(transport.sendControl("key-down Ctrl")).toBe(true);
    expect(controlChannel!.send).not.toHaveBeenCalled();

    controlChannel!.readyState = "open";
    controlChannel!.onopen?.();
    expect(controlChannel!.send).toHaveBeenCalledOnce();
    expect(parseWebRtcControlAction(controlChannel!.send.mock.calls[0][0])).toBe("key-down Ctrl");
    expect(transport.sendControl("key-up Ctrl")).toBe(true);
    expect(parseWebRtcControlAction(controlChannel!.send.mock.calls[1][0])).toBe("key-up Ctrl");

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
    expect(transport.sendControl("key-up Ctrl")).toBe(false);
  });

  it("exposes an ordered control queue before the Firestore offer write finishes", async () => {
    let finishOfferWrite: (() => void) | undefined;
    firestoreMocks.safeSetDoc.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finishOfferWrite = () => resolve(undefined);
    }));
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    let resolvedTransport: Awaited<ReturnType<typeof startFirebaseViewerWebRtcTransport>> | undefined;

    const transportPromise = startFirebaseViewerWebRtcTransport(
      "session-fast-start",
      { onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );
    void transportPromise.then((transport) => {
      resolvedTransport = transport;
    });

    await vi.waitFor(() => expect(firestoreMocks.safeSetDoc).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(resolvedTransport).toBeDefined();
    expect(resolvedTransport!.sendControl("key-down Backspace")).toBe(true);

    const controlChannel = FakePeerConnection.latest.channels.get("wonremote-control")!;
    expect(controlChannel.send).not.toHaveBeenCalled();
    controlChannel.readyState = "open";
    controlChannel.onopen?.();
    expect(parseWebRtcControlAction(controlChannel.send.mock.calls[0][0])).toBe("key-down Backspace");

    finishOfferWrite?.();
    const transport = await transportPromise;
    transport.close();
  });

  it("keeps the startup watchdog active until both tile and control channels open", async () => {
    vi.useFakeTimers();
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-missing-control",
      { onError, onFrame: vi.fn() },
      { VITE_WONREMOTE_RTC_CONNECT_TIMEOUT_MS: "2000" } as unknown as ImportMetaEnv,
    );

    const tileChannel = FakePeerConnection.latest.channels.get("wonremote-tiles")!;
    tileChannel.readyState = "open";
    tileChannel.onopen?.();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("without open tile and control channels"),
    }));
    expect(transport.sendControl("key-down A")).toBe(false);
  });

  it("keeps a healthy connection alive when one trickle ICE candidate write fails", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onDiagnostic = vi.fn();
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-candidate-warning",
      { onDiagnostic, onError, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );

    const peer = FakePeerConnection.latest;
    const tileChannel = peer.channels.get("wonremote-tiles")!;
    const controlChannel = peer.channels.get("wonremote-control")!;
    tileChannel.readyState = "open";
    controlChannel.readyState = "open";
    tileChannel.onopen?.();
    controlChannel.onopen?.();

    firestoreMocks.safeAddDoc.mockRejectedValueOnce(new Error("candidate write denied"));
    peer.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: "candidate:1" }) } as RTCIceCandidate,
    });
    await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("viewer-candidate-write-failed"),
    ));

    expect(onError).not.toHaveBeenCalled();
    expect(peer.close).not.toHaveBeenCalled();
    expect(transport.sendControl("key-down A")).toBe(true);
    transport.close();
  });

  it("queues Agent ICE candidates until the matching Answer remote description is applied", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-candidate-before-answer",
      { onDiagnostic: vi.fn(), onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );
    await vi.waitFor(() => expect(firestoreMocks.safeSetDoc).toHaveBeenCalledOnce());

    const peer = FakePeerConnection.latest;
    let remoteDescriptionApplied = false;
    let completeRemoteDescription: (() => void) | undefined;
    const successfullyAppliedCandidates: RTCIceCandidateInit[] = [];
    peer.setRemoteDescription.mockImplementationOnce(() => new Promise<void>((resolve) => {
      completeRemoteDescription = () => {
        remoteDescriptionApplied = true;
        resolve();
      };
    }));
    peer.addIceCandidate.mockImplementation(async (candidate?: RTCIceCandidateInit) => {
      if (!remoteDescriptionApplied) {
        throw new Error("Remote description must be applied before ICE candidates.");
      }
      if (candidate) {
        successfullyAppliedCandidates.push(candidate);
      }
    });

    const offerWrite = firestoreMocks.safeSetDoc.mock.calls[0] as unknown as [
      unknown,
      { offer: { negotiationId: string } },
    ];
    const negotiationId = offerWrite[1].offer.negotiationId;
    const signalCallback = firestoreMocks.onSnapshot.mock.calls.find(
      ([target]) => target.path === "sessions/session-candidate-before-answer/webrtc/signal",
    )?.[1];
    const candidateCallback = firestoreMocks.onSnapshot.mock.calls.find(
      ([target]) => target.path === "sessions/session-candidate-before-answer/agentCandidates",
    )?.[1];
    expect(signalCallback).toBeTypeOf("function");
    expect(candidateCallback).toBeTypeOf("function");

    const candidate = { candidate: "candidate:agent-before-answer" };
    candidateCallback?.({
      docs: [{
        id: "agent-candidate-before-answer",
        data: () => ({ candidate, negotiationId }),
      }],
    });
    await Promise.resolve();
    expect.soft(peer.addIceCandidate).not.toHaveBeenCalled();

    signalCallback?.({
      data: () => ({
        answer: { type: "answer", sdp: "agent-answer", negotiationId },
        negotiationId,
      }),
    });
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
    completeRemoteDescription?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect.soft(peer.addIceCandidate).toHaveBeenCalledTimes(1);
    expect.soft(successfullyAppliedCandidates).toEqual([candidate]);
    transport.close();
  });

  it("automatically retries an Agent ICE candidate once after its first post-Answer application fails", async () => {
    vi.useFakeTimers();
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onDiagnostic = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-candidate-retry",
      { onDiagnostic, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(firestoreMocks.safeSetDoc).toHaveBeenCalledOnce();

    const peer = FakePeerConnection.latest;
    const offerWrite = firestoreMocks.safeSetDoc.mock.calls[0] as unknown as [
      unknown,
      { offer: { negotiationId: string } },
    ];
    const negotiationId = offerWrite[1].offer.negotiationId;
    const signalCallback = firestoreMocks.onSnapshot.mock.calls.find(
      ([target]) => target.path === "sessions/session-candidate-retry/webrtc/signal",
    )?.[1];
    const candidateCallback = firestoreMocks.onSnapshot.mock.calls.find(
      ([target]) => target.path === "sessions/session-candidate-retry/agentCandidates",
    )?.[1];
    expect(signalCallback).toBeTypeOf("function");
    expect(candidateCallback).toBeTypeOf("function");

    signalCallback?.({
      data: () => ({
        answer: { type: "answer", sdp: "agent-answer", negotiationId },
        negotiationId,
      }),
    });
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();

    peer.addIceCandidate
      .mockRejectedValueOnce(new Error("transient candidate rejection"))
      .mockResolvedValueOnce(undefined);
    const candidateSnapshot = {
      docs: [{
        id: "agent-candidate-retry",
        data: () => ({
          candidate: { candidate: "candidate:agent-retry" },
          negotiationId,
        }),
      }],
    };

    candidateCallback?.(candidateSnapshot);
    await Promise.resolve();
    await Promise.resolve();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("agent-candidate-rejected"),
    );
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(2);

    candidateCallback?.(candidateSnapshot);
    await Promise.resolve();
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(2);
    transport.close();
  });

  it("stops before sending the next file chunk when its AbortSignal is cancelled", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-file-cancel",
      { onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );
    const fileChannel = FakePeerConnection.latest.channels.get("wonremote-files")!;
    fileChannel.readyState = "open";
    fileChannel.onopen?.();
    const controller = new AbortController();
    fileChannel.send.mockImplementationOnce(() => {
      controller.abort();
    });
    const file = new Blob([new Uint8Array(WEBRTC_FILE_CHUNK_BYTES * 2)]);

    const transferPromise = transport.sendFile({
      file,
      filename: "large.bin",
      fileSha256: "a".repeat(64),
      signal: controller.signal,
      transferId: "transfer-cancel",
    });

    await expect(transferPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(fileChannel.send).toHaveBeenCalledOnce();
    transport.close();
  });

  it("does not tear down a peer for a transient disconnected state", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-transient-disconnect",
      { onError, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );

    const peer = FakePeerConnection.latest;
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange?.();

    expect(onError).not.toHaveBeenCalled();
    expect(peer.close).not.toHaveBeenCalled();
    transport.close();
  });

  it("closes a saturated pre-open queue before allowing Firestore fallback", async () => {
    const { startFirebaseViewerWebRtcTransport } = await import("./viewerFirebase");
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(
      "session-control-overflow",
      { onError, onFrame: vi.fn() },
      {} as ImportMetaEnv,
    );

    for (let index = 0; index < 2_048; index += 1) {
      expect(transport.sendControl(`key-down Repeat${index}`)).toBe(true);
    }
    expect(transport.sendControl("key-up Repeat2047")).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("control-queue-overflow"),
    }));
    expect(transport.sendControl("key-release-all")).toBe(false);
  });
});
