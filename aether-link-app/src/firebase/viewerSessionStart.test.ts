import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginConnectionTiming, markConnectionTiming } from "../domain/connectionTiming";

const dynamicTurnEnv: ImportMetaEnv = {
  BASE_URL: "/", DEV: false, PROD: false, SSR: false, MODE: "test", VITE_WONREMOTE_APP_VERSION: "0.0.0",
  VITE_WONREMOTE_RTC_DYNAMIC_CREDENTIALS: "true",
};

const state = vi.hoisted(() => ({
  viewerUid: "viewer-1",
  batch: {
    commit: vi.fn<() => Promise<void>>(async () => undefined),
    set: vi.fn(),
  },
  getDoc: vi.fn(async () => ({ id: "device-1", exists: () => true, data: () => ({ ownerUid: "agent-1", protocolVersion: 2, status: "online" }) })),
  safeBatchSet: vi.fn((batch: { set: (...args: unknown[]) => unknown }, ref: unknown, data: unknown, options?: unknown) =>
    options === undefined ? batch.set(ref, data) : batch.set(ref, data, options)),
  snapshot: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(async (_ref: unknown) => {}),
  signal: vi.fn(),
  turn: vi.fn(),
}));

vi.mock("firebase/functions", () => ({httpsCallable: () => state.turn}));
vi.mock("firebase/auth", async importOriginal => ({
  ...await importOriginal<typeof import("firebase/auth")>(), signOut: vi.fn(async () => {}),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  doc: vi.fn((root: { path?: string }, ...segments: string[]) => segments.length > 0
    ? { path: segments.join("/") }
    : { path: `${root.path}/command-auto` }),
  getDoc: state.getDoc,
  getDocFromServer: state.getDoc,
  getDocs: vi.fn(async () => ({empty:true, docs:[]})),
  deleteDoc: state.remove,
  limit: vi.fn(),
  onSnapshot: state.snapshot,
  orderBy: vi.fn(),
  query: vi.fn(),
  serverTimestamp: vi.fn(() => "server-time"),
  where: vi.fn(),
  writeBatch: vi.fn(() => state.batch),
}));

vi.mock("./firebaseServices", () => ({
  getWonRemoteFirebaseServices: vi.fn(() => ({
    auth: { get currentUser() { return { uid: state.viewerUid }; } },
    db: {},
    functions: {},
    storage: {},
  })),
}));

vi.mock("./firestoreWrite", () => ({
  safeAddDoc: state.add,
  safeBatchSet: state.safeBatchSet,
  safeBatchUpdate: vi.fn(),
  safeSetDoc: state.signal,
  safeUpdateDoc: vi.fn(),
}));

