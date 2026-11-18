import { describe, expect, it, vi } from "vitest";
import { RTCPeerConnection, type PeerConfig } from "werift";
import { performance } from "node:perf_hooks";
import type { AgentPeerConnectionFactoryOptions } from "./agentPeerConnection";
import type { AgentWebRtcTransport } from "./agentFirebase";

const broker = vi.hoisted(() => {
  type Data = Record<string, unknown>;
  type Snapshot = { docs: { id: string; data: () => Data }[]; data: () => Data | undefined };
  const documents = new Map<string, Data>();
  const listeners = new Set<{ path: string; next: (snapshot: Snapshot) => void }>();
  const snapshot = (path: string): Snapshot => ({
    docs: [...documents]
      .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
      .map(([key, data]) => ({ id: key.slice(path.length + 1), data: () => data })),
    data: () => documents.get(path),
  });
  const notify = (listener: { path: string; next: (snapshot: Snapshot) => void }) => {
    queueMicrotask(() => {
      if (listeners.has(listener)) listener.next(snapshot(listener.path));
    });
  };
  const write = (path: string, data: Data) => {
    documents.set(path, { ...documents.get(path), ...data });
    for (const listener of listeners) {
      if (listener.path === path || listener.path === path.slice(0, path.lastIndexOf("/"))) {
        notify(listener);
      }
    }
  };
  const subscribe = ({ path }: { path: string }, nextOrOptions: ((snapshot: Snapshot) => void) | { includeMetadataChanges?: boolean }, callback?: (snapshot: Snapshot) => void) => {
    const listener = { path, next: typeof nextOrOptions === "function" ? nextOrOptions : callback! };
    listeners.add(listener);
    notify(listener);
    return () => { listeners.delete(listener); };
  };
  return { documents, listeners, snapshot, write, subscribe };
});

vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => ({path:path.join("/")}),
  collection: (_db: unknown, ...path: string[]) => ({path:path.join("/")}),
  query: (ref: unknown) => ref,
  orderBy: () => ({}), limit: () => ({}), where: () => ({}),
  onSnapshot: broker.subscribe,
  getDocs: async ({path}: {path:string}) => broker.snapshot(path),
  serverTimestamp: () => "local-test-time",
}));
vi.mock("./firebaseConfig", () => ({resolveFirebaseConfig:()=>({projectId:"local-rtc-test"})}));
vi.mock("./firebaseServices", () => ({getWonRemoteFirebaseServices:()=>({auth:{currentUser:{uid:"local-viewer"}},db:{},functions:{}})}));
vi.mock("firebase/functions", () => ({httpsCallable:()=>{throw new Error("Cloud calls are not permitted in the loopback fixture.");}}));
vi.mock("./firestoreWrite", () => ({
  safeSetDoc: async ({path}: {path:string}, data: Record<string,unknown>)=>broker.write(path,data),
  safeAddDoc: async ({path}: {path:string}, data: Record<string,unknown>)=>broker.write(`${path}/${broker.documents.size}`,data),
}));
const loopbackStunUrl = "stun:127.0.0.1:9";
const loopbackEnv = { VITE_WONREMOTE_RTC_STUN_URLS: loopbackStunUrl };
const viewerEnv: ImportMetaEnv = {
  ...loopbackEnv, BASE_URL: "/", MODE: "test", DEV: false, PROD: false, SSR: true,
  VITE_WONREMOTE_APP_VERSION: "0.0.0-test",
};

const peers: LoopbackPeer[] = [];
class LoopbackPeer extends RTCPeerConnection {
  private closing?: Promise<void>;
  iceCandidateEvents = 0;

  constructor(configuration: Partial<PeerConfig>) {
    super({...configuration, iceServers:[{urls:loopbackStunUrl}], iceUseIpv4:false, iceUseIpv6:false,
      iceInterfaceAddresses:{udp4:"127.0.0.1"}, iceAdditionalHostAddresses:["127.0.0.1"]});
    peers.push(this);
    this.onIceCandidate.subscribe(candidate => { if (candidate) this.iceCandidateEvents++; });
  }

  override setLocalDescription(...args: Parameters<RTCPeerConnection["setLocalDescription"]>) {
    // Werift otherwise falls back to its default STUN server for an empty server list.
    for (const transport of this.iceTransports) transport.connection.stunServer = undefined;
    return super.setLocalDescription(...args);
  }

  override close(): Promise<void> {
    return this.closing ??= super.close();
  }
}

vi.mock("./agentPeerConnection", async importOriginal => {
  const runtime = await importOriginal<typeof import("./agentPeerConnection")>();
  type WeriftModule = Awaited<ReturnType<NonNullable<AgentPeerConnectionFactoryOptions["importWerift"]>>>;
  return {
    ...runtime,
    createAgentPeerConnection: (config: Parameters<typeof runtime.createAgentPeerConnection>[0]) =>
      runtime.createAgentPeerConnection(config, {
        arch: "ia32",
        importWerift: async () => ({ RTCPeerConnection: LoopbackPeer }) as unknown as WeriftModule,
      }),
  };
});

