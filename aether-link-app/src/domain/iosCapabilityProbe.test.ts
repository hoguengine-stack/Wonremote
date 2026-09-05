import { describe, expect, it } from "vitest";
import {
  createIosProbeChecks,
  isIosLike,
  summarizeIosProbeChecks,
  updateIosProbeCheck,
} from "./iosCapabilityProbe";

const supportedSnapshot = {
  isIosDevice: true,
  isSecureContext: true,
  hasWebRtc: true,
  hasPointerEvents: true,
  hasClipboardText: true,
  hasClipboardImage: true,
  hasFileAccess: true,
  hasFullscreen: false,
  isStandalone: true,
  hasServiceWorker: true,
};

describe("iOS capability probe", () => {
  it("detects iPhone and touch-enabled iPad desktop user agents", () => {
    expect(isIosLike("Mozilla/5.0 (iPhone)", "iPhone", 5)).toBe(true);
    expect(isIosLike("Mozilla/5.0 (Macintosh)", "MacIntel", 5)).toBe(true);
    expect(isIosLike("Mozilla/5.0 (Windows NT 10.0)", "Win32", 0)).toBe(false);
  });

  it("keeps browser support separate from interactive proof", () => {
    const checks = createIosProbeChecks(supportedSnapshot);
    expect(checks.find((check) => check.id === "webrtc")?.status).toBe("pass");
    expect(checks.find((check) => check.id === "clipboard-text")?.status).toBe("pending");
    expect(checks.find((check) => check.id === "home-screen")?.status).toBe("pass");
  });

  it("updates one result without mutating the remaining checks", () => {
    const checks = createIosProbeChecks(supportedSnapshot);
    const updated = updateIosProbeCheck(checks, "ime", "pass", "compositionupdate 수신");
    expect(updated.find((check) => check.id === "ime")).toMatchObject({ status: "pass" });
    expect(summarizeIosProbeChecks(updated).pass).toBeGreaterThan(1);
    expect(checks.find((check) => check.id === "ime")?.status).toBe("pending");
  });
});
