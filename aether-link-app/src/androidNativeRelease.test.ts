import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone release verifier.
import { verifyNativeMapping } from "../../mobile/android/verify-native-release.mjs";

const mapping = ["ContextUtils", "PeerConnectionFactory", "PeerConnection", "DataChannel", "NetworkMonitor"]
  .map(name => `org.webrtc.${name} -> org.webrtc.${name}:`)
  .join("\n") + "\n    1:2:void onNetworkThreadReady():20:21 -> onNetworkThreadReady\n";

describe("optimized Android JNI release boundary", () => {
  it("accepts preserved JNI names while allowing unrelated app optimization", () => {
    expect(() => verifyNativeMapping(mapping + "com.wonremote.agent.MainActivity -> a.b:\n")).not.toThrow();
  });
  it("blocks native class removal and renaming observed in the shipped mapping", () => {
    expect(() => verifyNativeMapping(mapping.replace("org.webrtc.ContextUtils -> org.webrtc.ContextUtils:\n", "")))
      .toThrow("missing");
    expect(() => verifyNativeMapping(mapping.replace("-> org.webrtc.PeerConnection:", "-> N1.b:")))
      .toThrow("class changed");
  });
  it("blocks JNI callback renaming even when the class name survives", () => {
    expect(() => verifyNativeMapping(mapping.replace("-> onNetworkThreadReady", "-> a")))
      .toThrow("member changed");
  });
  it("allows R8-generated implementation members while preserving the source callback", () => {
    expect(() => verifyNativeMapping(mapping + "    1:2:void $r8$lambda():0:0 -> a\n")).not.toThrow();
  });
});
