import { describe, expect, it } from "vitest";
import {
  MAX_WEBRTC_CONTROL_ACTION_BYTES,
  parseWebRtcControlAction,
  serializeWebRtcControlAction,
} from "./webrtcControl";

describe("WebRTC control protocol", () => {
  it("round-trips ordered remote input actions", () => {
    const payload = serializeWebRtcControlAction("key-down Ctrl");
    expect(parseWebRtcControlAction(payload)).toBe("key-down Ctrl");
  });

  it("rejects malformed, empty, binary, and oversized messages", () => {
    expect(parseWebRtcControlAction("not-json")).toBeNull();
    expect(parseWebRtcControlAction(JSON.stringify({ type: "frame", action: "keypress A" }))).toBeNull();
    expect(parseWebRtcControlAction(JSON.stringify({ type: "control", action: "" }))).toBeNull();
    expect(parseWebRtcControlAction(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseWebRtcControlAction("x".repeat(MAX_WEBRTC_CONTROL_ACTION_BYTES + 1))).toBeNull();
  });

  it("refuses unsafe or oversized outgoing actions", () => {
    expect(() => serializeWebRtcControlAction("keypress A\0system shutdown")).toThrow("invalid");
    expect(() => serializeWebRtcControlAction("x".repeat(MAX_WEBRTC_CONTROL_ACTION_BYTES))).toThrow("too large");
  });
});