describe("Viewer direct session start", () => {
  afterEach(() => {vi.unstubAllGlobals();vi.useRealTimers();});
  beforeEach(() => {
    vi.clearAllMocks();
    state.viewerUid = "viewer-1";
  });

  function rtcFixture(offerReady?: Promise<void>, failFirstOffer = false, deferredPeer = 0) {
    const peers: any[]=[];
    class Peer {
      localDescription: unknown=null;
      onicecandidate: any;
      close=vi.fn(); addIceCandidate=vi.fn(async()=>{}); setRemoteDescription=vi.fn(async()=>{});
      createOffer=vi.fn(async()=>{
        if (peers[0] === this && failFirstOffer) throw new Error("preparation failed");
        if (peers[deferredPeer] === this) await offerReady;
        return {type:"offer",sdp:"prepared-offer"};
      });
      setLocalDescription=vi.fn(async description=>{this.localDescription=description;this.onicecandidate?.({candidate:{toJSON:()=>({candidate:"buffered-host"})}});});
      createDataChannel=vi.fn((label:string)=>({label,readyState:"connecting",send:vi.fn(),close:vi.fn()}));
      constructor(){peers.push(this);}
    }
    vi.stubGlobal("RTCPeerConnection",Peer);
    return peers;
  }

  it.each(["acknowledged","closed","denied"])("prepares local offer during target validation and queues it before ICE candidates (%s)", async outcome => {
    if (outcome === "denied") vi.useFakeTimers();
    const peers=rtcFixture();
    let validate!: (snapshot:any)=>void;
    state.getDoc.mockImplementationOnce(()=>new Promise(resolve=>{validate=resolve;}));
    state.add.mockResolvedValue({id:"candidate"});
    let acknowledgeOffer!: () => void, denyOffer!: (error:Error) => void;
    state.signal.mockImplementationOnce(() => new Promise<void>((resolve,reject) => { acknowledgeOffer=resolve; denyOffer=reject; }));
    const unsubscribes: ReturnType<typeof vi.fn>[] = [];
    state.snapshot.mockImplementation(()=>{const stop=vi.fn();unsubscribes.push(stop);return stop;});
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const opening=openFirebaseSession("device-1",{} as ImportMetaEnv);
    await vi.waitFor(()=>expect(peers[0]?.createOffer).toHaveBeenCalledOnce());
    expect(state.batch.commit).not.toHaveBeenCalled();expect(state.signal).not.toHaveBeenCalled();expect(state.add).not.toHaveBeenCalled();
    validate({id:"device-1",exists:()=>true,data:()=>({ownerUid:"agent-1",protocolVersion:2,status:"online"})});
    const {session}=await opening;
    const onState=vi.fn(), onError=vi.fn();
    const transport=await startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn(),onState,onError},{} as ImportMetaEnv);
    try {
      await vi.waitFor(()=>expect(state.signal).toHaveBeenCalledOnce());
      expect(peers).toHaveLength(1);expect(peers[0].createOffer).toHaveBeenCalledOnce();expect(peers[0].createDataChannel).toHaveBeenCalledTimes(3);
      expect(state.add).toHaveBeenCalledOnce();expect(state.add.mock.calls[0][1]).toMatchObject({candidate:{candidate:"buffered-host"}});
      expect(state.snapshot).toHaveBeenCalledTimes(2);
      expect(state.signal.mock.invocationCallOrder[0]).toBeLessThan(state.snapshot.mock.invocationCallOrder[0]);
      expect(state.signal.mock.invocationCallOrder[0]).toBeLessThan(state.add.mock.invocationCallOrder[0]);
      peers[0].onicecandidate({candidate:{toJSON:()=>({candidate:"later-candidate"})}});
      expect(state.add.mock.calls.map(([,data])=>data.candidate.candidate)).toEqual(["buffered-host","later-candidate"]);
      expect(onState).not.toHaveBeenCalledWith("webrtc-offer-sent");
      if (outcome === "closed") {
        transport.close();
        peers[0].onicecandidate({candidate:{toJSON:()=>({candidate:"late-after-close"})}});
        expect(state.add).toHaveBeenCalledTimes(2);
      }
      if (outcome === "denied") {
        denyOffer(new Error("Fixture offer denied."));
        await vi.waitFor(()=>expect(onError).toHaveBeenCalledOnce());
        expect(onError.mock.calls[0][0].message).toContain("Fixture offer denied.");
        expect(unsubscribes).toHaveLength(2);
        for(const stop of unsubscribes) expect(stop).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        peers[0].onicecandidate({candidate:{toJSON:()=>({candidate:"late-after-denial"})}});
        expect(state.add).toHaveBeenCalledTimes(2);
        expect(onState).not.toHaveBeenCalledWith("webrtc-offer-sent");
      } else if (outcome === "closed") {
        acknowledgeOffer();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(onState).not.toHaveBeenCalledWith("webrtc-offer-sent");
        expect(state.signal).toHaveBeenCalledOnce();
      } else {
        acknowledgeOffer();
        await vi.waitFor(()=>expect(onState).toHaveBeenCalledWith("webrtc-offer-sent"));
      }
      expect(state.batch.commit).toHaveBeenCalledOnce();expect(state.getDoc).toHaveBeenCalledOnce();
    } finally {
      acknowledgeOffer?.();
      transport.close();
      expect(peers[0].close).toHaveBeenCalledOnce();
    }
  });

  it("applies an answer from the first watch snapshot while the offer write acknowledgement is pending", async () => {
    const peers = rtcFixture();
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    state.signal.mockImplementationOnce(() => ack);
    state.snapshot.mockImplementationOnce((_ref, next) => {
      const negotiationId = state.signal.mock.calls[0][1].negotiationId;
      next({data:() => ({answer:{type:"answer",sdp:"early-answer",negotiationId}})});
      return vi.fn();
    }).mockImplementationOnce(() => vi.fn());
    const {startFirebaseViewerWebRtcTransport} = await import("./viewerFirebase");
    const onState = vi.fn();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    beginConnectionTiming("initial-answer", "viewer");
    const transport = await startFirebaseViewerWebRtcTransport("initial-answer",{onFrame:vi.fn(),onState},{} as ImportMetaEnv);
    try {
      await vi.waitFor(() => expect(peers[0].setRemoteDescription).toHaveBeenCalledExactlyOnceWith({type:"answer",sdp:"early-answer"}));
      expect(state.snapshot).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"stage":"offer-queued"'));
      expect(onState).not.toHaveBeenCalledWith("webrtc-offer-sent");
      acknowledge();
      await vi.waitFor(() => expect(onState).toHaveBeenCalledWith("webrtc-offer-sent"));
    } finally { acknowledge(); transport.close(); markConnectionTiming("initial-answer", "cancelled"); log.mockRestore(); }
  });

  it.each(["accepted", "denied"])("queues one prepared offer only after session acceptance and hands it to the mounted transport: %s", async outcome => {
    const peers = rtcFixture();
    let acceptSession!: () => void, acceptOffer!: () => void, rejectOffer!: (error: Error) => void;
    state.batch.commit.mockImplementationOnce(() => new Promise<void>(resolve => { acceptSession = resolve; }));
    const offerAck = new Promise<void>((resolve, reject) => { acceptOffer = resolve; rejectOffer = reject; });
    state.signal.mockImplementationOnce(() => offerAck);
    state.add.mockResolvedValue({id:"candidate"});
    state.snapshot.mockImplementation(() => vi.fn());
    if (outcome === "accepted") {
      state.snapshot.mockImplementationOnce((_ref, next) => {
        const negotiationId = state.signal.mock.calls[0][1].negotiationId;
        next({data:() => ({answer:{type:"answer",sdp:"already-answered",negotiationId}})});
        return vi.fn();
      });
    }
    const {openFirebaseSession, queuePreparedFirebaseViewerOffer, startFirebaseViewerWebRtcTransport} = await import("./viewerFirebase");
    const env = {} as ImportMetaEnv;
    const opening = openFirebaseSession("device-1", env);
    await vi.waitFor(() => expect(state.batch.commit).toHaveBeenCalledOnce());
    const sessionId = state.batch.set.mock.calls[0][0].path.split("/")[1];
    queuePreparedFirebaseViewerOffer(sessionId);
    expect(state.signal).not.toHaveBeenCalled();
    acceptSession();
    const {session} = await opening;
    expect(session.id).toBe(sessionId);
    state.viewerUid = "viewer-2";
    queuePreparedFirebaseViewerOffer(sessionId);
    expect(state.signal).not.toHaveBeenCalled();
    state.viewerUid = "viewer-1";
    queuePreparedFirebaseViewerOffer(sessionId);
    queuePreparedFirebaseViewerOffer(sessionId);
    expect(state.signal).toHaveBeenCalledOnce();
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    if (outcome === "denied") {
      rejectOffer(new Error("Early offer denied."));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const onState = vi.fn(), onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport(sessionId, {onFrame:vi.fn(),onState,onError}, env);
    try {
      expect(state.signal).toHaveBeenCalledOnce();
      if (outcome === "accepted") {
        await vi.waitFor(() => expect(peers[0].setRemoteDescription).toHaveBeenCalledExactlyOnceWith({type:"answer",sdp:"already-answered"}));
        expect(onState).not.toHaveBeenCalledWith("webrtc-offer-sent");
        acceptOffer();
        await vi.waitFor(() => expect(onState).toHaveBeenCalledWith("webrtc-offer-sent"));
        expect(state.add).toHaveBeenCalledOnce();
      } else {
        await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message:expect.stringContaining("Early offer denied.")})));
        expect(state.snapshot).not.toHaveBeenCalled();
        expect(state.add).not.toHaveBeenCalled();
      }
      expect(state.signal).toHaveBeenCalledOnce();
      expect(peers).toHaveLength(1);
    } finally { acceptOffer(); transport.close(); }
  });

  it("leaves an accepted session available when early signaling setup throws synchronously", async () => {
    const peers = rtcFixture();
    state.signal.mockResolvedValue(undefined);
    state.snapshot.mockImplementation(() => vi.fn());
    const {doc} = await import("firebase/firestore");
    const {openFirebaseSession, queuePreparedFirebaseViewerOffer, startFirebaseViewerWebRtcTransport} = await import("./viewerFirebase");
    const env = {} as ImportMetaEnv;
    const {session} = await openFirebaseSession("device-1", env);
    await new Promise(resolve => setTimeout(resolve, 0));
    const refs = vi.mocked(doc).mock.calls.length;
    vi.mocked(doc).mockImplementationOnce(() => { throw new Error("Early reference unavailable"); });
    expect(() => queuePreparedFirebaseViewerOffer(session.id)).not.toThrow();
    expect(doc).toHaveBeenCalledTimes(refs + 1);
    expect(state.signal).not.toHaveBeenCalled();
    const transport = await startFirebaseViewerWebRtcTransport(session.id, {onFrame:vi.fn()}, env);
    try {
      await vi.waitFor(() => expect(state.signal).toHaveBeenCalledOnce());
      expect(peers).toHaveLength(1);
    } finally { transport.close(); }
  });

  it.each(["prepared", "mounted", "extra-media", "malformed-space"])("uses only the published data-only offer to avoid duplicate candidate writes (%s)", async scenario => {
    const peers = rtcFixture();
    state.signal.mockResolvedValue(undefined);
    state.snapshot.mockImplementation(() => vi.fn());
    state.add.mockResolvedValue({id:"candidate"});
    const {openFirebaseSession, queuePreparedFirebaseViewerOffer, startFirebaseViewerWebRtcTransport} = await import("./viewerFirebase");
    const env = {} as ImportMetaEnv;
    const {session} = await openFirebaseSession("device-1", env);
    await new Promise(resolve => setTimeout(resolve, 0));
    const original = "candidate:11 1 udp 2113937151 192.0.2.1 5000 typ host generation 0 network-id 1";
    const next = original.replace(" 5000 ", " 5001 ");
    const usernameFragment = "demo";
    const candidate = {candidate:original.replace("network-id", "ufrag demo network-id"),sdpMid:"0",sdpMLineIndex:0,usernameFragment};
    const from = (value: RTCIceCandidateInit) => ({candidate:{toJSON:() => value}});
    const unsupported = [
      original.replace("192.0.2.1", "local-candidate.local"),
      original.replace("192.0.2.1", "2001:db8::1"),
      original.replace("typ host", "typ relay"),
      original.replace(" 1 udp ", " 1 tcp "),
    ];
    const offered = scenario === "malformed-space" ? original.replace(" 1 udp ", "  1 udp ") : original;
    const lines = ["v=0","m=application 9 UDP/DTLS/SCTP webrtc-datachannel","a=mid:0","a=ice-ufrag:demo",
      ...[offered,...unsupported].map(line => `a=${line}`)];
    if (scenario === "extra-media") lines.push("m=audio 9 UDP/TLS/RTP/SAVPF 111","a=mid:1");
    const sdp = lines.join("\r\n");
    peers[0].localDescription = {type:"offer",sdp};
    peers[0].onicecandidate(from(candidate));
    if (scenario !== "mounted") {
      queuePreparedFirebaseViewerOffer(session.id);
      expect(state.signal).toHaveBeenCalledOnce();
      peers[0].localDescription = {type:"offer",sdp:`${sdp}\r\na=${next}\r\n`};
    }
    const transport = await startFirebaseViewerWebRtcTransport(session.id, {onFrame:vi.fn()}, env);
    try {
      const unique = [
        {...candidate,candidate:next},
        {...candidate,sdpMid:"different"},
        {...candidate,sdpMLineIndex:1},
        {...candidate,usernameFragment:"different"},
        {...candidate,candidate:candidate.candidate.replace("ufrag demo","ufrag different")},
        {...candidate,candidate:"candidate:11 1"},
        ...unsupported.map(value => ({...candidate,candidate:value})),
      ];
      for (const value of [candidate,...unique]) peers[0].onicecandidate(from(value));
      expect(state.signal).toHaveBeenCalledOnce();
      expect(state.signal.mock.calls[0][1].offer.sdp).toBe(sdp);
      expect(state.add.mock.calls.map(([,data])=>data.candidate)).toEqual([
        {candidate:"buffered-host"}, ...(scenario === "extra-media" || scenario === "malformed-space" ? [candidate,candidate] : []), ...unique,
      ]);
    } finally { transport.close(); }
  });

  it.each(["close", "expire"])("cleans up the unclaimed early offer peer when it must %s", async outcome => {
    vi.useFakeTimers();
    const peers = rtcFixture();
    state.signal.mockResolvedValue(undefined);
    state.snapshot.mockImplementation(() => vi.fn());
    state.add.mockResolvedValue({id:"candidate"});
    const {openFirebaseSession, closeFirebaseSession, queuePreparedFirebaseViewerOffer, startFirebaseViewerWebRtcTransport} = await import("./viewerFirebase");
    const env = {} as ImportMetaEnv;
    const {session} = await openFirebaseSession("device-1", env);
    await vi.advanceTimersByTimeAsync(0);
    queuePreparedFirebaseViewerOffer(session.id);
    expect(state.signal).toHaveBeenCalledOnce();
    expect(state.snapshot).not.toHaveBeenCalled();
    if (outcome === "close") {
      state.getDoc.mockResolvedValueOnce({id:session.id,exists:()=>true,data:()=>({deviceId:"device-1",ownerUid:"viewer-1",state:"connected",status:"online",protocolVersion:2})});
      await closeFirebaseSession(session.id, env);
      queuePreparedFirebaseViewerOffer(session.id);
      expect(state.signal).toHaveBeenCalledOnce();
      expect(state.add.mock.calls.filter(([ref])=>ref?.path?.endsWith("/viewerCandidates"))).toHaveLength(0);
    } else {
      await vi.advanceTimersByTimeAsync(86_400_000);
      queuePreparedFirebaseViewerOffer(session.id);
      expect(state.signal).toHaveBeenCalledOnce();
      const transport = await startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},env);
      try {
        await vi.waitFor(() => expect(state.signal).toHaveBeenCalledTimes(2));
        expect(state.signal.mock.calls[0][1].negotiationId).not.toBe(state.signal.mock.calls[1][1].negotiationId);
        expect(peers).toHaveLength(2);
      } finally { transport.close(); }
    }
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a synchronously denied answer watch without opening a candidate watch or writing candidates", async () => {
    const peers = rtcFixture();
    let failWrite!: (error: Error) => void;
    const ack = new Promise<void>((_, reject) => { failWrite = reject; });
    state.signal.mockImplementationOnce(() => ack);
    const stop = vi.fn();
    state.snapshot.mockImplementationOnce((_ref, _next, fail) => {fail(new Error("answer watch denied"));return stop;});
    const {startFirebaseViewerWebRtcTransport} = await import("./viewerFirebase");
    const onError = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport("watch-denied",{onFrame:vi.fn(),onError},{} as ImportMetaEnv);
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message:expect.stringContaining("answer watch denied")}));
      expect(state.snapshot).toHaveBeenCalledOnce();
      expect(state.add).not.toHaveBeenCalled();
      expect(peers[0].close).toHaveBeenCalledOnce();
    } finally { transport.close(); failWrite(new Error("offer write denied")); }
  });

  it("diagnoses candidate-watch registration failure separately and releases the existing answer watch", async () => {
    const peers = rtcFixture();
    const stop = vi.fn();
    state.signal.mockResolvedValueOnce(undefined);
    state.snapshot.mockImplementationOnce(() => stop).mockImplementationOnce(() => {throw new Error("candidate watch registration");});
    const {startFirebaseViewerWebRtcTransport} = await import("./viewerFirebase");
    const onError = vi.fn(), onState = vi.fn();
    const transport = await startFirebaseViewerWebRtcTransport("candidate-watch-error",{onFrame:vi.fn(),onState,onError},{} as ImportMetaEnv);
    try {
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
      expect(onError.mock.calls[0][0].message).toContain("(agent-candidate-listener-failed)");
      expect(onState).not.toHaveBeenCalledWith("webrtc-offer-sent");
      expect(state.add).not.toHaveBeenCalled();
    } finally {
      transport.close();
      expect(stop).toHaveBeenCalledOnce();
      expect(peers[0].close).toHaveBeenCalledOnce();
    }
  });

  it("drops buffered local candidates if an unprepared offer is cancelled before submission", async () => {
    let releaseOffer!: () => void;
    const peers=rtcFixture(new Promise<void>(resolve=>{releaseOffer=resolve;}));
    state.snapshot.mockImplementation(()=>vi.fn());
    const {startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const transport=await startFirebaseViewerWebRtcTransport("cancelled-offer",{onFrame:vi.fn()},{} as ImportMetaEnv);
    try {
      const candidate={candidate:{toJSON:()=>({candidate:"buffered-before-cancel"})}};
      peers[0].onicecandidate(candidate);
      expect(state.add).not.toHaveBeenCalled();
      expect(state.snapshot).not.toHaveBeenCalled();
      transport.close();
      releaseOffer();
      peers[0].onicecandidate(candidate);
      await peers[0].createOffer.mock.results[0].value;
      expect(peers[0].close).toHaveBeenCalledOnce();
      expect(peers[0].setLocalDescription).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.signal).not.toHaveBeenCalled();
    } finally { releaseOffer(); transport.close(); }
  });

  it("does not publish or reuse preparation after the authenticated Viewer changes", async () => {
    const peers = rtcFixture();
    state.signal.mockResolvedValue(undefined);
    state.add.mockResolvedValue({id:"candidate"});
    state.snapshot.mockImplementation(() => vi.fn());
    const {openFirebaseSession, startFirebaseViewerWebRtcTransport} = await import("./viewerFirebase");
    const {session} = await openFirebaseSession("device-1", {} as ImportMetaEnv);
    state.viewerUid = "viewer-2";
    await expect(startFirebaseViewerWebRtcTransport(session.id, {onFrame:vi.fn()}, {} as ImportMetaEnv)).rejects.toThrow("account changed");
    expect(state.signal).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(peers).toHaveLength(1);
    expect(peers[0].close).toHaveBeenCalledOnce();
  });

  it("closes local preparation on denied validation without publishing signals or commands", async () => {
    const peers=rtcFixture();
    let validate!: (snapshot: Awaited<ReturnType<typeof state.getDoc>>) => void;
    state.getDoc.mockImplementationOnce(()=>new Promise(resolve=>{validate=resolve;}));
    const {openFirebaseSession}=await import("./viewerFirebase");
    const opening=openFirebaseSession("device-1",{} as ImportMetaEnv);
    const rejected=expect(opening).rejects.toThrow("online");
    await vi.waitFor(()=>expect(peers).toHaveLength(1));
    validate({id:"device-1",exists:()=>true,data:()=>({ownerUid:"agent-1",protocolVersion:2,status:"offline"})});
    await rejected;
    await vi.waitFor(()=>expect(peers[0]?.close).toHaveBeenCalledOnce());
    expect(state.batch.commit).not.toHaveBeenCalled();expect(state.signal).not.toHaveBeenCalled();expect(state.add).not.toHaveBeenCalled();
  });

  it.each([false, true])("discards a prepared peer but preserves an already committed session ID for cleanup (reconnect=%s)", async reconnect => {
    vi.useFakeTimers();
    const peers=rtcFixture();
    let commit!: () => void;
    state.batch.commit.mockImplementationOnce(()=>new Promise(resolve=>{commit=resolve;}));
    const {openFirebaseSession,logoutViewerWithFirebase}=await import("./viewerFirebase");
    const opening=openFirebaseSession("device-1",{} as ImportMetaEnv,reconnect);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.batch.commit).toHaveBeenCalledOnce();
    expect(peers[0].setLocalDescription).toHaveBeenCalledOnce();
    expect(state.signal).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    await logoutViewerWithFirebase({} as ImportMetaEnv);
    expect(peers[0].close).toHaveBeenCalledOnce();
    commit();
    await expect(opening).resolves.toMatchObject({session:{id:expect.any(String),state:"connected"}});
    expect(vi.getTimerCount()).toBe(0);
    expect(state.signal).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("preserves a callable reconnect's already dispatched session ID for logout cleanup", async () => {
    const env = {VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE:"callable"} as ImportMetaEnv;
    let admit!: (response: unknown) => void;
    state.turn.mockImplementationOnce(() => new Promise(resolve => { admit = resolve; }));
    const {openFirebaseSession,logoutViewerWithFirebase}=await import("./viewerFirebase");
    const opening=openFirebaseSession("device-1",env,true);
    await vi.waitFor(() => expect(state.turn).toHaveBeenCalledOnce());
    await logoutViewerWithFirebase(env);
    const result = {session:{id:"session-to-close",state:"connected"},inputLog:[]};
    admit({data:result});
    await expect(opening).resolves.toEqual(result);
    expect(state.batch.commit).not.toHaveBeenCalled();
  });

  it("expires an abandoned prepared peer without background requests", async () => {
    vi.useFakeTimers();const peers=rtcFixture();
    const {openFirebaseSession}=await import("./viewerFirebase");
    await openFirebaseSession("device-1",{} as ImportMetaEnv);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(peers[0].close).toHaveBeenCalledOnce();expect(state.signal).not.toHaveBeenCalled();expect(state.add).not.toHaveBeenCalled();
    expect(state.batch.commit).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });

  it("commits the Agent command without waiting and claims the in-flight offer once", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const peers=rtcFixture(new Promise<void>(resolve=>{finish=resolve;}));
    state.snapshot.mockImplementation(()=>vi.fn());state.add.mockResolvedValue({id:"candidate"});state.signal.mockResolvedValue(undefined);
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const {session}=await openFirebaseSession("device-1",{} as ImportMetaEnv);
    expect(state.batch.commit).toHaveBeenCalledOnce();
    const connecting=startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},{} as ImportMetaEnv);
    await expect(startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},{} as ImportMetaEnv)).rejects.toThrow("already in progress");
    await vi.advanceTimersByTimeAsync(74);
    expect(peers).toHaveLength(1);
    expect(state.signal).not.toHaveBeenCalled();
    finish();
    const transport=await connecting;
    await vi.advanceTimersByTimeAsync(0);
    expect(peers).toHaveLength(1);
    expect(peers[0].createOffer).toHaveBeenCalledOnce();
    expect(state.signal).toHaveBeenCalledOnce();
    transport.close();
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back after at most 75ms of unresolved SDP using the original TURN configuration", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const peers=rtcFixture(new Promise<void>(resolve=>{finish=resolve;}));
    state.turn.mockResolvedValue({data:{iceServers:[{urls:["turn:relay.test:3478"]}]}});
    state.snapshot.mockImplementation(()=>vi.fn());state.add.mockResolvedValue({id:"candidate"});state.signal.mockResolvedValue(undefined);
    const env=dynamicTurnEnv;
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const {session}=await openFirebaseSession("device-1",env);
    const connecting=startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},env);
    await vi.advanceTimersByTimeAsync(75);
    const transport=await connecting;
    expect(state.turn).toHaveBeenCalledOnce();
    expect(peers).toHaveLength(2);
    expect(peers[0].close).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(peers[0].setLocalDescription).not.toHaveBeenCalled();
    expect(state.signal).toHaveBeenCalledOnce();
    transport.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["logout", "switch"])("closes in-flight preparation on %s without publishing signaling", async mode => {
    vi.useFakeTimers();
    let finish!: () => void;
    const peers=rtcFixture(new Promise<void>(resolve=>{finish=resolve;}));
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport,logoutViewerWithFirebase}=await import("./viewerFirebase");
    const {session}=await openFirebaseSession("device-1",{} as ImportMetaEnv);
    const connecting=startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},{} as ImportMetaEnv);
    const rejected=expect(connecting).rejects.toThrow("cancelled or the Viewer account changed");
    if (mode === "logout") await logoutViewerWithFirebase({} as ImportMetaEnv);
    else state.viewerUid="viewer-2";
    finish();
    await rejected;
    expect(peers).toHaveLength(1);
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(state.signal).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses a slow in-flight TURN request instead of starting another one after the handoff deadline", async () => {
    vi.useFakeTimers();
    const peers=rtcFixture();
    let finish!: (value: unknown) => void;
    state.turn.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    state.snapshot.mockImplementation(()=>vi.fn());state.add.mockResolvedValue({id:"candidate"});state.signal.mockResolvedValue(undefined);
    const env=dynamicTurnEnv;
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const {session}=await openFirebaseSession("device-1",env);
    const connecting=startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},env);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.turn).toHaveBeenCalledOnce();
    expect(state.signal).not.toHaveBeenCalled();
    expect(peers).toHaveLength(0);
    finish({data:{iceServers:[{urls:["turn:relay.test:3478"]}]}});
    const transport=await connecting;
    await vi.advanceTimersByTimeAsync(0);
    expect(state.turn).toHaveBeenCalledOnce();
    expect(peers).toHaveLength(1);
    expect(state.signal).toHaveBeenCalledOnce();
    transport.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the existing single fallback retry when a relay-only configuration request fails", async () => {
    const peers=rtcFixture();
    state.turn.mockRejectedValueOnce(new Error("temporary TURN failure"))
      .mockResolvedValueOnce({data:{iceServers:[{urls:["turn:relay.test:3478"]}],iceTransportPolicy:"relay"}});
    state.snapshot.mockImplementation(()=>vi.fn());state.add.mockResolvedValue({id:"candidate"});state.signal.mockResolvedValue(undefined);
    const env={...dynamicTurnEnv,VITE_WONREMOTE_RTC_RELAY_ONLY:"true"};
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const {session}=await openFirebaseSession("device-1",env);
    const transport=await startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},env);
    await vi.waitFor(()=>expect(state.signal).toHaveBeenCalledOnce());
    expect(state.turn).toHaveBeenCalledTimes(2);
    expect(peers).toHaveLength(1);
    transport.close();
  });

  it("ends the original TURN request and fallback wait within the original SDK window", async () => {
    vi.useFakeTimers({toFake:["setTimeout", "clearTimeout", "performance"]});
    const peers=rtcFixture();
    let failFirst!: (error: Error) => void;
    state.turn.mockImplementationOnce(()=>new Promise((_, reject)=>{failFirst=reject;}))
      .mockImplementationOnce(()=>new Promise(()=>{}));
    const env={...dynamicTurnEnv,VITE_WONREMOTE_RTC_RELAY_ONLY:"true"};
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const {session}=await openFirebaseSession("device-1",env);
    const connecting=startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},env);
    const rejected=expect(connecting).rejects.toThrow("configuration timed out");
    await vi.advanceTimersByTimeAsync(69_900);
    expect(state.turn).toHaveBeenCalledOnce();
    failFirst(new Error("temporary TURN failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.turn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(peers).toHaveLength(0);
    expect(state.signal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains normal transport setup after optional preparation fails", async () => {
    const peers=rtcFixture(undefined,true);
    state.signal.mockResolvedValue(undefined);state.add.mockResolvedValue({id:"candidate"});state.snapshot.mockImplementation(()=>vi.fn());
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const {session}=await openFirebaseSession("device-1",{} as ImportMetaEnv);
    const transport=await startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},{} as ImportMetaEnv);
    await vi.waitFor(()=>expect(state.signal).toHaveBeenCalledOnce());
    expect(peers).toHaveLength(2);expect(peers[0].close).toHaveBeenCalledOnce();
    expect(peers[1].createOffer).toHaveBeenCalledOnce();expect(state.batch.commit).toHaveBeenCalledOnce();
    transport.close();
  });

  it.each(["close", "session-close", "switch"])("does not publish a fallback offer or candidates after %s", async mode => {
    let finish!: () => void;
    const peers=rtcFixture(new Promise<void>(resolve=>{finish=resolve;}), true, 1);
    state.snapshot.mockImplementation(()=>vi.fn());state.add.mockResolvedValue({id:"candidate"});state.signal.mockResolvedValue(undefined);
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport,closeFirebaseSession}=await import("./viewerFirebase");
    const {session}=await openFirebaseSession("device-1",{} as ImportMetaEnv);
    const transport=await startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},{} as ImportMetaEnv);
    expect(peers).toHaveLength(2);
    expect(peers[1].createOffer).toHaveBeenCalledOnce();
    if (mode === "close") transport.close();
    else if (mode === "session-close") {
      state.getDoc.mockResolvedValueOnce({id:session.id,exists:()=>true,data:()=>({deviceId:"device-1",ownerUid:"viewer-1",state:"connected",status:"online",protocolVersion:2})});
      await closeFirebaseSession(session.id,{} as ImportMetaEnv);
    }
    else state.viewerUid="viewer-2";
    finish();
    await vi.waitFor(()=>expect(peers[1].close).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(peers[1].setLocalDescription).not.toHaveBeenCalled();
    expect(state.signal).not.toHaveBeenCalled();
    expect(state.add.mock.calls.filter(([path])=>path?.path?.endsWith("/viewerCandidates"))).toHaveLength(0);
    if (mode === "session-close") expect(state.add).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:`stop-stream ${session.id}`}));
  });

  it("closes permanently stuck optional preparation within the existing connection timeout", async () => {
    vi.useFakeTimers();
    const peers=rtcFixture(new Promise<void>(()=>{}));
    const {openFirebaseSession}=await import("./viewerFirebase");
    await openFirebaseSession("device-1",{} as ImportMetaEnv);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(peers[0].close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    expect(state.batch.commit).toHaveBeenCalledOnce();expect(state.signal).not.toHaveBeenCalled();
  });

  it("commits the connected session and start-stream command atomically", async () => {
    const { openFirebaseSession } = await import("./viewerFirebase");

    const result = await openFirebaseSession("device-1", {} as ImportMetaEnv);

    expect(result.session).toMatchObject({ deviceId: "device-1", state: "connected" });
    expect(state.safeBatchSet).toHaveBeenCalledTimes(2);
    expect(state.safeBatchSet.mock.calls[0][2]).toMatchObject({
      deviceId: "device-1",
      ownerUid: "viewer-1",
      state: "connected",
    });
    expect(state.safeBatchSet.mock.calls[1][2]).toMatchObject({
      action: `start-stream ${result.session.id}`,
      sessionId: result.session.id,
      state: "pending",
    });
    expect(state.batch.commit).toHaveBeenCalledOnce();
    expect(state.getDoc).toHaveBeenCalledOnce();
  });

  it("refreshes only the selected manual-presence device before opening a fresh session", async () => {
    const peers = rtcFixture();
    let next: (snapshot: unknown) => void = () => {};
    const stop = vi.fn();
    state.getDoc.mockResolvedValueOnce({id:"device-1",exists:()=>true,data:()=>({protocolVersion:2,status:"offline",presenceMode:"manual"})} as any);
    state.snapshot.mockImplementationOnce((ref, options, callback) => {
      expect(ref.path).toBe("devices/device-1");
      expect(options).toEqual({includeMetadataChanges:true});
      next=callback;
      return stop;
    });
    state.add.mockResolvedValue({id:"command"});
    state.signal.mockResolvedValue(undefined);
    const env = {} as ImportMetaEnv;
    const {openFirebaseSession, startFirebaseViewerWebRtcTransport, logoutViewerWithFirebase} = await import("./viewerFirebase");
    const opening = openFirebaseSession("device-1", env, true);
    await vi.waitFor(() => expect(state.add).toHaveBeenCalledOnce());
    const action = state.add.mock.calls[0][1].action;
    const result = {id:"device-1",exists:()=>true,data:()=>({protocolVersion:2,status:"online",presenceMode:"manual",heartbeatRequestId:action.slice("refresh-status ".length)})};
    try {
      expect(state.add.mock.calls[0][0].path).toBe("devices/device-1/commands");
      next({...result, metadata:{fromCache:true}});
      next({...result, metadata:{fromCache:false,hasPendingWrites:true}});
      await vi.waitFor(() => expect(peers[0]?.createOffer.mock.calls).toHaveLength(1));
      expect(peers[0].setLocalDescription).not.toHaveBeenCalled();
      expect(state.batch.commit).not.toHaveBeenCalled();
      expect(state.signal).not.toHaveBeenCalled();
      next({...result, metadata:{fromCache:false,hasPendingWrites:false}});
      const {session} = await opening;
      expect(session.state).toBe("connected");
      expect(state.getDoc).toHaveBeenCalledOnce();
      expect(state.snapshot).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(state.add).toHaveBeenCalledOnce();
      expect(state.safeBatchSet).toHaveBeenCalledTimes(2);
      state.snapshot.mockReturnValue(vi.fn());
      const transport = await startFirebaseViewerWebRtcTransport(session.id, {onFrame:vi.fn()}, env);
      try {
        await vi.waitFor(() => expect(state.signal).toHaveBeenCalledOnce());
        expect(peers).toHaveLength(1);
        expect(peers[0].setLocalDescription).toHaveBeenCalledOnce();
      } finally {
        transport.close();
      }
    } finally {
      // Also release the presence check if a pre-authorization assertion fails.
      next(result);
      await opening.catch(() => {});
      await logoutViewerWithFirebase(env);
    }
  });

  it("rejects a future device protocol before creating the session batch", async () => {
    state.getDoc.mockResolvedValueOnce({
      id: "device-1",
      exists: () => true,
      data: () => ({ ownerUid: "agent-1", protocolVersion: 99, status: "online" }),
    });
    const { openFirebaseSession } = await import("./viewerFirebase");

    await expect(openFirebaseSession("device-1", {} as ImportMetaEnv)).rejects.toThrow("protocol v99");
    expect(state.batch.commit).not.toHaveBeenCalled();
  });

  it("still requires a fresh response before reconnecting despite an online server row", async () => {
    vi.useFakeTimers();
    const peers = rtcFixture();
    const stop = vi.fn();
    state.getDoc.mockResolvedValueOnce({ id: "device-1", exists: () => true, data: () => ({ protocolVersion: 2, status: "online", presenceMode: "manual" }) } as any);
    state.snapshot.mockReturnValueOnce(stop);
    const { openFirebaseSession } = await import("./viewerFirebase");
    const rejected = expect(openFirebaseSession("device-1", {} as ImportMetaEnv, true)).rejects.toThrow("원격 PC가 응답하지 않습니다.");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(state.getDoc).toHaveBeenCalledOnce();
    expect(state.add).toHaveBeenCalledOnce();
    expect(state.batch.commit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(peers).toHaveLength(1);
    expect(peers[0].setLocalDescription).not.toHaveBeenCalled();
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the confirmed heartbeat protocol and lock, not the older unlocked snapshot", async () => {
    const peers = rtcFixture();
    let next: (snapshot: unknown) => void = () => {};
    state.getDoc.mockResolvedValueOnce({id:"device-1",exists:()=>true,data:()=>({ownerUid:"agent-1",protocolVersion:2,status:"online",presenceMode:"manual"})} as any);
    state.snapshot.mockImplementationOnce((_ref, _options, callback) => { next=callback; return vi.fn(); });
    state.add.mockImplementationOnce(async (_ref, {action}) => {
      const heartbeatRequestId = action.slice("refresh-status ".length);
      next({id:"device-1",exists:()=>true,metadata:{fromCache:true},data:()=>({protocolVersion:2,status:"online",presenceMode:"manual",heartbeatRequestId})});
      next({id:"device-1",exists:()=>true,data:()=>({protocolVersion:2,status:"online",presenceMode:"manual",heartbeatRequestId,accessLocked:true})});
    });
    const {openFirebaseSession}=await import("./viewerFirebase");
    await expect(openFirebaseSession("device-1",{} as ImportMetaEnv,true)).rejects.toThrow("잠금 비밀번호");
    expect(state.getDoc).toHaveBeenCalledOnce();
    expect(state.batch.commit).not.toHaveBeenCalled();
    expect(peers[0].setLocalDescription).not.toHaveBeenCalled();
    expect(peers[0].close).toHaveBeenCalledOnce();
  });

  it.each(["static", "dynamic", "callable", "no-peer"])("cancels a %s reconnect on logout before a late heartbeat can start a session", async mode => {
    const peers = mode === "no-peer" ? [] : rtcFixture();
    if (mode === "no-peer") vi.stubGlobal("RTCPeerConnection", undefined);
    let next!: (snapshot: unknown) => void;
    const stop = vi.fn();
    state.getDoc.mockResolvedValueOnce({id:"device-1",exists:()=>true,data:()=>({protocolVersion:2,status:"online",presenceMode:"manual"})} as any);
    state.snapshot.mockImplementationOnce((_ref, _options, callback) => { next = callback; return stop; });
    state.add.mockResolvedValueOnce({id:"command"});
    const env: ImportMetaEnv = mode === "dynamic" ? dynamicTurnEnv
      : mode === "callable" ? {...dynamicTurnEnv,VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE:"callable"} : {} as ImportMetaEnv;
    const {openFirebaseSession, logoutViewerWithFirebase} = await import("./viewerFirebase");
    const rejected = expect(openFirebaseSession("device-1", env, true, mode === "callable" ? undefined : "fixture-only"))
      .rejects.toThrow("로그인 계정이 변경되었습니다.");
    await vi.waitFor(() => expect(state.add).toHaveBeenCalledOnce());
    await logoutViewerWithFirebase(env);
    if (mode === "static") {
      expect(peers[0].close).toHaveBeenCalledOnce();
      expect(peers[0].setLocalDescription).not.toHaveBeenCalled();
    } else expect(peers).toHaveLength(0);
    expect(stop).toHaveBeenCalledOnce();
    const heartbeatRequestId = state.add.mock.calls[0][1].action.slice("refresh-status ".length);
    next({id:"device-1",exists:()=>true,data:()=>({protocolVersion:2,status:"online",presenceMode:"manual",heartbeatRequestId,accessLocked:true})});
    await rejected;
    expect(state.turn).not.toHaveBeenCalled();
    expect(state.batch.commit).not.toHaveBeenCalled();
  });

  it("does not subscribe or send presence after logout while reading the reconnect target", async () => {
    const peers = rtcFixture();
    type DeviceSnapshot = Awaited<ReturnType<typeof state.getDoc>>;
    let receiveDevice!: (snapshot: DeviceSnapshot) => void;
    state.getDoc.mockImplementationOnce(() => new Promise(resolve => { receiveDevice = resolve; }));
    const env = {} as ImportMetaEnv;
    const {openFirebaseSession, logoutViewerWithFirebase} = await import("./viewerFirebase");
    const rejected = expect(openFirebaseSession("device-1", env, true)).rejects.toThrow("로그인 계정이 변경되었습니다.");
    await vi.waitFor(() => expect(peers[0]?.createOffer.mock.calls).toHaveLength(1));
    await logoutViewerWithFirebase(env);
    receiveDevice({id:"device-1",exists:()=>true,data:()=>({ownerUid:"agent-1",protocolVersion:2,status:"online",presenceMode:"manual"})});
    await rejected;
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.batch.commit).not.toHaveBeenCalled();
  });

  it.each(["approve", "logout"])("holds ICE until a locked reconnect is approved (%s)", async outcome => {
    const peers = rtcFixture();
    const {publicKey} = generateKeyPairSync("rsa", {modulusLength:2048});
    const lockedDevice = {ownerUid:"agent-1",protocolVersion:2,status:"online",presenceMode:"manual",accessLocked:true,
      accessPublicKey:publicKey.export({format:"der",type:"spki"}).toString("base64"),accessLockVersion:"v1"};
    const presence = vi.fn(), approval = vi.fn();
    let receivePresence!: (snapshot: unknown) => void;
    let receiveApproval!: (snapshot: unknown) => void;
    state.getDoc.mockResolvedValueOnce({id:"device-1",exists:()=>true,data:()=>lockedDevice});
    state.snapshot.mockImplementationOnce((_ref,_options,callback) => { receivePresence = callback; return presence; })
      .mockImplementationOnce((_ref,callback) => { receiveApproval = callback; return approval; });
    state.add.mockResolvedValueOnce({id:"command"});
    const env = {} as ImportMetaEnv;
    const {openFirebaseSession, logoutViewerWithFirebase} = await import("./viewerFirebase");
    const opening = openFirebaseSession("device-1", env, true, "fixture-only");
    const settled = opening.catch(error => error);
    try {
      await vi.waitFor(() => expect(state.add).toHaveBeenCalledOnce());
      const heartbeatRequestId = state.add.mock.calls[0][1].action.slice("refresh-status ".length);
      receivePresence({id:"device-1",exists:()=>true,data:()=>({...lockedDevice, heartbeatRequestId})});
      await vi.waitFor(() => expect(receiveApproval).toBeTypeOf("function"));
      expect(peers[0].setLocalDescription).not.toHaveBeenCalled();
      expect(state.batch.commit).toHaveBeenCalledOnce();
      if (outcome === "logout") {
        await logoutViewerWithFirebase(env);
        await expect(opening).rejects.toThrow("로그인 계정이 변경되었습니다.");
        expect(state.remove).toHaveBeenCalledOnce();
        expect(peers[0].setLocalDescription).not.toHaveBeenCalled();
      } else {
        receiveApproval({data:()=>({state:"approved",approvedVersion:"v1"})});
        await expect(opening).resolves.toMatchObject({session:{state:"connected"}});
        expect(peers[0].setLocalDescription).toHaveBeenCalledOnce();
        expect(state.batch.commit).toHaveBeenCalledTimes(2);
        expect(state.remove).not.toHaveBeenCalled();
      }
      expect(presence).toHaveBeenCalledOnce();
      expect(approval).toHaveBeenCalledOnce();
    } finally {
      await logoutViewerWithFirebase(env);
      await settled;
    }
  });

  it("closes a failed local offer while the reconnect target is still being read", async () => {
    const peers = rtcFixture(undefined, true);
    type DeviceSnapshot = Awaited<ReturnType<typeof state.getDoc>>;
    let receiveDevice!: (snapshot: DeviceSnapshot) => void;
    state.getDoc.mockImplementationOnce(() => new Promise(resolve => { receiveDevice = resolve; }));
    const {openFirebaseSession, logoutViewerWithFirebase} = await import("./viewerFirebase");
    const env = {} as ImportMetaEnv;
    const opening = openFirebaseSession("device-1", env, true);
    try {
      await vi.waitFor(() => expect(peers[0]?.close.mock.calls).toHaveLength(1));
      expect(state.batch.commit).not.toHaveBeenCalled();
    } finally {
      receiveDevice({id:"device-1",exists:()=>true,data:()=>({ownerUid:"agent-1",protocolVersion:2,status:"online"})});
      await opening;
      await logoutViewerWithFirebase(env);
    }
    expect(state.batch.commit).toHaveBeenCalledOnce();
  });

  it.each([dynamicTurnEnv, {VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE:"callable"} as ImportMetaEnv])(
    "does not start dynamic TURN or callable work for an unverified reconnect target (%j)", async env => {
      vi.useFakeTimers();
      const peers = rtcFixture();
      const stop = vi.fn();
      state.getDoc.mockResolvedValueOnce({id:"device-1",exists:()=>true,data:()=>({protocolVersion:2,status:"online",presenceMode:"manual"})} as any);
      state.snapshot.mockReturnValueOnce(stop);
      state.add.mockResolvedValueOnce({id:"command"});
      const {openFirebaseSession} = await import("./viewerFirebase");
      const rejected = expect(openFirebaseSession("device-1", env, true)).rejects.toThrow("원격 PC가 응답하지 않습니다.");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(state.turn).not.toHaveBeenCalled();
      expect(peers).toHaveLength(0);
      expect(state.getDoc).toHaveBeenCalledOnce();
      expect(state.add).toHaveBeenCalledOnce();
      expect(state.batch.commit).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
    },
  );
});
