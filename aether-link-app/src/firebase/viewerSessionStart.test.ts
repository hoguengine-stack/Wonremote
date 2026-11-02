import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  signal: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
  doc: vi.fn((root: { path?: string }, ...segments: string[]) => segments.length > 0
    ? { path: segments.join("/") }
    : { path: `${root.path}/command-auto` }),
  getDoc: state.getDoc,
  getDocFromServer: state.getDoc,
  getDocs: vi.fn(),
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
    auth: { currentUser: { uid: state.viewerUid } },
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

  function rtcFixture(offerReady?: Promise<void>, failFirstOffer = false) {
    const peers: any[]=[];
    class Peer {
      localDescription: unknown=null;
      onicecandidate: any;
      close=vi.fn(); addIceCandidate=vi.fn(async()=>{}); setRemoteDescription=vi.fn(async()=>{});
      createOffer=vi.fn(async()=>{
        if (peers[0] === this && failFirstOffer) throw new Error("preparation failed");
        if (peers[0] === this) await offerReady;
        return {type:"offer",sdp:"prepared-offer"};
      });
      setLocalDescription=vi.fn(async description=>{this.localDescription=description;this.onicecandidate?.({candidate:{toJSON:()=>({candidate:"buffered-host"})}});});
      createDataChannel=vi.fn((label:string)=>({label,readyState:"connecting",send:vi.fn(),close:vi.fn()}));
      constructor(){peers.push(this);}
    }
    vi.stubGlobal("RTCPeerConnection",Peer);
    return peers;
  }

  it("prepares local offer during target validation, reuses its three channels and forwards early ICE after authorization", async () => {
    const peers=rtcFixture();
    let validate!: (snapshot:any)=>void;
    state.getDoc.mockImplementationOnce(()=>new Promise(resolve=>{validate=resolve;}));
    state.add.mockResolvedValue({id:"candidate"});
    state.signal.mockResolvedValue(undefined);
    state.snapshot.mockImplementation(()=>vi.fn());
    const {openFirebaseSession,startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const opening=openFirebaseSession("device-1",{} as ImportMetaEnv);
    await vi.waitFor(()=>expect(peers[0]?.createOffer).toHaveBeenCalledOnce());
    expect(state.batch.commit).not.toHaveBeenCalled();expect(state.signal).not.toHaveBeenCalled();expect(state.add).not.toHaveBeenCalled();
    validate({id:"device-1",exists:()=>true,data:()=>({ownerUid:"agent-1",protocolVersion:2,status:"online"})});
    const {session}=await opening;
    const transport=await startFirebaseViewerWebRtcTransport(session.id,{onFrame:vi.fn()},{} as ImportMetaEnv);
    await vi.waitFor(()=>expect(state.signal).toHaveBeenCalledOnce());
    expect(peers).toHaveLength(1);expect(peers[0].createOffer).toHaveBeenCalledOnce();expect(peers[0].createDataChannel).toHaveBeenCalledTimes(3);
    expect(state.add).toHaveBeenCalledOnce();expect(state.add.mock.calls[0][1]).toMatchObject({candidate:{candidate:"buffered-host"}});
    expect(state.batch.commit).toHaveBeenCalledOnce();expect(state.getDoc).toHaveBeenCalledOnce();
    transport.close();expect(peers[0].close).toHaveBeenCalledOnce();
  });

  it("never reuses a prepared peer after the authenticated Viewer changes", async () => {
    const peers = rtcFixture();
    state.signal.mockResolvedValue(undefined);
    state.add.mockResolvedValue({id:"candidate"});
    state.snapshot.mockImplementation(() => vi.fn());
    const {openFirebaseSession, startFirebaseViewerWebRtcTransport} = await import("./viewerFirebase");
    const {session} = await openFirebaseSession("device-1", {} as ImportMetaEnv);
    state.viewerUid = "viewer-2";
    const transport = await startFirebaseViewerWebRtcTransport(session.id, {onFrame:vi.fn()}, {} as ImportMetaEnv);
    await vi.waitFor(() => expect(state.signal).toHaveBeenCalledOnce());
    expect(peers).toHaveLength(2);
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(peers[1].createOffer).toHaveBeenCalledOnce();
    transport.close();
  });

  it("closes local preparation on denied validation without publishing signals or commands", async () => {
    const peers=rtcFixture();
    state.getDoc.mockResolvedValueOnce({id:"device-1",exists:()=>true,data:()=>({ownerUid:"agent-1",protocolVersion:2,status:"offline"})});
    const {openFirebaseSession}=await import("./viewerFirebase");
    await expect(openFirebaseSession("device-1",{} as ImportMetaEnv)).rejects.toThrow("online");
    await vi.waitFor(()=>expect(peers[0]?.close).toHaveBeenCalledOnce());
    expect(state.batch.commit).not.toHaveBeenCalled();expect(state.signal).not.toHaveBeenCalled();expect(state.add).not.toHaveBeenCalled();
  });

  it("expires an abandoned prepared peer without background requests", async () => {
    vi.useFakeTimers();const peers=rtcFixture();
    const {openFirebaseSession}=await import("./viewerFirebase");
    await openFirebaseSession("device-1",{} as ImportMetaEnv);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(peers[0].close).toHaveBeenCalledOnce();expect(state.signal).not.toHaveBeenCalled();expect(state.add).not.toHaveBeenCalled();
    expect(state.batch.commit).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hold the Agent start command behind slow local preparation and closes it when late", async () => {
    let finish!: () => void;
    const peers=rtcFixture(new Promise<void>(resolve=>{finish=resolve;}));
    const {openFirebaseSession}=await import("./viewerFirebase");
    await openFirebaseSession("device-1",{} as ImportMetaEnv);
    expect(state.batch.commit).toHaveBeenCalledOnce();
    expect(peers[0].close).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(()=>expect(peers[0].close).toHaveBeenCalledOnce());
    expect(state.signal).not.toHaveBeenCalled();expect(state.add).not.toHaveBeenCalled();
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
    let next: (snapshot: unknown) => void = () => {};
    const stop = vi.fn();
    state.getDoc.mockResolvedValueOnce({id:"device-1",exists:()=>true,data:()=>({protocolVersion:2,status:"offline",presenceMode:"manual"})} as any);
    state.snapshot.mockImplementationOnce((ref, callback) => { expect(ref.path).toBe("devices/device-1"); next=callback; return stop; });
    state.add.mockImplementationOnce(async (ref, data) => {
      expect(ref.path).toBe("devices/device-1/commands");
      next({id:"device-1",exists:()=>true,data:()=>({protocolVersion:2,status:"online",presenceMode:"manual",heartbeatRequestId:data.action.slice("refresh-status ".length)})});
    });
    const {openFirebaseSession}=await import("./viewerFirebase");
    const result=await openFirebaseSession("device-1",{} as ImportMetaEnv,true);
    expect(result.session.state).toBe("connected");
    expect(state.getDoc).toHaveBeenCalledTimes(2);
    expect(state.snapshot).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.safeBatchSet).toHaveBeenCalledTimes(2);
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
});
