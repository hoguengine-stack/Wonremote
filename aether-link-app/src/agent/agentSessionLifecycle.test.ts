import { describe, expect, it } from "vitest";
import {
  beginAgentCaptureGeneration,
  currentSessionId,
  endAgentSessionGeneration,
  sessionIdFromStartStreamCommand,
  shouldStopActiveSession,
  stopStreamTargetFromCommand,
} from "./agentSessionLifecycle";

describe("Agent session lifecycle commands", () => {
  it("uses the explicit Firebase session ID from start-stream", () => {
    expect(
      sessionIdFromStartStreamCommand("start-stream firebase-session-2", {
        deviceId: "device-1",
        firebaseEnabled: true,
      }),
    ).toBe("firebase-session-2");
  });

  it("keeps bare start-stream only for the local API compatibility path", () => {
    expect(
      sessionIdFromStartStreamCommand("start-stream", {
        deviceId: "device-1",
        firebaseEnabled: false,
      }),
    ).toBe("session-device-1");
    expect(
      sessionIdFromStartStreamCommand("start-stream", {
        deviceId: "device-1",
        firebaseEnabled: true,
      }),
    ).toBeNull();
  });

  it("ignores a stale targeted stop command", () => {
    expect(stopStreamTargetFromCommand("stop-stream old-session")).toBe("old-session");
    expect(shouldStopActiveSession("new-session", "old-session", true)).toBe(false);
    expect(shouldStopActiveSession("new-session", "new-session", true)).toBe(true);
    expect(shouldStopActiveSession("new-session", undefined, true)).toBe(false);
  });

  it("uses the active session for Firebase chat, clipboard, file, and polling paths", () => {
    expect(currentSessionId("firebase-session-2", { deviceId: "device-1", firebaseEnabled: true })).toBe(
      "firebase-session-2",
    );
    expect(currentSessionId(null, { deviceId: "device-1", firebaseEnabled: true })).toBeNull();
    expect(currentSessionId(null, { deviceId: "device-1", firebaseEnabled: false })).toBe("session-device-1");
  });

  it("increments only capture generation when the same session restarts capture", () => {
    const next = beginAgentCaptureGeneration({
      activeSessionId: "session-1",
      captureGeneration: 3,
      sessionGeneration: 7,
    }, "session-1");

    expect(next).toEqual({
      activeSessionId: "session-1",
      captureGeneration: 4,
      sessionGeneration: 7,
      sessionChanged: false,
    });
  });

  it("invalidates session transport only on a session switch or stop", () => {
    const switched = beginAgentCaptureGeneration({
      activeSessionId: "session-1",
      captureGeneration: 3,
      sessionGeneration: 7,
    }, "session-2");
    expect(switched).toMatchObject({
      activeSessionId: "session-2",
      captureGeneration: 4,
      sessionGeneration: 8,
      sessionChanged: true,
    });

    expect(endAgentSessionGeneration(switched)).toEqual({
      activeSessionId: null,
      captureGeneration: 5,
      sessionGeneration: 9,
    });
  });
});
