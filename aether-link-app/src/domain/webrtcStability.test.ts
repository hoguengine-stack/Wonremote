import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS,
  MAX_WEBRTC_CONNECT_TIMEOUT_MS,
  MIN_WEBRTC_CONNECT_TIMEOUT_MS,
  formatWebRtcConnectionFailure,
  isTerminalWebRtcConnectionState,
  resolveWebRtcConnectTimeoutMs,
} from "./webrtcStability";

describe("WebRTC stability policy", () => {
  it("uses a bounded connection watchdog timeout", () => {
    expect(resolveWebRtcConnectTimeoutMs({})).toBe(DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS);
    expect(resolveWebRtcConnectTimeoutMs({ WONREMOTE_RTC_CONNECT_TIMEOUT_MS: "500" })).toBe(
      MIN_WEBRTC_CONNECT_TIMEOUT_MS,
    );
    expect(resolveWebRtcConnectTimeoutMs({ VITE_WONREMOTE_RTC_CONNECT_TIMEOUT_MS: "999999" })).toBe(
      MAX_WEBRTC_CONNECT_TIMEOUT_MS,
    );
    expect(resolveWebRtcConnectTimeoutMs({ WONREMOTE_RTC_CONNECT_TIMEOUT_MS: "9000" })).toBe(9_000);
  });

  it("treats failed, disconnected, and closed as terminal realtime states", () => {
    expect(isTerminalWebRtcConnectionState("failed")).toBe(true);
    expect(isTerminalWebRtcConnectionState("disconnected")).toBe(true);
    expect(isTerminalWebRtcConnectionState("closed")).toBe(true);
    expect(isTerminalWebRtcConnectionState("connecting")).toBe(false);
    expect(isTerminalWebRtcConnectionState("connected")).toBe(false);
  });

  it("formats unavailable reasons for diagnostics", () => {
    expect(formatWebRtcConnectionFailure("timeout", "offer not answered")).toBe(
      "WebRTC realtime channel unavailable (timeout): offer not answered",
    );
    expect(formatWebRtcConnectionFailure("failed")).toBe("WebRTC realtime channel unavailable (failed)");
  });
});
