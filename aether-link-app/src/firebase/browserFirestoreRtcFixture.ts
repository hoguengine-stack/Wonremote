import { build } from "esbuild";
import type { Page } from "playwright";
import { RTCPeerConnection } from "werift";
import type { AgentPeerConnectionConfig, AgentPeerConnectionLike } from "./agentPeerConnection";

export const loopbackStun = "stun:127.0.0.1:9";

export function createLoopbackAgentPeers() {
  const peers: RTCPeerConnection[] = [];
  class LoopbackPeer extends RTCPeerConnection {
    private gathering?: ReturnType<RTCPeerConnection["setLocalDescription"]>;
    private closing?: Promise<void>;

    override setLocalDescription(...args: Parameters<RTCPeerConnection["setLocalDescription"]>) {
      if (this.closing) return Promise.reject(new Error("Loopback peer is closing."));
      for (const transport of this.iceTransports) transport.connection.stunServer = undefined;
      return this.gathering = super.setLocalDescription(...args);
    }

    override close(): Promise<void> {
      return this.closing ??= (async()=>{
        await this.gathering?.catch(()=>{});
        await super.close();
      })();
    }
  }
  return {
    peers,
    create: async (config: AgentPeerConnectionConfig) => {
      const peer = new LoopbackPeer({iceTransportPolicy:config.iceTransportPolicy,iceServers:[{urls:loopbackStun}],iceUseIpv4:false,iceUseIpv6:false,
        iceInterfaceAddresses:{udp4:"127.0.0.1"},iceAdditionalHostAddresses:["127.0.0.1"]});
      peers.push(peer);
      return peer as unknown as AgentPeerConnectionLike;
    },
  };
}

export async function wireBrowserToLocalFirestore(page: Page, projectId: string, uid: string, port: number, realInventory = false, groupingOnly = false) {
  if (!/^demo-connect-[a-f0-9]{8}$/.test(projectId) || !Number.isSafeInteger(port) || port < 1 || port > 65535
      || new URL(page.url()).origin !== `http://127.0.0.1:${port}`) throw new Error("Expected a loopback demo project and Browser.");
  const sdk = await build({
    stdin:{
      contents: groupingOnly ? `import {saveViewerGrouping, subscribeViewerGrouping} from "./src/firebase/viewerFirebase";
        window.testApi.subscribeViewerAuthState = next => { next(true, ${JSON.stringify(uid)}); return () => {}; };
        window.testApi.subscribeViewerGrouping = subscribeViewerGrouping;
        window.testApi.saveViewerGrouping = saveViewerGrouping;` :
        `import {fetchFirebaseDevices, openFirebaseSession, closeFirebaseSession, queuePreparedFirebaseViewerOffer, startFirebaseViewerWebRtcTransport} from "./src/firebase/viewerFirebase";
        const env = {VITE_WONREMOTE_RTC_STUN_URLS:${JSON.stringify(loopbackStun)},VITE_WONREMOTE_FIREBASE_FUNCTIONS_MODE:"direct"};
        ${realInventory ? "window.testApi.fetchFirebaseDevices = (_env, ...args) => fetchFirebaseDevices(env, ...args);" : ""}
        window.testApi.openFirebaseSession = (device, _env, refresh, password) => openFirebaseSession(device,env,refresh,password);
        window.testApi.closeFirebaseSession = session => closeFirebaseSession(session,env);
        window.testApi.queuePreparedFirebaseViewerOffer = queuePreparedFirebaseViewerOffer;
        window.testApi.startFirebaseViewerWebRtcTransport = (session,handlers) => startFirebaseViewerWebRtcTransport(session,handlers,env);`,
      resolveDir:process.cwd(),
    },
    bundle:true, write:false, platform:"browser", format:"iife", define:{"import.meta.env":"{}"},
    plugins:[{name:"local-firestore-rtc",setup(builder) {
      builder.onLoad({filter:/[\\/]connectionTiming\.ts$/}, () => ({
        contents:"export const markConnectionTiming = (...args) => window.testMarkConnectionTiming(...args);",
      }));
      builder.onLoad({filter:/[\\/]firebaseConfig\.ts$/}, () => ({
        contents:`export const resolveFirebaseConfig = () => ({projectId:${JSON.stringify(projectId)}});`,
      }));
      builder.onLoad({filter:/[\\/]firebaseServices\.ts$/}, () => ({
        resolveDir:process.cwd(),
        contents:`import {initializeApp} from "firebase/app";
          import {connectFirestoreEmulator,getFirestore} from "firebase/firestore";
          const uid=${JSON.stringify(uid)};
          const db=getFirestore(initializeApp({projectId:${JSON.stringify(projectId)},apiKey:"loopback-only"}));
          connectFirestoreEmulator(db,"127.0.0.1",${port},{mockUserToken:{sub:uid,wonremoteViewer:true}});
          export const getWonRemoteFirebaseServices = () => ({db,auth:{currentUser:{uid}}});`,
      }));
      builder.onResolve({filter:/^\.\/firestoreWrite$/}, () => ({path:"writes",namespace:"loopback-write"}));
      builder.onLoad({filter:/^writes$/,namespace:"loopback-write"}, () => ({
        resolveDir:process.cwd(),
        contents:`import {safeAddDoc as add, safeSetDoc as set} from "./src/firebase/firestoreWrite.ts";
          export * from "./src/firebase/firestoreWrite.ts";
          const local = line => line.trim().split(/\\s+/)[4] === "127.0.0.1";
          const emptyCounts = () => ({embedded: 0, separate: 0, duplicate: 0, sameCore: 0, ipv4Core: 0, onlyUfragDifference: 0});
          const counts = window.fixtureIceCounts = {browser: emptyCounts(), loopback: emptyCounts()};
          const offered = new Map();
          const core = line => line.trim().split(/\\s+/).slice(0,8).join(" ");
          const withoutUfrag = line => line.trim().split(/\\s+/).filter((token,index,all) => index < 8 || (token !== "ufrag" && all[index-1] !== "ufrag")).join(" ");
          export const safeAddDoc = (ref,data) => {
            if (ref.id === "viewerCandidates") {
              const line = data.candidate?.candidate ?? "";
              const embedded = offered.get(data.negotiationId) ?? [];
              const observe = target => {
                target.separate++;
                if (embedded.includes(line.trim())) target.duplicate++;
                if (embedded.some(candidate => core(candidate) === core(line))) {
                  target.sameCore++;
                  if (/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(line.trim().split(/\\s+/)[4])) target.ipv4Core++;
                  if (embedded.some(candidate => withoutUfrag(candidate) === withoutUfrag(line))) target.onlyUfragDifference++;
                }
              };
              observe(counts.browser);
              if (!local(line)) return Promise.resolve();
              observe(counts.loopback);
            }
            return add(ref,data);
          };
          export const safeSetDoc = (ref,data,options) => {
            if (!data?.offer?.sdp) return set(ref,data,options);
            const lines = data.offer.sdp.split(/\\r?\\n/);
            const embedded = lines.filter(line=>line.startsWith("a=candidate:")).map(line=>line.slice(2).trim());
            counts.browser.embedded += embedded.length;
            counts.loopback.embedded += embedded.filter(local).length;
            offered.set(data.negotiationId, embedded);
            return set(ref,{...data,offer:{...data.offer,sdp:lines.filter(line=>!line.startsWith("a=candidate:")||local(line)).join("\\r\\n")}},options);
          };`,
      }));
    }}],
  });
  await page.addScriptTag({content:sdk.outputFiles[0].text});
}
