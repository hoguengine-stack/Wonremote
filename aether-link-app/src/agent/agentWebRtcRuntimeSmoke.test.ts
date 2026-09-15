import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentWebRtcRuntimeSmoke } from "./agentWebRtcRuntimeSmoke";

const x64NativeAddonInstalled = process.arch === "x64" && existsSync(path.resolve(
  "node_modules",
  "node-datachannel",
  "build",
  "Release",
  "node_datachannel.node",
));

describe("Agent WebRTC runtime smoke", () => {
  it("loads and closes the installed pure-JS x86 runtime", async () => {
    await expect(runAgentWebRtcRuntimeSmoke("ia32")).resolves.toBe("werift");
  });

  it.runIf(x64NativeAddonInstalled)("loads and closes an available x64 native runtime", async () => {
    await expect(runAgentWebRtcRuntimeSmoke("x64")).resolves.toBe("node-datachannel");
  });

  it.runIf(process.arch === "x64" && !x64NativeAddonInstalled)("fails closed when the optional x64 native runtime is unavailable", async () => {
    await expect(runAgentWebRtcRuntimeSmoke("x64")).rejects.toThrow("node-datachannel unavailable");
  });
});
