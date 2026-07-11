import { describe, expect, it } from "vitest";
import {
  MAX_RECENT_AGENT_NEGOTIATION_IDS,
  candidateMatchesNegotiation,
  parseAgentWebRtcOffer,
  rememberNegotiationAttempt,
} from "./agentWebRtcNegotiation";

describe("Agent WebRTC negotiation filtering", () => {
  it("accepts matching root and offer negotiation IDs", () => {
    expect(
      parseAgentWebRtcOffer({
        negotiationId: "rtc-new",
        offer: { negotiationId: "rtc-new", type: "offer", sdp: "v=0" },
      }),
    ).toEqual({ negotiationId: "rtc-new", type: "offer", sdp: "v=0" });
  });

  it("rejects legacy or conflicting offers that can reuse stale signaling", () => {
    expect(parseAgentWebRtcOffer({ offer: { type: "offer", sdp: "v=0" } })).toBeNull();
    expect(
      parseAgentWebRtcOffer({
        negotiationId: "rtc-old",
        offer: { negotiationId: "rtc-new", type: "offer", sdp: "v=0" },
      }),
    ).toBeNull();
  });

  it("accepts only candidates for the active negotiation", () => {
    expect(candidateMatchesNegotiation({ negotiationId: "rtc-new", candidate: { candidate: "candidate:1" } }, "rtc-new")).toBe(true);
    expect(candidateMatchesNegotiation({ negotiationId: "rtc-old", candidate: { candidate: "candidate:1" } }, "rtc-new")).toBe(false);
  });

  it("keeps accepting new Viewer retries while bounding negotiation history", () => {
    const recentNegotiationIds = new Set<string>();

    for (let index = 0; index < 100; index += 1) {
      expect(rememberNegotiationAttempt(recentNegotiationIds, `rtc-${index}`)).toBe(true);
    }

    expect(recentNegotiationIds.size).toBe(MAX_RECENT_AGENT_NEGOTIATION_IDS);
    expect(recentNegotiationIds.has("rtc-83")).toBe(false);
    expect(recentNegotiationIds.has("rtc-84")).toBe(true);
    expect(recentNegotiationIds.has("rtc-99")).toBe(true);
    expect(rememberNegotiationAttempt(recentNegotiationIds, "rtc-99")).toBe(false);
  });
});
