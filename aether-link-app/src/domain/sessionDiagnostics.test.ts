import { describe, expect, it } from "vitest";
import {
  formatControlDiagnostics,
  formatStreamDiagnostics,
  shouldWarnAboutControlLimit,
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
      "fallback-polling",
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
    expect(shouldWarnAboutControlLimit({ elevated: false, integrityLevel: "Medium" })).toBe(true);
    expect(shouldWarnAboutControlLimit({ elevated: true, integrityLevel: "High" })).toBe(false);
  });
});
