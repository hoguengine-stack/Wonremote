import { describe, expect, it } from "vitest";
import {
  CURRENT_REMOTE_PROTOCOL_VERSION,
  evaluateRemoteProtocolCompatibility,
  normalizeRemoteProtocolVersion,
  remoteProtocolErrorMessage,
} from "./remoteProtocol";

describe("remote protocol compatibility", () => {
  it("keeps legacy devices without protocol metadata connectable", () => {
    expect(normalizeRemoteProtocolVersion(undefined)).toBe(1);
    expect(evaluateRemoteProtocolCompatibility(undefined)).toMatchObject({ compatible: true, state: "legacy" });
  });

  it("accepts current protocol independently from the app release version", () => {
    expect(evaluateRemoteProtocolCompatibility(CURRENT_REMOTE_PROTOCOL_VERSION)).toEqual({
      compatible: true,
      effectiveVersion: CURRENT_REMOTE_PROTOCOL_VERSION,
      state: "current",
    });
  });

  it("rejects protocol generations outside the supported range with an actionable message", () => {
    const oldDecision = evaluateRemoteProtocolCompatibility(0);
    const newDecision = evaluateRemoteProtocolCompatibility(CURRENT_REMOTE_PROTOCOL_VERSION + 1);
    expect(oldDecision.compatible).toBe(false);
    expect(remoteProtocolErrorMessage(oldDecision)).toContain("Update the Agent");
    expect(newDecision.compatible).toBe(false);
    expect(remoteProtocolErrorMessage(newDecision)).toContain("Update the Viewer");
  });
});