describe("Agent and Viewer real local WebRTC wire", () => {
  it.each([false,true])("delivers a first frame and ordered input with duplicate suppression %s", async suppressDuplicates => {
    const {startAgentWebRtcTransportWithFirebase}=await import("./agentFirebase");
    const {startFirebaseViewerWebRtcTransport}=await import("./viewerFirebase");
    const offerMatcher = await import("../domain/viewerOfferIce");
    const passEveryCandidate = suppressDuplicates ? undefined : vi.spyOn(offerMatcher,"matchEmbeddedViewerIce").mockReturnValue(undefined);
    const controls: string[]=[];
    const frame = {
      sequence: 1, keyframe: true, width: 64, height: 32,
      tiles: [
        { x: 0, y: 0, w: 32, h: 32, data: "a".repeat(32 * 1024) },
        { x: 32, y: 0, w: 32, h: 32, data: "b".repeat(32 * 1024) },
      ],
    };
    const warning=vi.fn();
    const states:string[]=[];
    let frameSent: string | undefined;
    let controlsReceivedAt=0;
    let agent: AgentWebRtcTransport | undefined;
    let viewer: Awaited<ReturnType<typeof startFirebaseViewerWebRtcTransport>> | undefined;
    vi.stubGlobal("RTCPeerConnection", LoopbackPeer);
    try {
      agent = await startAgentWebRtcTransportWithFirebase("local-wire", {
        onState: (state, error) => {
          states.push(`agent:${state}`);
          if (state === "open") frameSent = agent?.sendFrame(frame);
          if (state === "error") warning(error);
        },
        onControl: (action, current) => {
          if (!current()) return;
          controls.push(action);
          controlsReceivedAt = performance.now();
        },
      }, loopbackEnv);
      const started=performance.now();
      let receivedAt=0;
      const onFrame=vi.fn(()=>{receivedAt=performance.now();});
      viewer=await startFirebaseViewerWebRtcTransport("local-wire",{
        onFrame,onError:warning,onState:state=>states.push(`viewer:${state}`),startInFastMode:true,
      }, viewerEnv);
      await vi.waitFor(()=>expect(onFrame).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(frame)),{timeout:7_000});
      expect(frameSent).toBe("sent");
      expect(peers).toHaveLength(2);
      const [viewerPeer, agentPeer] = peers;
      expect(viewerPeer.iceCandidateEvents).toBeGreaterThan(0);
      const viewerCandidateWrites = broker.snapshot("sessions/local-wire/viewerCandidates").docs.length;
      if (suppressDuplicates) expect(viewerCandidateWrites).toBe(0);
      else expect(viewerCandidateWrites).toBeGreaterThan(0);
      const viewerHost = viewerPeer.iceTransports[0].connection.localCandidates.find(candidate => candidate.host === "127.0.0.1");
      expect(viewerHost).toBeDefined();
      expect(agentPeer.iceTransports[0].connection.remoteCandidates).toContainEqual(expect.objectContaining({
        host:"127.0.0.1", port:viewerHost!.port, type:"host", transport:"udp",
      }));
      for (const peer of peers) {
        const addresses = peer.iceTransports.flatMap(transport =>
          transport.connection.localCandidates.map(candidate => candidate.host));
        expect(addresses).toContain("127.0.0.1");
        expect(addresses.every(address => address === "127.0.0.1")).toBe(true);
      }
      await vi.waitFor(()=>expect(viewer?.isControlReady()).toBe(true));
      const input=["move 32768 16384","mouse-down 32768 16384 left","mouse-up 32768 16384 left"];
      const sentAt=performance.now();
      for (const action of input) expect(viewer.sendControl(action)).toBe(true);
      await vi.waitFor(()=>expect(controls).toEqual(["set-stream-mode fast","request-keyframe",...input]));
      expect(warning).not.toHaveBeenCalled();
      console.info("Loopback WebRTC fixture",{suppressDuplicates,viewerCandidateWrites,firstFrameMs:Math.round(receivedAt-started),lastInputMs:Math.ceil(controlsReceivedAt-sentAt)});
      viewer.close();
      await agent.close();
      await vi.waitFor(() => {
        expect(peers.map(peer => peer.connectionState)).toEqual(["closed", "closed"]);
        expect(broker.listeners.size).toBe(0);
      });
    } catch (error) {
      console.info("Loopback WebRTC states",states,warning.mock.calls);
      throw error;
    } finally {
      try {
        await Promise.allSettled([
          Promise.resolve().then(() => viewer?.close()),
          Promise.resolve().then(() => agent?.close()),
        ]);
        await Promise.allSettled(peers.splice(0).map(peer => peer.close()));
      } finally {
        broker.documents.clear();
        passEveryCandidate?.mockRestore();
        vi.unstubAllGlobals();
      }
    }
  },12_000);
});
