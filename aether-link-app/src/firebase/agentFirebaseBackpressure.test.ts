import { describe, expect, it } from "vitest";
import { resolveAgentFrameMaxBufferedAmount } from "./agentFirebase";

describe("Agent WebRTC frame backpressure limit", () => {
  it("uses a finite positive per-frame override", () => {
    expect(resolveAgentFrameMaxBufferedAmount(512 * 1024, {})).toBe(512 * 1024);
  });

  it("uses the configured default when override is absent or invalid", () => {
    const env = { WONREMOTE_WEBRTC_MAX_BUFFERED_BYTES: "123456" };
    expect(resolveAgentFrameMaxBufferedAmount(undefined, env)).toBe(123456);
    expect(resolveAgentFrameMaxBufferedAmount(0, env)).toBe(123456);
    expect(resolveAgentFrameMaxBufferedAmount(Number.NaN, env)).toBe(123456);
    expect(resolveAgentFrameMaxBufferedAmount(Number.POSITIVE_INFINITY, env)).toBe(123456);
  });
});
