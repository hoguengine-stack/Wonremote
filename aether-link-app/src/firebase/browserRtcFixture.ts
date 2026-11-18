import { build } from "esbuild";
import type { Page } from "playwright";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { parseWebRtcControlAction, WEBRTC_CONTROL_CHANNEL_LABEL, WEBRTC_TILE_CHANNEL_LABEL } from "../domain/webrtcControl";
import { sendFrameWithBackpressure } from "./agentPeerConnection";

const loopback = "127.0.0.1";
const stun = `stun:${loopback}:9`;

export async function wireViewerToLocalPeer(
  page: Page,
  frames: Parameters<typeof sendFrameWithBackpressure>[1][],
  onMotion?: (action: string, index: number, receivedAt: number) => void,
) {
  const peers: RTCPeerConnection[] = [];
  const pendingOffers = new Set<Promise<unknown>>();
  let closed = false;
  const controls: string[] = [];
  const motionReceipts: { action: string; receivedAt: number }[] = [];
  const framesSent: string[] = [];
  const tileChannels: RTCDataChannel[] = [];
  const sendFrame = (index: number, frame: typeof frames[number], limits?: { queuedBytes: number; maxBufferedAmount?: number }) => {
    const channel = tileChannels[index];
    return sendFrameWithBackpressure(channel ? {
      readyState: channel.readyState, bufferedAmount: Math.max(channel.bufferedAmount, limits?.queuedBytes ?? 0), send: data => channel.send(data),
    } : null, frame, { maxBufferedAmount: limits?.maxBufferedAmount ?? 2 * 1024 * 1024, maxMessageBytes: 56 * 1024 });
  };
  const sendTilePacket = (index: number, packet: typeof frames[number] & { frameChunkIndex: number; frameChunkCount: number }) => {
    const channel = tileChannels[index];
    if (channel?.readyState !== "open") throw new Error("Expected an open loopback tile channel.");
    channel.send(JSON.stringify(packet));
  };
  const result = await build({
    stdin: {
      contents: `import {startFirebaseViewerWebRtcTransport} from "./src/firebase/viewerFirebase";
        window.testApi.startFirebaseViewerWebRtcTransport = (session, handlers) =>
          startFirebaseViewerWebRtcTransport(session, handlers, {VITE_WONREMOTE_RTC_STUN_URLS:"${stun}"});`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: "browser", format: "iife",
    define: { "import.meta.env": "{}" },
    plugins: [{name:"loopback-signaling", setup(builder) {
      builder.onResolve({filter:/^firebase\/firestore$/}, args => args.namespace === "local-signal"
        ? null : {path:"sdk",namespace:"local-signal"});
      builder.onLoad({filter:/^sdk$/,namespace:"local-signal"}, () => ({
        resolveDir: process.cwd(),
        contents: `export * from "firebase/firestore";
          export const doc = (_db,...parts) => parts.join("/");
          export const collection = doc;
          export const query = path => path;
          export const onSnapshot = (path,next) => {
            window.localSignalListeners.set(path,next);
            return () => window.localSignalListeners.delete(path);
          };
          export const serverTimestamp = () => 0;`,
      }));
      builder.onLoad({filter:/[\\/]firebaseServices\.ts$/}, () => ({
        contents: 'export const getWonRemoteFirebaseServices = () => ({db:{},auth:{currentUser:{uid:"local-viewer"}}});',
      }));
      builder.onLoad({filter:/[\\/]firebaseConfig\.ts$/}, () => ({
        contents: 'export const resolveFirebaseConfig = () => ({projectId:"demo-local-browser"});',
      }));
      builder.onLoad({filter:/[\\/]firestoreWrite\.ts$/}, () => ({
        contents: `window.localSignalListeners = new Map();
          export const safeAddDoc = async () => {}; // Do not advertise Chromium's LAN addresses.
          export const safeSetDoc = async (path, signal) => {
            if (!path.endsWith("/webrtc/signal") || signal.offer?.type !== "offer") throw new Error("Unexpected loopback write");
            const answer = await window.answerLocalFixtureOffer(signal.offer);
            window.localSignalListeners.get(path)?.({data:()=>({answer:{...answer,negotiationId:signal.negotiationId}})});
          };
          export const safeBatchSet = () => { throw new Error("Unexpected loopback batch"); };
          export const safeBatchUpdate = safeBatchSet;
          export const safeUpdateDoc = safeBatchSet;`,
      }));
    }}],
  });
  const answerOffer = async (offer: RTCSessionDescriptionInit) => {
    if (offer.type !== "offer" || !offer.sdp) throw new Error("Expected a loopback SDP offer");
    const index = peers.length;
    const frame = frames[index];
    if (!frame) throw new Error("Unexpected additional loopback peer");
    const peer = new RTCPeerConnection({
      iceServers:[{urls:stun}],iceUseIpv4:false,iceUseIpv6:false,
      iceInterfaceAddresses:{udp4:loopback},iceAdditionalHostAddresses:[loopback],
    });
    peers.push(peer);
    peer.ondatachannel = ({channel}) => {
      if (channel.label === WEBRTC_TILE_CHANNEL_LABEL) {
        tileChannels[index] = channel;
        const send = () => framesSent.push(sendFrame(index, frame));
        if (channel.readyState === "open") send();
        else channel.onopen = send;
      } else if (channel.label === WEBRTC_CONTROL_CHANNEL_LABEL) {
        channel.onmessage = ({data}) => {
          const action = parseWebRtcControlAction(data);
          if (action) {
            controls.push(action);
            if (action.startsWith("move ")) {
              const receivedAt = Date.now();
              motionReceipts.push({ action, receivedAt });
              onMotion?.(action,index,receivedAt);
            }
          }
        };
      }
    };
    // The browser reaches our loopback host candidate without advertising any LAN candidates.
    await peer.setRemoteDescription({type:"offer",sdp:offer.sdp.replace(/^a=(?:candidate:.*|end-of-candidates)\r?\n/gm,"")});
    for (const transport of peer.iceTransports) transport.connection.stunServer = undefined;
    await peer.setLocalDescription(await peer.createAnswer());
    const {type,sdp} = peer.localDescription!;
    const candidates = sdp.split(/\r?\n/).filter(line=>line.startsWith("a=candidate:"));
    if (!candidates.length || candidates.some(line=>line.split(/\s+/)[4]!==loopback)) throw new Error("Loopback-only candidates required");
    return {type,sdp};
  };
  await page.exposeFunction("answerLocalFixtureOffer", (offer: RTCSessionDescriptionInit) => {
    if (closed) throw new Error("Loopback responder is closed");
    const pending = answerOffer(offer);
    pendingOffers.add(pending);
    return pending.finally(() => pendingOffers.delete(pending));
  });
  await page.addScriptTag({content:result.outputFiles[0].text});
  return {peers,controls,motionReceipts,framesSent,sendFrame,sendTilePacket,close:async()=>{
    closed = true;
    await Promise.allSettled(pendingOffers);
    await Promise.all(peers.filter(peer=>peer.connectionState!=="closed").map(peer=>peer.close()));
  }};
}
