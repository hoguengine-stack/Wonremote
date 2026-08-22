import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const offerSignal = {
    negotiationId: "rtc-current",
    offer: { negotiationId: "rtc-current", type: "offer", sdp: "v=0\r\n" },
  };
  const peer = {
    addIceCandidate: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    connectionState: "new",
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "v=0\r\n" })),
    localDescription: {
      type: "answer",
      sdp: "v=0\r\na=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r\n",
    },
    onconnectionstatechange: undefined,
    ondatachannel: undefined,
    onicecandidate: undefined as
      | ((event: { candidate: { toJSON: () => Record<string, unknown> } | null }) => void)
      | undefined,
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
  };
  type SignalSnapshot = { data: () => typeof offerSignal | undefined };
  type SnapshotListener = (
    target: any,
    onNext: (snapshot: SignalSnapshot) => void,
    onError?: (error: Error) => void,
  ) => () => void;
  return {
    getDoc: vi.fn<() => Promise<SignalSnapshot>>(async () => ({ data: () => offerSignal })),
    offerSignal,
    onSnapshot: vi.fn<SnapshotListener>(() => () => undefined),
    peer,
    safeAddDoc: vi.fn(async () => ({ id: "candidate" })),
    safeSetDoc: vi.fn(async () => undefined),
    unsubscribe: vi.fn(),
  };
});

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  getDoc: mocks.getDoc,
  getDocs: vi.fn(async () => ({ docs: [], empty: true })),
  limit: vi.fn(),
  onSnapshot: mocks.onSnapshot,
  orderBy: vi.fn(),
  query: vi.fn(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(() => "server-time"),
  where: vi.fn(),
  writeBatch: vi.fn(),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => ({ auth: {}, db: {}, functions: {}, storage: {} })),
}));

vi.mock("./firestoreWrite", () => ({
  safeAddDoc: mocks.safeAddDoc,
  safeBatchUpdate: vi.fn(),
  safeSetDoc: mocks.safeSetDoc,
  safeUpdateDoc: vi.fn(),
}));

vi.mock("./agentPeerConnection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentPeerConnection")>()),
  createAgentPeerConnection: vi.fn(async () => mocks.peer),
}));

describe("Agent WebRTC Firebase signaling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeAddDoc.mockResolvedValue({ id: "candidate" });
    mocks.getDoc.mockImplementation(async () => ({ data: () => mocks.offerSignal }));
    mocks.onSnapshot.mockImplementation((target: any, onNext: (snapshot: any) => void) => {
      if (String(target?.path ?? "").endsWith("webrtc/signal")) {
        onNext({ data: () => mocks.offerSignal });
      }
      return mocks.unsubscribe;
    });
  });

  it("answers an offer delivered by the realtime listener without waiting for the 250ms poll", async () => {
    vi.useFakeTimers();
    mocks.getDoc.mockImplementation(async () => ({ data: () => undefined }));
    mocks.onSnapshot.mockImplementation((target: any, onNext: (snapshot: any) => void) => {
      if (String(target?.path ?? "").endsWith("webrtc/signal")) {
        onNext({ data: () => mocks.offerSignal });
      }
      return mocks.unsubscribe;
    });

    const { startAgentWebRtcTransportWithFirebase } = await import("./agentFirebase");
    const transportPromise = startAgentWebRtcTransportWithFirebase(
      "session-1",
      {},
      firebaseEnv({ WONREMOTE_RTC_CONNECT_TIMEOUT_MS: "2000" }),
    );
    let transport: Awaited<typeof transportPromise> | undefined;

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.safeSetDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ state: "agent-answer" }),
        { merge: true },
      );
      expect(mocks.getDoc).not.toHaveBeenCalled();
      expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
      transport = await transportPromise;
    } finally {
      if (transport === undefined) {
        await vi.advanceTimersByTimeAsync(2_500);
        transport = await transportPromise;
      }
      await transport?.close();
      vi.useRealTimers();
    }
  });

  it("unsubscribes the one-shot offer listener when the connect timeout expires", async () => {
    vi.useFakeTimers();
    mocks.onSnapshot.mockImplementation(() => mocks.unsubscribe);
    const onState = vi.fn();

    try {
      const { startAgentWebRtcTransportWithFirebase } = await import("./agentFirebase");
      const transportPromise = startAgentWebRtcTransportWithFirebase(
        "session-timeout",
        { onState },
        firebaseEnv({ WONREMOTE_RTC_CONNECT_TIMEOUT_MS: "2000" }),
      );
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(transportPromise).resolves.toBeNull();
      expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
      expect(onState).toHaveBeenCalledWith("error", expect.stringContaining("without a Viewer offer"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the gathered local Answer SDP containing ICE candidates", async () => {
    const onState = vi.fn();
    const { startAgentWebRtcTransportWithFirebase } = await import("./agentFirebase");
    const transport = await startAgentWebRtcTransportWithFirebase(
      "session-1",
      { onState },
      firebaseEnv(),
    );

    expect(onState).toHaveBeenCalledWith("negotiating");
    expect(mocks.safeSetDoc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        answer: expect.objectContaining({
          negotiationId: "rtc-current",
          sdp: expect.stringContaining("a=candidate:"),
        }),
      }),
      { merge: true },
    );
    await transport?.close();
  });

  it("does not fail the whole transport when one Agent ICE candidate write fails", async () => {
    const onState = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { startAgentWebRtcTransportWithFirebase } = await import("./agentFirebase");
    const transport = await startAgentWebRtcTransportWithFirebase(
      "session-candidate-warning",
      { onState },
      firebaseEnv(),
    );

    mocks.safeAddDoc.mockRejectedValueOnce(new Error("candidate write denied"));
    mocks.peer.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "candidate:1" }) } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("remaining candidates will continue"),
    ));

    expect(onState).not.toHaveBeenCalledWith("error", expect.anything());
    await transport?.close();
    warn.mockRestore();
  });

  it("resubscribes to signaling after a listener failure without closing the active transport", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let signalSubscriptionCount = 0;
    mocks.onSnapshot.mockImplementation((target: any, onNext: (snapshot: any) => void, onError?: (error: Error) => void) => {
      if (String(target?.path ?? "").endsWith("webrtc/signal")) {
        signalSubscriptionCount += 1;
        if (signalSubscriptionCount === 2) {
          queueMicrotask(() => onError?.(new Error("listener offline")));
        } else {
          onNext({ data: () => mocks.offerSignal });
        }
      }
      return mocks.unsubscribe;
    });

    const { startAgentWebRtcTransportWithFirebase } = await import("./agentFirebase");
    const transport = await startAgentWebRtcTransportWithFirebase(
      "session-signal-resubscribe",
      {},
      firebaseEnv({ WONREMOTE_RTC_CONNECT_TIMEOUT_MS: "2000" }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(signalSubscriptionCount).toBe(3);
    expect(mocks.peer.close).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("resubscribing"));
    await transport?.close();
    warn.mockRestore();
    vi.useRealTimers();
  });
});

function firebaseEnv(overrides: Record<string, string> = {}) {
  return {
    WONREMOTE_FIREBASE_API_KEY: "api-key",
    WONREMOTE_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
    WONREMOTE_FIREBASE_PROJECT_ID: "project-id",
    WONREMOTE_FIREBASE_APP_ID: "app-id",
    WONREMOTE_FIREBASE_STORAGE_BUCKET: "bucket",
    WONREMOTE_FIREBASE_MESSAGING_SENDER_ID: "sender-id",
    ...overrides,
  };
}
