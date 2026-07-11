import { describe, expect, it } from "vitest";
import { runAgentWebRtcRuntimeSmoke } from "./agentWebRtcRuntimeSmoke";

describe("Agent WebRTC runtime smoke", () => {
  it("loads and closes the installed pure-JS x86 runtime", async () => {
    await expect(runAgentWebRtcRuntimeSmoke("ia32")).resolves.toBe("werift");
  });

  it.runIf(process.arch === "x64")("loads and closes the installed x64 native runtime", async () => {
    await expect(runAgentWebRtcRuntimeSmoke("x64")).resolves.toBe("node-datachannel");
  });
});
