import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDataChannelLike } from "./agentPeerConnection";
import { parseWebRtcFileChunk, serializeWebRtcFileAck, WEBRTC_FILE_CHANNEL_LABEL } from "../domain/webrtcFileTransfer";

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
    getDocs: vi.fn(async () => ({ docs: [], empty: true })),
    limit: vi.fn((count: number) => ({ kind: "limit", count })),
    offerSignal,
    onSnapshot: vi.fn<SnapshotListener>(() => () => undefined),
    orderBy: vi.fn((field: string, direction: string) => ({ kind: "orderBy", field, direction })),
    peer,
    query: vi.fn((target: { path?: string }, ...constraints: unknown[]) => ({ ...target, constraints })),
    safeAddDoc: vi.fn(async () => ({ id: "candidate" })),
    safeSetDoc: vi.fn(async () => undefined),
    unsubscribe: vi.fn(),
  };
});

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  getDoc: mocks.getDoc,
  getDocs: mocks.getDocs,
  limit: mocks.limit,
  onSnapshot: mocks.onSnapshot,
  orderBy: mocks.orderBy,
  query: mocks.query,
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
  it("advertises reverse file capability once on the current open file channel", async () => {
    const { startAgentWebRtcTransportWithFirebase } = await import("./agentFirebase");
    const transport = await startAgentWebRtcTransportWithFirebase("session-1", {}, firebaseEnv());
    const send = vi.fn();
    const channel: AgentDataChannelLike = { label: WEBRTC_FILE_CHANNEL_LABEL, readyState: "connecting", send };
    const peer = mocks.peer as unknown as { ondatachannel: (event: { channel: AgentDataChannelLike }) => void };
    try {
      peer.ondatachannel({ channel });
      expect(send).not.toHaveBeenCalled();
      channel.readyState = "open";
      channel.onopen?.(); channel.onopen?.();
      expect(send).toHaveBeenCalledExactlyOnceWith('{"type":"file-capabilities","reverseFileSend":1,"reverseFileResume":1}');
      channel.onclose?.(); channel.onopen?.();
      expect(send).toHaveBeenCalledOnce();
    } finally { await transport?.close(); }
  });
  it("exposes reverse file sending on the negotiated channel and aborts on close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wonremote-rtc-reverse-"));
    const sourcePath = path.join(root, "a.txt");
    await writeFile(sourcePath, "abc");
    const { startAgentWebRtcTransportWithFirebase } = await import("./agentFirebase");
    const transport = await startAgentWebRtcTransportWithFirebase("session-1", {}, firebaseEnv());
    const channel: AgentDataChannelLike = { label: WEBRTC_FILE_CHANNEL_LABEL, readyState: "open" };
    try {
      await expect(transport!.sendFile({ sourcePath, transferId: "before-channel" })).rejects.toThrow("unavailable");
      const peer = mocks.peer as unknown as { ondatachannel: (event: { channel: AgentDataChannelLike }) => void };
      peer.ondatachannel({ channel });
      channel.send = payload => {
        const chunk = parseWebRtcFileChunk(payload)!;
        expect(Buffer.from(chunk.fileData, "base64").toString()).toBe("abc");
        channel.onmessage?.({ data: serializeWebRtcFileAck({ type: "file-ack", transferId: chunk.transferId, status: "complete", receivedBytes: 3, receivedChunks: 1 }) });
      };
      await transport!.sendFile({ sourcePath, transferId: "reverse-success" });
      let sent!: () => void;
      const firstPacket = new Promise<void>(resolve => { sent = resolve; });
      channel.send = () => sent();
      const pending = transport!.sendFile({ sourcePath, transferId: "reverse-close" });
      const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await firstPacket;
      channel.onclose?.();
      await assertion;
      await expect(transport!.sendFile({ sourcePath, transferId: "after-close" })).rejects.toThrow("unavailable");
    } finally {
      await transport?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
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
    expect(mocks.orderBy).toHaveBeenCalledWith("createdAt", "desc");
    expect(mocks.limit).toHaveBeenCalledWith(20);
    expect(mocks.getDocs).toHaveBeenCalledWith(expect.objectContaining({
      path: "sessions/session-1/viewerCandidates",
    }));
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
