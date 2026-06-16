import { describe, expect, it } from "vitest";
import { requireTurnWhenRelayOnly, resolveRtcIceServers, shouldUseRelayOnly } from "./rtcTransport";

describe("rtc transport configuration", () => {
  it("uses public STUN by default so local/LAN peer connections can start without extra config", () => {
    expect(resolveRtcIceServers({})).toEqual([
      { urls: ["stun:stun.l.google.com:19302"] },
    ]);
    expect(shouldUseRelayOnly({})).toBe(false);
  });

  it("parses TURN servers and credentials from runtime environment", () => {
    expect(
      resolveRtcIceServers({
        WONREMOTE_RTC_STUN_URLS: "stun:one.example, stun:two.example",
        WONREMOTE_RTC_TURN_URLS: "turn:turn.example:3478?transport=udp",
        WONREMOTE_RTC_TURN_USERNAME: "user",
        WONREMOTE_RTC_TURN_CREDENTIAL: "secret",
      }),
    ).toEqual([
      { urls: ["stun:one.example", "stun:two.example"] },
      {
        urls: ["turn:turn.example:3478?transport=udp"],
        username: "user",
        credential: "secret",
      },
    ]);
  });

  it("can force relay-only mode for strict NAT testing", () => {
    expect(shouldUseRelayOnly({ WONREMOTE_RTC_RELAY_ONLY: "true" })).toBe(true);
    expect(shouldUseRelayOnly({ VITE_WONREMOTE_RTC_RELAY_ONLY: "1" })).toBe(true);
  });

  it("rejects relay-only mode when TURN server settings are missing", () => {
    expect(() => requireTurnWhenRelayOnly({ WONREMOTE_RTC_RELAY_ONLY: "true" })).toThrow(
      "TURN relay-only mode requires WONREMOTE_RTC_TURN_URLS",
    );
    expect(() =>
      requireTurnWhenRelayOnly({
        WONREMOTE_RTC_RELAY_ONLY: "true",
        WONREMOTE_RTC_TURN_URLS: "turn:turn.example:3478",
      }),
    ).not.toThrow();
  });
});
