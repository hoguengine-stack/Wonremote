import { createAgentPeerConnection } from "../firebase/agentPeerConnection";

export type AgentWebRtcRuntimeKind = "node-datachannel" | "werift";

export async function runAgentWebRtcRuntimeSmoke(
  arch: string = process.arch,
): Promise<AgentWebRtcRuntimeKind> {
  const peer = await createAgentPeerConnection(
    { iceServers: [], iceTransportPolicy: "all" },
    { arch },
  );
  try {
    if (typeof peer.createAnswer !== "function" || typeof peer.addIceCandidate !== "function") {
      throw new Error("Agent WebRTC runtime returned an invalid RTCPeerConnection.");
    }
    return arch === "ia32" || arch === "x86" ? "werift" : "node-datachannel";
  } finally {
    await peer.close();
  }
}
