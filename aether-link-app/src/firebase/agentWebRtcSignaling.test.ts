import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
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
    onicecandidate: undefined,
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
  };
  return {
    peer,
    safeSetDoc: vi.fn(async () => undefined),
  };
});

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  getDoc: vi.fn(async () => ({
    data: () => ({
      negotiationId: "rtc-current",
      offer: { negotiationId: "rtc-current", type: "offer", sdp: "v=0\r\n" },
    }),
  })),
  getDocs: vi.fn(async () => ({ docs: [], empty: true })),
  limit: vi.fn(),
  onSnapshot: vi.fn(() => () => undefined),
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
  safeAddDoc: vi.fn(async () => ({ id: "candidate" })),
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
  });

  it("writes the gathered local Answer SDP containing ICE candidates", async () => {
    const { startAgentWebRtcTransportWithFirebase } = await import("./agentFirebase");
    const transport = await startAgentWebRtcTransportWithFirebase(
      "session-1",
      {},
      {
        WONREMOTE_FIREBASE_API_KEY: "api-key",
        WONREMOTE_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
        WONREMOTE_FIREBASE_PROJECT_ID: "project-id",
        WONREMOTE_FIREBASE_APP_ID: "app-id",
        WONREMOTE_FIREBASE_STORAGE_BUCKET: "bucket",
        WONREMOTE_FIREBASE_MESSAGING_SENDER_ID: "sender-id",
      },
    );

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
});
