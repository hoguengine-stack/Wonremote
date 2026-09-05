import { describe, expect, it } from "vitest";
import {
  formatControlDiagnostics,
  formatStreamDiagnostics,
} from "./sessionDiagnostics";

describe("session diagnostics", () => {
  it("formats stream fallback and restart details", () => {
    const lines = formatStreamDiagnostics(
      {
        backend: "gdi",
        desired: true,
        running: false,
        restartCount: 4,
        loopSleepMs: 125,
        outputIndex: 1,
        lastError: "DXGI access denied",
        transport: "firestore-fallback",
      },
      "diagnostic-fallback-polling",
      12,
      2,
    );

    expect(lines).toContain("backend=gdi");
    expect(lines).toContain("stream=recovering");
    expect(lines).toContain("restart=4");
    expect(lines).toContain("tile-path=firestore-fallback");
    expect(lines).toContain("display=#2");
    expect(lines).toContain("stream-error=DXGI access denied");
    expect(lines).toContain("fallback-errors=2");
    expect(lines).toContain("viewer=diagnostic-fallback-polling");
  });

  it("warns when the agent is not elevated", () => {
    expect(
      formatControlDiagnostics({
        elevated: false,
        integrityLevel: "Medium",
        win32ErrorCode: 5,
        win32ErrorMessage: "Access is denied.",
      }),
    ).toEqual(["control=user", "integrity=Medium", "win32=5", "control-error=Access is denied."]);
  });

  it("adds an explicit WebRTC/TURN diagnostic when realtime transport is unavailable", () => {
    expect(formatStreamDiagnostics(undefined, "webrtc-unavailable: timeout", 0, 0)).toContain(
      "webrtc=unavailable",
    );
    expect(formatStreamDiagnostics(undefined, "webrtc-error: ice failed", 0, 0)).toContain("turn=check-required");
    expect(formatStreamDiagnostics(undefined, "webrtc-failed", 0, 0)).toContain("webrtc=unavailable");
    expect(formatStreamDiagnostics(undefined, "webrtc-disconnected", 0, 0)).toContain("turn=check-required");
  });

  it("formats agent-reported WebRTC unavailable reasons", () => {
    const lines = formatStreamDiagnostics(
      {
        desired: true,
        running: true,
        transport: "none",
        rtcState: "unavailable",
        rtcError: "node-datachannel unavailable",
      },
      "webrtc-waiting",
      0,
      0,
    );

    expect(lines).toContain("webrtc=unavailable");
    expect(lines).toContain("webrtc-error=node-datachannel unavailable");
    expect(lines).toContain("tile-path=none");
  });

  it("does not show WebRTC noise when the agent reports no realtime transport attempt", () => {
    const lines = formatStreamDiagnostics(
      {
        desired: false,
        running: false,
        transport: "none",
        rtcState: "none",
      },
      "idle",
      0,
      0,
    );

    expect(lines).not.toContain("webrtc=none");
  });
});
