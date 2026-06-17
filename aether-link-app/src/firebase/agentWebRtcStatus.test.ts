import { describe, expect, it, vi } from "vitest";
import { bindAgentDataChannelStatus, formatNodeDataChannelUnavailableError } from "./agentWebRtcStatus";

describe("agent WebRTC status binding", () => {
  it("reports close and error events to the owner instead of only logging", () => {
    const onState = vi.fn();
    const channel: {
      onopen?: () => void;
      onclose?: () => void;
      onerror?: () => void;
    } = {};

    bindAgentDataChannelStatus(channel, { onState });

    channel.onopen?.();
    channel.onclose?.();
    channel.onerror?.();

    expect(onState).toHaveBeenNthCalledWith(1, "open");
    expect(onState).toHaveBeenNthCalledWith(2, "closed");
    expect(onState).toHaveBeenNthCalledWith(3, "error", "Agent WebRTC data channel failed.");
  });

  it("makes 32-bit native module failures explicit for x86 releases", () => {
    expect(formatNodeDataChannelUnavailableError(new Error("Cannot find module"), "ia32")).toContain(
      "32-bit WebRTC native module unavailable",
    );
    expect(formatNodeDataChannelUnavailableError(new Error("Cannot find module"), "x64")).toContain(
      "node-datachannel unavailable",
    );
  });
});
