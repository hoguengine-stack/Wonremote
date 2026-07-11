import { describe, expect, it } from "vitest";
import { parseActiveSession, serializeActiveSession } from "./sessionPersistence";

describe("viewer active session persistence", () => {
  it("round-trips only the reconnect contract", () => {
    const session = {
      deviceId: "device-1",
      id: "session-1",
      startedAt: "2026-07-11T03:00:00.000Z",
      state: "connected" as const,
    };
    expect(parseActiveSession(serializeActiveSession(session))).toEqual(session);
  });

  it("rejects malformed or closed session snapshots", () => {
    expect(parseActiveSession("not-json")).toBeNull();
    expect(parseActiveSession(JSON.stringify({ id: "s", deviceId: "d", startedAt: "bad", state: "connected" }))).toBeNull();
    expect(parseActiveSession(JSON.stringify({ id: "s", deviceId: "d", startedAt: "2026-07-11T03:00:00Z", state: "closed" }))).toBeNull();
  });
});
